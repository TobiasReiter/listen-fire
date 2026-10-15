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
import type { LocalDocumentStore } from './documents';
import { credentialFor, type RunningExternal } from './externals';
import { localFileText } from './files';
import { modelCalls } from './models';
import { localParkFamily } from './parks';
import type { Project } from './project';
import { remoteAdapterOf } from './remote';
import type { Credential } from './secrets';
import type { State } from './state';

/** The one tenant a local project is. */
export const LOCAL_TENANT = 'local';

/** The developer running lf, as the principal an event acts as: LF_USER /
 *  LF_USER_EMAIL, else lf.yaml's `user`, else the OS user. STUB: one identity
 *  for every event; no mapping from an event's actor to a user. The only host
 *  call that takes the acting principal is `lookup.resolveActingUser`. */
export function localIdentity(configured: Project['user'] = {}, env: NodeJS.ProcessEnv = process.env): ActingPrincipal {
  const name = env.LF_USER ?? configured.name ?? userInfo().username;
  return { principal: { id: `local:${name}`, display: name }, email: env.LF_USER_EMAIL ?? configured.email ?? `${name}@localhost` };
}

export interface LocalHostParts {
  project: Project;
  state: State;
  externals: Map<string, RunningExternal>;
  credentials: Map<string, Credential>;
  /** The engine a parked run's state was written by, stamped on each park:
   *  always Rust, the only engine lf runs. */
  engine: 'rust';
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

  const models = modelCalls(credentials);

  return {
    segment: {
      open: (input) => openSegmentWith(input, { segments, locks, open: hostSegments.open }),
      close: (input) => closeSegmentWith(input, { segments, table: adapters, locks, close: hostSegments.close }),
    },
    adapters: { resolve: (resolution) => adapters.resolve(resolution), call: (call) => adapters.call(call) },
    llm: models,
    park: localParkFamily({ state, runId: parts.runId, engine: parts.engine }),
    control: { cancel: NEVER_CANCELLED },
    files: {
      resolveFileText: async ({ segmentId, file }) =>
        localFileText({
          file,
          redeem: () =>
            withFileOwners(adapters.fileOwners(segmentId), () =>
              redeemFileRef(file, { tenantId: segments.facts(segmentId).teamId, documents: parts.documents }),
            ),
        }),
      // THIN: a "pdf" is stored as its text.
      render: ({ segmentId, content, type }) =>
        parts.documents.put({
          tenantId: segments.facts(segmentId).teamId,
          bytes: Buffer.from(content, 'utf8'),
          name: type === 'pdf' ? 'movement-artifact.pdf' : 'movement-artifact.txt',
          contentType: type === 'pdf' ? 'application/pdf' : 'text/plain',
        }),
    },
    lookup: { resolveActingUser: async () => localIdentity(project.user) },
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
