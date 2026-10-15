// The local run host: every EngineHost family served from the project folder.
// adapters → the externals over adapter protocol 2 · parks, trace, run log →
// SQLite · locks → in process · files → `.lf/files/` · acting user → a local
// identity · model calls → the provider key in the secrets file.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { METHODS, tenantIdOf, type ActingPrincipal, type TenantId } from 'engine-contracts';
import { parseWireResult } from 'movement-engine/services/translation_graph/protocol/client';
import { ADAPTER_METHODS, type AdapterMethod, type EngineHost, type ResolvedAdapter } from 'movement-engine/services/movement_engine/host';
import {
  closeSegmentWith,
  NEVER_CANCELLED,
  openSegmentWith,
  RANDOM_IDS,
  SegmentDirectory,
  WALL_CLOCK,
} from 'movement-engine/services/movement_engine/host_kit';
import { InMemoryWriteLocks, segmentWriteLocks } from 'movement-engine/services/write_locks/write_locks';
import { rpc, type RunningExternal } from './externals';
import { localFileText } from './files';
import { modelCalls } from './models';
import { localParkFamily } from './parks';
import type { Project } from './project';
import { withCredential, type Credential } from './secrets';
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
  const instances = new Map<string, { running: RunningExternal; credential: Credential | undefined }>();
  let opened = 0;

  const instancesOf = (segmentId: string) => ({
    closeSegment: () => {
      for (const key of instances.keys()) if (key.startsWith(`${segmentId}|`)) instances.delete(key);
    },
  });

  const models = modelCalls(credentials);

  return {
    segment: {
      open: (input) => openSegmentWith(input, { segments, locks, open: async () => ({ segmentId: `${parts.runId}/${++opened}` }) }),
      close: (input) => closeSegmentWith(input, { segments, table: instancesOf(input.segmentId), locks, close: async () => ({}) }),
    },
    adapters: {
      resolve: async ({ segmentId, adapterType, credentialsId }): Promise<ResolvedAdapter> => {
        if (typeof adapterType !== 'string') throw new Error(`no external for adapter ${JSON.stringify(adapterType)}`);
        const running = externals.get(adapterType);
        if (running === undefined) {
          throw new Error(`no external "${adapterType}" in ${project.externalsDir} (install it as a folder there)`);
        }
        // A credential's id is its name in the secrets file.
        const credential = credentialsId !== undefined ? credentials.get(credentialsId) : undefined;
        if (credentialsId !== undefined && credential === undefined) {
          throw new Error(`no credential "${credentialsId}" in the secrets file`);
        }
        const instance = `${segmentId}|${adapterType}|${credentialsId ?? ''}`;
        instances.set(instance, { running, credential });
        return {
          instance,
          adapterType,
          supportedTriggers: running.supportedTriggers as ResolvedAdapter['supportedTriggers'],
          capabilities: running.runtimeCapabilities,
          methods: running.methods.filter(isAdapterMethod),
          ...(running.webhookEventTypeId !== undefined ? { webhookEventTypeId: running.webhookEventTypeId } : {}),
        };
      },
      // One adapter call is one protocol call: the host family's arguments ARE
      // the protocol's params. THIN: no read memo, no call ceiling, no file
      // transport (a file crossing to or from an external is not rewritten),
      // and a rehearsed (dry-run) instance still writes.
      call: async ({ instance, method, args }) => {
        const held = instances.get(instance);
        if (held === undefined) throw new Error(`no adapter instance '${instance}' in this segment`);
        try {
          const raw = await withCredential(held.credential, () =>
            rpc({ running: held.running, credential: held.credential, method, params: args, tenant: LOCAL_TENANT }),
          );
          const schema = (METHODS as Record<string, { result: Parameters<typeof parseWireResult>[0] } | undefined>)[method]?.result;
          const result = schema !== undefined ? parseWireResult(schema, raw, { method, adapter: held.running.external.manifest.name }) : raw;
          return { result } as Awaited<ReturnType<EngineHost['adapters']['call']>>;
        } catch (error) {
          return { error: { kind: 'adapter_error', message: error instanceof Error ? error.message : String(error) } };
        }
      },
    },
    llm: models,
    park: localParkFamily({ state, runId: parts.runId, engine: parts.engine }),
    control: { cancel: NEVER_CANCELLED },
    files: {
      resolveFileText: async ({ file }) => localFileText(project, file),
      // The object store is a folder. THIN: a "pdf" is stored as its text.
      render: async ({ content, type }) => {
        const dir = join(project.lfDir, 'files');
        mkdirSync(dir, { recursive: true });
        const name = `${randomUUID()}.${type === 'pdf' ? 'pdf' : 'txt'}`;
        writeFileSync(join(dir, name), content);
        return {
          __brand: 'FileRef',
          name,
          contentType: type === 'pdf' ? 'application/pdf' : 'text/plain',
          source: { store: 'document', objectUri: `file://${join(dir, name)}` },
        };
      },
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

function isAdapterMethod(method: string): method is AdapterMethod {
  return (ADAPTER_METHODS as readonly string[]).includes(method);
}

export function tenant(): TenantId {
  return tenantIdOf(LOCAL_TENANT);
}
