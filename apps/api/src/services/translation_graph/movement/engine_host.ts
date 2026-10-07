// The production `EngineHost`: the world a movement run reaches, wired to the
// real systems — the adapter registry, Anthropic and the plugin registry, the
// trigger-run recorder's durable parks, Postgres record bindings, file text and
// rendering, cross-run write locks, and Listen-Fire's acting-user resolution.

import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { getAutomationsQb } from '../../../lib/kysely';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { enqueueAwaitWake } from '../../movement_engine/await_wake';
import { makeRecorderCallbackSink } from '../../movement_engine/callback_sink';
import type { MovementTraceEntry } from '../../movement_engine/expression';
import type { MovementTransformInvoker } from '../../movement_engine/extraction';
import type { ExtractCallLlmClient } from '../../movement_engine/extraction_call';
import {
  NEVER_CANCELLED,
  type EngineHost,
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
import { arbitrateEntityCandidates } from '../engine/entity_match';
import type { TriggerRunRecorder } from '../runs/trigger_run';
import { renderFileArtifact } from './file_render';
import { makeFileTextResolver } from './file_text';
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
    adapters: {
      // Production resolution is per (type, credential, construction args); the
      // role is a test seam.
      resolve: ({ adapterType, teamId, credentialsId, constructionArgs }) =>
        resolveAdapter({
          adapterType,
          teamId,
          credentialsId,
          ...(constructionArgs !== undefined ? { constructionArgs } : {}),
        }),
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
      arbitrateEntities: (arbitration) => usage(() => arbitrateEntityCandidates(arbitration)),
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

// ── Billing: the llm-usage context, set around each call ───────────────────
//
// Every model call below the host records its usage against the ambient
// `LlmUsageContext`. The host sets it explicitly around each of its own calls
// rather than relying on the caller having set it around the whole run, so the
// engine never depends on that ambient state: what a call is billed to is the
// host's decision, made where the call leaves for the world.

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

function billedLlmClient(client: LlmClient, usage: UsageScope): LlmClient {
  return { call: (input) => usage(() => client.call(input)) };
}

function billedExtractCallClient(client: ExtractCallLlmClient, usage: UsageScope): ExtractCallLlmClient {
  return { call: (input) => usage(() => client.call(input)) };
}

function billedTransforms(invoker: MovementTransformInvoker, usage: UsageScope): MovementTransformInvoker {
  return {
    invoke: (input) => usage(() => invoker.invoke(input)),
    ...(invoker.declaredOutput !== undefined ? { declaredOutput: invoker.declaredOutput } : {}),
    ...(invoker.isPriced !== undefined ? { isPriced: invoker.isPriced } : {}),
  };
}

function billedFileText(resolve: ResolveFileText, usage: UsageScope): ResolveFileText {
  return (request) => usage(() => resolve(request));
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
