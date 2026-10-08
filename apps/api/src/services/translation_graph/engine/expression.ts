// Source-agnostic expression evaluator. Walks the existing output-v3
// Expression AST (from `../knowledge_pipeline/output_v3/expression`) but
// resolves leaf field accesses through the source adapter's
// `getFieldValue` and `getRelated` rather than binding directly to the KG.
//
// Initial implementation handles the simple leaves (property, static, meta,
// concat, conditional, compare, logical, not). Complex cases — `traverse`,
// `aggregate`, `llm`, `resource_traverse`, `resource`, `linked_object`,
// `parent_result`, `edge_property` — are deferred and throw with a clear
// "not yet implemented" message. The full output-v3 evaluator covers them
// today; refactoring it to accept a pluggable source backend is a follow-on.

import { randomUUID } from 'node:crypto';

import type { Expression } from '../../knowledge_pipeline/output_v3/expression';
import type { AggregationFunction, TraversalStep } from '#shared/expression/types';
import { isObjectSpread, objectMemberExpression } from '#shared/expression/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type {
  ActingUser,
  ActorIdentity,
  Adapter,
  FieldEvidence,
  Resource,
} from '../adapter';
import { RESOURCES_REFERENCE_FIELD_ID } from '../adapter';
import type { ResourceFilter } from '../../knowledge_pipeline/output_v3/schemas';
import { resourcePositionsFromExtractNode } from './resources';
import type { TriggerEvent } from '../triggers/types';
import type { EphemeralNode, ExpressionType, SourcePosition } from '../types';
import { isEphemeralPosition, positionData } from '../types';
import { getAutomationsQb } from '../../../lib/kysely';
import type { runKgQuery as RunKgQueryFn } from '../../knowledge_pipeline/output_v3/kg_query_runner';
import {
  evaluateExtractStep,
  evaluateExtractValue,
  evaluateTransformStep,
  type Batcher,
  type ExtractState,
  type TransformAugmentation,
} from './evaluator';
import { resolveActingUser } from '../adapters/acting_user/resolve';
import { resolvePositionResources } from './files/resources';
import type { ActionResultRecord } from './action_plan';

/**
 * Node-scoped accumulator for the resources an action's evaluation touched
 * (`4d_resources.md`). Resources are node-level provenance — "source material
 * this record drew from" — so they don't ride the per-result `metadata`
 * channel evidence uses (which is property-level and dropped by transforms).
 * Instead, any sub-evaluation that *reads* a resource drops it here as a side
 * effect, so capture is indifferent to how the value then propagates (through
 * `concat`, `AI()`, arithmetic, …) — that is what "survives transforms" means
 * for a node-level claim.
 *
 * `buildActionPlan` allocates one sink per action node and reads it out into
 * `WriteInput.resources` once the node's field mappings have evaluated.
 *
 * Dedup is by stable key (`id ?? externalId`); anonymous resources (neither
 * key set) are kept verbatim since each is a distinct object.
 */
export class ResourceSink {
  private readonly seen = new Set<string>();
  private readonly collected: Resource[] = [];

  add(resource: Resource): void {
    const key = resource.id ?? resource.externalId;
    if (key !== undefined) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.collected.push(resource);
  }

  values(): Resource[] {
    return this.collected;
  }
}

export interface ExpressionEvalContext {
  /** Adapter that resolves source-side field accesses. KG-specific
   *  extensions are optional; the evaluator checks for them before
   *  invoking edge-property / linked-object / resource paths. */
  sourceAdapter: Adapter;

  /** Current source position (the node's resolved source). */
  position: SourcePosition;

  /** Meta-key lookup — for `meta` expressions. Free-form bag for
   *  per-dispatch keys (mutation/extraction filter sites supply
   *  `nodeTypeId`, `changeKind`, etc.); well-known keys like
   *  `@current_date` / `@user_email` resolve through `resolveMetaKey`
   *  and don't need to be piped in. */
  meta: Record<string, unknown>;

  /** Trigger event for the current dispatch. Threaded so the meta
   *  resolver can ask the source adapter to identify the acting user
   *  and fall back to the trigger row's `created_by_user_id` when the
   *  adapter declines. Absent for ad-hoc / non-trigger evaluations
   *  (router probes, validation passes); meta resolution then short-
   *  circuits to null for user keys. */
  trigger?: TriggerEvent;

  /** Per-evaluation acting-user cache. The first `@user_*` resolution
   *  in an evaluation populates this; subsequent calls reuse it so a
   *  TG with N mappings doesn't burn N adapter calls + N user lookups.
   *  Stores `null` to remember "no acting user found" (vs. "not yet
   *  resolved" = undefined). */
  actingUserCache?: { value: ActingUser | null };

  /** Per-evaluation actor cache. Same shape as `actingUserCache` but for
   *  `extractActor` — keeps repeated `@actor_*` references cheap (the
   *  adapter parse is local, but `extractActor` is async for remoteability,
   *  and the cache also remembers a null result so we don't re-parse a
   *  payload that has no actor). */
  actorCache?: { value: ActorIdentity | null };

  /** Parent-result lookup — for `parent_result` expressions. */
  parentResult?: { created: boolean; externalId?: string };

  /**
   * Write-handle results keyed by ActionNode id — for `action_result`
   * expressions (M4a). Threaded from `EvalContext.actionResults` at every
   * construction site in `evaluate.ts`; the engine records each applied
   * action into it before later siblings/children evaluate. Absent for
   * evaluations outside an engine run — handle reads then resolve to null.
   */
  actionResults?: Map<string, ActionResultRecord>;

  /**
   * Team scope. Used for adapter primitives that need it.
   */
  teamId?: TeamId;

  /**
   * Inline properties of the most-recently-walked traversal step's edges
   * (3b §2) — one record per walked edge, captured from
   * `RelatedResult.edgeProperties`. Consumed by `edge_property` expressions.
   * Empty when no edges have been walked yet (i.e., we're at the root).
   */
  lastEdgeProperties?: Record<string, unknown>[];

  /**
   * Resource handle for the current evaluation. Populated by the
   * `resource_traverse` evaluator when stepping into a resource; consumed
   * by the `resource` expression that reads fields on it.
   */
  currentResource?: Resource;

  /**
   * Node-scoped sink for resources this action's evaluation read
   * (`4d_resources.md`). Allocated once per action node by `buildActionPlan`
   * and shared (by reference, through `{ ...ctx }` spreads) across every
   * sub-evaluation, so a resource read anywhere — even through a transform —
   * lands on the node. Absent for evaluations that don't write a record
   * (filters, `runWhen`, validation passes), so those don't pollute the set.
   */
  resourceSink?: ResourceSink;

  /**
   * Per-evaluation cache for kg_exists/kg_value results, keyed by
   * `${kind}\n${query}\n${JSON.stringify(paramValues)}`. Allocated lazily
   * on first KG query so the same predicate evaluated repeatedly inside a
   * branch (e.g., across rows) reuses the result.
   */
  kgQueryCache?: Map<string, unknown>;

  /**
   * The trigger entry's filter expression, if this evaluation is running
   * inside a triggered TG. Its only former consumer (polymorphic reference
   * narrowing) has been removed — references discriminate via per-target
   * edges (and the `eventTypes` union), so this is currently unread and
   * retained pending a follow-up that prunes the thread end-to-end.
   */
  triggerFilter?: Expression;

  // ── TG-parity (wave-1 R1) ────────────────────────────────────────────────
  /**
   * Lexical alias bindings — populated when cypher-bracket aliases
   * (`-[name:Edge]->`, `-[name:#extract { ... }]->`,
   * `-[name:#transform { ... }]->`) are walked, and seeded at the
   * trigger level (`trigger: slack_message AS msg`). Resolved by
   * `alias_ref` and `traverse.aliasRoot`. The evaluator shadows
   * silently on re-bind (per `mental_model.md` "Naming and scope").
   *
   * Carries the bound source position — for an edge step, the walked
   * destination; for `#extract`, the materialised ephemeral node;
   * for `#transform`, the source node (the augmentation stream is
   * separately tracked).
   */
  aliases?: Record<string, SourcePosition>;

  /**
   * Per-alias stream of ephemeral nodes emitted by `#transform`
   * steps. When an author writes `urls.text` on a transform alias,
   * we read the stream from here and dispatch the property lookup
   * across each emitted ephemeral node.
   */
  aliasStreams?: Record<string, EphemeralNode[]>;

  /**
   * Per-position transform augmentations — properties + emissions
   * added by `#transform` steps. Keyed by the source position's
   * identity key (see `positionKey()` below). Consulted by the
   * evaluator when resolving property reads on a node that's been
   * augmented.
   *
   *   ("Transforms add ephemeral nodes to the source graph")
   */
  transformAugmentations?: Map<string, TransformAugmentation>;

  /**
   * `#extract` state — stack of ancestral siteIds + inherited
   * `data:` set + siteId counter. Threaded through every nested
   * evaluation so EXTRACT_VALUE can find its parent and nested
   * `#extract` can inherit `data:`. Allocated by the TG runner at
   * top-level; tests can pass one explicitly.
   */
  extractState?: ExtractState;

  /**
   * The batcher implementation used by `#extract` and EXTRACT_VALUE
   * to resolve materialisation. Required when the evaluator
   * encounters those forms; absence throws a clear error at the
   * dispatch site rather than crashing inside the evaluator.
   */
  batcher?: Batcher;

  /**
   * Type hint flowed into the evaluation from the surrounding
   * field-mapping context — used by EXTRACT_VALUE to infer the
   * scalar's type + enum options. The field-mapping pipeline sets
   * this before evaluating each mapping's expression; nested
   * sub-expressions inherit unless an operator narrows further.
   * Optional; absent → string default.
   */
  expectedFieldType?: ExpressionType;
  /**
   * Adapter-provided expression functions in scope for this evaluation —
   * keyed by the **lowercased** call name (the parser lowercases `fn`). Set
   * only by the field-mapping pipeline, and only for fields whose target
   * adapter advertises functions (`SchemaFieldDescriptor.functions`). Each
   * value invokes the target adapter's `invokeFieldFunction`. Absent
   * everywhere else, so a field function is simply an unknown name outside
   * the fields that expose it (P8).
   *
   */
  fieldFunctions?: Record<string, (args: unknown[]) => Promise<unknown>>;
}

/**
 * Resolve a `@<key>` meta reference (parsed as `{ type: 'meta', key }`)
 * to a runtime value. Three families of keys:
 *
 *   1. Universal time keys (`current_date`, `current_timestamp`) —
 *      resolved here at evaluation time; no dispatcher plumbing.
 *
 *   2. Acting-user keys (`user_email`, `user_name`, `user_id`) —
 *      resolved through `resolveContextActingUser`, which parses actor
 *      candidates from the source adapter (`getActorCandidates`) and hands
 *      them to Listen-Fire's `resolveActingUser` (creator-override →
 *      originator/non-service → relay/service → creator-fallback → null).
 *      The chain is cached per evaluation via `ctx.actingUserCache`.
 *
 *   3. Anything else — falls through to `ctx.meta` (the per-dispatch
 *      bag populated by mutation/extraction filter sites with
 *      `nodeTypeId`, `changeKind`, etc.). Unknown keys → null.
 *
 * Returns `null` for unknown / unavailable keys rather than `undefined`
 * — keeps the field-write coercion clean and matches
 * `output_v3/resolve.ts`'s `resolveMetaKey` semantics.
 *
 */
async function resolveMetaKey(
  key: string,
  ctx: ExpressionEvalContext,
): Promise<unknown> {
  switch (key) {
    case 'current_date':
      return new Date().toISOString().slice(0, 10);
    case 'current_timestamp':
      return new Date().toISOString();
    case 'user_email':
    case 'user_name':
    case 'user_id': {
      const user = await resolveContextActingUser(ctx);
      if (!user) return null;
      if (key === 'user_email') return user.email;
      if (key === 'user_name') return user.name ?? null;
      return user.id;
    }
    case 'actor_email':
    case 'actor_name':
    case 'actor_id': {
      const actor = await resolveActor(ctx);
      if (!actor) return null;
      if (key === 'actor_email') {
        return actor.email ?? (actor.scheme === 'email' ? actor.identifier : null);
      }
      if (key === 'actor_name') {
        return actor.name ?? actor.label ?? null;
      }
      return actor.identifier;
    }
    default:
      return ctx.meta[key] ?? null;
  }
}

/**
 * Resolve the acting user for the current dispatch.
 *
 * The acting-user split (extensible adapter protocol, 2026-05-29) moves
 * resolution out of the adapter: the adapter parses ordered actor
 * candidates from the event (`getActorCandidates`, no Listen-Fire DB), and
 * Listen-Fire's `resolveActingUser` (adapters/acting_user/resolve.ts) runs the
 * identical chain it always did — creator-override → originator/non-service
 * → relay/service → creator-fallback → null. The candidate thunk is passed
 * lazily so an override-on dispatch never pays the Slack/Attio actor-email
 * API round-trip.
 *
 * Cached on the eval context via `actingUserCache` so a TG with N
 * `@user_*` references doesn't pay N round trips. `null` is a valid
 * cached value (means "looked, found none").
 *
 */
async function resolveContextActingUser(
  ctx: ExpressionEvalContext,
): Promise<ActingUser | null> {
  if (ctx.actingUserCache) return ctx.actingUserCache.value;
  const resolved = await resolveContextActingUserUncached(ctx);
  ctx.actingUserCache = { value: resolved };
  return resolved;
}

async function resolveContextActingUserUncached(
  ctx: ExpressionEvalContext,
): Promise<ActingUser | null> {
  if (!ctx.trigger || !ctx.teamId) return null;
  if (!ctx.sourceAdapter.getActorCandidates) return null;
  try {
    const triggerRow = await loadTriggerRowForEvent(ctx.trigger);
    return await resolveActingUser({
      teamId: ctx.teamId,
      trigger: triggerRow ?? undefined,
      getCandidates: () =>
        ctx.sourceAdapter.getActorCandidates!({ event: ctx.trigger! }),
    });
  } catch {
    // Flaky adapter lookups shouldn't crash the whole evaluation; the
    // dispatcher already auth-gated before evaluation started. Null at
    // resolution time just means `@user_*` fields collapse to null.
    return null;
  }
}

/**
 * Resolve the raw actor identity for the current dispatch. Independent
 * of auth: returns whatever `extractActor` parses out of the event
 * payload, regardless of whether the actor maps to a Listen-Fire user.
 *
 * No DB calls — `extractActor` is a pure parse — but async so a remote
 * adapter can answer it over the wire. Cached so repeated `@actor_*`
 * references in a TG don't re-parse the payload.
 *
 */
async function resolveActor(
  ctx: ExpressionEvalContext,
): Promise<ActorIdentity | null> {
  if (ctx.actorCache) return ctx.actorCache.value;
  let resolved: ActorIdentity | null = null;
  if (ctx.trigger && ctx.sourceAdapter.extractActor) {
    try {
      resolved = await ctx.sourceAdapter.extractActor({ event: ctx.trigger });
    } catch {
      resolved = null;
    }
  }
  ctx.actorCache = { value: resolved };
  return resolved;
}

/**
 * Load the trigger row referenced by an event's `triggerEntryId` so
 * `resolveActingUser` can read `config.overrideActingUserToCreator` /
 * `config.fallbackToCreatorIfActorUnregistered` and `created_by_user_id`.
 * Returns null when the event predates trigger-aware dispatch or the join
 * misses.
 *
 * One join, indexed; the per-evaluation cache covers repeats.
 */
async function loadTriggerRowForEvent(
  event: TriggerEvent,
): Promise<{
  id: string;
  kind: string;
  config: unknown;
  createdByUserId: string | null;
} | null> {
  if (!event.triggerEntryId) return null;
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', event.triggerEntryId as never)
    .select(['id', 'kind', 'config', 'created_by_user_id'])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    kind: row.kind as string,
    config: row.config,
    createdByUserId: (row.created_by_user_id as unknown as string) ?? null,
  };
}

/**
 * Provenance/evidence metadata that travels alongside an expression's value.
 * Extensible by design (3b §3.4: "expressions emit both their return
 * value and metadata") — today it carries optional `evidence`.
 */
export interface ExpressionMetadata {
  /** Provenance for the value when it flows un-transformed from an extraction
   *  / property read. Absent once a transform produces a new value. */
  evidence?: FieldEvidence;
}

/** An expression's evaluation: the value plus its provenance metadata. */
export interface EvalResult {
  value: unknown;
  metadata: ExpressionMetadata;
}

/** A value with no provenance metadata — the common case. */
function bare(value: unknown): EvalResult {
  return { value, metadata: {} };
}

/**
 * Collapse a traversal/resource fan-out to the engine's single-or-array
 * convention, propagating metadata only when exactly one value flows through
 * (3b §3.4: a single un-transformed value stays evidence-bearing; an array
 * can't attribute one field's evidence, so it drops to bare).
 */
function collapse(results: EvalResult[]): EvalResult {
  if (results.length === 0) return bare(null);
  if (results.length === 1) return results[0];
  return bare(results.map((r) => r.value));
}

/**
 * Value-only evaluation — the entry point for callers that don't need
 * provenance (filters, runWhen, nested `#extract`/`#transform` bodies, KG
 * queries, etc.). Delegates to `evalExpr` and unwraps the value.
 */
export async function evaluateExpression(
  expr: Expression,
  ctx: ExpressionEvalContext,
): Promise<unknown> {
  return (await evalExpr(expr, ctx)).value;
}

/**
 * Core evaluator — returns the value PLUS provenance metadata. The
 * field-mapping pipeline uses the metadata to attach `FieldEvidence` to
 * writes. Provenance rule (3b §3.4): evidence rides through
 * provenance-preserving nodes (extract, property/passthrough reads, branch
 * selection, single-position traversal) and is dropped by transforms (AI(),
 * functions, arithmetic, comparisons, concat, aggregations) — a transformed
 * value is no longer justified by the original quote.
 */
export async function evalExpr(
  expr: Expression,
  ctx: ExpressionEvalContext,
): Promise<EvalResult> {
  switch (expr.type) {
    case 'property': {
      // Ephemeral nodes carry their resolved property values inline on
      // the `data` field (materialised by `#extract` or a `#transform`).
      // The evaluator reads them directly — the adapter knows nothing
      // about ephemeral-node identifiers, per the mental_model.md
      // "ephemeral vs persistent" indistinguishability rule.
      if (isEphemeralPosition(ctx.position)) {
        return bare(readEphemeralProperty(ctx.position, expr.propertyTypeId));
      }
      // Persistent position augmented by a `#transform`: properties
      // added by the transform sit on the per-position augmentation
      // map. Adapter answer takes precedence when both surface a
      // value (transforms can extend, not override).
      const adapterValue = await ctx.sourceAdapter.getFieldValue({
        position: ctx.position,
        fieldId: expr.propertyTypeId,
      });
      if (adapterValue !== null && adapterValue !== undefined) return bare(adapterValue);
      const augmented = ctx.transformAugmentations?.get(positionKey(ctx.position))?.properties;
      if (augmented && expr.propertyTypeId in augmented) {
        return bare(augmented[expr.propertyTypeId]);
      }
      return bare(adapterValue);
    }

    case 'static':
      return bare(expr.value);

    case 'meta':
      return bare(await resolveMetaKey(expr.key, ctx));

    case 'parent_result':
      if (!ctx.parentResult) return bare(null);
      if (expr.field === 'created') return bare(ctx.parentResult.created);
      if (expr.field === 'external_id') return bare(ctx.parentResult.externalId ?? null);
      return bare(null);

    case 'action_result': {
      // Write-handle read (M4a): a previously-applied action's result.
      // Resolution order: the specials ('created' / 'external_id') →
      // the field values the engine actually wrote → the adapter's
      // result-data bag (record URL etc.). Unknown handle or unknown
      // field → null, never a crash.
      const record = ctx.actionResults?.get(expr.nodeId);
      if (!record) return bare(null);
      if (expr.field === 'created') return bare(record.created);
      if (expr.field === 'external_id') return bare(record.externalId ?? null);
      if (expr.field in record.writtenValues) {
        return bare(record.writtenValues[expr.field] ?? null);
      }
      return bare(record.resultData?.[expr.field] ?? null);
    }

    case 'concat': {
      const parts = await Promise.all(expr.parts.map((p) => evaluateExpression(p, ctx)));
      return bare(parts.map((p) => (p == null ? '' : String(p))).join(''));
    }

    case 'conditional': {
      // Branch selection is provenance-preserving — the chosen branch's
      // value (and its evidence) flows through unchanged.
      const cond = await evaluateExpression(expr.condition, ctx);
      return evalExpr(cond ? expr.then : expr.else, ctx);
    }

    case 'at': {
      const inner = await evaluateExpression(expr.expression, ctx);
      const indexValue = await evaluateExpression(expr.index, ctx);
      const index = Number(indexValue);
      if (!Number.isInteger(index)) return bare(null);
      // Non-array source: index 0 returns the value itself (Cypher-ish:
      // treat a scalar as a one-element list); any other index → null.
      if (!Array.isArray(inner)) {
        if (inner === null || inner === undefined) return bare(null);
        return bare(index === 0 || index === -1 ? inner : null);
      }
      const resolved = index < 0 ? inner.length + index : index;
      if (resolved < 0 || resolved >= inner.length) return bare(null);
      return bare(inner[resolved]);
    }

    case 'compare': {
      const left = await evaluateExpression(expr.left, ctx);
      const right = await evaluateExpression(expr.right, ctx);
      return bare(compareValues(left, expr.op, right));
    }

    case 'logical': {
      if (expr.op === 'and') {
        for (const operand of expr.operands) {
          const v = await evaluateExpression(operand, ctx);
          if (!v) return bare(false);
        }
        return bare(true);
      }
      // 'or'
      for (const operand of expr.operands) {
        const v = await evaluateExpression(operand, ctx);
        if (v) return bare(true);
      }
      return bare(false);
    }

    case 'not': {
      const v = await evaluateExpression(expr.expression, ctx);
      return bare(!v);
    }

    case 'negate': {
      const v = await evaluateExpression(expr.expression, ctx);
      return bare(-Number(v));
    }

    case 'arithmetic': {
      const left = Number(await evaluateExpression(expr.left, ctx));
      const right = Number(await evaluateExpression(expr.right, ctx));
      switch (expr.op) {
        case '+':
          return bare(left + right);
        case '-':
          return bare(left - right);
        case '*':
          return bare(left * right);
        case '/':
          return bare(right === 0 ? null : left / right);
        case '%':
          return bare(right === 0 ? null : left % right);
      }
      // exhaustive
      return bare(null);
    }

    case 'traverse': {
      // Walk the source structure step-by-step, then evaluate the inner
      // expression at each resolved position. Active traversal: each step
      // dispatches to the source adapter's getRelated, which may invoke
      // API calls for external sources (P16). Edge steps support both
      // directions (subject to the source's incomingEdges capability);
      // linkBack/resource steps require the source's resources capability.
      //
      // `traverse.aliasRoot`: when present, the traversal starts from the
      // alias's bound position instead of the surrounding context.
      // Resolves dot-chains (`opp.company` → empty steps) and
      // alias-rooted walks (`msg-[:Author]->.email`).
      let rootCtx = ctx;
      if (expr.aliasRoot) {
        const bound = ctx.aliases?.[expr.aliasRoot];
        if (bound === undefined) {
          // Transform alias — bound as a stream of ephemeral nodes.
          // Fan out: evaluate the inner traversal at each stream node.
          const stream = ctx.aliasStreams?.[expr.aliasRoot];
          if (stream !== undefined) {
            const values: unknown[] = [];
            for (const node of stream) {
              const subCtx: ExpressionEvalContext = { ...ctx, position: node };
              const v = await evaluateExpression(
                { ...expr, aliasRoot: undefined },
                subCtx,
              );
              if (Array.isArray(v)) values.push(...v);
              else if (v !== null && v !== undefined) values.push(v);
            }
            if (values.length === 0) return bare(null);
            if (values.length === 1) return bare(values[0]);
            return bare(values);
          }
          throw new Error(
            `translation_graph engine: traverse.aliasRoot("${expr.aliasRoot}") has no binding in scope.`,
          );
        }
        rootCtx = { ...ctx, position: bound };
      }
      const { positions, lastEdgeProperties, aliases, aliasStreams } = await walkTraversal({
        steps: expr.steps,
        ctx: rootCtx,
        contextLabel: 'traverse',
      });
      // Single-position traversal is provenance-preserving — the inner
      // expression's evidence flows through. Fan-out collapses to bare.
      const results: EvalResult[] = [];
      for (const p of positions) {
        results.push(
          await evalExpr(expr.expression, {
            ...rootCtx,
            position: p,
            lastEdgeProperties,
            aliases,
            aliasStreams,
          }),
        );
      }
      return collapse(results);
    }

    case 'exists': {
      // Quantifier — walk the traversal, then return true iff at least one
      // resolved position satisfies `where` (or any position exists when
      // `where` is absent). Adapter-uniform: this is how predicates like
      // "is in list X" become EXISTS(-[list_membership where list.name='X']->)
      // instead of adapter-specific canned predicates.
      const { positions, lastEdgeProperties } = await walkTraversal({
        steps: expr.steps,
        ctx,
        contextLabel: 'exists',
      });
      if (positions.length === 0) return bare(false);
      if (!expr.where) return bare(true);
      for (const p of positions) {
        const ok = await evaluateExpression(expr.where, {
          ...ctx,
          position: p,
          lastEdgeProperties,
        });
        if (isTruthy(ok)) return bare(true);
      }
      return bare(false);
    }

    case 'aggregate': {
      const inner = await evaluateExpression(expr.expression, ctx);
      const arr = inner === null || inner === undefined ? [] : Array.isArray(inner) ? inner : [inner];
      return bare(
        await applyAggregation({ fn: expr.fn, values: arr, separator: expr.separator, prompt: expr.prompt, ctx }),
      );
    }

    case 'function': {
      const args = await Promise.all(expr.args.map((a) => evaluateExpression(a, ctx)));
      // Built-ins always win the name lookup — a field can't shadow `TRIM`
      // (P8). A non-built-in name resolves against the field's adapter
      // functions when one is in scope; otherwise it's an unknown function,
      // which is exactly the error `applyFunction` raises.
      if (BUILTIN_FUNCTION_NAMES.has(expr.fn)) return bare(applyFunction(expr.fn, args));
      const fieldFn = ctx.fieldFunctions?.[expr.fn];
      if (fieldFn) return bare(await fieldFn(args));
      return bare(applyFunction(expr.fn, args));
    }

    case 'llm': {
      // `AI(...)` is a universal framework primitive (a Haiku call) — valid
      // on every source regardless of the adapter's declared capabilities.
      // No per-adapter gate.
      const prompt = expr.promptExpression
        ? String((await evaluateExpression(expr.promptExpression, ctx)) ?? '')
        : expr.prompt;
      return bare(await callLLM(prompt));
    }

    case 'edge_property': {
      if (!ctx.sourceAdapter.runtimeCapabilities().traversal.edgeProperties) {
        throw new UnsupportedSourceCapabilityError(
          ctx.sourceAdapter.adapterType,
          'edgeProperties',
          `edge_property propertyTypeId=${expr.propertyTypeId}`,
        );
      }
      // Read the field off the walked edges' inline properties (3b §2),
      // captured into `ctx.lastEdgeProperties` during traversal.
      const edgeProps = ctx.lastEdgeProperties ?? [];
      const values = edgeProps
        .map((props) => props[expr.propertyTypeId])
        .filter((v) => v !== null && v !== undefined);
      if (values.length === 0) return bare(null);
      if (values.length === 1) return bare(values[0]);
      return bare(values);
    }

    case 'linked_object': {
      // `linked_object` was a TG-era AST kind backed by the adapter's
      // `getPriorMatch` correspondence store. The TG execution engine has
      // been retired (plans/2026-06-14-kill-tg) and the `bind` model
      // replaced this expression — no live movement emits it. The case is
      // retained only for switch exhaustiveness over the Expression union;
      // it can never be reached by an authored movement.
      throw new Error(
        `translation_graph engine: 'linked_object' expression is retired (adapter=${expr.adapter} field=${expr.field}). The TG execution engine has been removed; movements use 'bind' instead.`,
      );
    }

    case 'resource': {
      if (!ctx.currentResource) {
        // No resource is in scope — `resource` expressions are only valid
        // inside a `resource_traverse` body that's bound a current resource.
        return bare(null);
      }
      if (!ctx.sourceAdapter.runtimeCapabilities().resources) {
        throw new UnsupportedSourceCapabilityError(
          ctx.sourceAdapter.adapterType,
          'resources',
          `resource field=${expr.field}`,
        );
      }
      // Reading a field off a resource is a contribution — record it on the
      // node sink (`4d_resources.md`). Node-level provenance: the resource
      // belongs to whatever record this evaluation is building, regardless of
      // any transform the value subsequently passes through.
      ctx.resourceSink?.add(ctx.currentResource);
      // Resources carry their fields in `data` (adapters materialise the
      // standard fields when they resolve the resource), so a `resource`
      // field read is a local lookup — no bespoke adapter method.
      return bare(
        (ctx.currentResource.data as Record<string, unknown> | undefined)?.[expr.field] ?? null,
      );
    }

    case 'kg_exists': {
      const rows = await evalKgQuery({ kind: 'kg_exists', expr, ctx });
      return bare(rows.length > 0);
    }

    case 'kg_value': {
      const rows = await evalKgQuery({ kind: 'kg_value', expr, ctx });
      if (rows.length === 0) return bare(null);
      // Validation guarantees a single RETURN column for kg_value.
      const column = Object.keys(rows[0])[0];
      const values = rows.map((r) => r[column] ?? null);
      if (values.length === 1) return bare(values[0]);
      return bare(values);
    }

    case 'resource_traverse': {
      if (!ctx.sourceAdapter.runtimeCapabilities().resources) {
        throw new UnsupportedSourceCapabilityError(
          ctx.sourceAdapter.adapterType,
          'resources',
          `resource_traverse`,
        );
      }
      // Resources are reached over the uniform traversal path now — the
      // reserved `#resources` reference resolved via `getRelated` (P12).
      // There is no `getResources` method. Single-resource read is
      // provenance-preserving — evidence flows through.
      let resources = await resolvePositionResources({
        adapter: ctx.sourceAdapter,
        position: ctx.position,
        filter: expr.filter,
        // The translation-graph engine records no conversation to replay, so
        // its resource ids are random.
        mintIds: async (count) => Array.from({ length: count }, () => randomUUID()),
      });
      if (expr.expressionFilter) {
        // The hop's WHERE as a real expression, judged per resource — the
        // unified filter currency (the structured `filter` above stays as
        // the stored-AST / SQL-pushdown compatibility form).
        const kept: typeof resources = [];
        for (const resource of resources) {
          const verdict = await evalExpr(expr.expressionFilter, { ...ctx, currentResource: resource });
          if (verdict.value) kept.push(resource);
        }
        resources = kept;
      }
      if (resources.length === 0) return bare(null);
      const results = await Promise.all(
        resources.map((resource) =>
          evalExpr(expr.expression, { ...ctx, currentResource: resource }),
        ),
      );
      if (results.length === 1) return results[0];
      return bare(results.map((r) => r.value));
    }

    case 'extract_value': {
      // W3-F1 — fan-out shortcut: when the current source position is
      // an ephemeral node (i.e. we're inside a fan-out action's field
      // mapping evaluating per-emission), the LLM already extracted
      // the value as part of the fan-out site's array entry. Read it
      // off the ephemeral's `data` directly rather than queuing
      // another LLM call. The field key is the sanitised description
      // (mirrors schema_synthesis's `sanitizeFieldName`).
      if (isEphemeralPosition(ctx.position)) {
        const data = (positionData(ctx.position) ?? {}) as Record<string, unknown>;
        const key = sanitizeExtractFieldName(expr.description);
        if (key in data) {
          // The fan-out site's extraction quote rides on the ephemeral's
          // `evidence` map, keyed by the same data field name (3b §3.4).
          const evidence = ctx.position.evidence?.[key];
          return { value: data[key], metadata: evidence ? { evidence } : {} };
        }
        // Fall through to the batcher path when the ephemeral doesn't
        // carry the value — the per-evaluation lifecycle may legitimately
        // need to extract a value not pre-populated by the fan-out site.
      }
      // EXTRACT_VALUE registers a sub-invocation on the ancestral
      // #extract site. F3's validateTgExpression guarantees the
      // ancestral context exists; the runtime check inside
      // evaluateExtractValue confirms it as a backstop. The batcher
      // (R2) actually resolves the value; here we await its promise.
      if (!ctx.batcher) {
        throw new Error(
          `translation_graph engine: EXTRACT_VALUE("${expr.description}") requires a batcher on the eval context — set ctx.batcher before evaluation.`,
        );
      }
      if (!ctx.extractState) {
        throw new Error(
          `translation_graph engine: EXTRACT_VALUE("${expr.description}") requires an extractState on the eval context.`,
        );
      }
      const extracted = await evaluateExtractValue({
        description: expr.description,
        batcher: ctx.batcher,
        state: ctx.extractState,
        fieldType: ctx.expectedFieldType,
        enumOptions:
          ctx.expectedFieldType?.kind === 'enum' ? ctx.expectedFieldType.values : undefined,
      });
      return {
        value: extracted.value,
        metadata: extracted.evidence ? { evidence: extracted.evidence } : {},
      };
    }

    case 'alias_ref': {
      // Bare alias reference — `msg`, `opp`, etc. Resolves to the
      // bound source position (per the mental-model rule that
      // ephemeral and persistent positions are indistinguishable at
      // the expression level). Property access on the alias flows
      // through `traverse { aliasRoot, ... }`, not via this arm.
      const bound = ctx.aliases?.[expr.name];
      if (bound !== undefined) return bare(bound);
      // A transform alias binds the stream of emissions rather than
      // a single position. Return the array of ephemeral nodes so
      // downstream aggregation operators (count, collect) work
      // intuitively.
      const stream = ctx.aliasStreams?.[expr.name];
      if (stream !== undefined) return bare(stream);
      throw new Error(
        `translation_graph engine: alias_ref("${expr.name}") has no binding in scope. ` +
          `F3's validateTgExpression should have caught this at save time — please report as a bug.`,
      );
    }

    case 'list': {
      // Inline list literal — evaluate each element in order. Result
      // is an array of values (NOT flattened — the consumer decides
      // whether nested lists should spread), except where the author
      // wrote a spread: `...xs` splices xs's members in place.
      const evaluated = await Promise.all(expr.elements.map(async (e) =>
        e.type === 'spread'
          ? { spread: true as const, value: await evaluateExpression(e.expression, ctx) }
          : { spread: false as const, value: await evaluateExpression(e, ctx) },
      ));
      return bare(evaluated.flatMap(({ spread, value }) => {
        if (!spread) return [value];
        if (!Array.isArray(value)) {
          throw new Error(`'...' spreads a list into a list, and this value is ${value === null || value === undefined ? 'null' : typeof value}`);
        }
        return value;
      }));
    }

    case 'object': {
      // Inline object literal — every value evaluated, keys verbatim. Same
      // value semantics as the movement engine's `object` case, so the two
      // evaluators can't disagree about a structured value.
      // A spread copies a map's keys in place, a later key winning.
      const values = await Promise.all(expr.entries.map((e) => evaluateExpression(objectMemberExpression(e), ctx)));
      const object: Record<string, unknown> = {};
      expr.entries.forEach((e, i) => {
        if (!isObjectSpread(e)) {
          object[e.key] = values[i];
          return;
        }
        const spread = values[i];
        if (spread === null || spread === undefined) return;
        if (typeof spread !== 'object' || Array.isArray(spread)) {
          throw new Error(`'...' copies a map's keys into a map, and this value is ${Array.isArray(spread) ? 'a list' : typeof spread}`);
        }
        Object.assign(object, spread);
      });
      return bare(object);
    }
  }
}

/**
 * Walk a sequence of TraversalSteps starting from the current source
 * position, resolving each step through the source adapter. Returns the
 * final set of resolved positions plus the IDs of the last edges walked
 * (for `edge_property` lookup). Shared by `traverse` and `exists`.
 */
async function walkTraversal(input: {
  steps: TraversalStep[];
  ctx: ExpressionEvalContext;
  contextLabel: string;
}): Promise<{
  positions: SourcePosition[];
  lastEdgeProperties: Record<string, unknown>[];
  aliases: Record<string, SourcePosition>;
  aliasStreams: Record<string, EphemeralNode[]>;
}> {
  let positions: SourcePosition[] = [input.ctx.position];
  let lastEdgeProperties: Record<string, unknown>[] = [];
  // Threaded alias bindings — we extend rather than mutate, so the
  // walked traversal contributes new bindings without poisoning the
  // caller's scope.
  let aliases: Record<string, SourcePosition> = { ...(input.ctx.aliases ?? {}) };
  let aliasStreams: Record<string, EphemeralNode[]> = { ...(input.ctx.aliasStreams ?? {}) };
  let transformAugmentations = input.ctx.transformAugmentations;
  for (const step of input.steps) {
    if (step.type === 'edge') {
      if (step.direction === 'incoming' && !input.ctx.sourceAdapter.runtimeCapabilities().traversal.incoming) {
        throw new UnsupportedSourceCapabilityError(
          input.ctx.sourceAdapter.adapterType,
          'incomingEdges',
          `${input.contextLabel} step direction=incoming on edgeType=${step.edgeTypeId}`,
        );
      }

      const next: SourcePosition[] = [];
      const nextEdgeProperties: Record<string, unknown>[] = [];
      for (const p of positions) {
        // A `#transform` step earlier in this chain may have published
        // ephemeral neighbours under this edge name on the current
        // source position. Surface those before falling through to
        // the adapter — transforms augment the graph; the adapter
        // didn't see them.
        const aug = transformAugmentations?.get(positionKey(p));
        if (aug?.emissions[step.edgeTypeId]) {
          for (const node of aug.emissions[step.edgeTypeId]) next.push(node);
          continue;
        }
        const related = await input.ctx.sourceAdapter.getRelated({
          position: p,
          fieldId: step.edgeTypeId,
          direction: step.direction,
        });
        for (const r of related) {
          next.push(r.position);
          if (r.edgeProperties) nextEdgeProperties.push(r.edgeProperties);
        }
      }
      positions = next;
      lastEdgeProperties = nextEdgeProperties;
      // Bind alias to the walked destination(s). When the destination
      // fans out, the alias is bound to the first position; downstream
      // alias-rooted walks operate per-fan-out via the caller's loop.
      if (step.alias && positions.length > 0) {
        aliases = { ...aliases, [step.alias]: positions[0] };
      }
    } else if (step.type === 'resource' || step.type === 'linkBack') {
      throw new ExpressionNotImplementedError(`${input.contextLabel} step type=${step.type}`);
    } else if (step.type === 'meta_edge') {
      if (step.metaEdge === 'extract') {
        if (!input.ctx.batcher) {
          throw new Error(
            `translation_graph engine: -[${step.alias ?? ''}:#extract]-> requires a batcher on the eval context.`,
          );
        }
        if (!input.ctx.extractState) {
          throw new Error(
            `translation_graph engine: -[${step.alias ?? ''}:#extract]-> requires an extractState on the eval context.`,
          );
        }
        // #extract fires once per current source position — each
        // produces its own ephemeral node bound to the alias. For the
        // common case of single-position chains this collapses to one
        // invocation; fan-out is preserved.
        const evalSubExpr = (expr: Expression) =>
          evaluateExpression(expr, {
            ...input.ctx,
            aliases,
            aliasStreams,
            transformAugmentations,
          });
        const next: SourcePosition[] = [];
        let aliasAnchor: EphemeralNode | undefined;
        const allEmissions: EphemeralNode[] = [];
        for (let i = 0; i < positions.length; i++) {
          const { node, siteId, resolvedData } = await evaluateExtractStep({
            step,
            batcher: input.ctx.batcher,
            state: input.ctx.extractState,
            ancestorAliases: aliases,
            evalExpression: evalSubExpr,
          });
          // Push extract context onto the state for downstream
          // EXTRACT_VALUE / nested #extract inheritance. The caller
          // pops it after the surrounding expression evaluates;
          // here we leave the stack in its post-step form because
          // the inner expression of the enclosing `traverse` runs
          // with the same state.
          input.ctx.extractState.stack.push(siteId);
          input.ctx.extractState.data = resolvedData;
          // W3-F5 — `#extract` is a traversal; `evaluateExtractStep`
          // returns the full emission array (zero, one, or many).
          // Each emission becomes a downstream source position so the
          // inner expression evaluates per-entity.
          for (const emission of node) {
            next.push(emission);
            allEmissions.push(emission);
            if (!aliasAnchor) aliasAnchor = emission;
          }
        }
        positions = next;
        if (step.alias) {
          if (aliasAnchor) {
            aliases = { ...aliases, [step.alias]: aliasAnchor };
          }
          aliasStreams = { ...aliasStreams, [step.alias]: allEmissions };
        }
        lastEdgeProperties = [];
      } else if (step.metaEdge === 'transform') {
        // #transform augments the current source positions in place.
        // Run once per position; merge augmentations into the per-
        // position map; bind the alias to the concatenated stream.
        const evalSubExpr = (expr: Expression) =>
          evaluateExpression(expr, {
            ...input.ctx,
            aliases,
            aliasStreams,
            transformAugmentations,
          });
        const augMap = transformAugmentations ?? new Map<string, TransformAugmentation>();
        const allEmissions: EphemeralNode[] = [];
        for (const p of positions) {
          const { augmentation, aliasStream } = await evaluateTransformStep({
            step,
            sourcePosition: p,
            evalExpression: evalSubExpr,
          });
          augMap.set(positionKey(p), augmentation);
          allEmissions.push(...aliasStream);
        }
        transformAugmentations = augMap;
        if (step.alias) {
          aliasStreams = { ...aliasStreams, [step.alias]: allEmissions };
        }
        // Position cursor stays — transforms augment, don't move.
      } else if (step.metaEdge === 'resources') {
        // `#resources` moves the cursor onto a node's resources, each carrying
        // a `Resource` on its `data` so an inner field read evaluates per
        // resource (like a domain edge step). On an EXTRACT node the resources
        // ride inline (`ephemeral.resources`) — yield them as ephemeral source
        // nodes. On a real source they're walked via `getRelated('#resources')`.
        const next: SourcePosition[] = [];
        for (const p of positions) {
          const fromExtract = resourcePositionsFromExtractNode(
            p,
            (step as { filter?: ResourceFilter }).filter,
          );
          if (fromExtract !== null) {
            for (const rp of fromExtract) next.push(rp);
            continue;
          }
          if (!input.ctx.sourceAdapter.runtimeCapabilities().resources) {
            throw new UnsupportedSourceCapabilityError(
              input.ctx.sourceAdapter.adapterType,
              'resources',
              `${input.contextLabel} meta_edge step (#resources)`,
            );
          }
          const related = await input.ctx.sourceAdapter.getRelated({
            position: p,
            fieldId: RESOURCES_REFERENCE_FIELD_ID,
            direction: 'outgoing',
          });
          for (const r of related) next.push(r.position);
        }
        positions = next;
        lastEdgeProperties = [];
        if (step.alias && positions.length > 0) {
          aliases = { ...aliases, [step.alias]: positions[0] };
        }
      } else {
        throw new Error(
          `${input.contextLabel} meta_edge step (#${step.metaEdge}) not yet implemented.`,
        );
      }
    }
  }
  return { positions, lastEdgeProperties, aliases, aliasStreams };
}


/**
 * Identity key for a `SourcePosition`, used to key the per-position
 * transform augmentation map. Each position variant has a natural
 * identifier; positions of unknown shape fall back to JSON for
 * deterministic-enough hashing (rare path, only when an adapter ships
 * a new kind without updating this helper).
 */
function positionKey(p: SourcePosition): string {
  // Ephemeral: keyed by its synthetic in-run node id.
  if (p.originRef) return `ephemeral:${p.originRef.nodeId}`;
  // Stable record: keyed by adapter + type + durable external id.
  if (p.identity.kind === 'stable') {
    return `stable:${p.adapterType}:${p.recordType ?? ''}:${p.identity.recordId}`;
  }
  // Unstable, non-ephemeral (inbound webhook root, meta root): keyed by
  // adapter + type — there is at most one per (adapter, type) in a run.
  return `unstable:${p.adapterType}:${p.recordType ?? ''}`;
}

/**
 * Read a property off an ephemeral node's `data` payload. The
 * convention from the F4 transform registry + R1 extract evaluator
 * is that `data` is a record-shaped object whose keys are property
 * names. Other shapes (a File primitive, a string) are returned
 * as-is when the property name is `'value'` or matches a known
 * synthetic name; otherwise null.
 */
/**
 * W3-F1 — sanitise an EXTRACT_VALUE description to the field-key form
 * `schema_synthesis.sanitizeFieldName` writes onto ephemeral `data`.
 * Local copy (rather than a cross-package import) so the expression
 * evaluator doesn't pull batched_extraction internals; the contract is
 * documented in `schema_synthesis.ts:invToField`.
 */
function sanitizeExtractFieldName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function readEphemeralProperty(node: EphemeralNode, fieldId: string): unknown {
  const data = positionData(node);
  if (data === null || data === undefined) return null;
  if (typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (fieldId in record) return record[fieldId];
    return null;
  }
  // Scalar / array `data` doesn't carry named properties — return
  // null for any field access. (Authors who need the scalar itself
  // should use the alias_ref directly, not a property access.)
  return null;
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

async function evalKgQuery(input: {
  kind: 'kg_exists' | 'kg_value';
  expr: Extract<Expression, { type: 'kg_exists' | 'kg_value' }>;
  ctx: ExpressionEvalContext;
}): Promise<Record<string, unknown>[]> {
  const { kind, expr, ctx } = input;
  if (!ctx.teamId) {
    throw new Error(`kg_query expression requires teamId on the eval context`);
  }
  const paramValues: unknown[] = [];
  for (const p of expr.params) {
    paramValues.push(await evaluateExpression(p, ctx));
  }
  const cache = (ctx.kgQueryCache ??= new Map<string, unknown>());
  // Lazy-loaded: kg_query_runner pulls in cypher → kysely → Prisma runtime,
  // which fails in unit-test envs that don't mock the chain. Same pattern as
  // callLLM below.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runKgQuery } = require('../../knowledge_pipeline/output_v3/kg_query_runner') as {
    runKgQuery: typeof RunKgQueryFn;
  };
  return runKgQuery({ kind, query: expr.query, paramValues, teamId: ctx.teamId, cache });
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case 'eq':
      if (Array.isArray(left) && Array.isArray(right)) return setEquals(left, right);
      return left === right;
    case 'neq':
      if (Array.isArray(left) && Array.isArray(right)) return !setEquals(left, right);
      return left !== right;
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'exists':
      return left !== null && left !== undefined;
    case 'in':
      return Array.isArray(right) && (right as unknown[]).includes(left);
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
      if (Array.isArray(left)) return (left as unknown[]).includes(right);
      return false;
    default:
      return false;
  }
}

function setEquals(a: unknown[], b: unknown[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

export class ExpressionNotImplementedError extends Error {
  constructor(public readonly expressionType: string) {
    super(`Expression type '${expressionType}' is not yet implemented in the engine.`);
    this.name = 'ExpressionNotImplementedError';
  }
}

/**
 * Thrown when an expression requires a capability the source adapter
 * doesn't declare. The engine checks `Adapter.runtimeCapabilities()` before
 * dispatching to capability-gated primitives; failing the check produces
 * this error rather than a misleading "not implemented" message.
 */
export class UnsupportedSourceCapabilityError extends Error {
  constructor(
    public readonly adapterType: string,
    public readonly capability: string,
    public readonly context: string,
  ) {
    super(
      `Adapter '${adapterType}' does not support capability '${capability}', required for: ${context}.`,
    );
    this.name = 'UnsupportedSourceCapabilityError';
  }
}

// ── Aggregation helpers ────────────────────────────────────────────────────

function applyAggregation(input: {
  fn: AggregationFunction;
  values: unknown[];
  separator?: string;
  prompt?: string;
  ctx: ExpressionEvalContext;
}): Promise<unknown> | unknown {
  const { fn, values } = input;
  switch (fn) {
    case 'first':
      return values.length > 0 ? values[0] : null;
    case 'last':
      return values.length > 0 ? values[values.length - 1] : null;
    case 'only': {
      const present = values.filter((v) => v !== null && v !== undefined);
      if (present.length > 1) {
        throw new Error(
          `ONLY says there is exactly one, and there are ${present.length}.`,
        );
      }
      return present.length === 1 ? present[0] : null;
    }
    case 'count':
      return values.length;
    case 'sum':
      return values.reduce<number>((acc, v) => acc + (Number(v) || 0), 0);
    case 'avg':
      return values.length > 0
        ? values.reduce<number>((acc, v) => acc + (Number(v) || 0), 0) / values.length
        : null;
    case 'min':
      return values.length > 0 ? Math.min(...values.map((v) => Number(v))) : null;
    case 'max':
      return values.length > 0 ? Math.max(...values.map((v) => Number(v))) : null;
    case 'join':
      return values.filter((v) => v !== null && v !== undefined).map(String).join(input.separator ?? ', ');
    case 'collect':
      return values;
    case 'llm':
      // Universal framework primitive — no per-adapter gate.
      return aggregateViaLLM({ values, prompt: input.prompt ?? 'Summarize the values:' });
    case 'sort':
      // `SORT` is the movement language's ordering primitive and carries a key
      // and a direction this evaluator is never handed. Nothing here can
      // produce one; say so rather than answer with an arbitrary order.
      throw new Error('SORT is not available on this engine');
  }
}

async function aggregateViaLLM(input: { values: unknown[]; prompt: string }): Promise<string> {
  const valuesText = input.values
    .filter((v) => v !== null && v !== undefined)
    .map((v) => `- ${String(v)}`)
    .join('\n');
  const message = `${input.prompt}\n\n${valuesText}`;
  return callLLM(message);
}

async function callLLM(prompt: string): Promise<string> {
  // Lazy-loaded for the same reason the v3 bridge was: the chat wrapper has a
  // transitive Prisma runtime dependency that fails in the unit-test
  // environment if eagerly imported.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { anthropicChat }: typeof import('../../../lib/anthropic') = require('../../../lib/anthropic');
  return anthropicChat({
    model: 'claude-sonnet-5',
    temperature: 0,
    label: 'tg_llm_aggregate',
    system: '',
    userMessage: prompt,
  });
}

// ── Function helpers ──────────────────────────────────────────────────────
// Pure-functional builtins that operate on resolved values regardless of source.

// The built-in scalar functions `applyFunction` handles. Kept in sync with
// the switch below; used by the `function` evaluator to let built-ins win
// name resolution over adapter-provided field functions (P8).
const BUILTIN_FUNCTION_NAMES = new Set([
  'isnull', 'coalesce', 'trim', 'lower', 'upper', 'length',
  'abs', 'round', 'floor', 'ceil', 'tostring', 'tonumber', 'multi', 'split',
]);

function applyFunction(fn: string, args: unknown[]): unknown {
  switch (fn) {
    case 'isnull':
      return args[0] === null || args[0] === undefined;
    case 'coalesce':
      for (const a of args) if (a !== null && a !== undefined) return a;
      return null;
    case 'trim':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).trim();
    case 'lower':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).toLowerCase();
    case 'upper':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).toUpperCase();
    case 'length':
      if (args[0] === null || args[0] === undefined) return 0;
      if (Array.isArray(args[0])) return args[0].length;
      return String(args[0]).length;
    case 'abs':
      return Math.abs(Number(args[0]));
    case 'round':
      return Math.round(Number(args[0]));
    case 'floor':
      return Math.floor(Number(args[0]));
    case 'ceil':
      return Math.ceil(Number(args[0]));
    case 'tostring':
      return args[0] === null || args[0] === undefined ? null : String(args[0]);
    case 'tonumber': {
      const n = Number(args[0]);
      return Number.isNaN(n) ? null : n;
    }
    case 'multi': {
      // MULTI(a, b, c) → flat array of non-null values. Nested arrays
      // flatten one level so MULTI mixed with traversal results behaves
      // intuitively.
      const flat: unknown[] = [];
      for (const v of args) {
        if (v == null) continue;
        if (Array.isArray(v)) flat.push(...v.filter((x) => x != null));
        else flat.push(v);
      }
      return flat;
    }
    case 'split': {
      // SPLIT(str, sep) → array of trimmed, non-empty parts. Defaults to
      // ',' when sep is omitted so SPLIT(domains) Just Works on comma-
      // delimited strings.
      if (args[0] == null) return [];
      const sep = args[1] == null ? ',' : String(args[1]);
      return String(args[0])
        .split(sep)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    default:
      throw new Error(`Unknown function: ${fn}`);
  }
}
