// `lf credential add|update|delete|list`: a person's credentials for a module,
// as the platform's credential pages hold them (a name, the module it is for,
// its fields), written to the secrets file by these commands only.
//
//   add --module <module> [name]   a new credential bound to the module and the
//                                  credential its manifest declares: signed in
//                                  at the provider for an OAuth 2 one, its
//                                  fields asked for a static one
//   update <name>                  signed in again / its fields edited; an
//                                  entry written by hand gets its binding
//   delete <name>
//   list
//
// The OAuth app's client id and secret are the module's install's (`lf
// connect <module>`), never copied into a user's credential.

import { userInfo } from 'node:os';
import type { WireCredentialDeclarationShape } from 'engine-contracts';
import { storeGrant } from 'movement-engine/public/secrets';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { CLIENT_ID_FIELD, CLIENT_SECRET_FIELD, findExternal, readManifest, REDIRECT_PORT_FIELD } from './connect';
import { authorizeAtProvider, type RedirectMode } from './oauth_redirect';
import type { Project } from './project';
import type { Prompter } from './prompt';
import { bindingOf, changeEntry, entryContent, installOf, loadSecrets, secretsFileForWrites, secretsOf, type Credential, type CredentialBinding } from './secrets';

/** How the provider sends the person back, as the command line asked. */
export interface RedirectChoice {
  how: 'loopback' | 'headless' | 'public';
  /** --redirect-port; absent: the install's registered port. */
  port?: number;
  openBrowser: boolean;
}

const TOKEN_FIELDS = ['access_token', 'refresh_token', 'expires_at'];

/** A credential name a movement can import. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function addCredential(
  project: Project,
  input: { module: string; name?: string; declared?: string; redirect: RedirectChoice; prompter: Prompter },
): Promise<Credential> {
  const { prompter } = input;
  const credentials = loadSecrets(project);
  const external = findExternal(project, input.module);
  if (external === undefined) throw new Error(`module "${input.module}" is not installed here; set it up first: lf connect ${input.module}`);
  const module = external.manifest.name;
  const install = installOf(credentials, module);
  const running = await readManifest(project, external, install);
  const declaration = chooseDeclared(module, running.credentials, input.declared);

  const name = input.name ?? (await prompter.ask(`a name for the credential`, { default: `${userInfo().username.replace(/[^A-Za-z0-9_]/g, '_')}_${module}` }));
  if (!NAME.test(name)) throw new Error(`"${name}" cannot be a credential name: letters, digits and _ (a movement imports it by this name)`);
  if (credentials.has(name)) throw new Error(`there is already a credential "${name}"; change it with lf credential update ${name}`);

  const fields = Object.fromEntries(Object.entries(await askFields(declaration, {}, prompter)).filter(([, value]) => value !== ''));
  if (declaration.kind === 'oauth2') {
    const grant = await authorizeAtProvider({
      oauth2: declaration.oauth2,
      client: clientOf(module, install),
      mode: redirectMode(project, input.redirect, install),
      prompter,
      label: `"${name}" (${module})`,
    });
    Object.assign(fields, grant.fields);
  }
  const credential: Credential = { name, external: module, binding: { kind: 'credential', declared: declaration.name }, fields, origin: { envFields: new Set() } };
  await changeEntry(secretsFileForWrites(project), name, { kind: 'create', entry: entryContent(credential) });
  prompter.print(`added ${name} (${module}, credential ${declaration.name}); a movement uses it as:`);
  prompter.print(`  import { ${name} } from credentials`);
  prompter.print(`  x = connect ${module} using ${name}`);
  return credential;
}

export async function updateCredential(
  project: Project,
  input: { name: string; declared?: string; reauthorize: boolean; redirect: RedirectChoice; prompter: Prompter },
): Promise<Credential> {
  const { prompter, name } = input;
  const credentials = loadSecrets(project);
  const credential = writable(credentials, name);
  const binding = bindingOf(credential);
  if (binding.kind === 'install') throw new Error(`"${name}" is the install of ${credential.external}; change it with lf connect ${credential.external}`);
  const external = findExternal(project, credential.external);
  if (external === undefined) throw new Error(`"${name}" is for module "${credential.external}", which is not installed here (lf connect ${credential.external})`);
  const install = installOf(credentials, credential.external);
  const running = await readManifest(project, external, install);
  const declaration = chooseDeclared(credential.external, running.credentials, binding.kind === 'credential' ? binding.declared : (input.declared ?? declaredByName(running.credentials, name)));

  const edited = await askFields(declaration, credential.fields, prompter);
  if (declaration.kind === 'oauth2' && input.reauthorize) {
    // A hand-written entry holds its own app; a bound one uses the install's.
    const grant = await authorizeAtProvider({
      oauth2: declaration.oauth2,
      client: clientOf(credential.external, binding.kind === 'legacy' && credential.fields[CLIENT_ID_FIELD] !== undefined ? credential : install),
      mode: redirectMode(project, input.redirect, install),
      prompter,
      label: `"${name}" (${credential.external})`,
    });
    Object.assign(edited, grant.fields);
  }
  const file = credential.origin.file;
  if (file === undefined) throw new Error(`"${name}" is not in a secrets file`);
  // Through the family: the same lock and write a refresh takes.
  if (Object.keys(edited).length > 0) await storeGrant(secretsOf(credential), name, { fields: edited, response: {} });
  const bound: CredentialBinding = { kind: 'credential', declared: declaration.name };
  const cleared = new Set(declaration.fields.filter((f) => f.optional === true && edited[f.name] === '').map((f) => f.name));
  await changeEntry(file, name, {
    kind: 'replace',
    next: (stored) => {
      if (stored === null) throw new Error(`"${name}" was deleted meanwhile`);
      const { external: _external, module: _module, credential: _credential, ...storedFields } = stored;
      const kept = Object.fromEntries(Object.entries(storedFields).filter(([field]) => !cleared.has(field)));
      return entryContent({ external: credential.external, binding: bound, fields: kept });
    },
  });
  prompter.print(`updated ${name} (${credential.external}, credential ${declaration.name})${binding.kind === 'legacy' ? '; its binding is now recorded' : ''}`);
  return { ...credential, binding: bound };
}

export async function deleteCredential(project: Project, input: { name: string; prompter: Prompter }): Promise<void> {
  const credentials = loadSecrets(project);
  const credential = writable(credentials, input.name);
  if (bindingOf(credential).kind === 'install') {
    throw new Error(`"${input.name}" is the install of ${credential.external}, not a user credential`);
  }
  const file = credential.origin.file;
  if (file === undefined) throw new Error(`"${input.name}" is not in a secrets file`);
  await changeEntry(file, input.name, { kind: 'delete' });
  input.prompter.print(`deleted ${input.name} (${credential.external})`);
}

/** One line per credential: its name, module, declared credential, and where it is kept. Never a value. */
export function listCredentials(project: Project): string[] {
  const lines: string[] = [];
  for (const credential of loadSecrets(project).values()) {
    const binding = bindingOf(credential);
    const what = (() => {
      switch (binding.kind) {
        case 'install':
          return 'install';
        case 'credential':
          return `credential ${binding.declared}`;
        case 'legacy':
          return 'written by hand (lf credential update records its binding)';
        default:
          return neverAsAny(binding);
      }
    })();
    const where = [
      ...(credential.origin.file !== undefined ? [credential.origin.file.path] : []),
      ...(credential.origin.envFields.size > 0 ? ['environment'] : []),
    ].join(' + ');
    const expires = credential.fields.expires_at !== undefined ? `; token expires ${credential.fields.expires_at}` : '';
    lines.push(`${credential.name}  ${credential.external}  ${what}  (${where})${expires}`);
  }
  return lines;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A credential lf may write: in a secrets file, no field from the environment. */
function writable(credentials: Map<string, Credential>, name: string): Credential {
  const credential = credentials.get(name);
  if (credential === undefined) throw new Error(`there is no credential "${name}" (lf credential list)`);
  if (credential.origin.file === undefined || credential.origin.envFields.size > 0) {
    throw new Error(`"${name}" has fields from the environment (LF_SECRET__${name.toUpperCase()}__…), which lf cannot write; change it there, or unset them`);
  }
  return credential;
}

function chooseDeclared(module: string, declared: WireCredentialDeclarationShape[], named: string | undefined): WireCredentialDeclarationShape {
  if (declared.length === 0) throw new Error(`module "${module}" declares no credential; it needs none`);
  if (named !== undefined) {
    const found = declared.find((d) => d.name === named);
    if (found === undefined) throw new Error(`module "${module}" declares no credential "${named}" (it declares ${declared.map((d) => d.name).join(', ')})`);
    return found;
  }
  const [only, ...others] = declared;
  if (only === undefined || others.length > 0) {
    throw new Error(`module "${module}" declares several credentials (${declared.map((d) => d.name).join(', ')}); name one with --credential`);
  }
  return only;
}

/** A hand-written entry's declared credential: the one named like it, if any. */
function declaredByName(declared: WireCredentialDeclarationShape[], name: string): string | undefined {
  return declared.length > 1 ? declared.find((d) => d.name === name)?.name : undefined;
}

/** Ask each field the declaration lists (not the tokens a sign-in writes);
 *  the current value is the default. */
async function askFields(declaration: WireCredentialDeclarationShape, current: Record<string, string>, prompter: Prompter): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const field of declaration.fields) {
    if (TOKEN_FIELDS.includes(field.name) && declaration.kind === 'oauth2') continue;
    const now = current[field.name];
    const answer = await prompter.ask(field.label !== undefined ? `${field.label} (${field.name})` : field.name, {
      secret: field.secret !== false,
      ...(now !== undefined && now !== '' ? { default: now } : {}),
      ...(field.optional === true ? { optional: true } : {}),
    });
    if (answer !== now) answers[field.name] = answer;
  }
  return answers;
}

function clientOf(module: string, holder: Credential | undefined): { clientId: string; clientSecret?: string } {
  const clientId = holder?.fields[CLIENT_ID_FIELD];
  if (holder === undefined || clientId === undefined || clientId === '') {
    throw new Error(`module "${module}" has no OAuth app set up: lf connect ${module}`);
  }
  const clientSecret = holder.fields[CLIENT_SECRET_FIELD];
  return { clientId, ...(clientSecret !== undefined && clientSecret !== '' ? { clientSecret } : {}) };
}

function redirectMode(project: Project, choice: RedirectChoice, install: Credential | undefined): RedirectMode {
  const registered = Number(install?.fields[REDIRECT_PORT_FIELD] ?? '0');
  const port = choice.port ?? registered;
  switch (choice.how) {
    case 'loopback':
      return { kind: 'loopback', port, openBrowser: choice.openBrowser };
    case 'headless':
      if (port === 0) {
        throw new Error('--headless needs the redirect port your app registered: --redirect-port <port>, or set it with lf connect');
      }
      return { kind: 'headless', port };
    case 'public':
      if (project.publicUrl === undefined) throw new Error('--public needs lf.yaml\'s publicUrl, where lf serve is reached');
      return { kind: 'public', publicUrl: project.publicUrl, lfDir: project.lfDir };
    default:
      return neverAsAny(choice.how);
  }
}
