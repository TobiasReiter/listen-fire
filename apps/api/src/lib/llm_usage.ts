import { AsyncLocalStorage } from 'node:async_hooks';

import { sql } from 'kysely';

import type { Resolved } from 'movement-engine/lib/models/map';
import type { TeamId } from '../generated/kysely/core/Team';
import type { DealflowPipelineId } from '../generated/kysely/public/DealflowPipeline';
import type { AgentConversationId } from '../generated/kysely/public/AgentConversation';
import type { TriggerRunId } from '../generated/kysely/automations/TriggerRun';

import { isInsideSpendMeter, reportRunCost } from 'movement-engine/lib/run_spend';
import { costMicrodollars } from 'movement-engine/lib/models/pricing';
import { models } from 'movement-engine/lib/models/registry';
import { logger } from 'movement-engine/services/logger';
import { getQb } from './kysely';

// -- Context --

/**
 * The cancel gate the LLM chokepoint reads off the same AsyncLocalStorage
 * context (runs-and-cancel spec §cancel) — a structural type here (not an
 * import) so `llm_usage.ts` stays free of a dependency on the movement-engine
 * layer. The concrete gate lives in `services/movement_engine/cancel_gate.ts`.
 *
 * The read is async because it has to be: a cached last-known value could only
 * ever repeat what the interpreter's statement-boundary check already knew, and
 * the boundaries reading this sink are all INSIDE a statement, where that check
 * is not going to run until the statement is over.
 */
interface CancelSink {
  /** Re-read (debounced) and latch — throws `RunCancelledSignal` at the next
   *  in-statement boundary when true. */
  cancelled(): Promise<boolean>;
}

interface LlmUsageContextData {
  teamId: string;
  pipelineId?: string;
  conversationId?: string;
  /** The trigger_run this LLM call attributes to (movement firings) — threaded
   *  onto each `llm_usage` row for the per-run rollup (billing spec §2.3). */
  triggerRunId?: string;
  /** The run's cancel gate — every boundary inside a statement (LLM calls,
   *  plugin invocations) reads it here (runs-and-cancel spec §cancel).
   *  Absent ⇒ not a cancellable firing. */
  cancelGate?: CancelSink;
}

const asyncLocalStorage = new AsyncLocalStorage<LlmUsageContext>();

class LlmUsageContext {
  data: LlmUsageContextData;

  constructor(data: LlmUsageContextData) {
    this.data = data;
  }

  async runAsync<T>(fn: () => Promise<T>): Promise<T> {
    return asyncLocalStorage.run(this, fn);
  }
}

function currentLlmUsageContext(): LlmUsageContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * The run a log line belongs to, as structured log fields — spread into any
 * `logger.*` call made underneath a movement firing.
 *
 * A plugin logs what it is doing (the URL it is fetching, the characters it
 * got back), but a log line with no run on it cannot answer the question
 * anyone actually asks of it — "what was THIS run waiting on for seven
 * minutes?". The firing already establishes this context around everything it
 * calls, so the correlation costs nothing to carry; it was simply never
 * carried. Outside a firing the bag is empty and the line is unchanged.
 */
function runFields(): { runId?: string } {
  const runId = currentLlmUsageContext()?.data.triggerRunId;
  return runId ? { runId } : {};
}

// -- Pricing --

// The prices are data, in movement-engine's prices.json (see pricing.ts for sources).

/**
 * Keys already complained about. An unpriced key records a real token count at
 * zero cost — usage that reads as free rather than as missing — and the only
 * thing that distinguishes the two is somebody being told. Once per key per
 * process: the same unpriced key is called thousands of times a day, and a
 * warning per call is a warning nobody reads.
 */
const unpricedKeysWarned = new Set<string>();

function pricingKey(served: Served): string {
  return `${served.provider}/${served.wireModel}`;
}

/** Where an unpriced key came from, in the terms an operator changes: the map
 *  line that produced it, or the map's silence about that name. */
function originOf(served: Served): string {
  if (served.provider === 'jev') return 'Jev, which no MODEL_MAP line routes';
  const key = pricingKey(served);
  const { home } = models[served.preferred];
  return served.provider === home && served.wireModel === served.preferred
    ? `"${served.preferred}", which MODEL_MAP does not mention, so it went to its home vendor as ${key}`
    : `the MODEL_MAP line "${served.preferred}": "${key}"`;
}

function calculateCostMicrodollars(options: {
  served: Served;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const key = pricingKey(options.served);
  const cost = costMicrodollars(key, options);
  if (cost === undefined) {
    if (!unpricedKeysWarned.has(key)) {
      unpricedKeysWarned.add(key);
      logger.warn(
        `[llm_usage] no price for "${key}" (from ${originOf(options.served)}) — its usage is recorded ` +
          'at zero cost. Add it to movement-engine/lib/models/prices.json.',
      );
    }
    return 0;
  }
  return cost;
}

// -- Recording --

/** Jev is Typesafe AI's non-generative judge (`lib/jev/client.ts`): a vendor
 *  of its own that the model map never routes, so it has no preferred name. */
interface JevCall {
  provider: 'jev';
  wireModel: string;
}

/** Who answered a call and under what name. */
type Served = Resolved | JevCall;

interface RecordUsageOptions {
  /** What the model map resolved the call to — the `Resolved` the caller
   *  already holds from `chatCallFor` or `resolveModel`, never rebuilt. */
  resolved: Served;
  callType: 'chat' | 'structured' | 'tool_loop' | 'embedding' | 'image' | 'responses';
  label?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
}

async function recordLlmUsage(options: RecordUsageOptions): Promise<void> {
  const ctx = currentLlmUsageContext();
  const teamId = ctx?.data.teamId;
  const insideRun = isInsideSpendMeter();

  if (!teamId && !insideRun) return;

  const { resolved } = options;
  const costMicrodollars = calculateCostMicrodollars({
    served: resolved,
    inputTokens: options.inputTokens,
    outputTokens: options.outputTokens,
    cacheReadTokens: options.cacheReadTokens ?? 0,
    cacheCreationTokens: options.cacheCreationTokens ?? 0,
  });
  // Charged before the first await: most callers do not await this, and the
  // run's next priced call must already see what this one cost.
  reportRunCost({ source: { kind: 'model', name: resolved.wireModel }, microdollars: costMicrodollars });

  if (!teamId) return;

  try {
    await getQb(['llm_usage'])
      .insertInto('llm_usage')
      .values({
        team_id: teamId as TeamId,
        provider: resolved.provider,
        model: resolved.wireModel,
        preferred_model: resolved.provider === 'jev' ? null : resolved.preferred,
        call_type: options.callType,
        label: options.label ?? null,
        input_tokens: options.inputTokens,
        output_tokens: options.outputTokens,
        cache_read_tokens: options.cacheReadTokens ?? 0,
        cache_creation_tokens: options.cacheCreationTokens ?? 0,
        cost_microdollars: costMicrodollars,
        duration_ms: options.durationMs ?? null,
        pipeline_id: (ctx?.data.pipelineId ?? null) as DealflowPipelineId | null,
        conversation_id: (ctx?.data.conversationId ?? null) as AgentConversationId | null,
        trigger_run_id: (ctx?.data.triggerRunId ?? null) as TriggerRunId | null,
      })
      .execute();
  } catch (err) {
    logger.error('[llm_usage] Failed to record usage', { error: err });
  }
}

// -- Per-run rollup --

/** One run's model-cost account, rolled up from its `llm_usage` rows. */
interface RunCostSummary {
  runId: string;
  costMicrodollars: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Roll up `llm_usage` for a set of runs, in one grouped query — the run
 * history view shows every run's cost, and fetching that per row would be
 * N+1 against a table that already carries `trigger_run_id`. Runs with no
 * usage rows (nothing billed — no model calls, or calls predating the
 * `trigger_run_id` column) are simply absent from the returned map; callers
 * treat a miss as zero.
 */
async function runCostSummaries(runIds: TriggerRunId[]): Promise<Map<string, RunCostSummary>> {
  if (runIds.length === 0) return new Map();

  const rows = await getQb(['llm_usage'])
    .selectFrom('llm_usage')
    .select([
      'trigger_run_id',
      sql<number>`count(*)::int`.as('calls'),
      sql<number>`sum(input_tokens)::int`.as('input_tokens'),
      sql<number>`sum(output_tokens)::int`.as('output_tokens'),
      sql<number>`sum(cost_microdollars)::int`.as('cost_microdollars'),
    ])
    .where('trigger_run_id', 'in', runIds)
    .groupBy('trigger_run_id')
    .execute();

  const result = new Map<string, RunCostSummary>();
  for (const row of rows) {
    if (!row.trigger_run_id) continue;
    result.set(row.trigger_run_id, {
      runId: row.trigger_run_id,
      costMicrodollars: row.cost_microdollars,
      calls: row.calls,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    });
  }
  return result;
}

/** Microdollars → USD, rounded to 4 decimal places — the MCP surface's
 *  `costUsd`, precise enough to show sub-cent cost without float noise. */
function costMicrodollarsToUsd(microdollars: number): number {
  return Math.round(microdollars / 100) / 10000;
}

/** Which runs' usage lines to unlink: an explicit set, or every run of a team. */
type LlmUsageRunScope = { runIds: TriggerRunId[] } | { teamId: TeamId };

/**
 * Null the `trigger_run_id` of the scoped usage rows — by hand, exactly what
 * the ON DELETE SET NULL did before `llm_usage` (public) and `trigger_run`
 * (automations) ended up in different schemas with no constraint between them
 * (D3). The two paths that delete runs — the retention prune and
 * `dev:seed --reset` — call this alongside the delete, so the usage side is
 * released explicitly rather than rotting into orphans nobody notices.
 */
async function releaseLlmUsageRunReferences(scope: LlmUsageRunScope): Promise<void> {
  const qb = getQb(['llm_usage']);
  if ('runIds' in scope) {
    if (scope.runIds.length === 0) return;
    await qb
      .updateTable('llm_usage')
      .set({ trigger_run_id: null })
      .where('trigger_run_id', 'in', scope.runIds)
      .execute();
    return;
  }
  await qb
    .updateTable('llm_usage')
    .set({ trigger_run_id: null })
    .where('team_id', '=', scope.teamId)
    .execute();
}

export {
  LlmUsageContext,
  calculateCostMicrodollars,
  costMicrodollarsToUsd,
  currentLlmUsageContext,
  recordLlmUsage,
  releaseLlmUsageRunReferences,
  runCostSummaries,
  runFields,
};
export type { RecordUsageOptions, RunCostSummary };
