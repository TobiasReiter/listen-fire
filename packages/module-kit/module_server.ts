// The process transport's server half: any module served over adapter
// protocol 2. Each request builds the module afresh over a context made from
// that request — its tenant (the team header), its credential (the envelope's)
// — so nothing of one install's call outlives it. A credential the module
// changes (`ctx.credential.update`) rides back as the answer's
// `credentialUpdate`, on a failure too. A file whose bytes the module
// resolves (`resolveFileRef`) is held for one fetch at a URL of the server's
// own (`served_files.ts`).

import { ADAPTER_TEAM_HEADER } from 'movement-engine/public/adapter';

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { METHODS, type MethodName, type RpcResponseShape, type WireCostLineShape, type WireCredentialShape } from 'engine-contracts';

import type { CredentialFields, ModuleCredential, ModuleDefinition, ModuleFiles, ModuleKv, ModuleLog, ModuleModels, ModuleSpend } from './define';

import { moduleContext, noCredential } from './in_process';
import { servedFiles, type ServedFile, type ServedFiles } from './served_files';
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
  /** The kv of the tenant a request names. */
  kvFor: (tenant: string) => ModuleKv;
  /** The models the serving host lends; default: refused by name. Given
   *  each request's spend, so a host door's cost is charged to the call. */
  models?: ModuleModels | ((spend: ModuleSpend) => ModuleModels);
  baseUrlOverride?: string;
  /** Construction arguments for every request (an entry position); a
   *  request's own `settings` (its install's) are laid over them. */
  constructionArgs?: Readonly<Record<string, string>>;
  /** Where callers reach this server, for the URLs of the files it holds.
   *  Never taken from a request's Host header (a caller could name any host);
   *  absent, a file without a URL of its own is not served. */
  publicUrl?: string;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The request's credentials as the module reads them, by declared name;
 *  updates are collected for the answer, per credential. */
function requestCredentials(
  definition: ModuleDefinition,
  request: CheckedRequest,
  updates: Map<string, Record<string, string>>,
): { first: ModuleCredential; named: (name: string) => ModuleCredential } {
  const sent = new Map<string, WireCredentialShape>();
  for (const credential of request.credentials ?? []) sent.set(credential.name, credential);
  if (request.credential !== undefined) sent.set(request.credential.name, request.credential);
  const built = new Map<string, ModuleCredential>();
  const named = (name: string): ModuleCredential => {
    const known = built.get(name);
    if (known !== undefined) return known;
    if (!definition.credentials.some((declared) => declared.name === name)) {
      return noCredential(`module ${definition.name} declares no credential "${name}"`);
    }
    const carried = sent.get(name);
    if (carried === undefined) return noCredential(`module ${definition.name}: the request carried no "${name}" credential`);
    let fields: CredentialFields = { ...carried.fields };
    const credential: ModuleCredential = {
      name,
      fields: async () => fields,
      update: async (changed) => {
        fields = { ...fields, ...changed };
        updates.set(name, { ...(updates.get(name) ?? {}), ...changed });
      },
    };
    built.set(name, credential);
    return credential;
  };
  const declared = definition.credentials[0];
  const first = declared === undefined ? noCredential(`module ${definition.name} declares no credential`) : named(declared.name);
  return { first, named };
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
async function answer(
  options: ModuleServerOptions,
  req: IncomingMessage,
  request: CheckedRequest,
  files: ServedFiles,
): Promise<ProtocolAnswer> {
  const { definition, publicUrl } = options;
  const updates = new Map<string, Record<string, string>>();
  const credentials = requestCredentials(definition, request, updates);
  const costs: WireCostLineShape[] = [];
  const spend: ModuleSpend = { charge: (line) => void costs.push(line) };
  const models = typeof options.models === 'function' ? options.models(spend) : options.models;
  const constructionArgs = { ...(options.constructionArgs ?? {}), ...(request.settings ?? {}) };
  const tenant = headerValue(req.headers, ADAPTER_TEAM_HEADER) ?? '';
  let loaded: LoadedModule;
  try {
    loaded = loadedModule(
      definition,
      moduleContext({
        tenant,
        credential: credentials.first,
        credentialNamed: credentials.named,
        spend,
        log: options.log,
        files: options.files,
        kv: options.kvFor(tenant),
        ...(models !== undefined ? { models } : {}),
        ...(options.baseUrlOverride !== undefined ? { baseUrlOverride: options.baseUrlOverride } : {}),
        constructionArgs,
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
              {
                adapter: loaded.instance,
                warn: (message) => options.log.warn(message),
                manifest: () => moduleManifest(loaded),
                ...(publicUrl !== undefined ? { exposeFile: (file: ServedFile) => files.expose(file, publicUrl) } : {}),
              },
              request,
            )
          : null;
  const body: RpcResponseShape =
    answered?.body ?? errorEnvelope('method_not_implemented', `Module ${definition.name} does not implement "${request.method}".`, false);
  const status = answered?.status ?? 200;
  const withCost: RpcResponseShape = costs.length === 0 ? body : { ...body, cost: costs };
  // The answer carries one credentialUpdate: the first declared credential's
  // when it changed, else the first that did.
  const changed = updates.get(credentials.first.name) !== undefined ? credentials.first.name : [...updates.keys()][0];
  if (changed === undefined) return { status, body: withCost };
  if (updates.size > 1) options.log.warn(`module ${definition.name}: several credentials changed in one call; only "${changed}"'s change is sent back`);
  return { status, body: { ...withCost, credentialUpdate: { name: changed, fields: updates.get(changed) ?? {} } } };
}

/** The HTTP handler that serves one module over adapter protocol 2. */
export function createModuleProtocolHandler(options: ModuleServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const files = servedFiles();
  return async function handle(req, res) {
    if (files.serve(req, res)) return;
    if (options.authenticate && !options.authenticate(req.headers)) {
      sendAnswer(res, UNAUTHORIZED);
      return;
    }
    const read = await readProtocolRequest(req);
    if (!read.ok) {
      sendAnswer(res, read.answer);
      return;
    }
    sendAnswer(res, await answer(options, req, read.request, files));
  };
}
