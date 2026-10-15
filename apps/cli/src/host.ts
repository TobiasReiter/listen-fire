// The local run host: every EngineHost family served from the project folder.
// adapters → the externals, through the hosted product's own adapter table
// and remote adapter, each call inside the segment's scope (call ceiling) ·
// parks, trace, run log → SQLite · locks → in process · files → the document
// store's local backend (`.lf/files/`) · acting user → a local identity ·
// model calls → the provider key in the secrets file.

import { userInfo } from 'node:os';
import { tenantIdOf, type ActingPrincipal, type TenantId } from 'engine-contracts';
import type { EngineHost } from 'movement-engine/services/movement_engine/host';
import { adapterTable } from 'movement-engine/services/translation_graph/engine/adapter_table';
import type { DryRunWriteSink } from 'movement-engine/services/translation_graph/engine/dry_run_adapter';
import { redeemFileRef } from 'movement-engine/services/translation_graph/engine/files/redeem';
import { withFileOwners } from 'movement-engine/services/translation_graph/engine/files/file_owners';
import { hostSegments, segmentScopedCalls } from 'movement-engine/services/translation_graph/segment_scope';
import {
  closeSegmentWith,
  NEVER_CANCELLED,
  openSegmentWith,
  RANDOM_IDS,
  SegmentDirectory,
  WALL_CLOCK,
} from 'movement-engine/services/movement_engine/host_kit';
import { InMemoryWriteLocks, segmentWriteLocks } from 'movement-engine/services/write_locks/write_locks';
import type { ParkSink } from 'movement-engine/services/movement_engine/run';
import type { LocalDocumentStore } from './documents';
import { credentialFor, type RunningExternal } from './externals';
import { modelCalls } from './models';
import type { Project } from './project';
import { remoteAdapterOf } from './remote';
import type { Credential } from './secrets';
import type { State } from './state';

/** The one tenant a local project is. */
export const LOCAL_TENANT = 'local';

/** The developer running lf, as the principal an event acts as. STUB: one
 *  identity for every event; no mapping from an event's actor to a user. */
export function localIdentity(env: NodeJS.ProcessEnv = process.env): ActingPrincipal {
  const name = env.LF_USER ?? userInfo().username;
  return { principal: { id: `local:${name}`, display: name }, email: env.LF_USER_EMAIL ?? `${name}@localhost` };
}

export interface LocalHostParts {
  project: Project;
  state: State;
  externals: Map<string, RunningExternal>;
  credentials: Map<string, Credential>;
  /** The engine a parked run's state was written by, stamped on each park. */
  engine: 'rust' | 'ts';
  documents: LocalDocumentStore;
  /** Receives each write a rehearsed (dry-run) instance captured instead of
   *  making it. */
  writeSink?: DryRunWriteSink;
}

/**
 * The host for one run entry (a firing or a resume) of `runId`. A park the
 * engine commits is written to the state's park table; a timer park also
 * queues its wake for `lf serve`.
 */
export function localHost(parts: LocalHostParts & { runId: string }): EngineHost {
  const { project, state, externals, credentials } = parts;
  const segments = new SegmentDirectory();
  const locks = segmentWriteLocks(new InMemoryWriteLocks());
  // The hosted product's table: a rehearsed instance captures its writes
  // instead of making them, and every call runs inside its segment's scope,
  // where a remote adapter's calls count against the segment's ceiling.
  const adapters = adapterTable({
    segments,
    resolveLive: ({ adapterType, credentialsId, teamId }) => {
      const running = externals.get(adapterType);
      if (running === undefined) {
        throw new Error(`no external "${adapterType}" in ${project.externalsDir} (install it as a folder there)`);
      }
      // A credential's id is its name in the secrets file.
      const credential = credentialsId !== undefined ? credentials.get(credentialsId) : credentialFor(credentials, adapterType);
      if (credentialsId !== undefined && credential === undefined) {
        throw new Error(`no credential "${credentialsId}" in the secrets file`);
      }
      return remoteAdapterOf({ running, credential, documents: parts.documents, tenant: teamId });
    },
    ...segmentScopedCalls,
    ...(parts.writeSink !== undefined ? { writeSink: parts.writeSink } : {}),
  });

  const parkSink: ParkSink = {
    recordJoin: async ({ frameAddress, parkedChildren }) => state.recordJoin(parts.runId, frameAddress, parkedChildren),
    commitTimerPark: async ({ address, state: parked, wakeAt }) => {
      state.addPark({ run_id: parts.runId, kind: 'timer', address, wake_at: wakeAt, adapter_type: null, correlation_key: null, state: JSON.stringify(parked), engine: parts.engine });
      state.enqueue('resume', wakeAt, { runId: parts.runId });
    },
    commitAwaitPark: async ({ address, state: parked, adapterType, correlationKey }) => {
      state.addPark({ run_id: parts.runId, kind: 'await', address, wake_at: null, adapter_type: adapterType, correlation_key: correlationKey, state: JSON.stringify(parked), engine: parts.engine });
    },
    decrementJoin: async ({ frameAddress }) => state.decrementJoin(parts.runId, frameAddress),
    // THIN: branch exports of a parked join are not persisted yet, so a run
    // whose parked combinator arms export values resumes without them.
    persistBranchExport: async () => {},
    collectBranchExports: async () => [],
    cancelSubtrees: async ({ subtreeAddresses }) => state.dropParks(parts.runId, subtreeAddresses),
    commitSuspension: async ({ address, state: parked }) => {
      state.addPark({ run_id: parts.runId, kind: 'suspension', address, wake_at: null, adapter_type: null, correlation_key: null, state: JSON.stringify(parked), engine: parts.engine });
    },
  };

  const bindings = new Map<string, unknown>();
  const models = modelCalls(credentials);

  return {
    segment: {
      open: (input) => openSegmentWith(input, { segments, locks, open: hostSegments.open }),
      close: (input) => closeSegmentWith(input, { segments, table: adapters, locks, close: hostSegments.close }),
    },
    adapters: { resolve: (resolution) => adapters.resolve(resolution), call: (call) => adapters.call(call) },
    llm: models,
    park: {
      sink: {
        recordJoin: ({ segmentId: _s, ...input }) => parkSink.recordJoin(input),
        commitTimerPark: ({ segmentId: _s, ...input }) => parkSink.commitTimerPark(input),
        commitAwaitPark: ({ segmentId: _s, ...input }) => parkSink.commitAwaitPark(input),
        decrementJoin: ({ segmentId: _s, ...input }) => parkSink.decrementJoin(input),
        persistBranchExport: ({ segmentId: _s, ...input }) => parkSink.persistBranchExport(input),
        collectBranchExports: ({ segmentId: _s, ...input }) => parkSink.collectBranchExports(input),
        cancelSubtrees: ({ segmentId: _s, ...input }) => parkSink.cancelSubtrees(input),
        commitSuspension: ({ segmentId: _s, ...input }) => parkSink.commitSuspension!(input),
      },
      // STUB: an await's wake is not queued; `lf resume` re-enters await
      // parks, and the external's push door (`/hooks/<external>/wake`) is
      // not served yet.
      wake: async () => {},
      // THIN: record bindings live for the process only.
      bindings: {
        record: async ({ from, to }) => {
          bindings.set(JSON.stringify(from), to);
        },
        findBoundCounterpart: async () => null,
        delete: async ({ from }) => {
          bindings.delete(JSON.stringify(from));
        },
      },
    },
    control: { cancel: NEVER_CANCELLED },
    files: {
      // THIN: only a text file is read; the hosted extractors (PDF text
      // layer, OCR, decks, sheets, transcription) are not wired here.
      resolveFileText: async ({ segmentId, file }) => {
        const tenantId = segments.facts(segmentId).teamId;
        const type = file.contentType ?? '';
        if (!type.startsWith('text/')) return { unreadable: 'unsupported_type', detail: `lf reads only text files, not ${type || 'an untyped file'}`, cost: [] };
        try {
          const { stream } = await withFileOwners(adapters.fileOwners(segmentId), () =>
            redeemFileRef(file, { tenantId, documents: parts.documents }),
          );
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const text = Buffer.concat(chunks).toString('utf8');
          return text.trim() === '' ? { unreadable: 'no_text', cost: [] } : { text, cost: [] };
        } catch (error) {
          return { unreadable: 'bytes_unavailable', detail: error instanceof Error ? error.message : String(error), cost: [] };
        }
      },
      // THIN: a "pdf" is stored as its text.
      render: ({ segmentId, content, type }) =>
        parts.documents.put({
          tenantId: segments.facts(segmentId).teamId,
          bytes: Buffer.from(content, 'utf8'),
          name: type === 'pdf' ? 'movement-artifact.pdf' : 'movement-artifact.txt',
          contentType: type === 'pdf' ? 'application/pdf' : 'text/plain',
        }),
    },
    lookup: { resolveActingUser: async () => localIdentity() },
    locks: { acquire: (input) => locks.acquire(input), release: (input) => locks.release(input) },
    trace: {
      append: async ({ entries }) => state.appendTrace(parts.runId, entries),
    },
    clock: WALL_CLOCK,
    ids: RANDOM_IDS,
  };
}

export function tenant(): TenantId {
  return tenantIdOf(LOCAL_TENANT);
}
