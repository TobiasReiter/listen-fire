// The process transport's server half: any module served over adapter
// protocol 2. Each request builds the module afresh over a context made from
// that request — its tenant (the team header), its credential (the envelope's)
// — so nothing of one install's call outlives it. A credential the module
// changes (`ctx.credential.update`) rides back as the answer's
// `credentialUpdate`, on a failure too.

import { ADAPTER_TEAM_HEADER } from 'movement-engine/public/adapter';

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { METHODS, type MethodName, type RpcResponseShape, type WireCredentialShape } from 'engine-contracts';

import type { CredentialFields, ModuleCredential, ModuleDefinition, ModuleFiles, ModuleKv, ModuleLog } from './define';

import { moduleContext, noCredential } from './in_process';
import { loadedModule, moduleManifest, type LoadedModule } from './manifest';
import {
  UNAUTHORIZED,
  answerAdapterRequest,
  errorAnswer,
  errorEnvelope,
  readProtocolRequest,
  sendAnswer,
  type CheckedRequest,
  type ProtocolAnswer,
} from './server';

export interface ModuleServerOptions {
  definition: ModuleDefinition;
  /** Gates every request; false answers HTTP 401. */
  authenticate?: (headers: IncomingHttpHeaders) => boolean;
  log: ModuleLog;
  files: ModuleFiles;
  kv: ModuleKv;
  baseUrlOverride?: string;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The request's credential as the module reads it; updates are collected
 *  for the answer. */
function requestCredential(
  definition: ModuleDefinition,
  sent: WireCredentialShape | undefined,
  updates: Record<string, string>,
): ModuleCredential {
  const declared = definition.credentials[0];
  if (declared === undefined) return noCredential(`module ${definition.name} declares no credential`);
  if (sent === undefined) return noCredential(`module ${definition.name}: the request carried no "${declared.name}" credential`);
  if (sent.name !== declared.name) {
    return noCredential(`module ${definition.name}: the request carried credential "${sent.name}", not "${declared.name}"`);
  }
  let fields: CredentialFields = { ...sent.fields };
  return {
    name: declared.name,
    fields: async () => fields,
    update: async (changed) => {
      fields = { ...fields, ...changed };
      Object.assign(updates, changed);
    },
  };
}

/** The module's own methods (beyond an adapter's), answered from its instance. */
async function answerModuleMethod(loaded: LoadedModule, request: CheckedRequest): Promise<ProtocolAnswer | null> {
  const { method, params } = request;
  const run = async (call: () => Promise<unknown>): Promise<ProtocolAnswer> => {
    try {
      const result = await call();
      return { status: 200, body: { ok: true, result: result ?? null } };
    } catch (err) {
      return { status: 200, body: errorAnswer(method, err) };
    }
  };
  const missing = (): ProtocolAnswer => ({
    status: 200,
    body: errorEnvelope('method_not_implemented', `Module ${loaded.definition.name} does not implement "${method}".`, false),
  });
  const { instance } = loaded;
  switch (method) {
    case 'refreshCredential': {
      const refresh = instance.refreshCredential;
      return refresh === undefined ? missing() : run(() => Reflect.apply(refresh, instance, []));
    }
    case 'invokePlugin': {
      if (loaded.kind !== 'plugin') return missing();
      const invocation = METHODS.invokePlugin.params.parse(params);
      return run(() => loaded.instance.invokePlugin(invocation));
    }
    case 'poll': {
      if (loaded.kind !== 'adapter' || loaded.instance.poll === undefined) return missing();
      const poll = loaded.instance.poll;
      const input = METHODS.poll.params.parse(params);
      return run(() => Reflect.apply(poll, loaded.instance, [input]));
    }
    case 'runPeriodic': {
      if (loaded.kind !== 'adapter' || loaded.instance.runPeriodic === undefined) return missing();
      const runPeriodic = loaded.instance.runPeriodic;
      const input = METHODS.runPeriodic.params.parse(params);
      return run(async () => {
        await Reflect.apply(runPeriodic, loaded.instance, [input]);
        return null;
      });
    }
    default:
      return null;
  }
}

const MODULE_METHODS: ReadonlySet<MethodName> = new Set<MethodName>(['refreshCredential', 'invokePlugin', 'poll', 'runPeriodic']);

/** One request, answered by the module built for it. */
async function answer(options: ModuleServerOptions, req: IncomingMessage, request: CheckedRequest): Promise<ProtocolAnswer> {
  const { definition } = options;
  const updates: Record<string, string> = {};
  const credential = requestCredential(definition, request.credential, updates);
  let loaded: LoadedModule;
  try {
    loaded = loadedModule(
      definition,
      moduleContext({
        tenant: headerValue(req.headers, ADAPTER_TEAM_HEADER) ?? '',
        credential,
        log: options.log,
        files: options.files,
        kv: options.kv,
        ...(options.baseUrlOverride !== undefined ? { baseUrlOverride: options.baseUrlOverride } : {}),
        validateResults: false,
      }),
    );
  } catch (err) {
    return { status: 200, body: errorAnswer(request.method, err) };
  }

  const answered =
    request.method === 'manifest'
      ? { status: 200, body: { ok: true as const, result: moduleManifest(loaded) } }
      : MODULE_METHODS.has(request.method)
        ? await answerModuleMethod(loaded, request)
        : loaded.kind === 'adapter'
          ? await answerAdapterRequest(
              { adapter: loaded.instance, warn: (message) => options.log.warn(message), manifest: () => moduleManifest(loaded) },
              request,
            )
          : null;
  const body: RpcResponseShape =
    answered?.body ?? errorEnvelope('method_not_implemented', `Module ${definition.name} does not implement "${request.method}".`, false);
  const status = answered?.status ?? 200;
  if (Object.keys(updates).length === 0 || credential.name === '') return { status, body };
  return { status, body: { ...body, credentialUpdate: { name: credential.name, fields: updates } } };
}

/** The HTTP handler that serves one module over adapter protocol 2. */
export function createModuleProtocolHandler(options: ModuleServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req, res) {
    if (options.authenticate && !options.authenticate(req.headers)) {
      sendAnswer(res, UNAUTHORIZED);
      return;
    }
    const read = await readProtocolRequest(req);
    if (!read.ok) {
      sendAnswer(res, read.answer);
      return;
    }
    sendAnswer(res, await answer(options, req, read.request));
  };
}
