// The in-process transport: a module loaded into the host's own process (the
// platform's built-ins). The host builds the context; the module's methods
// are called directly, with no wire between. What the process transport
// guarantees by construction — every answer is the protocol's shape — is held
// here by validating each answer against the same schema, when the host asks
// (`validateResults`): always in tests and development, where recorded parity
// gates each module, and off in hosted production for the built-ins
// (`inProcessValidationDefault`), where it would only cost time.

import { METHODS, type MethodName, type WireManifestResultShape } from 'engine-contracts';
import type { Adapter } from 'movement-engine/public/adapter';

import type {
  AdapterModuleDefinition,
  CredentialFields,
  ModuleDefinition,
  ModuleContext,
  ModuleCredential,
  ModuleSpend,
  ModuleFiles,
  ModuleIdentities,
  ModuleKv,
  ModuleLog,
  ModuleModels,
  PluginAnswer,
  PluginInvocation,
  PluginModuleDefinition,
  PollAnswer,
  PollInput,
} from './define';

import { moduleManifest, type LoadedModule } from './manifest';

/** What a host hands a module it loads in process. */
export interface ModuleHost {
  tenant: string;
  credential: ModuleCredential;
  /** The module's other declared credentials, by name. Default: the first alone. */
  credentialNamed?: (name: string) => ModuleCredential;
  /** Where the module's spend is charged. Default: nowhere (a host that meters nothing). */
  spend?: ModuleSpend;
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  log: ModuleLog;
  files: ModuleFiles;
  kv: ModuleKv;
  /** Default: refused by name (a host with no models to lend). */
  models?: ModuleModels;
  /** Default: none kept (`refusingIdentities`). */
  identities?: ModuleIdentities;
  baseUrlOverride?: string;
  constructionArgs?: Readonly<Record<string, string>>;
  credentialRef?: string;
  /** Check every answer against the protocol's result schema. */
  validateResults: boolean;
}

/**
 * Whether an in-process built-in's answers are validated by default: yes,
 * except in hosted production. `ADAPTER_VALIDATE=1` turns it on there (a
 * suspected bad answer), `ADAPTER_VALIDATE=0` off anywhere. A module served
 * as a process is always validated, by the client that calls it.
 */
export function inProcessValidationDefault(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.ADAPTER_VALIDATE === '1') return true;
  if (env.ADAPTER_VALIDATE === '0') return false;
  return env.NODE_ENV !== 'production';
}

export function moduleContext(host: ModuleHost): ModuleContext {
  return {
    credential: host.credential,
    credentialNamed:
      host.credentialNamed ??
      ((name) => (name === host.credential.name ? host.credential : noCredential(`this host sends credential "${host.credential.name}" alone, not "${name}"`))),
    spend: host.spend ?? { charge: () => undefined },
    fetch: host.fetch ?? fetch,
    log: host.log,
    files: host.files,
    kv: host.kv,
    models: host.models ?? refusingModels('this host lends no models to its modules'),
    identities: host.identities ?? refusingIdentities('this host keeps no linked identities'),
    config: {
      tenant: host.tenant,
      ...(host.baseUrlOverride !== undefined ? { baseUrlOverride: host.baseUrlOverride } : {}),
      constructionArgs: host.constructionArgs ?? {},
      ...(host.credentialRef !== undefined ? { credentialRef: host.credentialRef } : {}),
    },
  };
}

/** An answer that is not the protocol's shape for its method. */
export class ModuleAnswerInvalid extends Error {
  constructor(module: string, method: string, detail: string) {
    super(`module ${module}: ${method} answered outside the protocol's shape: ${detail}`);
    this.name = 'ModuleAnswerInvalid';
  }
}

/** Methods whose in-process answer is the wire's answer. The paged ones
 *  stream in process, `resolveFileRef` answers bytes rather than a URL, and
 *  `resolveAwait` lives on `awaitable`, so those cross differently. */
const VALIDATED_METHODS: ReadonlySet<string> = new Set<MethodName>([
  'listEntryPoints',
  'describe',
  'edgesFrom',
  'resolveEntity',
  'getFieldValue',
  'getRelated',
  'preprocessInbound',
  'listEventTypes',
  'createRecord',
  'updateRecord',
  'deleteRecord',
  'linkRecords',
  'unlinkRecords',
  'ensureEventSubscription',
  'removeEventSubscription',
  'wakeKeys',
  'readRecord',
  'translateFilter',
  'getDedupRules',
  'getActorCandidates',
  'extractActor',
  'describeOpaqueId',
  'invokeFieldFunction',
  'poll',
  'runPeriodic',
  'invokePlugin',
]);

function isValidatedMethod(name: string): name is MethodName {
  return VALIDATED_METHODS.has(name);
}

/** Check one answer as the wire would carry it (JSON, `undefined` as `null`). */
function validated<T>(module: string, method: MethodName, answer: T): T {
  const onWire: unknown = answer === undefined ? null : JSON.parse(JSON.stringify(answer));
  const parsed = METHODS[method].result.safeParse(onWire);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ModuleAnswerInvalid(module, method, issue ? `${issue.path.join('.') || '(result)'}: ${issue.message}` : 'invalid');
  }
  return answer;
}

/** The adapter, each answer validated on its way out. */
function validatingAdapter(module: string, adapter: Adapter): Adapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof member !== 'function' || !isValidatedMethod(property)) return member;
      return async (...args: unknown[]) => validated(module, property, await Reflect.apply(member, target, args));
    },
  });
}

export interface InProcessAdapterModule {
  adapter: Adapter;
  manifest: WireManifestResultShape;
  /** Present when the module declares `poll`. */
  poll?(input: PollInput): Promise<PollAnswer>;
  /** Present when the module declares `periodic`. */
  runPeriodic?(name: string): Promise<void>;
}

/** Each definition's manifest, checked the first time it is loaded: a host
 *  loads a module per install, and its declarations do not change between. */
const manifests = new WeakMap<ModuleDefinition, WireManifestResultShape>();

function checkedManifest(loaded: LoadedModule): WireManifestResultShape {
  const known = manifests.get(loaded.definition);
  if (known !== undefined) return known;
  const manifest = moduleManifest(loaded);
  manifests.set(loaded.definition, manifest);
  return manifest;
}

/** Load an adapter module in process, over the host's context. */
export function adapterInProcess(definition: AdapterModuleDefinition, host: ModuleHost): InProcessAdapterModule {
  const instance = definition.create(moduleContext(host));
  const manifest = checkedManifest({ kind: 'adapter', definition, instance });
  const check = <T>(method: MethodName, answer: T): T => (host.validateResults ? validated(definition.name, method, answer) : answer);
  const { poll, runPeriodic } = instance;
  return {
    adapter: host.validateResults ? validatingAdapter(definition.name, instance) : instance,
    manifest,
    ...(poll !== undefined
      ? { poll: async (input: PollInput) => check('poll', await Reflect.apply(poll, instance, [input])) }
      : {}),
    ...(runPeriodic !== undefined
      ? {
          runPeriodic: async (name: string) => {
            check('runPeriodic', await Reflect.apply(runPeriodic, instance, [{ name }]));
          },
        }
      : {}),
  };
}

export interface InProcessPluginModule {
  manifest: WireManifestResultShape;
  invoke(input: PluginInvocation): Promise<PluginAnswer>;
}

/** Load a plugin module in process, over the host's context. */
export function pluginsInProcess(definition: PluginModuleDefinition, host: ModuleHost): InProcessPluginModule {
  const instance = definition.create(moduleContext(host));
  const manifest = checkedManifest({ kind: 'plugin', definition, instance });
  return {
    manifest,
    invoke: async (input) => {
      const answer = await instance.invokePlugin(input);
      return host.validateResults ? validated(definition.name, 'invokePlugin', answer) : answer;
    },
  };
}

// ── Context parts a host does not have ──────────────────────────────────────
// A host without one says so when it is used, naming the module: never a
// silent stand-in that loses what the module stored.

/** The credential of a module that declares none, or of a host that holds
 *  none for it. */
export function noCredential(reason: string): ModuleCredential {
  const refuse = (): never => {
    throw new Error(reason);
  };
  return { name: '', fields: async () => refuse(), update: async (_fields: CredentialFields) => refuse() };
}

export function refusingFiles(reason: string): ModuleFiles {
  return {
    put: async () => {
      throw new Error(reason);
    },
    read: async () => {
      throw new Error(reason);
    },
    expose: async () => {
      throw new Error(reason);
    },
  };
}

export function refusingModels(reason: string): ModuleModels {
  return {
    chat: async () => {
      throw new Error(reason);
    },
    chatStructured: async () => {
      throw new Error(reason);
    },
  };
}

export function refusingKv(reason: string): ModuleKv {
  return {
    get: async () => {
      throw new Error(reason);
    },
    set: async () => {
      throw new Error(reason);
    },
    delete: async () => {
      throw new Error(reason);
    },
    list: async () => {
      throw new Error(reason);
    },
  };
}

export function refusingIdentities(reason: string): ModuleIdentities {
  return {
    list: async () => {
      throw new Error(reason);
    },
    find: async () => {
      throw new Error(reason);
    },
  };
}
