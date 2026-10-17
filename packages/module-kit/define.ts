// A module: one integration, written once, loaded by every host. An adapter
// module is a system a movement reads and writes (`@lf/dealroom`); a plugin
// module is a set of functions a movement calls (`@lf/web`). Either one is its
// declarations (data the host acts on without knowing the module) and
// `create(ctx)`, which builds the methods over a context the HOST supplies:
// the credential, fetch, a logger, files, a key-value store and its config.
// Nothing in a module reaches the hosted product, a database or the recording
// layer; the host behind `ctx` is the only way out.
//
// The declarations are the adapter protocol's own (engine-contracts): what a
// module declares in process is exactly what its `manifest` answers over the
// wire, so the two transports cannot disagree about it.

import type {
  FileRef,
  WireCredentialDeclarationShape,
  WireInboundDeclarationShape,
  WirePluginResultShape,
} from 'engine-contracts';
import type { Adapter, AdapterManifest, DiscriminableEvent } from 'movement-engine/public/adapter';
import type { PluginDeclaration } from 'movement-engine/public/plugins';

// ── The context a host hands a module ───────────────────────────────────────

/** A credential's fields: strings, by the names the declaration gives them. */
export type CredentialFields = Readonly<Record<string, string>>;

/** The install's credential, the first the module declares. */
export interface ModuleCredential {
  readonly name: string;
  /** Its fields now. Read per call, never kept: a refresh between calls is
   *  seen by the next one. */
  fields(): Promise<CredentialFields>;
  /** The provider changed it (a refreshed token, a rotated refresh token): the
   *  host merges these fields over the stored ones and writes them back. */
  update(fields: CredentialFields): Promise<void>;
}

export interface ModuleLog {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Files the host keeps for the module: bytes in, a file value out that a
 *  write or a record can carry, and the bytes of a file it was handed. */
export interface ModuleFiles {
  put(input: { bytes: Uint8Array; name?: string; contentType?: string }): Promise<FileRef>;
  read(ref: FileRef): Promise<Uint8Array>;
}

/** Someone who linked their account on the provider to a user of the host
 *  (the platform's Telegram `/start` handshake): the provider's id for them,
 *  the host user's email as linked, and when. */
export interface LinkedIdentity {
  externalId: string;
  email: string;
  /** ISO-8601. */
  linkedAt?: string;
}

/** The host's record of who linked, for this install's tenant. The host
 *  writes it (a handshake is the host's own door); a module only reads it. */
export interface ModuleIdentities {
  /** Everyone linked, in the order they linked. */
  list(): Promise<LinkedIdentity[]>;
  /** One person by their provider id; null when they never linked. */
  find(externalId: string): Promise<LinkedIdentity | null>;
}

/** Small durable state of the module's own, per install (a dedup mark, a
 *  cursor nothing else holds). Values are JSON. */
export interface ModuleKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ModuleConfig {
  /** The tenant the install belongs to. */
  readonly tenant: string;
  /** Where to reach the provider instead of its production URL: the dev
   *  loop's fakes. Absent in production. */
  readonly baseUrlOverride?: string;
  /** Non-credential construction arguments (an entry position such as a
   *  spreadsheet). */
  readonly constructionArgs: Readonly<Record<string, string>>;
  /** The host's name for the install's credential. A file the module owns
   *  names it in its source, so the host redeems the file on this same
   *  install. Absent where the host names it itself (the process transport's
   *  client rewrites every owned file). */
  readonly credentialRef?: string;
}

export interface ModuleContext {
  credential: ModuleCredential;
  fetch: typeof fetch;
  log: ModuleLog;
  files: ModuleFiles;
  kv: ModuleKv;
  identities: ModuleIdentities;
  config: ModuleConfig;
}

// ── What a module's `create` returns ────────────────────────────────────────

export interface PollInput {
  /** The listen's options. */
  config: unknown;
  /** What the previous poll returned; absent the first time. */
  checkpoint?: unknown;
}

export interface PollAnswer {
  events: DiscriminableEvent[];
  checkpoint?: unknown;
}

/** An adapter, plus the methods its declarations pair with. */
export type AdapterModuleMethods = Adapter & {
  /** Paired with the `poll` declaration. */
  poll?(input: PollInput): Promise<PollAnswer>;
  /** Paired with the `periodic` declaration. */
  runPeriodic?(input: { name: string }): Promise<void>;
  /** For a provider whose refresh is not the standard OAuth 2 grant: the
   *  changed fields of `ctx.credential`. */
  refreshCredential?(): Promise<{ fields: CredentialFields }>;
};

export interface PluginInvocation {
  /** The registered name (`fetch-url`) or the program's spelling (`fetch_url`). */
  name: string;
  /** The author's arguments, by name. */
  config: Record<string, unknown>;
  /** The fields extracted so far, inside a `through [ … ]` stage. */
  extractedContext: Record<string, unknown>;
}

export type PluginAnswer = WirePluginResultShape;

export interface PluginModuleMethods {
  invokePlugin(input: PluginInvocation): Promise<PluginAnswer>;
  refreshCredential?(): Promise<{ fields: CredentialFields }>;
}

// ── The definition ──────────────────────────────────────────────────────────

interface Common {
  /** The package (`@lf/dealroom`). */
  name: string;
  /** The credential it needs; the first is the one each call carries. */
  credentials: readonly WireCredentialDeclarationShape[];
}

export interface AdapterModuleDefinition extends Common {
  kind: 'adapter';
  /** What the host's catalog, editor and checker read about the adapter. */
  manifest: AdapterManifest;
  /** How its provider signs webhooks; the host verifies each delivery. */
  inbound?: WireInboundDeclarationShape;
  /** A polled source: the host calls `poll` this often per listen. */
  poll?: { intervalSeconds: number };
  /** Housekeeping the host runs per install. */
  periodic?: ReadonlyArray<{ name: string; intervalSeconds: number }>;
  create(ctx: ModuleContext): AdapterModuleMethods;
}

export interface PluginModuleDefinition extends Common {
  kind: 'plugin';
  /** Each plugin's declaration: its signature, and whether it may cost money. */
  plugins: readonly PluginDeclaration[];
  create(ctx: ModuleContext): PluginModuleMethods;
}

export type ModuleDefinition = AdapterModuleDefinition | PluginModuleDefinition;

/** The adapter type a module answers to: the package name after its scope,
 *  `@lf/google-sheets` → `google_sheets`. */
export function moduleSlug(name: string): string {
  const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return bare.replace(/-/g, '_');
}

/**
 * A module, checked as it is defined: an adapter module's manifest names the
 * adapter its package does, and every declaration is well formed. The pairing
 * of declarations with methods is checked when the module is first loaded
 * (`moduleManifest`), since methods exist only once `create` has run.
 */
export function defineModule<D extends ModuleDefinition>(definition: D): D {
  if (definition.kind === 'adapter' && definition.manifest.adapterType !== moduleSlug(definition.name)) {
    throw new Error(
      `module ${definition.name}: its manifest names adapter "${definition.manifest.adapterType}", but the package answers to "${moduleSlug(definition.name)}"`,
    );
  }
  return definition;
}
