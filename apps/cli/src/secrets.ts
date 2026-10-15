// Secrets live outside the program: a program names a credential, and the
// host hands that credential's fields to the external's call and nowhere else.
// The engine never sees one.
//
// The file is YAML keyed by credential name → the external it is for, plus its
// fields. It is SOPS-compatible: a file carrying SOPS metadata is decrypted
// with `sops -d`.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Project } from './project';

export interface Credential {
  name: string;
  external: string;
  fields: Record<string, string>;
}

const Entry = z.object({ external: z.string().min(1) }).catchall(z.string());

/** The provider key a model call reads (`anthropic: { external: model, api_key: … }`). */
export const MODEL_CREDENTIAL = 'anthropic';

export function secretsPaths(project: Project): string[] {
  return [join(project.lfDir, 'secrets.yaml'), join(homedir(), '.config', 'lf', 'secrets.yaml')];
}

export function loadSecrets(project: Project, env: NodeJS.ProcessEnv = process.env): Map<string, Credential> {
  const path = secretsPaths(project).find((p) => existsSync(p));
  const credentials = new Map<string, Credential>();
  if (path !== undefined) {
    for (const [name, raw] of Object.entries(readSecretsFile(path))) {
      if (name === 'sops') continue;
      const entry = Entry.safeParse(raw);
      if (!entry.success) {
        throw new Error(`${path}: credential "${name}" needs an \`external\` and string fields`);
      }
      const { external, ...fields } = entry.data;
      credentials.set(name, { name, external, fields });
    }
  }
  applyEnvironment(credentials, env);
  return credentials;
}

function readSecretsFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = parse(text) ?? {};
  if (!isRecord(parsed)) throw new Error(`${path}: expected a mapping of credential names`);
  if (!('sops' in parsed)) return parsed;
  const decrypted = spawnSync('sops', ['-d', path], { encoding: 'utf8' });
  if (decrypted.error !== undefined) {
    throw new Error(`${path} is encrypted with SOPS, and \`sops\` could not be run (${decrypted.error.message}); install sops`);
  }
  if (decrypted.status !== 0) throw new Error(`sops -d ${path} failed: ${decrypted.stderr.trim()}`);
  const plain: unknown = parse(decrypted.stdout) ?? {};
  if (!isRecord(plain)) throw new Error(`${path}: decrypted secrets are not a mapping`);
  return plain;
}

/**
 * Environment overrides for containers and CI: `LF_SECRET_<CREDENTIAL>_<FIELD>`
 * sets one field of a credential the file already names. STUB: a credential
 * the file does not name cannot be created from the environment yet (its
 * external would be unknown).
 */
function applyEnvironment(credentials: Map<string, Credential>, env: NodeJS.ProcessEnv): void {
  for (const credential of credentials.values()) {
    for (const field of Object.keys(credential.fields)) {
      const value = env[`LF_SECRET_${credential.name}_${field}`.toUpperCase()];
      if (value !== undefined) credential.fields[field] = value;
    }
  }
}

/**
 * Persist a refreshed credential an external handed back (an OAuth token
 * refresh). STUB: the adapter protocol has no door for handing a refreshed
 * credential back yet, so nothing calls this; when it does, the write goes to
 * the file the credential came from (re-encrypted with `sops -e` when it was).
 */
export function writeBackCredential(_project: Project, credential: Credential): never {
  throw new Error(`writing a refreshed credential back is not built yet (credential "${credential.name}")`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
