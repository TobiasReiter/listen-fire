// The production `EngineHost`: the world a movement run reaches, wired to the
// real systems — the adapter registry behind each segment's scope, Anthropic
// and the plugin registry, the trigger-run recorder's durable parks, Postgres
// record bindings, file text and rendering, cross-run write locks, and
// Listen-Fire's acting-user resolution.

import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { getAutomationsQb } from '../../../lib/kysely';
import { LlmUsageContext } from '../../../lib/llm_usage';
import type { Budget, CostLine } from '../../../lib/run_cost';
import { withSpendMeter } from '../../../lib/run_spend';
import { enqueueAwaitWake } from '../../movement_engine/await_wake';
import { makeRecorderCallbackSink } from '../../movement_engine/callback_sink';
import type { MovementTraceEntry } from '../../movement_engine/expression';
import type { ExtractCallLlmClient } from '../../movement_engine/extraction_call';
import {
  NEVER_CANCELLED,
  type Costed,
  type EngineHost,
  type HostExtractCallClient,
  type HostLlmClient,
  type HostTransformInvoker,
  type ResolveActingUserInput,
  type ResolveFileText,
} from '../../movement_engine/host';
import { makeRecorderParkSink } from '../../movement_engine/park_sink';
import type { CancelGate } from '../../movement_engine/run';
import { notifyWork } from '../../work/drain';
import { PostgresWriteLocks } from '../../write_locks/postgres';
import { parseWriteLockTimeoutMs, WRITE_LOCK_TIMEOUT_ENV_VAR, type WriteLocks } from '../../write_locks/write_locks';
import type { ActingUser } from '../adapter';
import { resolveActingUser } from '../adapters/acting_user/resolve';
import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';
import { resolveAdapter } from '../adapters/resolve';
import type { LlmClient } from '../engine/batched_extraction';
import { meteredArbitration } from '../engine/entity_match';
import { hostSegments, segmentBoundAdapter } from '../segment_scope';
import type { TriggerRunRecorder } from '../runs/trigger_run';
import { renderFileArtifact } from './file_render';
import { makeFileTextResolver, type FileTextReader } from './file_text';
import { makeAnthropicExtractCallClient, makeAnthropicLlmClient } from './llm_clients';
import { postgresRawTextStore, type RawTextStore } from './raw_text_store';
import { postgresRecordBindings } from './record_bindings';
import { registryTransformInvoker } from './transform_invoker';

export function productionEngineHost(input: {
  teamId: TeamId;
  /** Credential import name → credential id, from the team's catalog
   *  snapshot. File imports need nothing here: the snapshot carries the files. */
  credentialIds: Readonly<Record<string, string>>;
  /** The run the host's model, plugin and file-text calls are billed to. Absent
   *  ⇒ they run under whatever llm-usage context the caller holds (a test run:
   *  none, so nothing is billed to the team). */
  triggerRunId?: TriggerRunId;
  /** The run whose parks and callbacks persist through this recorder. Absent ⇒
   *  no durable substrate: a dry run never parks or mints a callback. */
  parksInto?: TriggerRunRecorder;
  /** Absent ⇒ the run is never cancelled. */
  cancel?: CancelGate;
  trace?: MovementTraceEntry[];
  /** Where file text is stored. Absent ⇒ the team's `raw_text` table. */
  rawText?: RawTextStore;
  /** The cross-run write locks. Absent ⇒ the process's Postgres advisory
   *  locks. */
  locks?: WriteLocks;
}): EngineHost {
  const cancel = input.cancel ?? NEVER_CANCELLED;
  const usage = usageScope({ teamId: input.teamId, triggerRunId: input.triggerRunId, cancel });
  return {
    segment: hostSegments,
    adapters: {
      // Production resolution is per (type, credential, construction args); the
      // role is a test seam. The instance answers inside the segment it was
      // resolved for.
      resolve: async ({ adapterType, teamId, credentialsId, constructionArgs, segmentId }) =>
        segmentBoundAdapter(
          await resolveAdapter({
            adapterType,
            teamId,
            credentialsId,
            ...(constructionArgs !== undefined ? { constructionArgs } : {}),
          }),
          segmentId,
        ),
      credentialId: (credentialName) =>
        Object.hasOwn(input.credentialIds, credentialName)
          ? input.credentialIds[credentialName]
          : undefined,
    },
    llm: {
      client: billedLlmClient(makeAnthropicLlmClient({ cancel }), usage),
      extractCall: billedExtractCallClient(makeAnthropicExtractCallClient({ cancel }), usage),
      transforms: billedTransforms(registryTransformInvoker, usage),
      // The judge is a model call like any other.
      arbitrateEntities: (arbitration) => usage(() => meteredArbitration(arbitration)),
    },
    park: {
      ...(input.parksInto !== undefined
        ? {
            sink: makeRecorderParkSink(input.parksInto),
            callbacks: makeRecorderCallbackSink(input.parksInto, input.teamId),
          }
        : {}),
      // A `wake_await` work row, so the wake outlives this process.
      wake: async (request) => {
        await enqueueAwaitWake(request);
        notifyWork();
      },
      bindings: postgresRecordBindings,
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
    lookup: { resolveActingUser: resolveTeamActingUser },
    locks: input.locks ?? processWriteLocks(),
    ...(input.trace !== undefined ? { trace: input.trace } : {}),
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
): Promise<Costed<Output>> {
  const { value, cost } = await withSpendMeter(request.budget, () => call(request));
  const lines: CostLine[] = [...cost, ...(value.cost ?? [])];
  return { ...value, cost: lines };
}

function billedLlmClient(client: LlmClient, usage: UsageScope): HostLlmClient {
  return { call: (request) => usage(() => metered(request, (input) => client.call(input))) };
}

function billedExtractCallClient(client: ExtractCallLlmClient, usage: UsageScope): HostExtractCallClient {
  return { call: (request) => usage(() => metered(request, (input) => client.call(input))) };
}

function billedTransforms(invoker: HostTransformInvoker, usage: UsageScope): HostTransformInvoker {
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
async function resolveTeamActingUser(input: ResolveActingUserInput): Promise<ActingUser | null> {
  const trigger = input.triggerId !== undefined ? await loadActingUserTrigger(input.triggerId) : undefined;
  return resolveActingUser({
    teamId: input.teamId,
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
