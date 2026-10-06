// The production `EngineHost`: the world a movement run reaches, wired to the
// real systems — the adapter registry, Anthropic, the trigger-run recorder's
// durable parks, Postgres record bindings and raw text, the document store.

import type { ResolveFile } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import { getAutomationsQb } from '../../../lib/kysely';
import { DocumentService } from '../../document';
import { makeRecorderCallbackSink } from '../../movement_engine/callback_sink';
import type { ActingUserTriggerRow, MovementTraceEntry } from '../../movement_engine/expression';
import { makeAnthropicLlmClient, registryTransformInvoker } from '../../movement_engine/extraction';
import { makeAnthropicExtractCallClient } from '../../movement_engine/extraction_call';
import { makeFileTextResolver } from '../../movement_engine/file_text';
import { NEVER_CANCELLED, type EngineHost } from '../../movement_engine/host';
import { makeRecorderParkSink } from '../../movement_engine/park_sink';
import { postgresRawTextStore } from '../../movement_engine/raw_text_store';
import { postgresRecordBindings } from '../../movement_engine/record_binding';
import type { CancelGate } from '../../movement_engine/run';
import { InMemoryWriteLocks } from '../../write_locks/write_locks';
import { resolveAdapter } from '../adapters/resolve';
import type { TriggerRunRecorder } from '../runs/trigger_run';

// Runs in one process exclude each other without a database.
const PROCESS_WRITE_LOCKS = new InMemoryWriteLocks();

export function productionEngineHost(input: {
  teamId: TeamId;
  /** The team catalog's credential and file-import resolution. */
  catalog: {
    resolveCredentialId: (credentialName: string) => string | undefined;
    resolveFile: ResolveFile;
  };
  /** The run whose parks and callbacks persist through this recorder. Absent ⇒
   *  no durable substrate: a dry run never parks or mints a callback. */
  parksInto?: TriggerRunRecorder;
  /** Absent ⇒ the run is never cancelled. */
  cancel?: CancelGate;
  trace?: MovementTraceEntry[];
}): EngineHost {
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
      credentialId: input.catalog.resolveCredentialId,
    },
    llm: {
      client: makeAnthropicLlmClient(),
      extractCall: makeAnthropicExtractCallClient(),
      transforms: registryTransformInvoker,
    },
    park: {
      ...(input.parksInto !== undefined
        ? {
            sink: makeRecorderParkSink(input.parksInto),
            callbacks: makeRecorderCallbackSink(input.parksInto, input.teamId),
          }
        : {}),
      bindings: postgresRecordBindings,
    },
    control: { cancel: input.cancel ?? NEVER_CANCELLED },
    files: {
      resolveFile: input.catalog.resolveFile,
      resolveFileText: makeFileTextResolver(postgresRawTextStore),
      rawText: postgresRawTextStore,
      documents: { getById: (id) => DocumentService.getById(id) },
    },
    lookup: { triggerForActingUser },
    locks: PROCESS_WRITE_LOCKS,
    ...(input.trace !== undefined ? { trace: input.trace } : {}),
  };
}

async function triggerForActingUser(triggerId: string): Promise<ActingUserTriggerRow | null> {
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', triggerId as never)
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
