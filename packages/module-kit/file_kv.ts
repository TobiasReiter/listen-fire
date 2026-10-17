// A module's kv kept in a directory of files, one JSON file per tenant: what
// `serve-module` gives a module when it is told where its state lives
// (`MODULE_STATE_DIR`). Entries keep the order their keys were first set, so
// `list` answers in creation order as every kv does. A write replaces the file
// whole, through a temporary file and a rename, so a reader never sees half
// of one; the writes of one process to one file are queued, so two never race.
// The file is read on every call, so state seeded or edited beside the process
// is what the next call sees.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleKv } from './define';

import { refusingKv } from './in_process';

interface KvFile {
  entries: Array<{ key: string; value: unknown }>;
}

function isKvFile(value: unknown): value is KvFile {
  if (value === null || typeof value !== 'object') return false;
  const entries: unknown = Reflect.get(value, 'entries');
  return Array.isArray(entries) && entries.every((entry: unknown) => entry !== null && typeof entry === 'object' && typeof Reflect.get(entry, 'key') === 'string');
}

/** The path of a tenant's file under `dir`. */
export function fileKvPath(dir: string, tenant: string): string {
  return join(dir, `${encodeURIComponent(tenant)}.json`);
}

/** Write `entries` as a tenant's file, as `fileKv` would (seeding one). */
export async function writeFileKv(dir: string, tenant: string, entries: KvFile['entries']): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = fileKvPath(dir, tenant);
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ entries } satisfies KvFile, null, 2)}\n`);
  await rename(temporary, path);
}

/** Queued writes per file, across every kv this process opened on it. */
const queues = new Map<string, Promise<unknown>>();

export function fileKv(dir: string, tenant: string): ModuleKv {
  if (tenant === '') return refusingKv('ctx.kv: the request named no tenant, so there is no state to read or keep');
  const path = fileKvPath(dir, tenant);

  const read = async (): Promise<KvFile['entries']> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (Reflect.get(Object(error), 'code') === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isKvFile(parsed)) throw new Error(`ctx.kv: ${path} is not a kv file ({ "entries": [{ "key", "value" }] })`);
    return parsed.entries;
  };

  const change = (edit: (entries: KvFile['entries']) => KvFile['entries']): Promise<void> => {
    const before = queues.get(path) ?? Promise.resolve();
    const run = before.then(async () => writeFileKv(dir, tenant, edit(await read())));
    const settled = run.catch(() => undefined);
    queues.set(path, settled);
    void settled.then(() => {
      if (queues.get(path) === settled) queues.delete(path);
    });
    return run;
  };

  return {
    get: async (key) => (await read()).find((entry) => entry.key === key)?.value,
    list: async (prefix) => (await read()).filter((entry) => entry.key.startsWith(prefix)),
    set: (key, value) =>
      change((entries) => {
        const json: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value));
        const at = entries.findIndex((entry) => entry.key === key);
        // A key set again keeps its place: the order is the order keys were first set.
        if (at < 0) return [...entries, { key, value: json }];
        return entries.map((entry, index) => (index === at ? { key, value: json } : entry));
      }),
    delete: (key) => change((entries) => entries.filter((entry) => entry.key !== key)),
  };
}
