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
// (optionally `client_id`, `client_secret`, `expires_at` as an ISO time), or
// one an external's manifest declares `oauth2`, is refreshed before a call
// when `expires_at` is within 30 s, and once more when a call answers
// `unauthorized`. The new `access_token`, `expires_at` and any rotated
// `refresh_token` are written back to the file they came from; a field that
// came from the environment is used for this process only (one warning). All
// of it goes through the engine's secrets family (see below).

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { z } from 'zod';
import { MovementParseError, parseProgram } from 'movement-lang';
import { RemoteProtocolError } from 'movement-engine/public/adapter';
import {
  contentVersion,
  createSecretsFamily,
  oauth2Refresher,
  redactSecrets,
  withSecret,
  type Refresher,
  type SecretRecord,
  type SecretsBackend,
  type SecretsFamily,
  type WriteBackOutcome,
} from 'movement-engine/public/secrets';
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

// ── The secrets family over lf's stores ────────────────────────────────────
// A credential is refreshed and written back through the engine's secrets
// family (movement-engine `public/secrets`), the same rules the platform's
// encrypted table keeps: write-back at a version, one refresh at a time (a
// lock file beside the secrets file, so `lf serve` and an `lf run` beside it
// spend a refresh token once), and a SOPS file whose `sops` cannot run is
// refused before the refresh token is spent.

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 20;

/** A secrets file's lock: a file created exclusively beside it. One left by a
 *  process that died is taken over once it is older than LOCK_STALE_MS. */
async function withFileLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch (gone) {
        if (!isErrno(gone, 'ENOENT')) throw gone;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`${path} stayed locked by another lf for ${LOCK_WAIT_MS / 1000}s (${lock})`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await body();
  } finally {
    try {
      unlinkSync(lock);
    } catch (gone) {
      if (!isErrno(gone, 'ENOENT')) throw gone;
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** One credential's fields in a secrets file's content, without `external`. */
function entryFields(content: Record<string, unknown>, name: string): Record<string, string> | null {
  const entry = Entry.safeParse(content[name]);
  if (!entry.success) return null;
  const { external: _external, ...fields } = entry.data;
  return fields;
}

/**
 * A secrets file as a store: a plain YAML file is rewritten in place (comments
 * and order kept, through a staging file); a SOPS file is read with `sops -d`
 * and updated field by field with `sops set`, never decrypted onto disk.
 */
export function fileSecrets(path: string, options: { encrypted?: boolean } = {}): SecretsBackend {
  const encrypted = options.encrypted ?? readSecretsFile(path).encrypted;
  const current = (name: string): SecretRecord | null => {
    const fields = entryFields(readSecretsFile(path).content, name);
    return fields === null ? null : { fields, version: contentVersion(fields) };
  };
  const backend: SecretsBackend = {
    async resolve(name) {
      return current(name);
    },
    async writeBack(name, fields, expectedVersion): Promise<WriteBackOutcome> {
      const now = current(name);
      if (now === null) return { kind: 'missing' };
      if (now.version !== expectedVersion) return { kind: 'conflict', current: now };
      const changed = Object.entries(fields);
      if (encrypted) {
        for (const [field, value] of changed) {
          const set = spawnSync('sops', ['set', path, `[${JSON.stringify(name)}][${JSON.stringify(field)}]`, JSON.stringify(value)], { encoding: 'utf8' });
          if (set.error !== undefined) throw sopsRefusal(name, path, set.error.message);
          if (set.status !== 0) throw new Error(`credential "${name}": sops set on ${path} failed: ${redactSecrets(set.stderr.trim(), Object.values(fields))}`);
        }
      } else {
        const document = parseDocument(readFileSync(path, 'utf8'));
        for (const [field, value] of changed) document.setIn([name, field], value);
        const staging = join(dirname(path), `.${name}.secrets.tmp`);
        writeFileSync(staging, document.toString(), { mode: 0o600 });
        renameSync(staging, path);
      }
      const merged = { ...now.fields, ...fields };
      return { kind: 'written', record: { fields: merged, version: contentVersion(merged) } };
    },
    exclusive: (_name, body) => withFileLock(path, () => body(backend)),
    assertWritable: async (name) => assertSopsRuns(name, path, encrypted),
  };
  return backend;
}

async function assertSopsRuns(name: string, path: string, encrypted: boolean): Promise<void> {
  if (!encrypted) return;
  const probe = spawnSync('sops', ['--version'], { encoding: 'utf8' });
  if (probe.error !== undefined) throw sopsRefusal(name, path, probe.error.message);
}

function sopsRefusal(name: string, path: string, why: string): Error {
  return new Error(
    `credential "${name}" was refreshed but ${path} is encrypted with SOPS and \`sops\` could not be run (${why}); ` +
      'install sops (the refreshed token was not saved)',
  );
}

const ENV_NOT_PERSISTED = (name: string) =>
  `credential "${name}" has fields from the environment; its refreshed token is used for this run only and cannot be written back`;

/**
 * The environment (`LF_SECRET__…`) as a store. It is read-only: a write-back
 * is kept for this process and reported once, since nothing lf runs can
 * change its parent's environment.
 */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretsBackend {
  const kept = new Map<string, Record<string, string>>();
  const current = (name: string): SecretRecord | null => {
    const credentials = new Map<string, Credential>();
    applyEnvironment(credentials, env);
    const credential = credentials.get(name);
    if (credential === undefined) return null;
    const fields = { ...credential.fields, ...kept.get(name) };
    return { fields, version: contentVersion(fields) };
  };
  return {
    async resolve(name) {
      return current(name);
    },
    async writeBack(name, fields, expectedVersion): Promise<WriteBackOutcome> {
      const now = current(name);
      if (now === null) return { kind: 'missing' };
      if (now.version !== expectedVersion) return { kind: 'conflict', current: now };
      kept.set(name, { ...kept.get(name), ...fields });
      const merged = { ...now.fields, ...fields };
      return { kind: 'not_persisted', record: { fields: merged, version: contentVersion(merged) }, why: ENV_NOT_PERSISTED(name) };
    },
  };
}

/**
 * One loaded credential as a store: its secrets file's fields, read through
 * to the file, with the fields the environment supplied over them. A
 * write-back goes to the file for the fields that came from it, and is kept
 * for this process (reported once) for the ones the environment supplied. The
 * credential's own `fields` follow every read and write.
 */
function credentialSecrets(credential: Credential): SecretsBackend {
  const { file: origin, envFields } = credential.origin;
  const file = origin !== undefined ? fileSecrets(origin.path, { encrypted: origin.encrypted }) : undefined;
  const envOverlay = (): Record<string, string> => {
    const overlay: Record<string, string> = {};
    for (const field of envFields) {
      const value = credential.fields[field];
      if (value !== undefined) overlay[field] = value;
    }
    return overlay;
  };
  const read = async (store: SecretsBackend | undefined): Promise<{ record: SecretRecord; fileVersion?: string } | null> => {
    const fromFile = store !== undefined ? await store.resolve(credential.name) : null;
    if (store !== undefined && fromFile === null && envFields.size === 0) return null;
    const fields = { ...(fromFile?.fields ?? {}), ...envOverlay() };
    for (const key of Object.keys(credential.fields)) if (!(key in fields)) delete credential.fields[key];
    Object.assign(credential.fields, fields);
    return { record: { fields, version: contentVersion(fields) }, ...(fromFile !== null ? { fileVersion: fromFile.version } : {}) };
  };
  const over = (store: SecretsBackend | undefined): SecretsBackend => {
    const backend: SecretsBackend = {
      async resolve() {
        return (await read(store))?.record ?? null;
      },
      async writeBack(_name, fields, expectedVersion): Promise<WriteBackOutcome> {
        const now = await read(store);
        if (now === null) return { kind: 'missing' };
        if (now.record.version !== expectedVersion) return { kind: 'conflict', current: now.record };
        const toFile = Object.fromEntries(Object.entries(fields).filter(([field]) => !envFields.has(field)));
        const fileCount = Object.keys(toFile).length;
        if (store !== undefined && now.fileVersion !== undefined && fileCount > 0) {
          const written = await store.writeBack(credential.name, toFile, now.fileVersion);
          if (written.kind === 'conflict' || written.kind === 'missing') return written;
        }
        Object.assign(credential.fields, fields);
        const record = { fields: { ...credential.fields }, version: contentVersion(credential.fields) };
        if (fileCount < Object.keys(fields).length) return { kind: 'not_persisted', record, why: ENV_NOT_PERSISTED(credential.name) };
        if (store === undefined && fileCount > 0) {
          return { kind: 'not_persisted', record, why: `credential "${credential.name}" has no secrets file; its refreshed token is used for this run only` };
        }
        return { kind: 'written', record };
      },
    };
    if (origin !== undefined && store !== undefined) {
      backend.exclusive = (_name, body) => withFileLock(origin.path, () => body(backend));
      backend.assertWritable = (name) => assertSopsRuns(name, origin.path, origin.encrypted);
    }
    return backend;
  };
  return over(file);
}

const families = new WeakMap<Credential, SecretsFamily>();

/** The secrets family a loaded credential is refreshed and written back
 *  through: one per credential, so its single flight covers every call. */
export function secretsOf(credential: Credential): SecretsFamily {
  let family = families.get(credential);
  if (family === undefined) {
    family = createSecretsFamily({ backend: credentialSecrets(credential), warn: (message) => process.stderr.write(`lf: ${message}\n`) });
    families.set(credential, family);
  }
  return family;
}

// ── OAuth refresh ──────────────────────────────────────────────────────────
// A credential the external's manifest does not declare is refreshed when it
// holds `refresh_token` and `token_url` (and optionally `client_id`,
// `client_secret`), sent in the form body: lf's own convention, kept. A
// declared `oauth2` credential is refreshed from its declaration instead
// (remote.ts).

export function isRefreshable(credential: Credential): boolean {
  return credential.fields.refresh_token !== undefined && credential.fields.token_url !== undefined;
}

/** The refresher for an undeclared credential, from its own `token_url`. */
function fieldsRefresher(credential: Credential): Refresher | undefined {
  const tokenUrl = credential.fields.token_url;
  if (tokenUrl === undefined || credential.fields.refresh_token === undefined) return undefined;
  return oauth2Refresher({ tokenUrl, clientAuth: 'body' });
}

/** True for a protocol call refused as `unauthorized`: the one failure a
 *  refreshed token can fix. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof RemoteProtocolError && error.error.code === 'unauthorized';
}

/**
 * Run one external call with this credential: refresh first if the token is
 * about to expire, and once more if the call answers `unauthorized`.
 */
export async function withCredential<T>(credential: Credential | undefined, call: () => Promise<T>): Promise<T> {
  const refresher = credential !== undefined ? fieldsRefresher(credential) : undefined;
  if (credential === undefined || refresher === undefined) return call();
  return withSecret(secretsOf(credential), credential.name, { refresher, isUnauthorized }, () => call());
}

/** A standard OAuth2 refresh; updates the credential in memory and where it came from. */
export async function refreshCredential(credential: Credential): Promise<void> {
  const refresher = fieldsRefresher(credential);
  if (refresher === undefined) throw new Error(`credential "${credential.name}" is not refreshable`);
  // The credential's fields are the store's last answer, so their version is
  // the one this caller found stale.
  await secretsOf(credential).refresh(credential.name, { seenVersion: contentVersion(credential.fields), refresher });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
