// Secrets live outside the program: a program names a credential, and the
// host hands that credential's fields to the external's call and nowhere else.
// The engine never sees one.
//
// WHERE THEY COME FROM (a field's origin is tracked, so a refreshed token can
// be written back to where it came from):
//   1. The file: YAML keyed by credential name → `external: <name>` plus string
//      fields. `LF_SECRETS_FILE=<path>` names it (a mounted secret); otherwise
//      `<project>/.lf/secrets.yaml`, else `~/.config/lf/secrets.yaml`. It is
//      SOPS-compatible: a file carrying SOPS metadata is read with `sops -d`
//      and written back with `sops set` (never decrypted onto disk).
//   2. The environment overrides the file field by field, for containers/CI:
//        LF_SECRET__<CREDENTIAL>__<FIELD>=<value>
//      Double underscores separate the three parts; the credential and field
//      names are matched lowercased (LF_SECRET__ACME__TOKEN sets acme's
//      `token`). `LF_SECRET__<CREDENTIAL>__EXTERNAL=<external>` names the
//      external, and with it creates a credential the file does not name, so a
//      container needs no file at all. A credential or field name that itself
//      contains "__" cannot be set from the environment.
//
// OAuth refresh: a credential holding `refresh_token` and `token_url`
// (optionally `client_id`, `client_secret`, `expires_at` as an ISO time) is
// refreshed before a call when `expires_at` is within 30 s, and once more when
// a call answers `unauthorized`. The new `access_token`, `expires_at` and any
// rotated `refresh_token` are written back to the file they came from; a field
// that came from the environment is used for this process only (one warning).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { z } from 'zod';
import { MovementParseError, parseProgram } from 'movement-lang';
import { RemoteProtocolError } from 'movement-engine/services/translation_graph/protocol/client';
import type { Project } from './project';
import { scanMovements } from './sources';

/** Where a credential's fields came from. */
export interface CredentialOrigin {
  /** The secrets file it was read from; absent for a credential made wholly from the environment. */
  file?: { path: string; encrypted: boolean };
  /** The fields whose value the environment supplied. */
  envFields: Set<string>;
}

export interface Credential {
  name: string;
  external: string;
  fields: Record<string, string>;
  origin: CredentialOrigin;
}

const Entry = z.object({ external: z.string().min(1) }).catchall(z.string());

/** The provider key a model call reads (`anthropic: { external: model, api_key: … }`). */
export const MODEL_CREDENTIAL = 'anthropic';

const ENV_PREFIX = 'LF_SECRET__';
const REFRESH_WINDOW_MS = 30_000;

export function secretsPaths(project: Project, env: NodeJS.ProcessEnv = process.env): string[] {
  const named = env.LF_SECRETS_FILE;
  if (named !== undefined && named !== '') return [named];
  return [join(project.lfDir, 'secrets.yaml'), join(homedir(), '.config', 'lf', 'secrets.yaml')];
}

export function loadSecrets(project: Project, env: NodeJS.ProcessEnv = process.env): Map<string, Credential> {
  const paths = secretsPaths(project, env);
  const path = paths.find((p) => existsSync(p));
  if (path === undefined && env.LF_SECRETS_FILE !== undefined && env.LF_SECRETS_FILE !== '') {
    throw new Error(`LF_SECRETS_FILE points at ${env.LF_SECRETS_FILE}, which does not exist`);
  }
  const credentials = new Map<string, Credential>();
  if (path !== undefined) {
    const { content, encrypted } = readSecretsFile(path);
    for (const [name, raw] of Object.entries(content)) {
      if (name === 'sops') continue;
      const entry = Entry.safeParse(raw);
      if (!entry.success) {
        throw new Error(`${path}: credential "${name}" needs an \`external\` and string fields`);
      }
      const { external, ...fields } = entry.data;
      credentials.set(name, { name, external, fields, origin: { file: { path, encrypted }, envFields: new Set() } });
    }
  }
  applyEnvironment(credentials, env);
  return credentials;
}

function readSecretsFile(path: string): { content: Record<string, unknown>; encrypted: boolean } {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = parse(text) ?? {};
  if (!isRecord(parsed)) throw new Error(`${path}: expected a mapping of credential names`);
  if (!('sops' in parsed)) return { content: parsed, encrypted: false };
  const decrypted = spawnSync('sops', ['-d', path], { encoding: 'utf8' });
  if (decrypted.error !== undefined) {
    throw new Error(`${path} is encrypted with SOPS, and \`sops\` could not be run (${decrypted.error.message}); install sops`);
  }
  if (decrypted.status !== 0) throw new Error(`sops -d ${path} failed: ${decrypted.stderr.trim()}`);
  const plain: unknown = parse(decrypted.stdout) ?? {};
  if (!isRecord(plain)) throw new Error(`${path}: decrypted secrets are not a mapping`);
  return { content: plain, encrypted: true };
}

/** `LF_SECRET__<CREDENTIAL>__<FIELD>` overrides a field, or (for EXTERNAL) creates the credential. */
function applyEnvironment(credentials: Map<string, Credential>, env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;
    const parts = key.slice(ENV_PREFIX.length).toLowerCase().split('__');
    const [credentialName, field] = parts;
    if (parts.length !== 2 || !credentialName || !field) {
      throw new Error(`${key}: expected LF_SECRET__<CREDENTIAL>__<FIELD> (double underscores between the parts)`);
    }
    let credential = [...credentials.values()].find((c) => c.name.toLowerCase() === credentialName);
    if (credential === undefined) {
      credential = { name: credentialName, external: '', fields: {}, origin: { envFields: new Set() } };
      credentials.set(credentialName, credential);
    }
    if (field === 'external') {
      credential.external = value;
    } else {
      const existing = Object.keys(credential.fields).find((f) => f.toLowerCase() === field) ?? field;
      credential.fields[existing] = value;
      credential.origin.envFields.add(existing);
    }
  }
  for (const credential of credentials.values()) {
    if (credential.external === '') {
      throw new Error(`credential "${credential.name}" comes from the environment but ${ENV_PREFIX}${credential.name.toUpperCase()}__EXTERNAL is not set`);
    }
  }
}

// ── Credentials a program names ────────────────────────────────────────────

export interface MissingCredential {
  name: string;
  file: string;
  line: number;
  column: number;
  message: string;
}

/** Every credential the project's programs import, that the secrets do not hold. */
export function missingCredentials(project: Project, credentials: Map<string, Credential>, env: NodeJS.ProcessEnv = process.env): MissingCredential[] {
  const missing: MissingCredential[] = [];
  for (const file of scanMovements(project)) {
    let program;
    try {
      program = parseProgram(file.source, { languageVersion: project.languageVersion });
    } catch (error) {
      // `lf check` reports a file that does not parse.
      if (error instanceof MovementParseError) continue;
      throw error;
    }
    for (const statement of program.statements) {
      if (statement.kind !== 'import' || statement.source.kind !== 'builtin' || statement.source.namespace !== 'credentials') continue;
      for (const imported of statement.names) {
        if (credentials.has(imported.name)) continue;
        const where = secretsPaths(project, env).join(', ');
        missing.push({
          name: imported.name,
          file: file.path,
          line: statement.span.start.line,
          column: statement.span.start.col,
          message:
            `credential "${imported.name}" is imported here but not configured. Looked in: ${where}; ` +
            `environment ${ENV_PREFIX}${imported.name.toUpperCase()}__EXTERNAL and ${ENV_PREFIX}${imported.name.toUpperCase()}__<FIELD>`,
        });
      }
    }
  }
  return missing;
}

export class MissingCredentialsError extends Error {
  constructor(readonly missing: MissingCredential[]) {
    super(missing.map((m) => `${m.file}:${m.line}:${m.column} ${m.message}`).join('\n'));
    this.name = 'MissingCredentialsError';
  }
}

/** Refuse, naming each, when a program imports a credential the secrets lack. */
export function requireCredentials(project: Project, credentials: Map<string, Credential>, env: NodeJS.ProcessEnv = process.env): void {
  const missing = missingCredentials(project, credentials, env);
  if (missing.length > 0) throw new MissingCredentialsError(missing);
}

// ── OAuth refresh ──────────────────────────────────────────────────────────

export function isRefreshable(credential: Credential): boolean {
  return credential.fields.refresh_token !== undefined && credential.fields.token_url !== undefined;
}

function expiresSoon(credential: Credential, now: number): boolean {
  const at = credential.fields.expires_at;
  if (at === undefined) return false;
  const ms = Date.parse(at);
  return Number.isNaN(ms) || ms - now <= REFRESH_WINDOW_MS;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().optional(),
  refresh_token: z.string().min(1).optional(),
});

const refreshing = new WeakMap<Credential, Promise<void>>();
const warnedEnvWriteBack = new Set<string>();

/**
 * Run one external call with this credential: refresh first if the token is
 * about to expire, and once more if the call answers `unauthorized`.
 */
export async function withCredential<T>(credential: Credential | undefined, call: () => Promise<T>): Promise<T> {
  if (credential === undefined || !isRefreshable(credential)) return call();
  if (expiresSoon(credential, Date.now())) await refreshCredential(credential);
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof RemoteProtocolError) || error.error.code !== 'unauthorized') throw error;
    await refreshCredential(credential);
    return call();
  }
}

/** A standard OAuth2 refresh; updates the credential in memory and where it came from. */
export function refreshCredential(credential: Credential): Promise<void> {
  const inFlight = refreshing.get(credential);
  if (inFlight !== undefined) return inFlight;
  const run = doRefresh(credential).finally(() => refreshing.delete(credential));
  refreshing.set(credential, run);
  return run;
}

async function doRefresh(credential: Credential): Promise<void> {
  const { token_url, refresh_token, client_id, client_secret } = credential.fields;
  if (token_url === undefined || refresh_token === undefined) throw new Error(`credential "${credential.name}" is not refreshable`);
  // Checked before the refresh token is spent: a rotated one must not be lost.
  assertWritable(credential);
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token });
  if (client_id !== undefined) form.set('client_id', client_id);
  if (client_secret !== undefined) form.set('client_secret', client_secret);
  const response = await fetch(token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`refreshing credential "${credential.name}" at ${token_url} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const parsed = TokenResponse.safeParse(await response.json());
  if (!parsed.success) throw new Error(`refreshing credential "${credential.name}": the token endpoint's answer has no access_token`);
  const updates: Record<string, string> = { access_token: parsed.data.access_token };
  if (parsed.data.expires_in !== undefined) updates.expires_at = new Date(Date.now() + parsed.data.expires_in * 1000).toISOString();
  if (parsed.data.refresh_token !== undefined) updates.refresh_token = parsed.data.refresh_token;
  Object.assign(credential.fields, updates);
  writeBackCredential(credential, updates);
}

function assertWritable(credential: Credential): void {
  const file = credential.origin.file;
  if (file?.encrypted !== true) return;
  const probe = spawnSync('sops', ['--version'], { encoding: 'utf8' });
  if (probe.error !== undefined) throw sopsRefusal(credential, file.path, probe.error.message);
}

function sopsRefusal(credential: Credential, path: string, why: string): Error {
  return new Error(
    `credential "${credential.name}" was refreshed but ${path} is encrypted with SOPS and \`sops\` could not be run (${why}); ` +
      'install sops (the refreshed token was not saved)',
  );
}

/**
 * Persist refreshed fields to where the credential came from: a plain file is
 * rewritten in place (comments and order kept), a SOPS file is updated field
 * by field with `sops set` (re-encrypted in place), and a field the
 * environment supplied is used for this process only.
 */
export function writeBackCredential(credential: Credential, updates: Record<string, string>): void {
  const { file, envFields } = credential.origin;
  const fileUpdates = Object.entries(updates).filter(([field]) => !envFields.has(field));
  if (fileUpdates.length < Object.keys(updates).length && !warnedEnvWriteBack.has(credential.name)) {
    warnedEnvWriteBack.add(credential.name);
    process.stderr.write(`lf: credential "${credential.name}" has fields from the environment; its refreshed token is used for this run only and cannot be written back\n`);
  }
  if (fileUpdates.length === 0 || file === undefined) {
    if (file === undefined && fileUpdates.length > 0 && !warnedEnvWriteBack.has(credential.name)) {
      warnedEnvWriteBack.add(credential.name);
      process.stderr.write(`lf: credential "${credential.name}" has no secrets file; its refreshed token is used for this run only\n`);
    }
    return;
  }
  if (file.encrypted) {
    for (const [field, value] of fileUpdates) {
      const set = spawnSync('sops', ['set', file.path, `[${JSON.stringify(credential.name)}][${JSON.stringify(field)}]`, JSON.stringify(value)], { encoding: 'utf8' });
      if (set.error !== undefined) throw sopsRefusal(credential, file.path, set.error.message);
      if (set.status !== 0) throw new Error(`credential "${credential.name}": sops set on ${file.path} failed: ${set.stderr.trim()}`);
    }
    return;
  }
  const document = parseDocument(readFileSync(file.path, 'utf8'));
  for (const [field, value] of fileUpdates) document.setIn([credential.name, field], value);
  const staging = join(dirname(file.path), `.${credential.name}.secrets.tmp`);
  writeFileSync(staging, document.toString(), { mode: 0o600 });
  renameSync(staging, file.path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
