// C4 — Synthetic schema build.
//
// Translates a bundle's `#extract` + `EXTRACT_VALUE` sites into the
// shape the LLM is asked to produce. The legacy
// `buildExtractionSchema` / `buildDisplaySchema` pair walks the
// `ExtractionTree`; we walk the TG invocations.
//
// Three artifacts come out of this stage:
//
//   1. `EntityShape[]` — a flat list of entities the LLM should
//      produce, each with its declared fields (from EXTRACT_VALUE
//      invocations) plus the structural slot the `#extract` site
//      declared via its `outputSchema`.
//   2. A Zod schema used to validate the LLM JSON response (with the
//      same retry-on-validation-failure semantics as legacy).
//   3. The "entity guide" — the prompt section that names each
//      entity, describes its purpose, and enumerates its fields.
//      Authored in plain text so it can be snapshot-tested.
//
// Uniqueness constraints (including compound scoping via R5's
// `edge_to:` entries) are carried through transparently: the caller
// (R6 / the action layer) feeds in the action's
// `uniquenessConstraints`; we surface them in `EntityShape` so the
// rebinding stage (C8) can flow them into the consolidation /
// `resolveEntity` call.
//
// Entity-density model selection (Opus threshold) is `selectModel(entityCount)`
// in `./model_choice`, the single decision point.

import { z } from 'zod';

import type { ExpressionType } from 'movement-engine/services/translation_graph/types';
import type { StoredUniquenessConstraints } from '../../../knowledge_pipeline/uniqueness_constraints';
import type { Bundle } from './bundle';
import type { ExtractInvocation, ExtractValueInvocation } from '../evaluator/batcher';

// The density model choice is its own module (`./model_choice`), so the
// engine can make it without this module's storage types.
export { ENTITY_DENSITY_OPUS_THRESHOLD, selectModel } from 'movement-engine/services/translation_graph/engine/batched_extraction/model_choice';

/**
 * One declared scalar/structural field the LLM should emit for an
 * entity. Built from one `EXTRACT_VALUE` invocation or from the
 * surrounding action's field-mapping context.
 */
export interface FieldShape {
  /** Field name as it appears in the LLM JSON output. */
  name: string;
  /** Description shown to the LLM (the author's `EXTRACT_VALUE("...")`
   *  description, or the field's label from the field-mapping ctx). */
  description: string;
  /** Inferred expression type — drives validation + coercion. */
  type: ExpressionType;
  /** When `type.kind === 'enum'`, the allowed values. */
  enumOptions?: string[];
  /** The `EXTRACT_VALUE` siteId this field corresponds to. Rebinding
   *  uses it to route the LLM-produced value back to the invocation. */
  extractValueSiteId?: string;
  /** W3-T1 — the target adapter's UUID property type id this field
   *  belongs to (when the field originates from a TG `fieldMappings[]`
   *  entry whose `targetField` is a real property type UUID — the
   *  knowledge-graph adapter shape). Rebind stamps this onto
   *  `IntermediateEvidence.propertyTypeId` so writeEvidence routes
   *  evidence to a UUID column rather than to the LLM's synthesised
   *  field-name string. EV-derived fields (post-runRoot, registered
   *  via `EXTRACT_VALUE`) do not carry it — they target the
   *  ephemeral's own data, not a target-system property. */
  propertyTypeId?: string;
}

/**
 * One entity the LLM should produce. There's one shape per `#extract`
 * invocation in the bundle.
 */
export interface EntityShape {
  /** SiteId of the `#extract` invocation that this shape belongs to. */
  siteId: string;
  /** Description from the `#extract` step. Drives the entity guide. */
  description: string;
  /** Fields the LLM emits for this entity (from EXTRACT_VALUE sites). */
  fields: FieldShape[];
  /** Optional structural schema supplied by the engine (R6 / action
   *  layer threads its target-type schema through here). Defaults to
   *  a passthrough record. */
  structuralSchema: z.ZodTypeAny;
  /** Uniqueness constraints carried from the surrounding action.
   *  Consumed by the rebinding stage (C8) to drive consolidation. */
  uniquenessConstraints?: StoredUniquenessConstraints;
}

/**
 * Synthesised schema for a bundle. The Zod schema below is what the
 * extraction phase validates the LLM response against; the entity
 * guide is appended to the system prompt; the per-entity shapes are
 * the rebinding stage's lookup index.
 */
export interface SyntheticSchema {
  /** Per-`#extract` shapes, keyed by siteId. */
  entities: Record<string, EntityShape>;
  /** Aggregate Zod schema for the full LLM response. The response is
   *  an object keyed by siteId; each value is the entity's shape. */
  responseSchema: z.ZodTypeAny;
  /** Human-readable description block of all entities + their fields.
   *  Surfaced in the system prompt's "Entity Guide" section. */
  entityGuide: string;
  /** Total declared entity count — used by `selectModel` to decide
   *  Opus vs Sonnet routing. */
  entityCount: number;
}

/**
 * Build a synthetic schema for one bundle. The result is the contract
 * between the LLM call and the rebinding stage: the LLM produces a
 * JSON object matching `responseSchema`; rebinding routes values back
 * to invocations using the `entities` index.
 *
 * The optional `entityStructuralSchemas` map lets the action layer
 * thread per-`#extract` target-type schemas through (R6 sets these
 * from the action's `targetTypeRef`). When absent, we fall back to a
 * passthrough record so the bundle still validates.
 */
export function buildSyntheticSchema(input: {
  bundle: Bundle;
  /** Per-`#extract`-siteId structural schemas threaded from the action
   *  layer (`ExtractInvocation.outputSchema`). */
  perSiteStructuralSchema?: Map<string, z.ZodTypeAny>;
  /** Per-`#extract`-siteId uniqueness constraints from the surrounding
   *  action. */
  perSiteUniquenessConstraints?: Map<string, StoredUniquenessConstraints>;
}): SyntheticSchema {
  const entities: Record<string, EntityShape> = {};
  const responseShape: Record<string, z.ZodTypeAny> = {};

  // Group EXTRACT_VALUE invocations under their parent #extract.
  const valuesByParent = new Map<string, ExtractValueInvocation[]>();
  for (const ev of input.bundle.extractValueInvocations) {
    const arr = valuesByParent.get(ev.parentExtractSiteId) ?? [];
    arr.push(ev);
    valuesByParent.set(ev.parentExtractSiteId, arr);
  }

  for (const inv of input.bundle.extractInvocations) {
    const evFields = (valuesByParent.get(inv.siteId) ?? []).map(invToField);
    // W3-F4 — `inv.entityFields` carries the field shapes the action
    // layer pre-collected from the AST (every `extract_value`
    // description bound to this site's alias). When present, surface
    // them in the entity guide BEFORE the LLM call so the prompt
    // carries the field-name hints upfront — without this, schema
    // synthesis runs against an empty bundle (EXTRACT_VALUE invocations
    // only register AFTER `registerExtract`'s microtask resolves
    // `runRoot`) and the guide reads "(no scalar fields — structural
    // only)".
    //
    // Merge semantics: EV-registered fields (post-runRoot) and
    // entityFields (pre-runRoot) are unioned by field name. EV fields
    // carry the `extractValueSiteId` rebind needs; entityFields don't
    // (siteIds are runtime-allocated). When both sources surface the
    // same name, prefer the EV-registered one so rebind's value
    // routing still works. The entityFields-only path applies when
    // schema synthesis runs upfront with no EV invocations registered
    // yet (the production K.2 closure pattern).
    const fields = mergeEntityFields(inv.entityFields ?? [], evFields);
    const structural =
      input.perSiteStructuralSchema?.get(inv.siteId) ??
      inv.outputSchema ??
      z.record(z.string(), z.unknown());

    const entityShape: EntityShape = {
      siteId: inv.siteId,
      description: inv.description,
      fields,
      structuralSchema: structural,
      uniquenessConstraints: input.perSiteUniquenessConstraints?.get(inv.siteId),
    };
    entities[inv.siteId] = entityShape;

    // The LLM response slot for this entity is the union of its
    // declared EXTRACT_VALUE fields and the structural schema.
    const fieldShape: Record<string, z.ZodTypeAny> = {};
    for (const f of fields) {
      fieldShape[f.name] = wrapFieldEvidence(zodForExpressionType(f.type, f.enumOptions));
    }
    const fieldSchema = z.object(fieldShape).passthrough();
    // The structural schema may be a record / object / etc.; we
    // intersect with the field-evidence shape so EXTRACT_VALUE outputs
    // sit alongside whatever the action layer declared.
    const perEntityShape = z.intersection(fieldSchema, structural);
    // W3-F5 — `#extract` is a traversal; every site's response slot is an
    // array (zero, one, or many emissions). The description carries the
    // cardinality intent (e.g. "each investor in this round" → many; "the
    // company being raised" → one).
    //
    // Be forgiving about the one-cardinality case: a site described as a
    // single entity often comes back from the model as a bare object rather
    // than a one-element array. Coerce a non-array object to a one-element
    // array *before* the (unchanged) array schema, rather than failing the
    // whole site with "expected array, received object". Arrays and
    // null/undefined pass through untouched (many-cardinality unaffected).
    responseShape[inv.siteId] = z
      .preprocess(
        (value) => (Array.isArray(value) || value == null ? value : [value]),
        z.array(perEntityShape),
      )
      .optional();
  }

  return {
    entities,
    responseSchema: z.object(responseShape).passthrough(),
    entityGuide: buildEntityGuide(entities),
    entityCount: Object.keys(entities).length,
  };
}

/**
 * W3-F4 — union the pre-collected (action AST) field shapes with the
 * post-runRoot (EV invocation) field shapes. EV-derived fields take
 * precedence on name collisions because they carry the
 * `extractValueSiteId` the rebinder needs to route values back. The
 * pre-collected source only kicks in when the EV path hasn't
 * registered the field yet (the closure pattern for K.2 — the LLM
 * call fires upfront, before the trailing `extract_value` would have
 * registered).
 */
function mergeEntityFields(pre: FieldShape[], post: FieldShape[]): FieldShape[] {
  const byName = new Map<string, FieldShape>();
  for (const f of pre) byName.set(f.name, f);
  for (const f of post) byName.set(f.name, f);
  return Array.from(byName.values());
}

function invToField(ev: ExtractValueInvocation): FieldShape {
  return {
    name: ev.description.length > 80 ? sanitizeFieldName(ev.description) : sanitizeFieldName(ev.description),
    description: ev.description,
    type: ev.fieldType,
    enumOptions: ev.enumOptions,
    extractValueSiteId: ev.siteId,
  };
}

/**
 * Convert a description into a JSON-friendly field key. Whitespace
 * → underscore, non-alphanumerics dropped, lowercase. Collisions are
 * not handled here (the schema build assumes the author wrote
 * unique descriptions per `#extract` site) — surfacing collisions is
 * the editor's job.
 */
function sanitizeFieldName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function zodForExpressionType(type: ExpressionType, enumOptions?: string[]): z.ZodTypeAny {
  switch (type.kind) {
    case 'string':
      return z.string().nullable();
    case 'number':
      return z.number().nullable();
    case 'boolean':
      return z.boolean().nullable();
    case 'date':
    case 'timestamp':
      return z.string().nullable();
    case 'json':
      return z.unknown();
    case 'enum': {
      const opts = enumOptions ?? type.values;
      if (opts.length === 0) return z.string().nullable();
      return z.enum(opts as [string, ...string[]]).nullable();
    }
    case 'file':
      // File handles aren't LLM-extractable scalars; treat as opaque
      // string (URL) for the LLM's purposes.
      return z.string().nullable();
    case 'list':
      return z.array(zodForExpressionType(type.element)).nullable();
    case 'record': {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, t] of Object.entries(type.fields)) {
        shape[k] = zodForExpressionType(t);
      }
      return z.object(shape).nullable();
    }
  }
}

/**
 * Each field comes wrapped in `{ evidence, value }` — same shape as
 * legacy `expandProperties` consumes. The evidence string is the
 * verbatim quote the LLM points at; value is the typed scalar.
 */
function wrapFieldEvidence(valueSchema: z.ZodTypeAny): z.ZodTypeAny {
  return z
    .object({
      evidence: z.string().nullable(),
      value: valueSchema,
    })
    .nullable()
    .optional();
}

function buildEntityGuide(entities: Record<string, EntityShape>): string {
  const sections: string[] = [];
  for (const [siteId, shape] of Object.entries(entities)) {
    const fieldLines = shape.fields.map(
      (f) => `    - \`${f.name}\` (${f.type.kind}${f.enumOptions ? `: ${f.enumOptions.join(' | ')}` : ''}): ${f.description}`,
    );
    // W3-F5 — `#extract` is a traversal; every entity slot is an array
    // (zero, one, or many emissions). The description carries the
    // cardinality intent.
    sections.push(
      `**${siteId}**: ${shape.description} (emit each matching entity as an array element — zero, one, or many objects depending on the description)\n${fieldLines.length ? fieldLines.join('\n') : '    (no scalar fields — structural only)'}`,
    );
  }
  return sections.join('\n\n');
}

