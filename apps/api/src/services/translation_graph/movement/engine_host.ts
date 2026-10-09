// The production `EngineHost`: the world a movement run reaches, wired to the
// real systems — the adapter registry behind each segment's scope, Anthropic
// and the plugin registry, the trigger-run recorder's durable parks, Postgres
// record bindings, file text and rendering, cross-run write locks, and
// Listen-Fire's acting-user resolution.

import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TenantId } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementTraceEntry } from '../../movement_engine/expression';
import type { ExtractCallLlmClient } from '../../movement_engine/extraction_call';
import type {
  Costed,
  EngineHost,
  HostExtractCallClient,
  HostLlmClient,
  HostTransformInvoker,
  PricedAnswer,
  ResolveFileText,
} from '../../movement_engine/host';
import type { CancelGate } from '../../movement_engine/run';
import type { ActingUser } from '../adapter';
import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';
import type { LlmClient } from '../engine/batched_extraction';
import type { DryRunWriteSink } from '../engine/dry_run_adapter';
import type { TriggerRunRecorder } from '../runs/trigger_run';

import { getAutomationsQb } from '../../../lib/kysely';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { isBudgetExhausted, type Budget, type CostLine } from '../../../lib/run_cost';
import { withSpendMeter } from '../../../lib/run_spend';
import { enqueueAwaitWake } from '../../movement_engine/await_wake';
import { makeRecorderCallbackSink } from '../../movement_engine/callback_sink';
import {
  actingPrincipalOf,
  appendingInto,
  closeSegmentWith,
  NEVER_CANCELLED,
  RANDOM_IDS,
  WALL_CLOCK,
  openSegmentWith,
  SegmentDirectory,
  type ActingUserLookup,
} from '../../movement_engine/host_kit';
import { makeRecorderParkSink } from '../../movement_engine/park_sink';
import { notifyWork } from '../../work/drain';
import { PostgresWriteLocks } from '../../write_locks/postgres';
import {
  parseWriteLockTimeoutMs,
  segmentWriteLocks,
  WRITE_LOCK_TIMEOUT_ENV_VAR,
  type WriteLocks,
} from '../../write_locks/write_locks';
import { resolveActingUser } from '../adapters/acting_user/resolve';
import { resolveAdapter } from '../adapters/resolve';
import { meteredArbitration } from '../engine/entity_match';
import { adapterTable, type LiveAdapterResolver } from '../engine/adapter_table';
import { hostSegments, segmentScopedCalls } from '../segment_scope';
import { renderFileArtifact } from './file_render';
import { teamOfTenant } from './tenant';
import { makeFileTextResolver, type FileTextReader } from './file_text';
import { makeAnthropicExtractCallClient, makeAnthropicLlmClient } from './llm_clients';
import { postgresRawTextStore, type RawTextStore } from './raw_text_store';
import { deleteBinding, findBoundCounterpart, recordBinding } from './record_bindings';
import { registryTransformInvoker, type TransformInvoker } from './transform_invoker';

export function productionEngineHost(input: {
  teamId: TeamId;
  /** Where live adapter instances come from. Absent ⇒ the adapter registry
   *  (a dev probe supplies a client pointed at its fake server). */
  resolveLive?: LiveAdapterResolver;
  /** Receives each write a rehearsed (`dryRun`) target captured. */
  writeSink?: DryRunWriteSink;
  /** The run the host's model, plugin and file-text calls are billed to. Absent
   *  ⇒ they run under whatever llm-usage context the caller holds (a test run:
   *  none, so nothing is billed to the team). */
  triggerRunId?: TriggerRunId;
  /** The run whose parks and callbacks persist through this recorder. Absent ⇒
   *  no durable substrate: a dry run never parks or mints a callback. */
  parksInto?: TriggerRunRecorder;
  /** The run lease the segment steps under: every park it commits lands only
   *  while the run is still leased to it. */
  lease?: { token: string };
  /** Absent ⇒ the run is never cancelled. */
  cancel?: CancelGate;
  /** Where the run's trace is appended as it goes, so a caller can publish it
   *  before the run settles. */
  trace?: MovementTraceEntry[];
  /** Where file text is stored. Absent ⇒ the team's `raw_text` table. */
  rawText?: RawTextStore;
  /** The cross-run write locks. Absent ⇒ the process's Postgres advisory
   *  locks. */
  locks?: WriteLocks;
}): EngineHost {
  const cancel = input.cancel ?? NEVER_CANCELLED;
  const usage = usageScope({ teamId: input.teamId, triggerRunId: input.triggerRunId, cancel });
  // Every call names its segment; the team it is for is the segment's.
  const segments = new SegmentDirectory();
  const tenantOf = (segmentId: string): TenantId => segments.facts(segmentId).teamId;
  const teamOf = (segmentId: string): TeamId => teamOfTenant(tenantOf(segmentId));
  // The live instances, per segment. Production resolution is per (type,
  // credential, construction args); the role is a test seam. Each call runs
  // inside the segment it was resolved for.
  const adapters = adapterTable({
    segments,
    resolveLive:
      input.resolveLive ??
      (({ adapterType, teamId, credentialsId, constructionArgs }) =>
        resolveAdapter({
          adapterType,
          teamId: teamOfTenant(teamId),
          credentialsId,
          ...(constructionArgs !== undefined ? { constructionArgs } : {}),
        })),
    ...segmentScopedCalls,
    ...(input.writeSink !== undefined ? { writeSink: input.writeSink } : {}),
  });
  // Each segment's cross-run lock session, closed with the segment.
  const locks = segmentWriteLocks(input.locks ?? processWriteLocks());
  return {
    segment: {
      open: (opening) => openSegmentWith(opening, { segments, locks, open: hostSegments.open }),
      close: (closing) =>
        closeSegmentWith(closing, { segments, table: adapters, locks, close: hostSegments.close }),
    },
    adapters: { resolve: (resolution) => adapters.resolve(resolution), call: (call) => adapters.call(call) },
    llm: {
      client: billedLlmClient(makeAnthropicLlmClient({ cancel }), usage),
      extractCall: billedExtractCallClient(makeAnthropicExtractCallClient({ cancel }), usage),
      transforms: billedTransforms(registryTransformInvoker, usage),
      // The judge is a model call like any other.
      arbitrateEntities: (arbitration) => usage(() => refusingPastBudget(() => meteredArbitration(arbitration))),
    },
    park: {
      ...(input.parksInto !== undefined
        ? {
            sink: makeRecorderParkSink(input.parksInto, input.lease !== undefined ? { lease: input.lease } : {}),
            callbacks: makeRecorderCallbackSink(input.parksInto, input.teamId),
          }
        : {}),
      // A `wake_await` work row, so the wake outlives this process.
      wake: async ({ segmentId, adapterType, correlationKey }) => {
        await enqueueAwaitWake({ adapterType, teamId: teamOf(segmentId), correlationKey });
        notifyWork();
      },
      bindings: {
        record: ({ segmentId, from, to }) => recordBinding({ teamId: teamOf(segmentId), from, to }),
        findBoundCounterpart: ({ segmentId, endpoint, counterpart }) =>
          findBoundCounterpart({
            teamId: teamOf(segmentId),
            endpoint,
            ...(counterpart !== undefined ? { counterpart } : {}),
          }),
        delete: ({ segmentId, from, to }) => deleteBinding({ teamId: teamOf(segmentId), from, to }),
      },
    },
    control: { cancel },
    files: {
      // OCR and transcription are model calls of their own.
      resolveFileText: billedFileText(
        makeFileTextResolver(input.rawText ?? postgresRawTextStore(input.teamId), { teamId: input.teamId }),
        usage,
      ),
      render: renderFileArtifact,
    },
    lookup: {
      // The source instance's parse of the event's actors, asked of it inside
      // its segment, only when the trigger does not already decide the user.
      resolveActingUser: async ({ triggerId, segmentId, instance, event }) =>
        actingPrincipalOf(
          await resolveTeamActingUser({
            teamId: tenantOf(segmentId),
            ...(triggerId !== undefined ? { triggerId } : {}),
            getCandidates: () => adapters.answer({ segmentId, instance, method: 'getActorCandidates', args: { event } }),
          }),
        ),
    },
    locks: { acquire: (request) => locks.acquire(request), release: (request) => locks.release(request) },
    ...(input.trace !== undefined ? { trace: appendingInto(input.trace) } : {}),
    clock: WALL_CLOCK,
    ids: RANDOM_IDS,
  };
}

// ── Billing and budget, set around each call ────────────────────────────────
//
// Every model call below the host records its usage against the ambient
// `LlmUsageContext`, and charges its price to the ambient spend meter. The host
// sets both explicitly around each of its own calls rather than relying on the
// caller having set them around the whole run, so the engine never depends on
// that ambient state: what a call is billed to, and the budget it may spend, are
// the host's to set where the call leaves for the world — the budget from the
// call's own request, what it spent back on its answer.

type UsageScope = <T>(call: () => Promise<T>) => Promise<T>;

function usageScope(input: {
  teamId: TeamId;
  triggerRunId: TriggerRunId | undefined;
  cancel: CancelGate;
}): UsageScope {
  const { triggerRunId } = input;
  if (triggerRunId === undefined) return (call) => call();
  return (call) =>
    new LlmUsageContext({ teamId: input.teamId, triggerRunId, cancelGate: input.cancel }).runAsync(call);
}

/** Serve one priced call under its request's budget; the answer comes back
 *  with every line spent — the meter's, and any the call reported of its own
 *  (a plugin's cost envelope). */
async function metered<Request extends { budget: Budget }, Output extends object>(
  request: Request,
  call: (request: Request) => Promise<Costed<Output>>,
): Promise<PricedAnswer<Output>> {
  return refusingPastBudget(async () => {
    const { value, cost } = await withSpendMeter(request.budget, () => call(request));
    const lines: CostLine[] = [...cost, ...(value.cost ?? [])];
    return { ...value, cost: lines };
  });
}

/** A priced call refused past its budget answers the refusal, with what it
 *  spent first, rather than throwing it across the boundary. */
async function refusingPastBudget<Output extends object>(
  call: () => Promise<Costed<Output>>,
): Promise<PricedAnswer<Output>> {
  try {
    return await call();
  } catch (error) {
    if (!isBudgetExhausted(error)) throw error;
    return { error: { kind: 'budget', message: error.message }, cost: error.cost };
  }
}

function billedLlmClient(client: LlmClient, usage: UsageScope): HostLlmClient {
  return { call: (request) => usage(() => metered(request, (input) => client.call(input))) };
}

function billedExtractCallClient(client: ExtractCallLlmClient, usage: UsageScope): HostExtractCallClient {
  return { call: (request) => usage(() => metered(request, (input) => client.call(input))) };
}

function billedTransforms(invoker: TransformInvoker, usage: UsageScope): HostTransformInvoker {
  return { invoke: (request) => usage(() => metered(request, (input) => invoker.invoke(input))) };
}

function billedFileText(read: FileTextReader, usage: UsageScope): ResolveFileText {
  return (request) => usage(() => metered(request, (input) => read(input)));
}

// ── Cross-run write locks ───────────────────────────────────────────────────

// One table per process: each segment's holder opens its own connection, so a
// shared instance costs nothing and keeps one lock timeout for every run.
let postgresWriteLocks: WriteLocks | undefined;

function processWriteLocks(): WriteLocks {
  if (postgresWriteLocks === undefined) {
    postgresWriteLocks = new PostgresWriteLocks({
      connectionString: lockDatabaseUrl(),
      timeoutMs: parseWriteLockTimeoutMs(process.env[WRITE_LOCK_TIMEOUT_ENV_VAR]),
    });
  }
  return postgresWriteLocks;
}

/** The database every other connection of this process uses (the variables
 *  `lib/pg.ts` and `lib/kysely.ts` read). The bare URL: `?schema=` is a Prisma
 *  parameter, and advisory locks are per database, not per schema. */
function lockDatabaseUrl(): string {
  const name = process.env.NODE_ENV === 'test' ? 'DATABASE_URL_TEST' : 'DATABASE_URL';
  const url = process.env[name];
  if (url === undefined || url === '') {
    throw new Error(`cross-run write locks need ${name}, which is not set`);
  }
  return url;
}

// ── Acting-user resolution ──────────────────────────────────────────────────

/** The trigger the event dispatched through decides first (its creator
 *  override and creator fallback); then the source adapter's candidates. A
 *  trigger that is gone reads as none. */
async function resolveTeamActingUser(input: ActingUserLookup): Promise<ActingUser | null> {
  const trigger = input.triggerId !== undefined ? await loadActingUserTrigger(input.triggerId) : undefined;
  return resolveActingUser({
    teamId: teamOfTenant(input.teamId),
    ...(trigger !== undefined ? { trigger } : {}),
    getCandidates: input.getCandidates,
  });
}

async function loadActingUserTrigger(triggerId: string): Promise<ActingUserTriggerContext | undefined> {
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    // The event carries the trigger's id as a plain string.
    .where('id', '=', triggerId as TriggerId)
    .select(['id', 'kind', 'config', 'created_by_user_id'])
    .executeTakeFirst();
  if (!row) return undefined;
  return { id: row.id, kind: row.kind, config: row.config, createdByUserId: row.created_by_user_id };
}
