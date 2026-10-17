// Externals: the project's installed modules (a folder each, like
// node_modules), each with an `lf-external.yaml`. An external speaks adapter
// protocol 2 over HTTP: the host starts its command (or reaches its url, or
// serves its `module` with serve-module) and every call is one protocol
// call. An adapter external is a system a movement connects to; a plugin
// external serves a package of plugins a movement imports
// (``import { `@lf/web` as web } from plugins``). Nothing about an external
// lives in lf itself.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse } from 'yaml';
import { z } from 'zod';
import { METHODS, WireListenDeclarations, WireManifestProtocolVersion, type WireCredentialDeclarationShape, type WireInboundDeclarationShape, type WirePluginsDeclarationShape } from 'engine-contracts';
import { authHeader, parseWireResult, postRpc } from 'movement-engine/services/translation_graph/protocol/client';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import type { RemoteAdapter } from 'movement-engine/services/translation_graph/adapters/remote';
import type { SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';
import type { InstanceSchema } from 'movement-lang';
import type { Project } from './project';
import { bindingOf, installOf, withCredential, type Credential } from './secrets';

const ExternalManifest = z.object({
  name: z.string().min(1),
  kind: z.enum(['adapter', 'plugin']).default('adapter'),
  protocol: z.literal(2).default(2),
  command: z.array(z.string()).min(1).optional(),
  url: z.string().url().optional(),
  /** A module (a path, relative to the folder, or a package name) the host
   *  serves itself with serve-module: the same module the platform loads in
   *  process. */
  module: z.string().min(1).optional(),
  auth: z.object({ kind: z.literal('bearer'), field: z.string() }).optional(),
  webhook: z
    .object({
      signature: z.literal('hmac-sha256'),
      header: z.string().default('x-listen-fire-signature'),
      secretField: z.string(),
    })
    .optional(),
  env: z.record(z.string(), z.string()).default({}),
});
export type ExternalManifest = z.infer<typeof ExternalManifest>;

export interface External {
  dir: string;
  manifest: ExternalManifest;
}

export const EXTERNAL_MANIFEST = 'lf-external.yaml';

export function scanExternals(project: Project): External[] {
  if (!existsSync(project.externalsDir)) return [];
  const found: External[] = [];
  for (const entry of readdirSync(project.externalsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(project.externalsDir, entry.name);
    const file = join(dir, EXTERNAL_MANIFEST);
    if (!existsSync(file)) continue;
    const parsed = ExternalManifest.safeParse(parse(readFileSync(file, 'utf8')));
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const reaches = [parsed.data.command, parsed.data.url, parsed.data.module].filter((how) => how !== undefined).length;
    if (reaches !== 1) {
      throw new Error(`${file}: an external needs exactly one of \`command\`, \`url\` or \`module\``);
    }
    found.push({ dir, manifest: parsed.data });
  }
  return found;
}

/** An adapter external the host can call: where it answers, and how to stop it. */
export interface RunningExternal {
  external: External;
  baseUrl: string;
  /** Protocol methods it implements (its `manifest` answer). */
  methods: string[];
  supportedTriggers: string[];
  runtimeCapabilities: z.infer<typeof METHODS.manifest.result>['runtimeCapabilities'];
  webhookEventTypeId?: string;
  /** What a listen on it may say, from its manifest answer — the declarations
   *  the hosted product reads from the install's manifest file. */
  listen: z.infer<typeof WireListenDeclarations>;
  /** The credentials its manifest declares it needs; the first is sent on
   *  each call (remote.ts). */
  credentials: WireCredentialDeclarationShape[];
  /** How its manifest says its webhooks are signed (doors.ts). */
  inbound?: WireInboundDeclarationShape;

  /** The plugins it serves (a plugin external). */
  plugins?: WirePluginsDeclarationShape;
  stop(): void;
}

/** The secret a call to this external carries: the named field of the credential. */
export function callSecret(external: External, credential: Credential | undefined): Record<string, string> {
  const auth = external.manifest.auth;
  if (auth === undefined) return {};
  if (credential === undefined) {
    throw new Error(`external "${external.manifest.name}" needs a credential (its auth field is "${auth.field}")`);
  }
  const secret = credential.fields[auth.field];
  if (secret === undefined) {
    throw new Error(`credential "${credential.name}" has no "${auth.field}" field, which external "${external.manifest.name}" sends`);
  }
  return authHeader({ kind: 'bearer' }, secret);
}

export async function rpc(input: {
  running: RunningExternal;
  credential: Credential | undefined;
  method: string;
  params: unknown;
  /** The local tenant, sent as the team header. */
  tenant: string;
}): Promise<unknown> {
  // Through the credential's refresh, as every call through the remote
  // adapter is: the secret is read per attempt, after any refresh.
  return withCredential(input.credential, () =>
    postRpc({
      baseUrl: input.running.baseUrl,
      auth: callSecret(input.running.external, input.credential),
      teamId: input.tenant,
      method: input.method,
      cacheScopeId: '<none>',
      params: input.params,
    }),
  );
}

/** Start (or reach) every external and read its manifest. */
export async function startExternals(input: {
  project: Project;
  externals: External[];
  credentials: Map<string, Credential>;
  tenant: string;
  /** Where the host takes an external's pushes (`lf serve`), handed to a
   *  started external as LF_HOST_URL. */
  hostUrl?: string;
}): Promise<Map<string, RunningExternal>> {
  const running = new Map<string, RunningExternal>();
  try {
    for (const external of input.externals) {
      const { baseUrl, stop } = await reach(input.project, external, input.hostUrl);
      const shell: RunningExternal = {
        external,
        baseUrl,
        methods: [],
        supportedTriggers: [],
        runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
        listen: {},
        credentials: [],
        stop,
      };
      running.set(external.manifest.name, shell);
      const raw = await rpc({
        running: shell,
        // Signed with the install's server secret: the manifest is the
        // install's, whoever later connects.
        credential: installOf(input.credentials, external.manifest.name),
        method: 'manifest',
        params: {},
        tenant: input.tenant,
      });
      const version = WireManifestProtocolVersion.safeParse(isRecord(raw) ? raw.protocolVersion : undefined);
      if (!version.success) throw new Error(`external "${external.manifest.name}": ${version.error.issues[0]?.message}`);
      const manifest = parseWireResult(METHODS.manifest.result, raw, { method: 'manifest', adapter: external.manifest.name });
      if (manifest.adapterType !== external.manifest.name) {
        throw new Error(`external folder "${external.manifest.name}" serves "${manifest.adapterType}"; the names must agree`);
      }
      if (external.manifest.kind === 'plugin' && manifest.plugins === undefined) {
        throw new Error(`external "${external.manifest.name}" is a plugin external, but its manifest declares no plugins`);
      }
      if (manifest.plugins !== undefined) shell.plugins = manifest.plugins;
      shell.methods = manifest.methods;
      shell.supportedTriggers = manifest.supportedTriggers;
      shell.runtimeCapabilities = manifest.runtimeCapabilities;
      shell.listen = WireListenDeclarations.parse(manifest);
      shell.credentials = manifest.credentials ?? [];
      if (manifest.inbound !== undefined) shell.inbound = manifest.inbound;
      if (manifest.webhookEventTypeId !== undefined) shell.webhookEventTypeId = manifest.webhookEventTypeId;
    }
  } catch (error) {
    for (const r of running.values()) r.stop();
    throw error;
  }
  return running;
}

/** The credential a connection that names none acts as: the first entry
 *  for this external that a `using` could name — never its install, whose
 *  secret signs calls but is no account at the provider. */
export function credentialFor(credentials: Map<string, Credential>, external: string): Credential | undefined {
  for (const credential of credentials.values()) {
    if (credential.external === external && bindingOf(credential).kind !== 'install') return credential;
  }
  return undefined;
}

/** serve-module, run by this node: lf serves a module external itself. */
const SERVE_MODULE = require.resolve('module-kit/bin/serve-module.cjs');

async function reach(project: Project, external: External, hostUrl: string | undefined): Promise<{ baseUrl: string; stop: () => void }> {
  if (external.manifest.url !== undefined) return { baseUrl: external.manifest.url, stop: () => {} };
  const [command, ...args] =
    external.manifest.module !== undefined ? [process.execPath, SERVE_MODULE, external.manifest.module] : (external.manifest.command ?? []);
  if (command === undefined) throw new Error(`external "${external.manifest.name}" has no command`);
  const stateDir = join(project.lfDir, 'externals', external.manifest.name);
  mkdirSync(stateDir, { recursive: true });
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', PORT: '0', ...(hostUrl !== undefined ? { LF_HOST_URL: hostUrl } : {}) };
  for (const [key, value] of Object.entries(external.manifest.env)) env[key] = value.replaceAll('{lf}', project.lfDir);
  const child = spawn(command, args, { cwd: external.dir, env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await listeningPort(child, external.manifest.name);
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    stop: () => {
      child.kill();
    },
  };
}

/** The port a started external prints as `listening <port>`. */
function listeningPort(child: ChildProcess, name: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`external "${name}" did not print "listening <port>" within 10s`)), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`external "${name}" exited (${code}) before listening`));
    });
    if (child.stdout === null) return;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const match = /^listening (\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
}

/**
 * One external's schema, the way the hosted product projects it: its entry
 * points and one `describe` per entry point, asked through the same remote
 * adapter and projected by the same function (`instanceSchemaFromDescriptors`).
 * THIN: no demand rounds, no positioned instances, no narrowing — the hosted
 * catalog's live walk does those.
 */
export async function describeExternal(adapter: RemoteAdapter): Promise<InstanceSchema> {
  const entries = await adapter.listEntryPoints();
  const descriptors = new Map<string, SchemaTypeDescriptor>();
  for (const entry of entries) {
    const descriptor = await adapter.describe(entry.typeId);
    if (descriptor !== null) descriptors.set(entry.typeId, descriptor);
  }
  return instanceSchemaFromDescriptors({
    adapterType: adapter.adapterType,
    entries,
    descriptors,
    supportsInPlaceUpdate: typeof adapter.updateRecord === 'function',
  }).schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
