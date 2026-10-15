// `#extract` semantics — materialise an ephemeral source-side node via
// the batcher (R2). The evaluator handles:
//
//   - siteId allocation
//   - `data:` resolution (with parent-extract inheritance)
//   - scope capture (ancestor aliases + parent extract site)
//   - schema synthesis (delegated — the action layer threads its
//     target schema in; for the bare evaluator we accept whatever the
//     caller provides or synthesize an empty schema)
//   - alias binding so descendants can reference the produced node
//
// The actual LLM batching is the batcher's job.
//
// ephemeral vs persistent

import { z } from 'zod';

import type { Expression } from '#shared/expression/types';
import type { MetaEdgeStep } from '#shared/expression/types';
import type { EphemeralNode, SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { Batcher, ExtractScope, EnrichmentBinding } from './batcher';
import type { FieldShape } from '../batched_extraction/schema_synthesis';

import { projectEnrichWithArgument, ANON_EXTRACT_ALIAS } from '../batched_extraction/collect_extract_fields';

/**
 * Per-evaluation extract state. Carried on the eval context. Tracks
 * the ancestral `#extract` stack (for nesting + EXTRACT_VALUE parent
 * resolution) and the current `data:` set (inherited by nested
 * `#extract`s that don't declare their own).
 */
export interface ExtractState {
  /** Stack of ancestral `#extract` siteIds, root → leaf. The top of
   *  the stack is the nearest enclosing `#extract` for an
   *  `EXTRACT_VALUE` invocation. */
  stack: string[];
  /** The most-recently-declared `data:` set — inherited by nested
   *  `#extract` sites that don't override. Already resolved to raw
   *  values (not Expressions) so child extracts don't re-evaluate
   *  parent data. */
  data?: unknown[];
  /** Monotonic counter for siteId allocation. Process-shared per
   *  evaluation so fan-out arms get distinct ids even with the same
   *  alias. */
  counter: { value: number };
  /**
   * W3-F4 — `#extract`-alias → ancestral `extract_value` field
   * shapes, populated upfront by the action layer
   * (`evaluateActionNode` calls `collectExtractFieldsFromAction`
   * before kicking off any traversal). Read by `evaluateExtractStep`
   * / `fireExtractFromActionTraversal` when allocating each
   * `ExtractInvocation` so `inv.entityFields` is set before the
   * batcher's `registerExtract` microtask fires.
   *
   * Keyed by AST alias (the only stable static identifier — siteIds
   * are runtime-allocated and not known until evaluation reaches the
   * step). The action layer mutates this map in place at the start
   * of each action evaluation; the extract evaluator looks up
   * `fieldsByAlias.get(step.alias)` per invocation.
   *
   * Absent → schema synthesis falls back to the post-runRoot
   * `valuesByParent` source (legacy behaviour).
   */
  fieldsByAlias?: Map<string, FieldShape[]>;
}

/** Construct a fresh `ExtractState` — top-level (no enclosing extract). */
export function makeExtractState(): ExtractState {
  return { stack: [], counter: { value: 0 } };
}

/**
 * Allocate a fresh siteId. Uses the alias when present (for readable
 * test fixtures) plus a counter; counter-only when anonymous.
 */
export function allocateSiteId(input: { alias?: string; kind: 'extract' | 'extract_value'; state: ExtractState }): string {
  const n = ++input.state.counter.value;
  const prefix = input.kind === 'extract' ? 'x' : 'ev';
  const alias = input.alias ? `:${input.alias}` : '';
  return `${prefix}${alias}#${n}`;
}

/**
 * Evaluate a `#extract` meta-edge step. Resolves `data:`, registers
 * the site with the batcher, and returns ALL produced ephemeral nodes
 * — the traversal yields N positions by nature (zero, one, or many)
 * per the description's cardinality intent.
 *
 * The caller is responsible for:
 *   - pushing the returned siteId onto `extractState.stack` for the
 *     duration of downstream traversal (so nested EXTRACT_VALUEs see
 *     the parent siteId)
 *   - binding emissions to `step.alias` in the alias scope (typically
 *     the first emission, when the alias is used as a singular anchor)
 *   - updating `extractState.data` so child `#extract`s inherit
 *
 */
export async function evaluateExtractStep(input: {
  step: MetaEdgeStep;
  batcher: Batcher;
  state: ExtractState;
  ancestorAliases: Record<string, SourcePosition>;
  /** Evaluate an Expression in the current scope. Pulled in by the
   *  caller so this module doesn't depend on `expression.ts` (which
   *  would be a cycle). */
  evalExpression: (expr: Expression) => Promise<unknown>;
}): Promise<{
  node: EphemeralNode[];
  siteId: string;
  resolvedData: unknown[];
}> {
  const { step, batcher, state, ancestorAliases, evalExpression } = input;

  // Resolve `description`. F3 enforces presence at validation time;
  // defend at runtime as well.
  const descExpr = step.config?.description;
  if (!descExpr) {
    throw new Error(
      `translation_graph engine: -[${step.alias ?? ''}:#extract]-> step is missing required 'description' config.`,
    );
  }
  const description = String((await evalExpression(descExpr)) ?? '');

  // Resolve `data:`. Inherit from the enclosing extract if absent. F3
  // already represents `data` as `Expression[]` (each element typically
  // a `list` expression element or a traversal). Flatten one level so
  // a list value spread into the data set behaves like an inline value.
  let resolvedData: unknown[];
  if (step.config?.data && step.config.data.length > 0) {
    resolvedData = [];
    for (const elem of step.config.data) {
      const v = await evalExpression(elem);
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const x of v) if (x != null) resolvedData.push(projectDatumForBundle(x));
      } else {
        resolvedData.push(projectDatumForBundle(v));
      }
    }
  } else if (state.data) {
    // Inherit parent's resolved data set verbatim.
    resolvedData = state.data;
  } else {
    resolvedData = [];
  }

  const siteId = allocateSiteId({ alias: step.alias, kind: 'extract', state });

  // W3-F3 — field-mapping `#extract` (and action-traversal single-emission
  // `#extract` reached via this helper) is its own root. Don't seed
  // `parentExtractSiteId` from `state.stack` — in production the stack
  // accumulates frames across field-mappings within a single action's
  // evaluation (per `expression.ts:680`'s push-without-pop), so reading
  // the top would attach this invocation to a stale rootId whose
  // `runRoot` already deleted itself. Mirrors W3-F2's fix at
  // `evaluate.ts:541-549` for the fanout path (Gap Q).
  //
  // `EXTRACT_VALUE` still reads `state.stack[top]` legitimately — that's
  // the ancestral `#extract` context within a single expression's
  // traversal chain, which is what the stack was designed for.
  const scope: ExtractScope = {
    parentExtractSiteId: undefined,
    ancestorAliases: { ...ancestorAliases },
  };

  // The evaluator owns at-most a permissive output schema. The action
  // layer (wave-1 R6 / composition runtime, and field-mapping
  // pipeline) supplies a richer schema synthesised from the target
  // type + EXTRACT_VALUE sites. Default: passthrough record.
  const outputSchema = z.record(z.string(), z.unknown());

  // W3-F4 — surface the pre-collected `extract_value` field shapes
  // upfront so schema synthesis builds a populated entity guide before
  // the LLM call. The lookup is by alias because siteIds are
  // runtime-allocated; an anonymous `#extract` (no alias) binds under
  // the shared `ANON_EXTRACT_ALIAS` sentinel so its field hints reach
  // the guide too — without it the guide is empty and every value comes
  // back null.
  const entityFields = state.fieldsByAlias
    ? state.fieldsByAlias.get(step.alias ?? ANON_EXTRACT_ALIAS)
    : undefined;

  // W5-D3 — resolve `enrich_with` entries into runtime bindings the
  // batcher can dispatch. The transform name is evaluated here
  // (almost always a static string) and the argument's emission-data
  // field name is projected from the AST. The cycle itself is
  // implicit — authors don't see it; the batcher's pipeline owns it.
  const enrichWith = await resolveEnrichmentBindings({
    step,
    evalExpression,
  });

  const node = await batcher.registerExtract({
    siteId,
    description,
    data: resolvedData,
    outputSchema,
    scope,
    ...(entityFields && entityFields.length > 0 ? { entityFields } : {}),
    ...(enrichWith && enrichWith.length > 0 ? { enrichWith } : {}),
  });

  // `#extract` is a traversal — the batcher always returns the full
  // ephemeral array (zero, one, or many) per the LLM's emission set.
  // The single-emission and fan-out paths collapse into the same shape.
  return { node, siteId, resolvedData };
}

/**
 * Project a raw `data:` element into the shape the bundle assembler
 * recognises. Two cases matter for wave-1:
 *
 *   - A plain string passes through as a TEXT segment.
 *   - A `SourcePosition` whose payload is a MaterialisedValue (the
 *     generic adapter's record shape — `{ properties, edges }`) with
 *     an `externalId` property (or legacy `resourceId`) is projected
 *     into a `Resource`-shaped POJO so `bundle.ts:isResource` picks it
 *     up and segments + an evidence anchor land on the persisted
 *     resource.
 *
 * Per the W3-B2 separation, the source identifier from the generic
 * shape lands on `externalId` (a source handle), never on `id`
 * (always a generated UUID).
 *
 * Other shapes fall through verbatim — primitives, ephemerals,
 * already-Resource-shaped objects (the adapter path produces those)
 * all behave as they did before this projection.
 *
 * K.3
 */
export function projectDatumForBundle(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  // Already a Resource-shaped POJO — pass through verbatim. We accept
  // either the post-W3-B2 shape (`externalId` or `id`) or the legacy
  // `resourceId`-only shape so older callers still type-check during
  // the migration.
  const valueRec = value as { id?: unknown; externalId?: unknown; resourceId?: unknown };
  if (
    typeof valueRec.id === 'string'
    || typeof valueRec.externalId === 'string'
    || typeof valueRec.resourceId === 'string'
  ) {
    return value;
  }
  // Materialised record reached via the generic source adapter's
  // `__record__` pseudo-field (see `generic_source_adapter.ts`).
  // Shape: `{ properties: Record<string, unknown>, edges: {} }`.
  const matValue = value as { properties?: Record<string, unknown> };
  const props = matValue.properties;
  if (!props) return value;
  // The generic shape may expose the source handle under either
  // `externalId` (new authoring convention) or `resourceId`
  // (back-compat — wave-1 fixtures named the slot `resourceId` before
  // W3-B2). Both project into `externalId` on the Resource POJO.
  const sourceHandle =
    typeof props.externalId === 'string'
      ? props.externalId
      : typeof props.resourceId === 'string'
        ? props.resourceId
        : undefined;
  if (sourceHandle === undefined) return value;
  const type = typeof props.type === 'string' ? props.type : undefined;
  const name = typeof props.name === 'string' ? props.name : undefined;
  const content = typeof props.content === 'string' ? props.content : undefined;
  const projection: Record<string, unknown> = { externalId: sourceHandle };
  if (type) projection.type = type;
  if (name) projection.name = name;
  if (content) projection.content = content;
  // Carry through any other known Resource fields so adapters with
  // richer Resource models still see them.
  if (typeof props.contentType === 'string') projection.contentType = props.contentType;
  if (typeof props.url === 'string') projection.url = props.url;
  return projection;
}

/**
 * W5-D3 — resolve `enrich_with` AST entries into runtime bindings. The
 * transform name is evaluated here (the AST allows any Expression — in
 * practice always `static`); the argument's emission-data field name is
 * projected from the AST shape. The framework owns the cycle; per the
 * 2026-05-22 ruling, the iteration is implicit and authors don't see it.
 *
 * Returns `undefined` when the step has no `enrichWith` configured —
 * `ExtractInvocation.enrichWith` stays absent so the batcher's pipeline
 * skips the two-pass branch.
 */
async function resolveEnrichmentBindings(input: {
  step: MetaEdgeStep;
  evalExpression: (expr: Expression) => Promise<unknown>;
}): Promise<EnrichmentBinding[] | undefined> {
  const entries = input.step.config?.enrichWith;
  if (!entries || entries.length === 0) return undefined;
  const out: EnrichmentBinding[] = [];
  for (const entry of entries) {
    const rawName = await input.evalExpression(entry.transform);
    const transformName = typeof rawName === 'string' ? rawName.trim() : '';
    if (!transformName) {
      // Skip silently — a missing/empty transform name is an authoring
      // error, but failing the entire extract for it would be worse
      // than no-op. Validation should catch this upstream.
      continue;
    }
    const projected = projectEnrichWithArgument(entry.argument as Expression);
    out.push({
      transformName,
      ...(projected ? { argumentFieldName: projected.fieldName, argumentDescription: projected.description } : {}),
    });
  }
  return out;
}
