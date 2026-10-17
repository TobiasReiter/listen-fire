// The credentials table, in memory, for unit tests of a module line: each
// credential kept as its stored JSON payload (what the connect flow wrote)
// and read and written back through a `PayloadShape`, exactly as the Postgres
// store does, so a test sees the payload a refresh leaves behind. Its lock is
// a queue per credential.

import type { SecretsBackend } from 'movement-engine/public/secrets';
import type { PayloadShape } from '../secrets_postgres';

import { contentVersion } from 'movement-engine/public/secrets';

export type StoredPayloads = Map<string, Record<string, unknown>>;

const versionOf = (payload: Record<string, unknown>): string => contentVersion({ payload: JSON.stringify(payload) });

export function payloadSecrets(payloads: StoredPayloads, shape: PayloadShape): SecretsBackend {
  const locks = new Map<string, Promise<unknown>>();
  const backend: SecretsBackend = {
    async resolve(ref) {
      const payload = payloads.get(ref);
      return payload === undefined ? null : { fields: shape.toFields(payload), version: versionOf(payload) };
    },
    async writeBack(ref, fields, expectedVersion) {
      const payload = payloads.get(ref);
      if (payload === undefined) return { kind: 'missing' };
      if (versionOf(payload) !== expectedVersion) return { kind: 'conflict', current: { fields: shape.toFields(payload), version: versionOf(payload) } };
      const next = shape.withFields(payload, fields);
      payloads.set(ref, next);
      return { kind: 'written', record: { fields: shape.toFields(next), version: versionOf(next) } };
    },
    async exclusive(ref, body) {
      const before = locks.get(ref) ?? Promise.resolve();
      const run = before.then(() => body(backend));
      locks.set(ref, run.catch(() => undefined));
      return run;
    },
  };
  return backend;
}
