// Translation Graph — typed contract for the unified data-translation primitive.
// New translation graphs are stored as JSONB conforming to this schema; existing
// structures (output v3 trees, extraction graphs) are projected into this contract
// via read-only adapters (P12).

import { z } from 'zod';
import { before, type DeclaredEffectRow, type LanguageVersion } from 'movement-lang';

import type { UniquenessConstraints } from './uniqueness';
import type {
  EphemeralOriginRef,
  FieldEvidence,
  Position,
  PositionIdentity,
  Resource,
  SourcePosition,
} from 'engine-contracts';
import type { FilterExpression, TraversalStep } from '../knowledge_pipeline/output_v3/schemas';
import type { Expression } from '../knowledge_pipeline/output_v3/expression';
import type { EdgeCapability, EdgeSequencing, FieldCapability } from '#shared/expression/types';

import { uniquenessConstraintsSchema } from './uniqueness';
import {
  expressionSchema,
  filterExpressionSchema,
  traversalStepSchema,
} from '../knowledge_pipeline/output_v3/schemas';


// The `translation_graph` / `schema_type` tables were dropped (kill-tg phase
// 6), so their kysely id brands are gone. These TG-body schemas are vestigial
// (no live storage consumer), but kept compiling; brand the ids locally.
type TranslationGraphId = string & { readonly __brand: 'TranslationGraphId' };
type SchemaTypeId = string & { readonly __brand: 'SchemaTypeId' };

// ── ExpressionType: value-type primitives used in generic shapes ───────────
// The expression type system describes the static type of a value flowing
// through an expression. Used by `GenericShape.properties` to declare the
// shape of an in-memory value produced by an input TG and consumed by a
// standalone TG (see `../../composition.md`).
//
// `File` is a first-class primitive — a typed binary handle. See
// `../../resources_currency.md` for its semantics.
//
// File primitive
//
// This deliberately extends but does not subsume `schemaFieldKindSchema`
// below. SchemaFieldKind is the adapter-descriptor's runtime-field type
// (already in production); ExpressionType is the broader expression-system
// type that adds composability (lists, nested records, File). Adapter field
// kinds project into ExpressionType — every SchemaFieldKind has an
// ExpressionType equivalent.

export const expressionTypeSchema: z.ZodType<ExpressionType> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('string') }),
    z.object({ kind: z.literal('number') }),
    z.object({ kind: z.literal('boolean') }),
    z.object({ kind: z.literal('date') }),
    z.object({ kind: z.literal('timestamp') }),
    z.object({ kind: z.literal('json') }),
    z.object({
      kind: z.literal('enum'),
      values: z.array(z.string()),
    }),
    /** File — typed binary handle. Carries content-type + optional name.
     *  Flows through expressions, transforms, and `#extract`'s `data:`
     *  config. */
    z.object({ kind: z.literal('file') }),
    /** List of T. Inhabits `properties` for multi-valued fields and `edges`
     *  for many-cardinality edges (the edge target is List<recordShape>). */
    z.object({
      kind: z.literal('list'),
      element: expressionTypeSchema,
    }),
    /** Inline record shape — used to describe the destination of an edge
     *  in a `GenericShape`. */
    z.object({
      kind: z.literal('record'),
      fields: z.record(z.string(), expressionTypeSchema),
    }),
  ]),
);

export type ExpressionType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'timestamp' }
  | { kind: 'json' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'file' }
  | { kind: 'list'; element: ExpressionType }
  | { kind: 'record'; fields: Record<string, ExpressionType> };

// ── GenericShape: declared in-memory contract for a TG side ─────────────────
// Used by `kind: 'generic'` schemaRefs. The shape declares properties (typed
// values) and edges (typed walks to record-shaped destinations). The
// destination of an edge is itself an ExpressionType — typically a `record`
// (single neighbour) or `list<record>` (many neighbours).

export const genericEdgeSchema = z.object({
  /** The destination type of the edge. A many-cardinality edge has
   *  `target: { kind: 'list', element: { kind: 'record', ... } }`; a
   *  single-cardinality edge has `target: { kind: 'record', ... }`. */
  target: expressionTypeSchema,
});

export type GenericEdge = z.infer<typeof genericEdgeSchema>;

export const genericShapeSchema = z.object({
  properties: z.record(z.string(), expressionTypeSchema),
  edges: z.record(z.string(), genericEdgeSchema),
});

export type GenericShape = z.infer<typeof genericShapeSchema>;

// ── SchemaRef: which adapter's schema interprets a side of the graph ───────
//
// `generic` and `generic_reference` extend the union to support
// materialise-then-chain composition: an input TG declares its target as
// `generic_reference` pointing at a standalone TG, whose `source` is
// `generic` with the matching shape. The runtime materialises the input
// TG's output as a concrete value of the declared shape and feeds it to
// the standalone TG. See `../../composition.md`.
//
// `generic_reference` only makes sense on the target side (a TG cannot
// "consume by reference"; consumption happens through a declared
// generic source). Zod-level enforcement: `tg_id` is required and typed
// as `TranslationGraphId` (the kysely brand on `knowledge.translation_graph.id`).
// Validation of the source/target side-restriction lives in the F3 saver
// (out of scope here — types just expose the union).

export const schemaRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('knowledge-graph') }),
  z.object({
    kind: z.literal('adapter'),
    adapterType: z.string(),
    // N3-P adapter terminals additionally carry a `credentialsId` on
    // the same jsonb (the tight N3 zod `targetSchemaRefSchema` reads
    // adapter identity off `adapterType` directly — single source of
    // truth, no parallel `adapterKind` field). Optional so legacy
    // adapter refs (no credentialsId) still parse.
    credentialsId: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal('generic'), shape: genericShapeSchema }),
  z.object({
    kind: z.literal('generic_reference'),
    /** Id of the standalone TG whose `source.shape` this references. The
     *  branded type matches `knowledge.translation_graph.id` so call
     *  sites can pass it directly. Required — `generic_reference` with no
     *  target is meaningless. */
    // Brand is applied via the kysely-generated `TranslationGraphId` —
    // zod cannot carry the brand directly, so the schema validates the
    // raw string and the inferred type uses `unknown` as the input bridge.
    // Call sites pass the branded id; downstream uses receive the brand back.
    tg_id: z.string().min(1) as unknown as z.ZodType<TranslationGraphId>,
  }),
  // N3 dynamic source — the trigger's raw adapter feed; only valid on
  // a TG source. Stored alongside the legacy adapter/knowledge-graph
  // kinds so `parseRowBodyLenient` accepts N3-shaped provisioning bodies.
  z.object({
    kind: z.literal('dynamic'),
    adapterKind: z.string().min(1),
    // Optional object-type discriminant (D4). Names which variant of the
    // adapter's feed this edge TG consumes (e.g. Attio 'company' vs
    // 'person'); lets a root `branch` narrow the dynamic source per arm.
    objectType: z.string().min(1).optional(),
    credentialsId: z.string().nullable(),
  }),
  // N3 static — a named schema_type row, used for both source and
  // target of inner / intermediate TGs.
  z.object({
    kind: z.literal('static'),
    schemaTypeId: z.string().min(1),
  }),
  // Unset — a freshly-created action whose destination the author hasn't
  // chosen yet. Parses (so the row reads back) but is NOT a valid terminal:
  // the orchestration validator blocks going live until it's pointed
  // somewhere. Lets "Add action" avoid silently defaulting to the KG.
  z.object({ kind: z.literal('unset') }),
]);

export type SchemaRef = z.infer<typeof schemaRefSchema>;

// ── N3 SourceSchemaRef + TargetSchemaRef (tightened) ───────────────────────
// N3 tightens the source/target sides of a TG body into two distinct
// discriminated unions, removing the loose `kind: 'adapter'` / `kind:
// 'knowledge-graph'` overlap and naming the two roles the framework
// distinguishes between:
//
//   - Source: `dynamic` (the trigger's raw adapter feed; only valid at the
//     edge of an orchestration) | `static` (a named `schema_type` row,
//     shared with the previous step's target).
//   - Target: `static` (intermediate TGs — produce a value for the next
//     step) | `knowledge-graph` (terminal write to the KG) | `adapter`
//     (terminal write to an external system).
//
// `generic_reference` stays in the legacy `schemaRefSchema` union for
// composition; it is intentionally NOT carried into the tightened unions —
// out of scope per the N3-S chunk brief.
//
// SchemaType brand: zod can't carry the kysely brand directly (same dance
// as `tg_id` above). We validate the raw string and cast on the type alias.
//
//   §Schema, §translation_graph.body schemaRef tightening
//   §3 (static at TG boundaries), §5 (side effects only at terminals)

const adapterKindSchema = z.string().min(1);
const credentialsIdSchema = z.string().min(1);
const schemaTypeIdSchema = z.string().min(1) as unknown as z.ZodType<SchemaTypeId>;

// N3 tightened source/target schemas. Strict — no extra keys, no
// passthrough — so a malformed N3 body fails parsing before the
// validator gets a chance to misinterpret it.
export const sourceSchemaRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('dynamic'),
      adapterKind: adapterKindSchema,
      // Object-type discriminant (D4) — see schemaRefSchema above.
      objectType: z.string().min(1).optional(),
      credentialsId: credentialsIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('static'),
      schemaTypeId: schemaTypeIdSchema,
    })
    .strict(),
]);

export type SourceSchemaRef = z.infer<typeof sourceSchemaRefSchema>;

export const targetSchemaRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('static'),
      schemaTypeId: schemaTypeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('knowledge-graph'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('adapter'),
      adapterKind: adapterKindSchema,
      credentialsId: credentialsIdSchema,
    })
    .strict(),
]);

export type TargetSchemaRef = z.infer<typeof targetSchemaRefSchema>;

/**
 * Resolve a `SchemaRef` to a concrete adapter type when one exists.
 *
 * - `knowledge-graph` → `'kg'` (the KG's adapter type)
 * - `adapter` → its `adapterType`
 * - `generic` / `generic_reference` → `null` (these refs don't dispatch
 *   through a concrete adapter; the runtime resolves them via the
 *   materialise-then-chain composition runtime, landing in wave-1 R6)
 *
 * Existing code that needs an adapter type should call this helper and
 * handle the `null` case explicitly (throw, fallback, etc.). This is the
 * single narrowing point for the schemaRef union so the F2-extension
 * arms (`generic`, `generic_reference`) don't silently fall through to
 * wrong behaviour.
 *
 *   ("F2 — Extending schemaRefSchema breaks .adapterType narrowing")
 */
export const KG_ADAPTER_TYPE_FOR_REF = 'kg';

export function adapterTypeForRef(ref: SchemaRef): string | null {
  switch (ref.kind) {
    case 'knowledge-graph':
      return KG_ADAPTER_TYPE_FOR_REF;
    case 'adapter':
      return ref.adapterType;
    case 'generic':
    case 'generic_reference':
      return null;
    case 'dynamic':
      return ref.adapterKind;
    case 'static':
    case 'unset':
      return null;
  }
}

/**
 * Where the credential lives on a schemaRef. `adapter` and `dynamic`
 * refs carry their own `credentialsId` under the N3-P substrate (the
 * canonical post-N3-T location); the other arms never do. Centralised
 * so the schema-introspection endpoints resolve credentials from the
 * same place `resolveAdapter` (translation_agent.ts) reads them, rather
 * than the legacy single `pipeline_output.credentials_id` path.
 *
 * issue #4
 */
export function credentialsIdFromRef(ref: SchemaRef): string | null {
  switch (ref.kind) {
    case 'adapter':
      return ref.credentialsId ?? null;
    case 'dynamic':
      return ref.credentialsId ?? null;
    case 'knowledge-graph':
    case 'generic':
    case 'generic_reference':
    case 'static':
    case 'unset':
      return null;
  }
}

// ── ChangedFieldsPredicate: gate a mapping on the mutation's changed fields ─
// Per P15. Used by mappings on translation graphs fired from mutation triggers.
// For non-mutation triggers the predicate defaults to 'always'.

export const changedFieldsPredicateSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('any-of'), fields: z.array(z.string()) }),
  z.object({ op: z.literal('all-of'), fields: z.array(z.string()) }),
  z.object({ op: z.literal('none-of'), fields: z.array(z.string()) }),
  z.object({ op: z.literal('always') }),
]);

export type ChangedFieldsPredicate = z.infer<typeof changedFieldsPredicateSchema>;

// ── FieldMapping: write-permission semantics + runWhen extension ───────────
// Diverges from the output v3 fieldMappingSchema by adding `semantics` (overwrite /
// set-if-null / merge per P7.1) and `runWhen` (per P15). When wrapping existing
// output v3 trees through the read adapter, semantics defaults to 'overwrite' and
// runWhen is omitted.

export const fieldMappingSemanticsSchema = z.enum(['overwrite', 'set-if-null', 'merge']);
export type FieldMappingSemantics = z.infer<typeof fieldMappingSemanticsSchema>;

export const tgFieldMappingSchema = z.object({
  targetField: z.string(),
  /**
   * Source-side expression that produces the value to write. Optional
   * so the editor can render a freshly-added field row with no
   * pre-seeded `static ""` placeholder — the row is "configured" only
   * once the author types something. The engine treats an absent
   * expression as "skip this mapping" (same as a mapping that
   * evaluates to undefined). Once authored, the expression is always
   * present.
   */
  expression: expressionSchema.optional(),
  semantics: fieldMappingSemanticsSchema.default('overwrite'),
  runWhen: changedFieldsPredicateSchema.optional(),
  dataType: z.enum(['string', 'number', 'boolean', 'json', 'documents']).optional(),
});

export type TGFieldMapping = z.infer<typeof tgFieldMappingSchema>;

// ── NodeRelationship: how a child entity relates to its parent ────────────
// Reused conceptually from output v3's pattern. Used by adapters that need
// explicit relationship typing (Attio reference fields, knowledge-graph edges).

export const nodeRelationshipSchema = z.object({
  parentField: z.string().optional(),
  childField: z.string().optional(),
  type: z.enum(['reference', 'embed', 'attachment']),
  /**
   * Name of the edge connecting the parent action's target to this
   * child's target. For graph-shaped targets (KG, adapters whose
   * descriptor publishes references) the picker enumerates the names
   * of edges available from the parent type and stores the chosen one
   * here. The engine resolves the name back to a concrete edge at
   * evaluation time:
   *
   *   - KG target: scan ontology edges. Outbound name match implies
   *     parent is source (outgoing); inbound name match implies parent
   *     is target (incoming). Names are unique per direction.
   *   - Adapter target: scan the parent type's references for one with
   *     a matching `fieldId`. Adapter references are unidirectional, so
   *     a match is unambiguously outgoing.
   *
   * Direction is intentionally not stored — the name disambiguates it
   * and outbound/inbound look identical in the UI ("Person — mentors →"
   * regardless of which side of the underlying edge it is).
   *
   * Optional for back-compat with TGs authored before the picker
   * became edge-aware. When absent, the engine falls back to its
   * default behavior (using `parentField` / `childField` if set).
   */
  edgeName: z.string().optional(),
});

export type NodeRelationship = z.infer<typeof nodeRelationshipSchema>;

// ── ExtractionTemplate: what the LLM is asked to produce ───────────────────
// Initially only the foreign-key-to-extraction-graph form is supported (so the
// engine can dispatch to the existing extraction execution code without forking).
// Inline native templates are a future enhancement.

export const extractionTemplateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('extraction_graph_ref'),
    extractionGraphId: z.string(),
  }),
  // Future: kind: 'inline' with a structural template definition.
]);

export type ExtractionTemplate = z.infer<typeof extractionTemplateSchema>;

// ── Node taxonomy ─────────────────────────────────────────────────────────

export type ActionNode = {
  kind: 'action';
  id: string;
  targetTypeRef: string;
  /**
   * Per-action target override (M4b — multi-target movements). When set,
   * this action resolves its target adapter from THIS ref instead of the
   * evaluation-level `targetSchemaRef`. The override is inherited by the
   * action's children (linked writes land in their parent's graph), so a
   * child without its own `targetRef` writes through its parent's
   * effective target. Absent → the action uses whatever target its parent
   * (or the evaluation) established. Resolution honours the
   * `resolveAdapter` injection point and dry-run wrapping — see
   * `EvalContext.resolveTargetAdapter`.
   */
  targetRef?: SchemaRef;
  /**
   * Credentials for the `targetRef` adapter. Optional — when absent the
   * engine falls back to the credentialsId carried on the ref itself
   * (`adapter` / `dynamic` refs), mirroring `credentialsIdFromRef`.
   */
  targetCredentialsId?: string;
  mode?: 'assert' | 'read' | 'delete';
  traversal: TraversalStep[];
  fieldMappings: TGFieldMapping[];
  adapterConfig?: Record<string, unknown>;
  storeLink?: boolean;
  children: ChildEdge[];
  /**
   * Action-local uniqueness constraints — an opaque OR-of-AND of the
   * target adapter's own field names (`{ any: [{ all: [{ field, fuzzy? }] }] }`).
   * The engine unions these with the target adapter's native constraints
   * (`adapter.describe(recordType).uniquenessConstraints`) before driving
   * entity resolution. Lets authors add Listen-Fire-side identity logic on top of
   * what the target system enforces — e.g. "treat fuzzy name OR exact website
   * as identifying for Attio companies" even though Attio itself doesn't
   * enforce that. `field` names target fields (KG: property type ids; external
   * adapters: their native field ids).
   */
  uniquenessConstraints?: UniquenessConstraints;
};

export type BranchNode = {
  kind: 'branch';
  id: string;
  filter: FilterExpression;
  match?: TranslationGraphNode;
  noMatch?: TranslationGraphNode;
};

/**
 * @deprecated `ExtractionNode` is retired (see
 * `plans/2026-05-19-tg-extraction-parity/gaps_inventory.md` "ExtractionNode
 * is dead"). The replacement is the `#extract` traversal step, which
 * produces ephemeral source-side positions inline within a TG. Bodies
 * containing `kind: 'extraction'` nodes are rejected at zod validation
 * time with a migration pointer.
 *
 * The type is kept exported only so legacy reads (e.g. the now-dead
 * `ExtractionGraphProjection`) still compile until they are deleted.
 * Do not author new code against this type.
 */
export type ExtractionNode = {
  kind: 'extraction';
  id: string;
  parentContext?: TGFieldMapping[];
  template: ExtractionTemplate;
};

export type TranslationGraphNode = ActionNode | BranchNode;

export type ChildEdge = {
  node: TranslationGraphNode;
  relationship: NodeRelationship;
};

// ── Recursive zod schemas ──────────────────────────────────────────────────
// Recursion uses z.lazy at the *reference sites* only (matching the pattern
// in output_v3/schemas.ts). Schema bodies themselves are not wrapped.

const actionNodeSchema: z.ZodType<ActionNode> = z.object({
  kind: z.literal('action'),
  id: z.string(),
  targetTypeRef: z.string(),
  targetRef: schemaRefSchema.optional(),
  targetCredentialsId: z.string().optional(),
  mode: z.enum(['assert', 'read', 'delete']).optional(),
  traversal: z.array(traversalStepSchema),
  fieldMappings: z.array(tgFieldMappingSchema),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
  storeLink: z.boolean().optional(),
  children: z.array(
    z.object({
      node: z.lazy((): z.ZodType<TranslationGraphNode> => translationGraphNodeSchema),
      relationship: nodeRelationshipSchema,
    }),
  ),
  uniquenessConstraints: uniquenessConstraintsSchema.optional(),
});

const branchNodeSchema: z.ZodType<BranchNode> = z.object({
  kind: z.literal('branch'),
  id: z.string(),
  filter: filterExpressionSchema,
  match: z.lazy((): z.ZodType<TranslationGraphNode> => translationGraphNodeSchema).optional(),
  noMatch: z.lazy((): z.ZodType<TranslationGraphNode> => translationGraphNodeSchema).optional(),
});

/**
 * Deprecation guard for the retired ExtractionNode kind. Any TG body that
 * still carries `kind: 'extraction'` parses through this branch and fails
 * with a clear migration pointer. This is intentionally permissive on the
 * shape (just `kind` + a passthrough) so the error fires on `kind` alone
 * rather than getting mangled by unrelated field mismatches.
 *
 * See plans/2026-05-19-tg-extraction-parity/gaps_inventory.md
 * ("ExtractionNode is dead") and `_execution/wave-0/F5-retire-extraction-node.md`.
 */
const deprecatedExtractionNodeSchema: z.ZodType<never> = z
  .object({ kind: z.literal('extraction') })
  .passthrough()
  .transform((_, ctx) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Translation-graph node kind 'extraction' (ExtractionNode) has been retired. " +
        "Use the `#extract` traversal step instead — it produces ephemeral source-side " +
        'positions inline within the TG. See plans/2026-05-19-tg-extraction-parity/.',
    });
    return z.NEVER;
  });

export const translationGraphNodeSchema: z.ZodType<TranslationGraphNode> = z.union([
  actionNodeSchema,
  branchNodeSchema,
  deprecatedExtractionNodeSchema,
]);

// ── NodeMapping ────────────────────────────────────────────────────────────
// Top-level entity-type correspondence, declared once per TG and consumed by
// event-mode execution. The directed structure (the rooted tree of action
// nodes in `roots`) remains the entry point for pipeline mode and is
// independent of node mappings; future unification can merge them.

export const nodeMappingSchema = z.object({
  id: z.string(),
  sourceTypeRef: z.string(),
  targetTypeRef: z.string(),
  fieldMappings: z.array(tgFieldMappingSchema),
  /** Node-level filter — limits which entities of this type are in scope.
   *  Symmetric: applies regardless of which edge brings us to this node. */
  filter: expressionSchema.optional(),
  /** Per-mapping uniqueness constraints — unioned with adapter-native
   *  constraints during entity resolution. Same semantics as ActionNode's
   *  uniquenessConstraints. */
  uniquenessConstraints: uniquenessConstraintsSchema.optional(),
  /** Optional adapter-config (e.g. Attio per-object identifiers). */
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
});

export type NodeMapping = z.infer<typeof nodeMappingSchema>;

// ── TraversalExpression ────────────────────────────────────────────────────
// Ordered list of steps; length > 1 = multi-hop. Each step reuses the
// existing TraversalStep schema used by the directed structure. Adapters
// resolve the expression against their own system.

export const traversalExpressionSchema = z.object({
  steps: z.array(traversalStepSchema).min(1),
});

export type TraversalExpression = z.infer<typeof traversalExpressionSchema>;

// ── TGEdge ─────────────────────────────────────────────────────────────────
// Relationship correspondence between two NodeMappings. Names traversals in
// source and target via adapter-local edge names; the adapter resolves
// physical mechanisms (FK lookup, list query, join table, etc.). The TG
// stays system-agnostic — no `kind: 'reverse-reference', field: '...'`-style
// details live here.
//
// Each side may declare zero, one, or both directions:
//   - traversalAB: A → B in this system
//   - traversalBA: B → A in this system
//
// Missing direction = "not traversable on this side." The runtime asks the
// adapter for FK-ownership and change-relevance at execution time; the edge
// itself doesn't carry that metadata.

export const tgEdgeSchema = z.object({
  id: z.string(),
  /** Ordered pair of NodeMapping ids. `AB` / `BA` below refer to this order. */
  endpoints: z.tuple([z.string(), z.string()]),
  source: z.object({
    traversalAB: traversalExpressionSchema.optional(),
    traversalBA: traversalExpressionSchema.optional(),
  }),
  target: z.object({
    traversalAB: traversalExpressionSchema.optional(),
    traversalBA: traversalExpressionSchema.optional(),
  }),
});

export type TGEdge = z.infer<typeof tgEdgeSchema>;

// ── TranslationGraph body (the JSONB shape) ────────────────────────────────
// The full row also has id/team_id/name/description/version/timestamps as
// columns (see knowledge.translation_graph) — those are not part of the body.
//
// Note: NodeMappings + Edges are NOT here. They live one level up, on the
// consumer entity (`pipeline_input.tg_event_body` /
// `pipeline_output.tg_event_body`), shared across all triggers on the same
// input/output. See `pipelineEventBodySchema` below.

export const translationGraphBodySchema = z.object({
  // Bodies may start empty when the user creates a trigger before authoring
  // its TG. The engine treats an empty body as a no-op; the editor seeds
  // the first node interactively.
  roots: z.array(translationGraphNodeSchema),
  /**
   * Name of the lexical alias the trigger declaration binds to the source
   * root position (the `msg` in `trigger: source AS msg`). When set, the
   * engine seeds `ctx.aliases = { [sourceAlias]: rootPosition }` before any
   * expressions evaluate, so `traverse.aliasRoot: 'msg'` (and `alias_ref`)
   * can resolve at the trigger root. When undefined the engine leaves
   * `ctx.aliases` unset — R1's evaluator throws a clear
   * `traverse.aliasRoot("…") has no binding in scope.` for the missing-
   * alias case, which is the right UX for unwired bodies.
   *
   * F3 authoring sets this at parse time from the `AS` clause; back-compat
   * leaves it optional so legacy bodies (no alias) keep parsing.
   *
   */
  sourceAlias: z.string().min(1).optional(),
});

export type TranslationGraphBody = z.infer<typeof translationGraphBodySchema>;

// ── PipelineEventBody (the input/output-level event-mode map) ──────────────
// Stored as JSONB on `pipeline_input.tg_event_body` and
// `pipeline_output.tg_event_body`. One canonical map per consumer entity;
// every event-mode trigger on that consumer shares the same map.
//
// Event-mode dispatch reads this body alongside the trigger entry's
// (filter, executionMode) to construct the runtime body the engine
// consumes — see triggers/router.ts.

export const pipelineEventBodySchema = z.object({
  nodeMappings: z.array(nodeMappingSchema),
  edges: z.array(tgEdgeSchema),
});

export type PipelineEventBody = z.infer<typeof pipelineEventBodySchema>;

/** Lenient parse — used at storage boundary so a malformed JSONB doesn't
 *  break the page. Returns an empty body when input isn't recognisable. */
export function parsePipelineEventBodyLenient(value: unknown): PipelineEventBody {
  if (!value || typeof value !== 'object') return { nodeMappings: [], edges: [] };
  const parsed = pipelineEventBodySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Partial-parse: accept whichever side is well-formed.
  const obj = value as Record<string, unknown>;
  return {
    nodeMappings: Array.isArray(obj.nodeMappings)
      ? z.array(nodeMappingSchema).parse(obj.nodeMappings)
      : [],
    edges: Array.isArray(obj.edges) ? z.array(tgEdgeSchema).parse(obj.edges) : [],
  };
}

// ── Top-level TranslationGraph (body + metadata) ───────────────────────────

/**
 * TG flavour persisted on the `knowledge.translation_graph.kind` column.
 * Only `extraction` (regular mapping TGs) survives — the `router` flavour
 * was retired with the router-TG mechanism (3c substrate collapse;
 * content routing is now a `branch` step in the orchestration).
 */
export const translationGraphRowKindSchema = z.enum(['extraction']);
export type TranslationGraphRowKind = z.infer<typeof translationGraphRowKindSchema>;

export const translationGraphSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  sourceSchemaRef: schemaRefSchema,
  targetSchemaRef: schemaRefSchema,
  body: translationGraphBodySchema,
  /**
   * W5-D2 — TG flavour. Optional in the schema so back-compat callers
   * that construct `TranslationGraph` literals without specifying kind
   * still type-check; storage adapters always set it on load. Callers
   * that need to branch on it should treat `undefined` as `'extraction'`.
   */
  kind: translationGraphRowKindSchema.optional(),
  version: z.number().int().positive(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type TranslationGraph = z.infer<typeof translationGraphSchema>;

// ── TranslationGraph row "kind" (legacy alias, kept for storage helpers) ───
// F7 removed the persisted `kind` column from `knowledge.translation_graph`
// — a mapping has no owner. Some storage helpers still use this enum as a
// dispatch hint ("which consumer am I writing this binding for?"). The
// values match the old persisted values so call-site rewrites stay small.

export const translationGraphKindSchema = z.enum(['input', 'output', 'standalone']);
export type TranslationGraphKind = z.infer<typeof translationGraphKindSchema>;

// ── Trigger entries (pipeline_input.translation_graphs persisted shape) ────
// Per `plans/2026-05-07-structured-input-containers/`: a structured input's
// configuration is a list of *triggers*, each pairing a trigger kind
// (manual snapshot, webhook event, …) with a translation graph that runs
// when the trigger fires. Multiple triggers can share an objectType — a
// manual backfill TG and a live-webhook TG may translate the same Attio
// Person differently.
//
// The column name (`translation_graphs`) is a holdover from the earlier
// "one TG per object type" shape. The persisted value is now a TriggerEntry
// array; renaming the column is a follow-up tidy.

export const triggerEntryKindSchema = z.enum(['manual', 'webhook', 'mutation', 'extraction']);
export type TriggerEntryKind = z.infer<typeof triggerEntryKindSchema>;

export const triggerEntrySchema = z.object({
  /** Stable identifier per entry. Post-F7 this IS the
   *  `knowledge.trigger_entry.id` — i.e. the binding row that ties a
   *  consumer to a translation_graph mapping. Lets the engine route an
   *  inbound event to one specific binding on this consumer. */
  id: z.string(),

  /** Id of the underlying mapping (`knowledge.translation_graph.id`).
   *  Optional so existing code paths that synthesise TriggerEntries
   *  ad-hoc (tests, snapshot iteration shims) don't have to fill it; the
   *  storage helpers populate it on read. */
  translationGraphId: z.string().optional(),

  /** Which kind of source-side event fires this entry's TG.
   *  - `manual`: the user clicks "Snapshot now". Seeds the engine at the
   *    adapter's meta-position; the TG's root traversal walks meta → a
   *    collection edge to fan out into records.
   *  - `webhook`: the adapter dispatches an inbound event matching this
   *    entry's filter.
   *  - `mutation`: a KG commit hook emits a RecordMutationEvent matching
   *    this entry's filter (output-side containers,
   *    plans/2026-05-10-valuations-knowledge-sync/).
   *  - `extraction`: an extraction commit emits an ExtractionEvent for a
   *    newly-extracted message-typed node; the entry's filter narrows by
   *    message node type. Source is the extracted subgraph (with linkBack to
   *    the full KG); distinct from `mutation` because the relevant starting
   *    position is the message node, not any arbitrary affected KG node. */
  triggerKind: triggerEntryKindSchema,

  /**
   * Boolean Expression evaluated against the source graph / event payload.
   * - `manual`: scopes the snapshot fan-out (pushed down via the adapter's
   *   `translateFilter` on the relevant traversal step).
   * - `webhook`: selects which inbound events fire this trigger AND narrows
   *   polymorphic references at picker time.
   * - `mutation`: selects which KG mutation events fire this trigger.
   *   Evaluated against an event position with `meta` carrying
   *   `{nodeTypeId, changeKind, changedFields, actor, adapterType}` — so a
   *   filter like `meta.nodeTypeId == '<uuid>' && meta.changeKind != 'delete'`
   *   scopes by node type and excludes deletes.
   * - `extraction`: selects which extraction events fire this trigger by
   *   message node type — e.g. `meta.nodeTypeId == '<message-type-uuid>'`.
   * Absent ⇒ no filter.
   */
  filter: expressionSchema.optional(),

  /** TG body schemas (source/target + roots). The body lives inline so the
   *  storage layer doesn't need a separate table. `roots` are the directed
   *  pipeline-mode action tree, per-trigger (different triggers can fan
   *  out differently). NodeMappings + Edges (the event-mode map) live one
   *  level up on the consumer entity — see `pipelineEventBodySchema`. */
  sourceSchemaRef: schemaRefSchema,
  targetSchemaRef: schemaRefSchema,
  roots: z.array(translationGraphNodeSchema),

  /**
   * Trigger source alias — see `TranslationGraphRowBody.sourceAlias`. The
   * in-memory `TriggerEntry` carries it alongside the mapping body so
   * downstream projections (`entryToTranslationGraph`) can place it on the
   * resulting `TranslationGraphBody.sourceAlias`.
   */
  sourceAlias: z.string().min(1).optional(),

  /** Execution mode for this trigger.
   *   - `pipeline` (default): fan down from `roots` (existing behavior).
   *   - `event`: re-assert the changed entity plus its potentially-changed
   *      edges, consuming the consumer-level `tg_event_body`
   *      (nodeMappings + edges shared across all event-mode triggers on
   *      the same input/output). Adapter answers FK-ownership +
   *      change-relevance; runtime prunes traversals.
   *   Defaults to `pipeline` for back-compat. */
  executionMode: z.enum(['pipeline', 'event']).optional(),
});

export type TriggerEntry = z.infer<typeof triggerEntrySchema>;

export const triggerEntriesSchema = z.array(triggerEntrySchema);
export type TriggerEntries = z.infer<typeof triggerEntriesSchema>;

// ── TranslationGraph row body (the JSONB shape persisted to the table) ─────
// F7 split: the row body is now a pure mapping (sourceSchemaRef,
// targetSchemaRef, roots). Trigger metadata moved to knowledge.trigger_entry.

export const translationGraphRowBodySchema = z.object({
  sourceSchemaRef: schemaRefSchema,
  targetSchemaRef: schemaRefSchema,
  roots: z.array(translationGraphNodeSchema),
  /**
   * Lexical alias the trigger declaration binds to the source root
   * position (the `msg` in `trigger: source AS msg`). See
   * `translationGraphBodySchema.sourceAlias` for the full contract — this
   * is the persistence-level field; the engine reads the same name off
   * `TranslationGraphBody` after projection (`entryToTranslationGraph` /
   * `runReferencedMapping`).
   *
   */
  sourceAlias: z.string().min(1).optional(),
});

export type TranslationGraphRowBody = z.infer<typeof translationGraphRowBodySchema>;

/**
 * In-memory binding shape — one `knowledge.trigger_entry` row plus its
 * referenced mapping. Storage helpers join across the two tables and
 * return this so consumers keep the legacy `TriggerEntry[]` mental model
 * even though the underlying persistence split into two relations.
 */
export interface TriggerEntryRow {
  id: string;                       // trigger_entry.id
  teamId: string;
  translationGraphId: string;       // FK → translation_graph.id (the mapping)
  pipelineInputId: string | null;
  pipelineOutputId: string | null;
  triggerKind: TriggerEntryKind;
  filter?: import('../knowledge_pipeline/output_v3/expression').Expression;
  executionMode?: 'pipeline' | 'event';
}

/**
 * Build a `TriggerEntry` (the joined in-memory view) from a binding row +
 * its mapping body. The `id` of the resulting TriggerEntry is the
 * trigger_entry row id — i.e. the firing-binding identifier. The mapping
 * id is exposed separately as `translationGraphId`.
 */
export function buildTriggerEntry(input: {
  binding: TriggerEntryRow;
  mappingBody: TranslationGraphRowBody;
}): TriggerEntry {
  return {
    id: input.binding.id,
    translationGraphId: input.binding.translationGraphId,
    triggerKind: input.binding.triggerKind,
    filter: input.binding.filter,
    sourceSchemaRef: input.mappingBody.sourceSchemaRef,
    targetSchemaRef: input.mappingBody.targetSchemaRef,
    roots: input.mappingBody.roots,
    sourceAlias: input.mappingBody.sourceAlias,
    executionMode: input.binding.executionMode,
  };
}

/**
 * Project a `TriggerEntry` back into (binding fields, mapping body) for
 * persistence. The caller is responsible for routing the binding fields
 * to the trigger_entry write and the mapping body to the
 * translation_graph write.
 */
export function splitTriggerEntry(entry: TriggerEntry): {
  mappingBody: TranslationGraphRowBody;
  bindingFields: Pick<TriggerEntryRow, 'triggerKind' | 'filter' | 'executionMode'>;
} {
  return {
    mappingBody: {
      sourceSchemaRef: entry.sourceSchemaRef,
      targetSchemaRef: entry.targetSchemaRef,
      roots: entry.roots,
      sourceAlias: entry.sourceAlias,
    },
    bindingFields: {
      triggerKind: entry.triggerKind,
      filter: entry.filter,
      executionMode: entry.executionMode,
    },
  };
}

/**
 * Lenient parse of a mapping row body — tolerates malformed JSONB so
 * reads never 500 the page. Returns null when the body is not
 * recognisable as a mapping.
 *
 * Parse failures emit a `console.warn` with a summary of the zod errors:
 * silent failures here surface downstream as misleading "referenced
 * mapping not found" errors (G1-v4 / Gap G), costing diagnostic time.
 * The warn includes the schema location + the first few issue paths so
 * the caller can grep the source straight away.
 */
export function parseRowBodyLenient(value: unknown): TranslationGraphRowBody | null {
  if (!value || typeof value !== 'object') {
    console.warn(
      '[parseRowBodyLenient] row body is not an object — returning null',
      { type: typeof value, isNull: value === null },
    );
    return null;
  }
  const parsed = translationGraphRowBodySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  console.warn(
    '[parseRowBodyLenient] translationGraphRowBodySchema rejected row body — returning null. ' +
      'See packages/movement-engine/services/translation_graph/types.ts (translationGraphRowBodySchema) ' +
      'and packages/movement-engine/services/knowledge_pipeline/output_v3/expression.ts (expressionSchema).',
    {
      issueCount: parsed.error.issues.length,
      firstIssues: issues,
    },
  );
  return null;
}

// F7 removed the legacy `typed_translation_graphs` aliases and
// `parseTriggerEntriesLenient` — TGs no longer live as JSONB on the
// pipeline_input/pipeline_output rows; the table-backed loaders speak
// the typed shape directly.

// ── SchemaDescriptor: what an adapter exposes about its schema ─────────────
// Per Layer 2 §2.6 + critique §C3 (framework consumes descriptor abstractly;
// adapter generates it however — introspection or hardcoded).

export const schemaFieldKindSchema = z.enum([
  'string',
  'number',
  'boolean',
  'date',
  'json',
  'enum',
  'reference',
  /**
   * File — typed binary handle. Mirrors `ExpressionType { kind: 'file' }`
   * so adapter-published file fields (e.g., the Email attachment's `data`
   * slot, Slack file's `data` slot, Attio attachment slots) flow through
   * the editor as a first-class kind. The field-mapping editor uses this
   * to route File-typed expressions only into File-typed target fields
   * and surface an inline error on mismatch (E5, wave-2).
   *
   */
  'file',
]);

export type SchemaFieldKind = z.infer<typeof schemaFieldKindSchema>;

/**
 * UI rendering hint for a field. The editor uses this to pick the
 * input control independently of the underlying `kind` (which is the
 * runtime/storage type). Most fields can leave it unset and the editor
 * picks a default based on `kind`.
 *
 *   - `prompt`     — long-form text with embed-token support (used for
 *                     LLM prompt fields like Note titlePrompt /
 *                     contentPrompt). The editor renders a
 *                     prompt-aware textarea.
 *   - `textarea`   — plain multi-line string (no embed support).
 *   - `select`     — closed enum, rendered as a dropdown rather than
 *                     a free-text input. Useful when `kind: 'string'`
 *                     but values are constrained.
 *   - `string`/`number`/`boolean`/`date`/`json` — explicit overrides
 *                     for when `kind` doesn't fit (rare).
 *
 * This slot replaces v3's `FieldDefinition.type` discriminator on the
 * adapter-registry path and lets the editor consume the descriptor as
 * the single source of truth.
 */
export const schemaFieldUiHintSchema = z.enum([
  'string',
  'textarea',
  'prompt',
  'select',
  'number',
  'boolean',
  'date',
  'json',
]);
export type SchemaFieldUiHint = z.infer<typeof schemaFieldUiHintSchema>;

/**
 * Where a writable field lands at the adapter's write boundary.
 *
 *   - `{ kind: 'node' }` — property anchored to the action's target
 *     node (the default; omit `anchor` and the adapter treats it as
 *     node-anchored).
 *   - `{ kind: 'edge', edgeTypeId, side }` — property anchored to the
 *     edge between the action's target node and one of its
 *     neighbours. The KG adapter surfaces these on actions whose
 *     `parentLink.edgeName` resolves to the same edge type; the write
 *     path keys the `knowledge.property` row on `edge_id` instead of
 *     `node_id`.
 *
 * `side` records which end of the edge the action's target sits on
 * relative to the edge type's declared direction: `target` when the
 * action's target type matches `edge_type.target_node_type_id`
 * (i.e. the outgoing reference walked the edge into us) and `source`
 * when it matches `edge_type.source_node_type_id` (incoming
 * reference). The engine uses this to disambiguate edges that share a
 * single edge type but might be authored against from either end.
 *
 */
export const fieldAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node') }),
  z.object({
    kind: z.literal('edge'),
    edgeTypeId: z.string(),
    side: z.enum(['source', 'target']),
  }),
]);
export type FieldAnchor = z.infer<typeof fieldAnchorSchema>;

/**
 * The effect row a function whose BODY is not a movement declares for itself —
 * a plugin, an adapter's field function. The inferred row's written twin: the
 * same five facts the checker derives by walking a movement, stated where the
 * body cannot be walked.
 *
 * `reads`/`writes` name synthetic sources in author-facing words ("the web"),
 * not instances: a declaration is written once and cannot know which graphs the
 * movement calling it constructed.
 */
export const declaredEffectRowSchema = z.object({
  reads: z.array(z.string().min(1)).optional(),
  writes: z.array(z.string().min(1)).optional(),
  ai: z.boolean().optional(),
  now: z.boolean().optional(),
  suspend: z.boolean().optional(),
}) satisfies z.ZodType<DeclaredEffectRow>;

export type DeclaredEffects = z.infer<typeof declaredEffectRowSchema>;

// ── Field functions: adapter-provided expression functions, scoped to a
// ── writable field (e.g. Slack's `SLACK_MESSAGE`).
//
// A field function is an ordinary expression function whose scope is one field
// and whose body lives on the adapter. This descriptor is the *advertisement*
// of one — pure, serialisable data (no closures) so it crosses the remote-
// adapter wire on `describe()` unchanged. It feeds three consumers from one
// source: runtime resolution (the engine binds the name to the adapter's
// `invokeFieldFunction`), the validator (a non-built-in function is only valid
// on a field that advertises it), and discoverability (editor palette +
// authoring handbook). The *body* is `Adapter.invokeFieldFunction`.
export const fieldFunctionParamSchema = z.object({
  name: z.string(),
  /** `string` — coerced to a string (the brief). `value` — a bare value
   *  passed through verbatim (the adapter never interprets it). */
  kind: z.enum(['string', 'value']),
  /** When true this is the trailing variadic parameter (e.g. `…data`). */
  variadic: z.boolean().optional(),
  doc: z.string(),
});
export type FieldFunctionParam = z.infer<typeof fieldFunctionParamSchema>;

export const fieldFunctionDescriptorSchema = z.object({
  /** The call name authors type, e.g. `SLACK_MESSAGE`. */
  name: z.string(),
  displayName: z.string(),
  /** One line for the palette + handbook. */
  summary: z.string(),
  params: z.array(fieldFunctionParamSchema),
  /** What the function returns; omitted means the field's own `kind`. The
   *  return is coerced to the field at the write boundary regardless. */
  returnKind: schemaFieldKindSchema.optional(),
  /**
   * What invoking it may do — the DECLARED effect row, the same one a plugin
   * carries, for the same reason: the body lives on the adapter
   * (`invokeFieldFunction`), so nothing can walk it.
   *
   * Declare it truthfully: `SLACK_MESSAGE` writes its text with a model, so
   * it declares `ai`. A function that only rearranges the arguments it was
   * given declares the EMPTY row — a claim, and a useful one: an empty
   * declared row is purity, where an absent one is nobody having said.
   *
   */
  effects: declaredEffectRowSchema.optional(),
});
export type FieldFunctionDescriptor = z.infer<typeof fieldFunctionDescriptorSchema>;

/** The FilterOperator universe, incl. WITHIN (recency). Mirrors
 *  `#shared/expression/types`' `FilterOperator` at the runtime boundary. */
const filterOperatorSchema = z.enum([
  'eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'in', 'within',
]);

/**
 * A field's own filter/order capability in the source system (chunk 4 of the
 * adapter-capability-contract plan). Rides the field descriptor `describe()`
 * already returns. See `#shared/expression/types`' `FieldCapability`.
 */
export const fieldCapabilitySchema = z.object({
  filterOperators: z.array(filterOperatorSchema).optional(),
  orderable: z.boolean().optional(),
}) satisfies z.ZodType<FieldCapability>;

const edgePushModeSchema = z.enum(['bounded', 'native']);

/**
 * Whether — and how — filter/order/limit push across one relationship (chunk 4).
 * Combined by the checker with the target type's per-field `fieldCapability`.
 * See `#shared/expression/types`' `EdgeCapability`.
 */
export const edgeCapabilitySchema = z.object({
  filter: edgePushModeSchema.optional(),
  order: edgePushModeSchema.optional(),
  supportsLimit: z.boolean(),
  naturalOrder: z
    .object({ field: z.string(), direction: z.enum(['asc', 'desc']) })
    .optional(),
}) satisfies z.ZodType<EdgeCapability>;

/**
 * What an edge's members are inherently ordered BY. A DIFFERENT fact from
 * `edgeCapabilitySchema.order`, which says only that an authored ORDER BY can
 * be pushed to the source. See `#shared/expression/types`' `EdgeSequencing`
 * for the distinction and the declaration rule.
 */
export const edgeSequencingSchema = z.enum([
  'chronological',
  'document',
  'arrival',
]) satisfies z.ZodType<EdgeSequencing>;

export const schemaFieldDescriptorSchema = z.object({
  fieldId: z.string(),
  displayName: z.string(),
  kind: schemaFieldKindSchema,
  enumValues: z.array(z.string()).optional(),
  /**
   * OPEN known-values (distinct from `enumValues`, a closed set): live values
   * the adapter could enumerate (Slack channel names, select options) that
   * hint + soft-check authoring — an unknown string literal draws a WARNING
   * with a did-you-mean, while values matching `knownValuePattern` (ids) and
   * computed expressions stay legal. Best-effort: omit when the listing
   * fails; the field then checks as plain text.
   */
  knownValues: z.array(z.string()).optional(),
  knownValuePattern: z.string().optional(),
  referenceTargetType: z.string().optional(),
  writable: z.boolean(),
  /**
   * Whether this field carries a value a movement can READ off the position.
   * Absent ⇒ true (every field is readable unless the adapter says
   * otherwise). Set `readable: false` on a WRITE-ONLY field — a value that
   * exists only to be set in a write, never to be read back (WhatsApp's
   * send-side `File`: outbound media rides the send; inbound media lives on
   * the `attachments` edge). The projection keeps the field on the write
   * shape but drops it from the readable position, so a read is caught at
   * check time (MOV_WRITE_ONLY_PROPERTY) instead of silently yielding null.
   */
  readable: z.boolean().optional(),
  required: z.boolean(),
  /**
   * Where this writable field lands at the adapter's write boundary.
   * Optional; omitted means node-anchored (the universal case for
   * external adapters and most KG fields).
   *
   * KG edge-property fields set `{ kind: 'edge', edgeTypeId, side }`
   * so the write path can route the value to `property.edge_id`
   * rather than `property.node_id`. Authors write field mappings
   * against edge fields the same way as node fields — the marker is
   * an internal write-routing concern, not an authoring distinction.
   */
  anchor: fieldAnchorSchema.optional(),
  /**
   * Field arity. Mirrors `SchemaReferenceDescriptor.cardinality` so fields
   * and references share one mental model for "many of X". When omitted,
   * defaults to 'one'. For 'many':
   *   - reads via `getFieldValue` return an array of `kind`-typed values.
   *   - writes via `createRecord`/`updateRecord` receive an array.
   *   - `compare.eq`/`neq` between two multi values is set-equality;
   *     `compare.in` is any-of (membership).
   *   - when a multi value flows into a scalar destination, the engine
   *     joins it with ', ' at the write boundary. Scalar → multi wraps
   *     in a one-element array.
   *
   * Only `string` multi is supported on the KG side today (via
   * `property.value_text_array`); other kinds will become supported when
   * the KG schema gains the corresponding array columns.
   */
  cardinality: z.enum(['one', 'many']).optional(),
  /** Optional UI rendering hint — see `schemaFieldUiHintSchema`. */
  uiHint: schemaFieldUiHintSchema.optional(),
  /**
   * Whether the editor should render this field on root actions only
   * (some adapter-config fields, like an Attio Note's contentPrompt,
   * make sense on a child action; others, like a Connection select,
   * only make sense at the root). Mirrors v3's
   * `FieldDefinition.hideForRootNode` / `hideForChildNode`.
   */
  hideOn: z.enum(['root', 'child']).optional(),
  /**
   * Optional placeholder + description, surfaced inline by the editor.
   * Replaces v3's `FieldDefinition.placeholder` / `description`.
   */
  placeholder: z.string().optional(),
  description: z.string().optional(),
  /**
   * Adapter-provided expression functions available *only* when mapping this
   * field — e.g. Slack advertises `SLACK_MESSAGE` on its message `text`
   * fields. Authors call them like any function (`SLACK_MESSAGE("…", …data)`);
   * outside these fields the name is simply unknown. The bodies live on the
   * adapter (`invokeFieldFunction`). See `fieldFunctionDescriptorSchema`.
   *
   */
  functions: z.array(fieldFunctionDescriptorSchema).optional(),
  /**
   * What the movement language may ask of THIS field — the operators the source
   * can filter it by server-side, and whether it can order by it (chunk 4).
   * Used by the checker (combined with the edge's push mode) to gate and
   * suggest WHERE / ORDER BY. Absent ⇒ unknown ⇒ silent best-effort. Relevant
   * to `native` edges; a `bounded` edge filters any field via the shared unit.
   */
  capability: fieldCapabilitySchema.optional(),
});

export type SchemaFieldDescriptor = z.infer<typeof schemaFieldDescriptorSchema>;

export const schemaReferenceDescriptorSchema = z.object({
  fieldId: z.string(),
  targetTypeId: z.string(),
  /**
   * The FULL set of types this ONE edge can land on, when it can land on more
   * than one — an Attio record-reference attribute allowed on both People and
   * Companies. The movement projection turns it into a real union: a
   * `polymorphic` edge whose target is a union of these types, narrowed by an
   * `IS` test, with linked writes still demanding an explicit type.
   *
   * ADDITIVE and OPTIONAL: absent means the reference lands on exactly one
   * type and `targetTypeId` is the whole fact, which is what every adapter
   * (and every remote-adapter manifest already on the wire) says today.
   *
   * Two rules keep the two fields from becoming two facts:
   *
   *   - at least two members — a one-member set is a single-target reference,
   *     so PRESENCE alone is the polymorphism fact and no consumer has to
   *     re-derive it by counting;
   *   - `targetTypeId` must be one of them — a consumer that reads only the
   *     single field is then narrower than the truth but never WRONG about it,
   *     which is the difference between under-reporting and lying.
   */
  targetTypeIds: z.array(z.string()).optional(),
  cardinality: z.enum(['one', 'many']),
  /**
   * The declaring type cannot exist without this edge — a required
   * FK/reference field IS a required edge (the movement language's
   * projection rule). Set from what the adapter honestly exposes: Attio's
   * per-attribute `is_required` on record-reference attributes; KG
   * scoping edges (`edge_type.scopes`) on the scoped type's incoming
   * reference. Absent when the system declares nothing (not proof the
   * edge is optional).
   */
  required: z.boolean().optional(),
  /** Direction the reference walks at runtime. Defaults to `'outgoing'`
   *  — the universal case. KG-source adapters that surface incoming
   *  edges (so the editor can offer `Companies ← employs ← People`)
   *  set this to `'incoming'`. */
  direction: z.enum(['outgoing', 'incoming']).optional(),
  /** Display name for the reference — used by formula serialization and
   *  the edge picker. When omitted, `fieldId` is the display name.
   *  KG bidirectional edges set this to `outbound_name` (when
   *  `direction === 'outgoing'`) or `inbound_name` (when incoming);
   *  external adapter references usually leave it unset so `fieldId`
   *  doubles as the name. */
  name: z.string().optional(),
  /** Optional human description of the edge, surfaced by the editor's
   *  caret hints. Adapters MAY supply one; KG edges carry the ontology's
   *  `description`. Omitted when there's nothing to say. */
  description: z.string().optional(),
  /** Property descriptors for the EDGE itself (not the destination
   *  node). KG edges can carry properties (e.g. `since: date`,
   *  `weight: number`); adapter references usually don't. Used by the
   *  editor's `edge.X` autocomplete inside `-[:Edge WHERE …]->`
   *  clauses, and by the engine when evaluating `edge_property`
   *  expressions during traversal. */
  edgeFields: z.array(schemaFieldDescriptorSchema).optional(),
  /**
   * Field ids on the *reference holder's* record that back this edge —
   * the fields the engine watches to decide whether a change event could
   * have affected this edge. Used by event-mode execution to prune
   * traversals:
   *
   *
   * Examples:
   *
   *   - Attio Person's `parent_object` reference → `backingFields: ['parent_object']`
   *   - Attio Deal's `associated_people` relation → `backingFields: ['associated_people']`
   *   - KG ontology edges → `backingFields: undefined` (KG mutations
   *     identify edge changes by edge id, not field id)
   *
   * Presence/absence carries FK-ownership semantics: a side whose
   * reference has no backing fields cannot have caused this edge to
   * change from a webhook on that side. Both sides of a many-to-many
   * may each carry their own backingFields.
   *
   * Optional. When undefined, the engine treats every change to the
   * reference holder as potentially affecting the edge (safe default,
   * no pruning).
   */
  backingFields: z.array(z.string()).optional(),
  /**
   * What the movement language may ask of THIS relationship — filter/order/
   * limit, answered live by the adapter (chunk 4). Absent ⇒ unknown ⇒ gating
   * degrades to silent best-effort, exactly like schema today. The adapter
   * declares a field filterable whether it pushes the predicate natively or
   * runs the shared filter unit over a bounded result; the consumer only needs
   * to know the adapter has committed to satisfying it.
   */
  capability: edgeCapabilitySchema.optional(),
  /**
   * Whether walking this edge hands back its members in an INHERENT order,
   * and what that order is. Absent ⇒ unordered — the safe default.
   *
   * Distinct from `capability.order`, which is about PUSHDOWN ("an authored
   * ORDER BY reaches the source"). An edge can be sequenced without being
   * order-pushable (Slack channel messages) and order-pushable without being
   * sequenced (an Attio company's people). Consumers must not read one as the
   * other.
   *
   * The declaration rule for adapter authors: set this only when the fetch
   * path ACTUALLY returns that order today — an explicit sort, a SQL ORDER BY,
   * or a provider call documented to return ordered results. Never because the
   * domain sounds ordered. Under-declaring costs an author an explicit ORDER
   * BY; over-declaring silently blesses a fold over an arbitrary sequence.
   *
   * Meaningless on a single-valued (`cardinality: 'one'`) reference — leave it
   * absent there.
   *
   */
  sequenced: edgeSequencingSchema.optional(),
  /**
   * Whether TRAVERSING this edge reads anything. Absent ⇒ true. Set
   * `readable: false` on a WRITE-ONLY edge — one that exists purely as a
   * create path with no read API behind it (WhatsApp's `replies` /
   * `reactions` / `typing`, Telegram's `replies`): traversal would silently
   * yield nothing, so the checker rejects the read instead
   * (MOV_WRITE_ONLY_EDGE). Writes along the edge are untouched.
   */
  readable: z.boolean().optional(),
  /**
   * Whether this edge DELIVERS its target rather than letting you fetch it —
   * the third edge promise beside `readable` and `writable`, and the one a
   * listen subscribes to. Absent ⇒ this edge is not an event edge.
   *
   * It lives HERE, on the edge, because that is where the fact is true: an
   * event is reached by being pushed along one specific edge from the root,
   * never by enumerating anything. The node-level `SchemaEntryPoint.fires`
   * says the same thing one level away from where it applies, and where the
   * two disagree the edge is right — the node flag is a claim, the edge is
   * the path.
   *
   */
  fires: z.boolean().optional(),
  /** The `events:` values this edge delivers, when it delivers several kinds
   *  (the node-level `firesOn`, stated where it applies). */
  firesOn: z.array(z.string()).optional(),
  /**
   * This edge leads from an EVENT node to the record the event is ABOUT — the
   * one hop that turns "a change happened" into "here is the thing that
   * changed". Declared on `Record Change`'s `Record` reference by every
   * adapter whose events arrive as a node (kg, airtable).
   *
   * DECLARED, never inferred. A checker that recognised the edge by its name
   * would be parsing a magic string — `'Record'` is a display name an adapter
   * is free to spell differently, and the moment one does, the inference is
   * wrong rather than absent. The flag is only ever COMPARED.
   *
   * What consumes it: a listen's `fields:` filter names properties of the
   * RECORD, not of the event node, so the checker validates those names one
   * hop along this edge. An event surface that declares no subject edge keeps
   * the older reading (the names belong to the landed position itself), which
   * is right for an adapter whose listen fires the record directly.
   *
   */
  subject: z.boolean().optional(),
  /**
   * THE write promise for this edge, and it must be EXPLICIT.
   * **Absent ⇒ READ-ONLY** — no write promise at all. `true` ⇒ a movement may
   * write along this edge (a linked write: create the target, or link an
   * existing one).
   *
   * An absent flag must never become an affirmative claim, so there is no
   * default-true here and no second flag: `writable` CONSUMED the retired
   * `creatable`, which is why `true` is what gates a linked write
   * (`createShapes` / `writableEdgesOf`) rather than a separate fact.
   *
   * The two halves of that promise are separable, and `linkable` is where an
   * adapter withdraws the second one.
   *
   */
  writable: z.boolean().optional(),
  /**
   * Whether two records that ALREADY EXIST can be joined along this edge —
   * `link a -[:e]-> b` and its inverse `unlink`.
   *
   * **Absent ⇒ the `writable` promise covers link too**, which is what that
   * promise has always said: "a linked write may create the target along this
   * edge, or link an existing one". `false` WITHDRAWS the second half, and the
   * checker refuses `link`/`unlink` along the edge, naming it.
   *
   * The distinction was parked on the reading that an edge which can only LINK
   * over-promises create. The live case is the mirror: Affinity's list
   * membership is made by adding a company to a list — there is no way to point
   * an entry that already exists at a different list — so `write
   * co-[:List Entries]-> { … }` is real and `link co -[:List Entries]-> entry`
   * can only fail at run time. An edge that promises what it cannot do is worth
   * saying at check time, and only the adapter can say it.
   *
   * Meaningless without `writable: true` — a read-only edge is already refused.
   */
  linkable: z.boolean().optional(),
  /** Writing along this edge performs an ACTION, not a record write —
   *  nothing materialises, nothing reads back (WhatsApp typing). Only
   *  meaningful with `writable: true`. */
  ephemeral: z.boolean().optional(),
  /** This edge resolves a LIVE record (a fetch by id) — so it is present only
   *  on event variants whose action leaves a record to fetch (create/update),
   *  and excluded from the `delete` variant. Default false. */
  requiresLiveRecord: z.boolean().optional(),
  /**
   * The AWAITABLE capability (asks-as-adapter, layer 3A). An awaitable edge
   * supports `await x-[:E]->` (`untilNonEmpty`): a resolution lands along it
   * and resumes a parked run. Bare traversal of an awaitable edge is a type
   * error (F2) — you await it, you don't read it.
   *
   * DECLARATION ONLY in chunk A: the flag rides the descriptor so the graph is
   * promise-honest and a later chunk (the awaitable ENGINE support) has the
   * fact to key off. Nothing consumes it yet. The ask `Response` edge is the
   * first declarant.
   *
   */
  awaitable: z.boolean().optional(),
  /**
   * Whether a resolution along this awaitable edge may carry NO landing (F20) —
   * so `T | absent` appears downstream. True for ask `Response` (an explicit
   * cancel resolves current awaiters EMPTY); false/absent for an edge whose
   * resolution always carries content (Slack `Replies`). Meaningful only with
   * `awaitable: true`. Declaration-only in chunk A (see `awaitable`).
   */
  resolvesEmpty: z.boolean().optional(),
  /**
   * Whether the platform DELIVERS an event when this edge resolves, so a run
   * parked on it is woken rather than looked at on a timer. Declare it only
   * where that delivery exists today: Slack `Replies` (an inbound webhook
   * resumes the park), ask `Response` (answering resumes the run).
   *
   * **Absent ⇒ no push.** An `await FIRST(…)` on such an edge is refused and
   * the author is pointed at the cadence form (`await until(…, every: …)`) —
   * a park nothing wakes is a run that never finishes, so silence here has to
   * mean the safe thing rather than the convenient one.
   *
   * Sibling of `awaitable`, and separate from it on purpose: WHETHER an edge
   * resolves and WHETHER anyone is told are two facts, and an adapter can gain
   * the second long after it declared the first.
   *
   */
  watchable: z.boolean().optional(),
  /**
   * This edge's LANDING TYPE is generic over the CONSTRUCTION SITE: the literal
   * value(s) a write body gives `field` fix what the landing looks like. The
   * ask `Response` is the first declarant — `Choose`'s answer is an enum of the
   * very `Options` that ask offered, `Provide`'s is the scalar its `Answer
   * Type` names.
   *
   * DECLARATIVE, exactly like `discriminatedWrite`: the adapter says WHICH body
   * field parameterizes the landing, so no checker ever has to know a field by
   * name. What the literals MEAN stays with the adapter (`askResponseDescriptorFor`);
   * the host resolves each write it can see and grafts the synthesized position,
   * and the checker only looks it up. A non-literal value is the "computed at
   * run time" case, and `onNonLiteral` says what that costs: `'error'` mirrors a
   * precondition `createRecord` already enforces (a computed `Answer Type` fails
   * live either way); `'warn'` is a write that runs but loses its typed landing
   * (a `Form` over computed `Fields` answers one opaque value rather than a
   * property per name); absent lands the base type silently, which is honest
   * only where nothing was promised.
   *
   * `field` names the WRITE-BODY field (the descriptor's `displayName`, which is
   * what an author types), not the internal `fieldId`.
   *
   */
  genericOver: z
    .object({ field: z.string(), onNonLiteral: z.enum(['error', 'warn']).optional() })
    .optional(),
}).superRefine((reference, ctx) => {
  if (reference.targetTypeIds === undefined) return;
  const members = [...new Set(reference.targetTypeIds)];
  if (members.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetTypeIds'],
      message:
        'a target set names at least two distinct types — one type is an ordinary single-target reference, declared by targetTypeId alone',
    });
  }
  if (!members.includes(reference.targetTypeId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetTypeIds'],
      message: `the target set must contain targetTypeId ('${reference.targetTypeId}') — it is the member every consumer that reads only the single field will name`,
    });
  }
});

export type SchemaReferenceDescriptor = z.infer<typeof schemaReferenceDescriptorSchema>;

/**
 * THE landing set of a reference — one entry for a single-target reference,
 * several for a polymorphic one, de-duplicated and in declaration order.
 *
 * One derivation, so no consumer has to remember that the single field and the
 * set are the same fact spelled two ways.
 */
export function referenceTargetTypeIds(
  reference: Pick<SchemaReferenceDescriptor, 'targetTypeId' | 'targetTypeIds'>,
): string[] {
  return reference.targetTypeIds === undefined
    ? [reference.targetTypeId]
    : [...new Set(reference.targetTypeIds)];
}

export const schemaTypeDescriptorSchema = z.object({
  typeId: z.string(),
  displayName: z.string(),
  /** Optional human description of the node type, surfaced by the editor's
   *  caret hints. Adapters MAY supply one; KG types carry the ontology's
   *  `description`. Omitted when the adapter has nothing to say. */
  description: z.string().optional(),
  /**
   * Adapter-internal id for this type, when it differs from `typeId`.
   * Filter literals at runtime compare against this value (e.g. an Attio
   * webhook payload's `id.object_id` is the object UUID). The editor
   * uses this to populate enum completions for discriminator fields
   * while displaying friendly names. Adapters with synthetic types
   * (knowledge-graph) can leave it undefined.
   */
  externalId: z.string().optional(),
  /**
   * Optional label format for action nodes targeting this type. Used
   * by the canvas / RHS panel to show a per-instance name beyond the
   * type's display name (e.g. List Entry actions show "List Entry —
   * Hot Leads" by interpolating against `adapterConfig`).
   *
   * Syntax: `{key}` placeholders against the action's `adapterConfig`.
   * Unresolved placeholders fall back to the raw value. When omitted,
   * the editor uses `displayName` alone — the right answer for
   * per-object types like `attio:companies` whose typeId already
   * encodes the instance.
   */
  labelTemplate: z.string().optional(),
  /**
   * How an action of this type is configured. Most types are
   * `self-configured` — the action's own `adapterConfig` carries the
   * identifiers needed to write it. Some attached types (Notes,
   * Tasks, Comments) are `inherits-parent-config` — they pick up
   * identifiers (parent record id, etc.) from the enclosing parent
   * action at runtime. Editor uses this to decide which adapterConfig
   * surface a field-mapping read against.
   *
   * Replaces the v3-derived `selfConfigTypes` hardcode in the editor.
   * Default: `self-configured`.
   */
  scope: z.enum(['self-configured', 'inherits-parent-config']).optional(),
  /**
   * When true, the type's `fields` are NOT populated in the descriptor
   * payload — callers fetch them on demand via `Adapter.describeType`
   * (and the matching `getTypeDetails` tRPC endpoint). Used for types
   * whose attribute set is per-instance and expensive to fetch
   * upfront — e.g. Attio per-list synthetic types whose entry
   * attributes vary list-by-list. References still appear inline so
   * the picker / canvas can render the type's edges without the extra
   * round-trip.
   *
   * Default: false (fields are inline in the descriptor).
   */
  lazyFields: z.boolean().optional(),
  fields: z.array(schemaFieldDescriptorSchema),
  references: z.array(schemaReferenceDescriptorSchema),
  /**
   * Native uniqueness rules the target system itself treats as
   * identifying (e.g. KG `node_type.uniqueness_constraints`, Attio
   * `is_unique` attributes). The engine unions these with any
   * author-defined TG-level constraints on the action node before
   * driving entity resolution. Optional — adapters with no native
   * identity model leave it unset (treated as []).
   */
  uniquenessConstraints: uniquenessConstraintsSchema.optional(),
  /**
   * Whether this adapter resolves identity by SIMILARITY (not just
   * equality) when a uniqueness component is marked fuzzy — the KG's
   * pg_trgm search, Attio's `$contains`. Surfaces close candidates for
   * the engine to arbitrate. Gates the movement-language `FUZZY`
   * modifier: an author may only mark a `unique by` component fuzzy
   * where the target honestly supports it. Default unset/false ⇒
   * exact-only, FUZZY rejected at author time. `true` ⇒ every field; a list
   * of field ids ⇒ only those (Valuations: the names its search covers).
   */
  supportsFuzzyResolution: z.union([z.boolean(), z.array(z.string()).nonempty()]).optional(),
  /**
   * Whether a movement may author `unique by` on this type. Default
   * (unset) ⇒ yes. `false` ⇒ the adapter decides record identity itself
   * and does not accept author-defined uniqueness — its native matching
   * IS the identity model and a movement can't meaningfully configure it
   * (Affinity: org by domain/name, person by email, with a
   * workspace-vs-global nuance the engine can't express). The checker
   * rejects `unique by` on such a type instead of silently ignoring it.
   */
  uniquenessAuthorable: z.boolean().optional(),
  /**
   * Whether a record of this type can be DELETED through the adapter's
   * `deleteRecord` — a promise per type, like a field's `writable`. Default
   * (unset) ⇒ no: an adapter declares it on exactly the types its
   * `deleteRecord` removes (Attio objects, but not its notes; Evertrace
   * searches, lists and list entries, but not its signals). Since language
   * version 5 the checker refuses `delete x` where `x`'s type does not
   * declare it; versions 1–4 leave it to the run, which fails where the
   * adapter refuses.
   */
  deletable: z.boolean().optional(),
  /**
   * This type's write body is a DISCRIMINATED UNION: the LITERAL value of one
   * required field (`discriminant`) selects which variant of the write shape
   * applies (the write-side dual of read narrowing — a create NAMES its
   * target). `variantTypes` maps each discriminant literal to the NAME
   * (`displayName`) of the type whose write shape is that variant — for Attio
   * lists, each list name maps to its own per-list type. The host projection
   * composes each variant by merging the named variant type's write shape onto
   * this type's own (so the discriminant field + common fields ride every
   * variant), and emits a `discriminated` block on the resulting
   * `WritableRootSchema` for the checker.
   *
   * The discriminant field itself must appear in `fields` as a REQUIRED enum
   * (a typo is `MOV_ENUM_UNKNOWN_VALUE`, a missing value the required-field
   * error). Keep its `enumValues` and `variantTypes` keys drawn from the SAME
   * source, or a literal could enum-check-pass but variant-select-fail.
   *
   */
  discriminatedWrite: z
    .object({
      discriminant: z.string(),
      variantTypes: z.record(z.string(), z.string()),
    })
    .optional(),
  /**
   * This type's writable surface is an UNTAGGED union of write shapes: a write
   * body must be assignable to at least one `variant`. What TypeScript would
   * model as `{ Message?: string; File?: File } | { Message?: string; Blocks?:
   * Json }` — a Slack message is a file post OR an interactive post, and no
   * discriminant field selects between them, because inventing one would be
   * nominal typing smuggled into a structural union.
   *
   * `fields` are field IDS (`SchemaFieldDescriptor.fieldId`), not display
   * names — the descriptor speaks its own identifiers and the projection maps
   * them onto the surface names the checker sees.
   *
   * Two schema rules keep a variant list from lying about the surface:
   *
   *   - at least TWO variants — one variant is not a union, it is the shape,
   *     and every field of it would then simply be writable;
   *   - EVERY writable field appears in at least one variant — a field left out
   *     of every variant would be advertised as writable and then rejected by
   *     the union check, which is a silent orphan rather than a type.
   *
   * MUTUALLY EXCLUSIVE with `discriminatedWrite`: one says a literal SELECTS
   * the shape, the other says the shape is inferred from what the body sets.
   * Composed, the semantics would be undefined (which layer decides the
   * variant?), so declaring both is a loud schema error.
   *
   * SCOPE: subset-of-a-variant only. No per-variant requiredness (requiredness
   * stays orthogonal — `SchemaFieldDescriptor.required` means the same thing it
   * always did) and no narrowing consequences.
   *
   */
  writeUnion: z
    .object({
      variants: z
        .array(
          z.object({
            /** Author-facing name of this write shape — "a file post". It is
             *  COMPARED by nobody and PARSED by nobody; it exists so the
             *  checker's error can name the shapes an author must choose
             *  between. */
            name: z.string(),
            /** Field IDS this shape accepts. */
            fields: z.array(z.string()).min(1),
          }),
        )
        .min(2),
    })
    .optional(),
}).superRefine((type, ctx) => {
  const union = type.writeUnion;
  if (union === undefined) return;
  if (type.discriminatedWrite !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['writeUnion'],
      message:
        "writeUnion and discriminatedWrite can't both be declared on one type — a discriminated write selects its shape from a literal, an untagged union infers it from the body, and composed there is no answer to which one decides the variant",
    });
  }
  const writableIds = new Set(type.fields.filter((f) => f.writable).map((f) => f.fieldId));
  const names = new Set<string>();
  for (const [index, variant] of union.variants.entries()) {
    if (names.has(variant.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writeUnion', 'variants', index, 'name'],
        message: `two write variants are both named '${variant.name}' — the name is what the checker's error offers an author to choose between, so it has to tell them apart`,
      });
    }
    names.add(variant.name);
    for (const fieldId of variant.fields) {
      if (writableIds.has(fieldId)) continue;
      const known = type.fields.find((f) => f.fieldId === fieldId);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writeUnion', 'variants', index, 'fields'],
        message:
          known === undefined
            ? `write variant '${variant.name}' names field '${fieldId}', which this type does not declare`
            : `write variant '${variant.name}' names field '${fieldId}', which is not writable — a write shape can only be made of fields a write can set`,
      });
    }
  }
  const claimed = new Set(union.variants.flatMap((v) => v.fields));
  for (const fieldId of writableIds) {
    if (claimed.has(fieldId)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['writeUnion'],
      message: `writable field '${fieldId}' appears in no write variant — the union would advertise it as writable and then reject every body that sets it. Add it to the variants it belongs to (or drop its writable flag)`,
    });
  }
});

export type SchemaTypeDescriptor = z.infer<typeof schemaTypeDescriptorSchema>;

export const schemaDescriptorSchema = z.object({
  adapterType: z.string(),
  types: z.array(schemaTypeDescriptorSchema),
});

export type SchemaDescriptor = z.infer<typeof schemaDescriptorSchema>;

/**
 * Lightweight entry-point descriptor — what the editor's "Add action"
 * picker shows in root mode. Just enough to pick a starting type;
 * full fields/references come from `describe(typeId)` once the user
 * has selected one. Adapters publish entry points cheaply (no
 * per-type API calls) so the picker is responsive.
 */
export const schemaEntryPointSchema = z.object({
  typeId: z.string(),
  displayName: z.string(),
  /** Optional human description of the node type — same semantics as on
   *  `schemaTypeDescriptorSchema`. Surfaced by the editor's caret hints. */
  description: z.string().optional(),
  /** Adapter-internal id when distinct from typeId (e.g. an Attio
   *  object UUID for `id.object_id` enum completions). */
  externalId: z.string().optional(),
  /** Self-configured vs inherits-parent-config — same semantics as
   *  on `SchemaTypeDescriptor`. Drives editor surface choices. */
  scope: z.enum(['self-configured', 'inherits-parent-config']).optional(),
  /** Per-instance label template (when the type's display name needs
   *  parameterising against `adapterConfig`). */
  labelTemplate: z.string().optional(),
  /** Whether an action can WRITE this type (creates a record). The
   *  picker uses this to filter "Add action" options to writable
   *  entry points only. Most types are writable; webhook-event /
   *  read-only meta types are not. */
  writable: z.boolean(),
  /** Whether the source-side picker should offer this type as a
   *  starting point for reads / traversals. Symmetric counterpart to
   *  `writable`: a write-only target adapter publishes its entries
   *  with `readable: false` so the source picker filters them out
   *  before the engine ever calls `getFieldValue` against them. */
  readable: z.boolean(),
  /**
   * The NATURAL name of the meta-root COLLECTION edge that fans out to
   * records of this type — the edge an author writes after the constructed
   * instance (`granola-[m:meetings]-> …`). Defaults to the type's own
   * `displayName` (the common case: one entry point ⇒ one same-named
   * collection). Declare it only to give the collection a name distinct
   * from the position type — e.g. Granola's `Meeting Note` records are
   * pulled through a `meetings` collection so a movement traverses past
   * meetings without renaming the record type the poll source also fires.
   * The projection (`instanceSchemaFromDescriptors`) keys `collections`
   * by this; the adapter's `getRelated(meta, <collectionName>)` resolves it.
   */
  collectionName: z.string().optional(),
  /** This entry is an EVENT EDGE: a `listen` delivers its node; a movement can
   *  never traverse it. `fires` is the edge's whole promise — the third edge
   *  promise beside `readable` and `writable`, spelled the same way (an edge
   *  property on the entry) for consistency with them. The event is JUST A
   *  NODE: the projection synthesizes nothing from this marker — no variants,
   *  no union, no name map. Where the adapter has a change-kind axis it is an
   *  ordinary enum field on the event node (`action`, options = the listen's
   *  `events:` vocabulary — ONE namespace), narrowed in the address
   *  (`` WHERE `action` == "record.created" ``).
   *
   *  Independent of `readable`: nobody enumerates an inbox, so an event entry
   *  is normally `readable: false, writable: false, fires: true` — and it
   *  mints a position but never a root collection. */
  fires: z.boolean().optional(),
  /** The `events:` config values delivered along this event edge — a subset of
   *  the manifest's `subscribableEvents`, for adapters whose vocabulary spans
   *  several event edges (Slack's `app_mention`/`message` land on `Message
   *  Received`; `reaction_added` does not). Meaningful only with `fires`.
   *  Absent ⇒ every subscribable event (or the adapter has no vocabulary). */
  firesOn: z.array(z.string()).optional(),
});

export type SchemaEntryPoint = z.infer<typeof schemaEntryPointSchema>;

// ── Position: a typed node in the source graph ─────────────────────────────
// A position is a node with a type (null/abstract until narrowed) carrying
// EITHER a stable external identity OR its data inline. The seven-kind
// `SourcePosition` union it replaces conflated three orthogonal facts
// (identity stability, type knownness, provenance) into one discriminator
// and forced every adapter to repeat a dual-kind read guard. Edges are
// first-class and handled separately (RelatedResult.edgeId / parentLink
// today; `arrivalEdge` in landing B).
//
// landing A

// `PositionIdentity`, `Position`, `SourcePosition` and `EphemeralOriginRef`
// are the contract's (`engine-contracts`).
export type { EphemeralOriginRef, Position, PositionIdentity, SourcePosition };


/** A position materialised by an `#extract` / `#transform` step. Carries
 *  per-field provenance keyed by the ephemeral's `data` field name — the
 *  extraction quote that justified each value — so it travels with the value
 *  to the write (3b §3.3/§3.4) rather than via a post-write evidence pass. */
export type EphemeralNode = Position & {
  originRef: EphemeralOriginRef;
  evidence?: Record<string, FieldEvidence>;
  /** Source material the bundle that produced this node was extracted from
   *  (`4d_resources.md`). The whole record derives from these resources, so
   *  they are node-level provenance — seeded onto the action's `ResourceSink`
   *  at `buildActionPlan` and persisted via `WriteInput.resources`. Stamped by
   *  `rebind` from `bundle.resources`. */
  resources?: Resource[];
};

/** True when the position was produced by an extraction/transform step. */
export function isEphemeralPosition(p: Position): p is EphemeralNode {
  return p.originRef !== undefined;
}

// ── Position constructors ──────────────────────────────────────────────────
// Route all position construction through these so the stable/unstable
// shape and the meta convention live in one place (and the adapter
// conversions become mechanical). See 4_implementation.md.

/** A stable external record: durable `recordId`, optional materialised `data`. */
export function makeStablePosition(input: {
  adapterType: string;
  recordType: string | null;
  recordId: string;
  data?: unknown;
}): Position {
  return {
    adapterType: input.adapterType,
    recordType: input.recordType,
    identity: { kind: 'stable', recordId: input.recordId, data: input.data },
  };
}

/** An unstable node: content carried inline. Inbound payloads, etc. */
export function makeUnstablePosition(input: {
  adapterType: string;
  recordType: string | null;
  data: unknown;
}): Position {
  return {
    adapterType: input.adapterType,
    recordType: input.recordType,
    identity: { kind: 'unstable', data: input.data },
  };
}

/** The schema root of an adapter — `recordType: 'meta'`, no data. */
export const META_RECORD_TYPE = 'meta';
export function makeMetaPosition(adapterType: string): Position {
  return {
    adapterType,
    recordType: META_RECORD_TYPE,
    identity: { kind: 'unstable', data: undefined },
  };
}

/**
 * A synthetic node produced by an `#extract` / `#transform` step. Synthetic
 * source-side nodes use the `'synthetic'` adapterType sentinel (they aren't
 * served by a real adapter; the evaluator reads their inline data directly).
 */
export const SYNTHETIC_ADAPTER_TYPE = 'synthetic';
export function makeEphemeralPosition(input: {
  adapterType?: string;
  recordType?: string | null;
  data: unknown;
  originRef: EphemeralOriginRef;
  evidence?: Record<string, FieldEvidence>;
  resources?: Resource[];
}): EphemeralNode {
  return {
    adapterType: input.adapterType ?? SYNTHETIC_ADAPTER_TYPE,
    recordType: input.recordType ?? null,
    identity: { kind: 'unstable', data: input.data },
    originRef: input.originRef,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.resources && input.resources.length > 0
      ? { resources: input.resources }
      : {}),
  };
}

// ── Position readers ───────────────────────────────────────────────────────

/**
 * The node's data payload. Both a stable position's materialised cache and
 * an unstable position's inline content live here, so adapters that used to
 * read `position.data` across the `external-record`/`webhook-event` dual
 * guard now read uniformly. Undefined for a stable position the adapter
 * must materialise (and for the `meta` root).
 */
export function positionData(p: Position): unknown {
  return p.identity.data;
}

/**
 * The label a position's minted data names it by — the value an author types
 * to pick this member (Airtable's `{ Name }`, Sheets' `{ Title }`). ONE
 * convention for every member-labelling surface: the `positionArgs` value
 * enums and the walk's polymorphic-edge members both read through here, so an
 * adapter labels a member once and cannot disagree with itself. Prefers a
 * Title/Name field, else the first string value.
 */
export function positionLabel(p: Position): string | undefined {
  return positionLabelEntry(p)?.value;
}

/**
 * The label WITH the key it came from — for the caller that must state the
 * narrowing rather than just show the name (`Base WHERE \`Name\` == "CRM"`).
 *
 * It lives beside `positionLabel` because the two must never disagree about
 * which field named a member: a walk that displays `CRM` and an address that
 * narrows on a different key would send an author to a member they did not
 * pick. One convention, one place.
 */
export function positionLabelEntry(p: Position): { key: string; value: string } | undefined {
  const data = positionData(p);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const rec = data as Record<string, unknown>;
  for (const key of ['Title', 'Name', 'name', 'title']) {
    const v = rec[key];
    if (typeof v === 'string' && v) return { key, value: v };
  }
  for (const [key, v] of Object.entries(rec)) {
    if (typeof v === 'string' && v) return { key, value: v };
  }
  return undefined;
}

/** A stable position's durable external identity, else undefined. */
export function positionRecordId(p: Position): string | undefined {
  return p.identity.kind === 'stable' ? p.identity.recordId : undefined;
}

/** True for a stable external record (has a durable `recordId`). */
export function isStablePosition(p: Position): boolean {
  return p.identity.kind === 'stable';
}

// ── TransformSignature ─────────────────────────────────────────────────────
// Declared by each transform plugin (F4 registry stores them, R7 ports
// the existing plugins, R1 evaluator dispatches `#transform` through them).
//
// A transform augments the source graph with the nodes / edges /
// properties it declares in `additions`. After the transform runs, those
// new structures are accessible via regular traversal — see
// `../../expression_syntax.md` "Transforms add ephemeral nodes to the
// source graph".
//
// `dataDependency` separates two timings:
//   - `'none'`: the transform can run before extraction (it depends only
//     on the source node it was attached to).
//   - `'extracted_context'`: the transform needs the extracted context
//     from an ancestral `#extract` and must run after that extraction.
// The engine uses this to schedule transforms in the right phase.

export const transformDataDependencySchema = z.enum(['none', 'extracted_context']);
export type TransformDataDependency = z.infer<typeof transformDataDependencySchema>;

/** Declared shape of a transform's parameter (the values the author writes
 *  in the `config:` object of `-[urls:#transform { plugin, config: {…} }]->`).
 *  Optional `required` covers the common case; everything else lives in the
 *  transform's free-form `description`. */
export const transformParamSchema = z.object({
  name: z.string().min(1),
  type: expressionTypeSchema,
  required: z.boolean().optional(),
  description: z.string().optional(),
  /**
   * Engine-injected, NOT author-supplied: the engine fills this parameter
   * automatically from the extract source content (the `from [...]` the
   * transform runs over). It is excluded from the plugin's author-facing
   * argument list — the validator rejects passing it, autocomplete/hints don't
   * offer it, and the docs don't list it. `vc_url_retrieval`'s `content` is the
   * canonical case: `through [vc_url_retrieval]`, no argument.
   */
  auto: z.boolean().optional(),
});

export type TransformParam = z.infer<typeof transformParamSchema>;

/** What the transform contributes to the source graph at runtime. Each
 *  collection is a *declaration* (the schema of what gets added); the
 *  actual values are produced by the transform's `run` method (F4). */
export const transformAdditionsSchema = z.object({
  /** Properties added directly to the source node the transform was
   *  attached to. Keyed by property name → value type. */
  properties: z.record(z.string(), expressionTypeSchema).optional(),
  /** Outgoing edges added to the source node, keyed by edge name. Edge
   *  destinations are described as ExpressionTypes (typically `record`
   *  or `list<record>`) — same vocabulary as `GenericShape.edges`. */
  edges: z.record(z.string(), genericEdgeSchema).optional(),
  /** Free-standing ephemeral nodes emitted by the transform that are not
   *  attached to the source node via an edge. Rare; most transforms
   *  publish their output as new edges instead. Each entry is the
   *  declared shape of the emitted node. */
  nodes: z.array(expressionTypeSchema).optional(),
});

export type TransformAdditions = z.infer<typeof transformAdditionsSchema>;

/** One thing a plugin's output carries: its value type, and whether the plugin
 *  may leave it unfilled. `ExpressionType` — the vocabulary `additions` and
 *  `params` already speak — says the type; `optional` is the one thing it
 *  cannot say, and it maps onto the checker's `T | absent` exactly. */
export const transformOutputFieldSchema = z.object({
  type: expressionTypeSchema,
  /** The plugin may not fill this — a fetch that failed, a search that found
   *  nothing. Read downstream as `T | absent`, so it has to be discharged
   *  before it can be written anywhere that demands a value. */
  optional: z.boolean().optional(),
  description: z.string().optional(),
});

/**
 * What a PLAIN call to this plugin hands back (`page = fetch_url(url: …)`) —
 * on whichever plane it lives, which is the same two planes every bound value
 * in the language has:
 *
 *   - `value`   — one value, read as itself;
 *   - `record`  — several values read by name (`more.summary`);
 *   - `records` — a list of those, one per thing the plugin found
 *                 (`FIRST(pages).text`). The fields are the same for every
 *                 member, which is what lets one declaration type them all.
 *
 * A `through [ … ]` stage declares `additions` instead, and the two answer
 * different questions: `additions` is what reaches the EXTRACTOR, this is what
 * reaches a NAME. Absent means nobody has said, and the language keeps such a
 * plugin to stages.
 */
const transformOutputKindSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('value'),
    type: expressionTypeSchema,
    optional: z.boolean().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal('record'),
    fields: z.record(z.string(), transformOutputFieldSchema),
  }),
  z.object({
    kind: z.literal('records'),
    fields: z.record(z.string(), transformOutputFieldSchema),
    description: z.string().optional(),
  }),
]);

/**
 * A plugin whose output changed shape keeps its older shapes beside the
 * current one: `previously` lists what a call handed back to a movement pinned
 * before language version `before`, earliest first. A call runs, and is typed,
 * under its movement's pin (`transformOutputUnder`). Removing a language
 * version removes its entries.
 */
export const transformOutputSchema = transformOutputKindSchema.and(
  z.object({
    previously: z
      .array(z.object({ before: z.number().int(), output: transformOutputKindSchema }))
      .optional(),
  }),
);

export type TransformOutputShape = z.infer<typeof transformOutputSchema>;
export type TransformOutputKind = z.infer<typeof transformOutputKindSchema>;

/** What a plain call to a plugin declaring `output` hands back to a movement
 *  pinned to `languageVersion`. */
export function transformOutputUnder(
  output: TransformOutputShape,
  languageVersion: LanguageVersion,
): TransformOutputKind {
  const earlier = output.previously?.find((entry) => before(languageVersion, entry.before));
  return earlier !== undefined ? earlier.output : output;
}

export const transformSignatureSchema = z.object({
  /** Unique transform identifier — the value an author writes in
   *  `-[…:#transform { plugin: "<name>" }]->`. Must be unique across
   *  the framework-global registry. */
  name: z.string().min(1),
  /** Optional human-readable description, surfaced by the editor. */
  description: z.string().optional(),
  /** Declared parameters the author can pass via the `config:` object. */
  params: z.array(transformParamSchema),
  /** Timing dependency — see `TransformDataDependency` above. */
  dataDependency: transformDataDependencySchema,
  /**
   * What running this plugin may do — the DECLARED effect row (the checker
   * infers the same five facts for a movement by walking its body, and cannot
   * walk this one). It sits here, beside `params`, because this is the
   * plugin's surface: the same object an author's arguments are checked
   * against, kept in lockstep with the implementation by the same test.
   *
   * Declare it TRUTHFULLY: `reads` names the sources the plugin fetches from
   * in the words an author would use ("the web"), `ai` says it calls a model.
   * Absent is not "does nothing" — it is nobody having said, and the language
   * keeps such a plugin to `through [ … ]` stages, where the extraction
   * pipeline bounds what it can reach.
   *
   */
  effects: declaredEffectRowSchema.optional(),
  /** What the transform adds to the source graph (properties, edges,
   *  free-standing nodes). The editor uses this to power `data:` /
   *  field-mapping autocomplete after a `#transform` step in the
   *  traversal. */
  additions: transformAdditionsSchema,
  /**
   * What a PLAIN call hands back — see `transformOutputSchema`. Absent is
   * nobody having said, and the language keeps such a plugin to `through [ … ]`
   * stages, where its output goes to the extractor rather than to a name.
   *
   * Declare it TRUTHFULLY, field by field: a plugin that fills `summary` only
   * when it found something declares that field `optional`, and every read of
   * it downstream then has to discharge the absence.
   */
  output: transformOutputSchema.optional(),
});

export type TransformSignature = z.infer<typeof transformSignatureSchema>;

/**
 * Sentinel type id used in `describe(typeId)` to request the adapter's
 * meta-root descriptor — references on the returned descriptor are the
 * collections (entry points) reachable from the meta-position.
 */
export const ADAPTER_META_TYPE_ID = '__adapter_meta__';

// Re-export Expression for downstream modules (engine, evaluator) that operate
// against translation graphs.
export type { Expression };
