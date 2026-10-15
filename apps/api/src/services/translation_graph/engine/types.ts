// Engine evaluation types — context, results, errors, diagnostics.

import type { Kysely } from 'kysely';
import type DB from '../../../generated/kysely/Database';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type {
  ActingUser,
  Adapter,
} from 'movement-engine/services/translation_graph/adapter';
import type { MutationContext } from 'movement-engine/services/translation_graph/mutation_context';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { Expression } from 'movement-engine/services/knowledge_pipeline/output_v3/expression';
import type { ActionResultRecord } from './action_plan';
import type { SchemaRef, SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { Batcher } from './evaluator/batcher';
import type { ExtractState } from './evaluator/extract';
import type { FactExtractor } from './batched_extraction';

/** Minimal Kysely surface — narrowed per-query via getQb / getKnowledgeQb. */
export type DbHandle = Kysely<DB>;

/**
 * Context threaded through every node of an evaluation. Per 3b_evaluator.md.
 */
export interface EvalContext {
  /** Team scope. Used for adapter lookups and v3-bridge delegation. */
  teamId: TeamId;

  /** The trigger that fired (initial source seed, provenance, etc.). */
  trigger: TriggerEvent;

  /** Mutation context — populated incrementally as nodes evaluate. */
  mutationContext: MutationContext;

  /** Adapter that interprets the source side of expressions. Edge-property,
   *  correspondence, and resource reads are optional capabilities the engine
   *  gates on `capabilities` / method presence before invoking. */
  sourceAdapter: Adapter;

  /** Adapter that performs writes — the evaluation-level target. An
   *  action carrying a `targetRef` override evaluates (itself and its
   *  children) against a DERIVED context whose `targetAdapter` is the
   *  resolution of that ref (see `resolveTargetAdapter`). */
  targetAdapter: Adapter;

  /**
   * M4b — per-action target resolution. When an `ActionNode.targetRef` is
   * present, `evaluateActionNode` calls this to obtain the action's own
   * target adapter (already dry-run-wrapped when the evaluation is a dry
   * run). Wired by `evaluateTranslationGraph` from the same
   * `resolveAdapter` injection point the evaluation-level target uses —
   * absent in contexts that don't support overrides (e.g. the composition
   * runtime's hop contexts), where a `targetRef`-carrying body fails with
   * a clear error instead of silently writing to the wrong system.
   */
  resolveTargetAdapter?: (input: {
    ref: SchemaRef;
    credentialsId?: string;
  }) => Adapter | Promise<Adapter>;

  /**
   * Set of property type IDs whose canonical value changed in the triggering
   * mutation event. Empty/undefined for non-mutation triggers. `runWhen`
   * predicates evaluate against this set.
   */
  changedFields: Set<string> | null;

  /** Diagnostics — accumulated counters surfaced in the evaluation result. */
  diagnostics: Diagnostics;

  /** Non-fatal errors collected during evaluation. */
  errors: EvaluationError[];

  /** Database handle. */
  db: DbHandle;

  /**
   * The trigger entry's filter expression. Threaded into expression
   * evaluation; its only former consumer (polymorphic reference narrowing)
   * has been removed, so it is currently unread — retained pending a
   * follow-up prune. Optional — non-trigger evaluations leave it undefined.
   */
  triggerFilter?: Expression;

  /**
   * Whether this evaluation runs in dry-run mode. When true:
   *   • the target adapter is wrapped so create/update/delete are no-ops
   *     that return synthesized externalIds (see `engine/dry_run_adapter.ts`),
   *   • `ensureBridge` skips its linked_object write.
   *
   * Reads (readRecord, resolveEntity, getRelated, etc.) still hit the
   * real adapter — dry-run is about not *writing*, not about avoiding
   * the cost of looking around.
   */
  dryRun: boolean;

  /**
   * Action plans applied during this evaluation. Populated by
   * `evaluateActionNode` as each plan lands. The engine surfaces these in
   * the EvaluationResult so the runs UI can render per-action outcomes.
   */
  appliedActionPlans: AppliedActionPlanRecord[];

  /**
   * Write-handle results, keyed by ActionNode id — what `action_result`
   * expressions read (M4a, the movement language's write-handles).
   * Populated by `evaluateActionNode` as each plan applies (dry-run
   * included — the wrapped adapter's synthesized result lands here too).
   *
   * Scope: per evaluation, allocated lazily at the first action. Within a
   * fan-out (an action whose traversal yields N positions), each
   * position's subtree sees only entries produced for THAT position —
   * `evaluateActionNode` snapshots the map after recording its own entry
   * and restores it once the position's children complete, so sibling
   * handles never leak across positions. The action's own entry persists
   * past its loop (last emission wins) so later sibling roots can read it
   * — the movement compiler's top-level writes resolve to a single
   * position, where "last" is "the" result.
   */
  actionResults?: Map<string, ActionResultRecord>;

  /**
   * Batcher that owns `#extract` / `EXTRACT_VALUE` materialisation. The
   * engine threads this onto each `ExpressionEvalContext` it constructs
   * so the evaluator can dispatch meta-edge steps without having to
   * build a batcher itself.
   *
   * Production wiring (`evaluateTranslationGraph` and the composition
   * runtime's `buildHopContext`) constructs a `BatchedExtractionBatcher`
   * here. Tests that don't exercise `#extract` may leave it undefined —
   * the evaluator throws a clear "batcher is required" error at the
   * dispatch site rather than crashing inside the evaluator.
   */
  batcher?: Batcher;

  /**
   * Resource-lifecycle fact extractor. Threaded into the batcher's
   * configuration so the per-resource fact extraction step runs against
   * the production R8 implementation. Tests that don't exercise resource
   * facts may leave it undefined — the batcher skips C2 in that case.
   */
  factExtractor?: FactExtractor;

  /**
   * `#extract` / `EXTRACT_VALUE` per-evaluation state — stack of
   * ancestral siteIds, inherited `data:` set, and the siteId counter.
   * Allocated fresh at the top of `evaluateTranslationGraph` and at the
   * top of each composition hop's `buildHopContext` (NOT shared across
   * hops — `stack` is per-evaluation-tree state). Threaded onto each
   * `ExpressionEvalContext` the engine constructs so the evaluator's
   * meta-edge dispatch can find it. Tests that don't exercise `#extract`
   * may leave it undefined — the evaluator throws a clear
   * "extractState is required" error at the dispatch site (see
   * `engine/expression.ts:499,634`).
   */
  extractState?: ExtractState;

  /**
   * R16 — lexical alias bindings seeded at the trigger root. Populated
   * by `evaluateTranslationGraph` and `buildHopContext` when the
   * mapping body declares a `sourceAlias` (the `msg` in
   * `trigger: source AS msg`). Threaded onto each
   * `ExpressionEvalContext` the engine constructs so R1's
   * `traverse.aliasRoot` / `alias_ref` evaluators
   * (`engine/expression.ts:278-305`) can resolve at the trigger root.
   * Left undefined when the body has no `sourceAlias` — R1's evaluator
   * raises a clear "no binding in scope" error in that case, which is
   * the right UX for missing-alias bugs.
   *
   */
  aliases?: Record<string, SourcePosition>;

  /**
   * Per-evaluation acting-user cache (T4). The meta resolver populates
   * this on the first `@user_email` / `@user_name` / `@user_id`
   * resolution so every subsequent reference in the same TG reuses the
   * adapter call + DB lookup. Shared across the five
   * `ExpressionEvalContext` construction sites in `evaluate.ts` /
   * `materialise.ts`.
   *
   */
  actingUserCache?: { value: ActingUser | null };
}

export interface Diagnostics {
  reads: number;
  writes: number;
  skippedNoOps: number;
  skippedRunWhen: number;
  /**
   * Writes the circuit breaker (P14.2) refused because the matched
   * `linked_object` is halted or just exceeded the round-trip threshold.
   * Non-zero indicates a loop was caught at the safety-net layer.
   */
  circuitBreakerHalts: number;
  /**
   * Source positions resolved at the root of the evaluation — for snapshot
   * triggers this counts the records the meta→collection traversal fanned
   * out to, which is what `snapshot_run.record_count` wants to display.
   * Always 1 for trigger types that seed at a single position (mutation,
   * extraction, webhook).
   */
  rootPositionsResolved: number;
}

export interface EvaluationError {
  /** Translation-graph-node `id` where the error occurred. */
  nodeId?: string;
  /** Source position at the time of the error (best-effort, may be absent). */
  position?: SourcePosition;
  message: string;
  cause?: unknown;
}

export interface EvaluationResult {
  /**
   * Action plans that were applied. Empty array means the TG ran but produced
   * no writes (e.g., everything filtered out or no-op suppressed).
   */
  appliedActionPlans: AppliedActionPlanRecord[];

  diagnostics: Diagnostics;

  /** Non-fatal errors collected; the evaluation completed despite these. */
  errors: EvaluationError[];
}

export interface AppliedActionPlanRecord {
  /** Translation-graph node `id`. */
  nodeId: string;
  /** Adapter that received the write. */
  adapterType: string;
  /** Record type (typeId in the target adapter's schema descriptor). */
  recordType: string;
  /** Did this plan create a new record vs. update an existing one? */
  created: boolean;
  /** External ID of the affected record (may be the KG nodeId for KG targets). */
  externalId?: string;
  /**
   * Field → value map of what the engine actually sent to the target,
   * after no-op suppression and runWhen filtering. Stored verbatim on
   * tg_run.applied_action_plans (JSONB) and surfaced by the runs UI so
   * authors can audit what the TG wrote without round-tripping to the
   * target system.
   */
  writtenValues: Record<string, unknown>;
}

/**
 * Internal — what an action node's evaluator returns to its parent so the
 * child traversal context (parent_result expressions) has access.
 */
export interface NodeResult {
  /**
   * Set when an action node successfully created or updated a target record;
   * downstream child nodes consume `parent_result` expressions against this.
   */
  parentResult?: { created: boolean; externalId?: string };
}
