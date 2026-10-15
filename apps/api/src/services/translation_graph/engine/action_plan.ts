// ActionPlan — what an action-node evaluation produces before applying.
// Decoupled from the actual write so that:
//   (a) the engine can defer writes for reference-aware ordering (P16),
//   (b) the agent can request a "dry run" that returns plans without
//       applying them.

import type { FieldMappingSemantics } from 'movement-engine/services/translation_graph/types';
import type { MutationContext } from 'movement-engine/services/translation_graph/mutation_context';
import type { UniquenessConstraints } from 'movement-engine/services/translation_graph/uniqueness';
import type { FieldEvidence, Resource } from 'movement-engine/services/translation_graph/adapter';

export interface ActionPlan {
  /** Translation-graph node `id` that produced this plan. */
  nodeId: string;

  /** Adapter that will receive the write. */
  adapterType: string;

  /** Record type (typeId in the target adapter's schema descriptor). */
  recordType: string;

  /** Operation mode. 'assert' = create-or-update; 'read' = lookup; 'delete' = remove. */
  mode: 'assert' | 'read' | 'delete';

  /**
   * Field values to write, keyed by `targetField`. Each carries its
   * write-permission semantics so the apply step can decide overwrite vs.
   * set-if-null vs. merge per field (P7.1).
   */
  fields: Record<string, ActionPlanField>;

  /**
   * Effective uniqueness constraints driving entity resolution — the
   * union of (a) the target adapter's native constraints
   * (`listUniquenessConstraints(recordType)`) and (b) any author-defined
   * `uniquenessConstraints` on the source action node. Computed once at
   * plan-build time so the apply step doesn't need to re-fetch.
   */
  constraints: UniquenessConstraints;

  /**
   * Applicable required target fields (their ids) for this action — required +
   * writable + visible in this root/child context (`required_fields.ts`).
   * Enforced by `applyActionPlan` on the create branch: creating a record that
   * leaves one of these without a value fails loud (`2026-06-08-required-fields`).
   * Empty when the target type has no required fields the author must satisfy.
   */
  requiredFields: string[];

  /**
   * Node-level resource provenance (`4d_resources.md`) — the source material
   * (resources + their facts + provenance) that contributed to *any* field of
   * this record. Accumulated by the per-node `ResourceSink` during field
   * evaluation and forwarded to the adapter as `WriteInput.resources`, which
   * persists / dedupes them on the stable `Resource.id`. Empty when no field
   * read a resource.
   */
  resources: Resource[];

  /** Mutation context attached to writes this plan produces. */
  mutationContext: MutationContext;

  /**
   * Parent context, when this action was authored as a child of
   * another action that has created/matched a record. The apply step
   * forwards this to the adapter's `createRecord` as the lone entry of
   * `WriteInput.parentLinks` (this tree-shaped engine has at most one
   * parent — a linked write is the 1-element case of the general
   * N-parent list) so adapters can wire the parent → child relationship
   * in the target system. Undefined for root actions and for child
   * actions whose authored relationship pre-dates the edge-aware picker
   * (no `edgeName` recorded).
   */
  parentLink?: {
    recordType: string;
    externalId: string;
    edgeName: string;
  };

  /**
   * Edge-valued uniqueness context (compound identity). When an action's
   * uniqueness constraints name an edge `field` (a `describe().references`
   * fieldId) whose neighbour is the already-resolved parent, that neighbour
   * is surfaced here keyed by the same fieldId — `{ <edgeFieldId>: { id } }`.
   * `applyActionPlan` folds it into the resolve record so the adapter matches
   * candidates by adjacency through the same opaque `record[field]` lookup it
   * uses for property fields. Undefined when no edge constraint resolves to a
   * parent neighbour.
   */
  resolveEdgeContext?: Record<string, { id: string }>;
}

export interface ActionPlanField {
  value: unknown;
  semantics: FieldMappingSemantics;
  /** Provenance for this value, when it arrived un-transformed from an
   *  extraction / property read (3b §3.4). Carried onto `WriteInput.evidence`
   *  at apply time; absent for transformed values. */
  evidence?: FieldEvidence;
}

/** Result of applying a plan; surfaced to children for parent_result expressions. */
export interface ActionPlanResult {
  /** Did this plan create a new record (vs. update an existing one)? */
  created: boolean;

  /** External ID assigned/used (for KG targets, this is the node ID). */
  externalId?: string;

  /**
   * Field → value map of what the engine actually sent to the target
   * adapter, after no-op suppression and runWhen filtering. Empty
   * record for delete / read / fully-suppressed updates. Surfaces in
   * tg_run.applied_action_plans for the runs UI to show authors what
   * was written.
   */
  writtenValues: Record<string, unknown>;

  /**
   * The adapter's `WriteResult.data` flat field bag (record URL, display
   * name, …), with the result's top-level `url` folded in when the
   * adapter surfaces one. Feeds `action_result` (write-handle) reads —
   * fields the target system computed that the author never wrote.
   * Absent for delete / read / suppressed paths.
   */
  resultData?: Record<string, unknown>;
}

/**
 * What `actionResults` (the write-handle map on EvalContext) records per
 * applied action: the apply result keyed by the producing ActionNode's id.
 * `action_result` expressions resolve against it — specials
 * (`created` / `external_id`) first, then `writtenValues[field]`, then
 * `resultData[field]`, else null.
 */
export interface ActionResultRecord {
  created: boolean;
  externalId?: string;
  writtenValues: Record<string, unknown>;
  resultData?: Record<string, unknown>;
}
