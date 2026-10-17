// `lf connect <module>`: set up a module for this project, once, by prompts —
// never by editing the secrets file. Everything the module needs before any
// user signs in:
//   - installed: an `externals/<name>/lf-external.yaml`, serving a module
//     package with serve-module, or reaching a module run separately at its
//     server URL;
//   - its install's secrets: the server secret a separately-run module checks
//     (the external's `auth` field), the webhook secret its inbound deliveries
//     are signed with, and the OAuth app's client id and secret, stored once
//     per module, with the redirect port the app registered.
// User credentials are not set up here: `lf credential add --module <module>`.
// With no module named, it lists the modules it knows.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { WireCredentialDeclarationShape } from 'engine-contracts';
import { LOCAL_TENANT } from './host';
import { EXTERNAL_MANIFEST, scanExternals, startExternals, type External, type RunningExternal } from './externals';
import { DEFAULT_WEBHOOK_SECRET_FIELD, inboundSetupOf } from './doors';
import { loopbackRedirectUri, publicRedirectUri } from './oauth_redirect';
import type { Project } from './project';
import type { Prompter } from './prompt';
import { bindingOf, changeEntry, entryContent, installOf, loadSecrets, secretsFileForWrites, type Credential } from './secrets';

/** The install's fields for the OAuth app at the provider. */
export const CLIENT_ID_FIELD = 'client_id';
export const CLIENT_SECRET_FIELD = 'client_secret';
/** The loopback port the app registered (`http://127.0.0.1:<port>/callback`); 0: any. */
export const REDIRECT_PORT_FIELD = 'redirect_port';
/** The server secret field of a separately-run module lf connect installs. */
const SERVER_SECRET_FIELD = 'server_secret';

/** An installed external named by its name, its folder, or the module it serves. */
export function findExternal(project: Project, ref: string): External | undefined {
  return scanExternals(project).find((e) => e.manifest.name === ref || e.manifest.module === ref || e.dir === join(project.externalsDir, ref));
}

/** Start one external long enough to read its manifest answer. */
export async function readManifest(project: Project, external: External, install: Credential | undefined): Promise<RunningExternal> {
  const credentials = new Map<string, Credential>(install !== undefined ? [[install.name, install]] : []);
  const running = await startExternals({ project, externals: [external], credentials, tenant: LOCAL_TENANT });
  for (const r of running.values()) r.stop();
  const answer = running.get(external.manifest.name);
  if (answer === undefined) throw new Error(`external "${external.manifest.name}" did not answer its manifest`);
  return answer;
}

export function oauth2Of(declared: WireCredentialDeclarationShape[]): Extract<WireCredentialDeclarationShape, { kind: 'oauth2' }>[] {
  return declared.flatMap((d) => (d.kind === 'oauth2' ? [d] : []));
}

/** `lf connect` with no module: the installed externals, and module packages
 *  the project can install. */
export function knownModules(project: Project): string[] {
  const credentials = loadSecrets(project);
  const lines: string[] = [];
  const installed = scanExternals(project);
  for (const external of installed) {
    const how = external.manifest.module !== undefined ? `module ${external.manifest.module}` : external.manifest.url !== undefined ? `at ${external.manifest.url}` : 'command';
    const install = installOf(credentials, external.manifest.name);
    const users = [...credentials.values()].filter((c) => c.external === external.manifest.name && bindingOf(c).kind !== 'install').map((c) => c.name);
    lines.push(
      `${external.manifest.name}  installed (${how}); ${install !== undefined ? `install set up (${install.name})` : 'install not set up'}; credentials: ${users.length > 0 ? users.join(', ') : 'none'}`,
    );
  }
  const installedModules = new Set(installed.flatMap((e) => (e.manifest.module !== undefined ? [e.manifest.module] : [])));
  for (const name of modulePackages(project)) {
    if (!installedModules.has(name)) lines.push(`${name}  not installed (lf connect ${name})`);
  }
  return lines;
}

/** The `@lf/*` packages in the project's node_modules. */
function modulePackages(project: Project): string[] {
  const scope = join(project.root, 'node_modules', '@lf');
  if (!existsSync(scope)) return [];
  return readdirSync(scope, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => `@lf/${e.name}`);
}

export interface ConnectModuleOptions {
  prompter: Prompter;
  /** A separately-run module's server URL (asked when the module is neither
   *  installed nor a package the project has). */
  url?: string;
}

export async function connectModule(project: Project, ref: string, options: ConnectModuleOptions): Promise<{ external: string; install: string }> {
  const { prompter } = options;
  const credentials = loadSecrets(project);
  const found = findExternal(project, ref);
  const { external, created } = found !== undefined ? { external: found, created: false } : await installExternal(project, ref, options);
  const name = external.manifest.name;
  try {
    const existing = [installOf(credentials, name)].find((c) => c !== undefined && bindingOf(c).kind !== 'credential');
    if (existing !== undefined && (existing.origin.file === undefined || existing.origin.envFields.size > 0)) {
      throw new Error(`the install of "${name}" ("${existing.name}") comes from the environment, which lf cannot write; change it there`);
    }
    const fields: Record<string, string> = { ...(existing?.fields ?? {}) };
    const cleared = new Set<string>();
    const current = (field: string) => (fields[field] !== undefined && fields[field] !== '' ? { default: fields[field] } : {});

    // The server secret is needed to read the manifest of a module that checks it.
    const auth = external.manifest.auth;
    if (auth !== undefined) {
      fields[auth.field] = await prompter.ask(`the secret ${name}'s server checks (field "${auth.field}")`, { secret: true, ...current(auth.field) });
    }
    const provisional: Credential = {
      name: existing?.name ?? freeName(credentials, name),
      external: name,
      binding: { kind: 'install' },
      fields,
      origin: { envFields: new Set() },
    };
    const running = await readManifest(project, external, provisional);

    const inbound = inboundSetupOf(running);
    if (inbound !== undefined) {
      const generated = randomBytes(24).toString('hex');
      const field = inbound.secretField ?? DEFAULT_WEBHOOK_SECRET_FIELD;
      fields[field] = await prompter.ask(`the secret ${name}'s webhooks are signed with (field "${field}"; enter generates one)`, {
        secret: true,
        default: fields[field] !== undefined && fields[field] !== '' ? fields[field] : generated,
      });
    }

    const oauth2 = oauth2Of(running.credentials);
    if (oauth2.length > 0) {
      prompter.print(`${name} signs users in with OAuth 2 (${oauth2.map((d) => d.name).join(', ')}): your app at the provider, once for every credential`);
      fields[CLIENT_ID_FIELD] = await prompter.ask("your app's client id", current(CLIENT_ID_FIELD));
      const secret = await prompter.ask("your app's client secret (empty for a public client)", { secret: true, optional: true, ...current(CLIENT_SECRET_FIELD) });
      if (secret !== '') fields[CLIENT_SECRET_FIELD] = secret;
      else {
        delete fields[CLIENT_SECRET_FIELD];
        cleared.add(CLIENT_SECRET_FIELD);
      }
      const port = await prompter.ask('the loopback port your app registered for its redirect (0: any port)', { default: fields[REDIRECT_PORT_FIELD] ?? '0' });
      if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error(`the redirect port must be a number from 0 to 65535, not "${port}"`);
      fields[REDIRECT_PORT_FIELD] = port;
      prompter.print('register these redirect URIs with the provider:');
      prompter.print(
        Number(port) === 0
          ? `  ${loopbackRedirectUri(0).replace(':0', ':<any port>')}   (lf credential add; a provider that matches the port exactly needs a fixed one: lf connect ${name} again)`
          : `  ${loopbackRedirectUri(Number(port))}   (lf credential add, and --headless)`,
      );
      if (project.publicUrl !== undefined) prompter.print(`  ${publicRedirectUri(project.publicUrl)}   (lf credential add --public, through lf serve)`);
    }

    const file = existing?.origin.file ?? secretsFileForWrites(project);
    const install: Credential = { ...provisional, binding: existing !== undefined ? bindingOf(existing) : { kind: 'install' } };
    await changeEntry(file, install.name, {
      kind: 'replace',
      // A refresh beside this keeps its tokens: they are not an install's.
      next: (stored) => {
        const kept = Object.entries(stored ?? {}).filter(([field]) => !cleared.has(field));
        return { ...Object.fromEntries(kept), ...entryContent(install) };
      },
    });
    prompter.print(`connected ${name}: its install is "${install.name}" in ${file.path}`);
    const declared = running.credentials.map((d) => d.name);
    if (declared.length > 0) prompter.print(`next, a user credential: lf credential add --module ${name} <name>`);
    return { external: name, install: install.name };
  } catch (error) {
    if (created) rmSync(external.dir, { recursive: true, force: true });
    throw error;
  }
}

/** `name`, or `name_install` when an entry of another kind holds it. */
function freeName(credentials: Map<string, Credential>, name: string): string {
  return credentials.has(name) ? `${name}_install` : name;
}

/** Install `ref`: a module package the project has, else a module run
 *  separately at a server URL. */
async function installExternal(project: Project, ref: string, options: ConnectModuleOptions): Promise<{ external: External; created: true }> {
  const asPackage = options.url === undefined ? resolvesFrom(project.root, ref) : false;
  const url = asPackage ? undefined : (options.url ?? (await options.prompter.ask(`"${ref}" is not installed or a package here; the server URL of the separately-run module`)));
  if (url !== undefined && !/^https?:\/\//.test(url)) throw new Error(`the server URL must be http(s), not "${url}"`);
  const name = externalNameOf(ref);
  const dir = join(project.externalsDir, name);
  if (existsSync(join(dir, EXTERNAL_MANIFEST))) throw new Error(`${dir} already holds another external; connect it by its name`);
  // A path is kept absolute: the manifest is read from the external's folder.
  const module = ref.startsWith('.') ? resolve(project.root, ref) : ref;
  const manifest = asPackage
    ? { name, kind: 'adapter' as const, protocol: 2 as const, module, env: {} }
    : { name, kind: 'adapter' as const, protocol: 2 as const, url: url ?? '', auth: { kind: 'bearer' as const, field: SERVER_SECRET_FIELD }, env: {} };
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, EXTERNAL_MANIFEST),
    `# Installed by \`lf connect ${ref}\`.\n${stringify(asPackage ? { name, module } : { name, url, auth: manifest.auth })}`,
  );
  options.prompter.print(`installed ${ref} as externals/${name}`);
  return { external: { dir, manifest }, created: true };
}

/** The external's name for a module reference: the package's own name
 *  without its scope (`@acme/hubspot` → `hubspot`), or a URL's host. */
function externalNameOf(ref: string): string {
  const last = ref.split('/').filter((part) => part !== '').at(-1) ?? ref;
  return last.replace(/[^A-Za-z0-9_]/g, '_');
}

function resolvesFrom(root: string, ref: string): boolean {
  if (ref.startsWith('.') || ref.startsWith('/')) return existsSync(resolve(root, ref));
  try {
    require.resolve(ref, { paths: [root] });
    return true;
  } catch {
    return false;
  }
}
