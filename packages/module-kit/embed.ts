// Context parts an embedder fills a module's context with when it loads the
// module in its own process: the install's credential read from the
// embedder's secrets (one tenant's vault entry), and module state kept in
// memory. The platform builds the same parts over its own tables
// (apps/api builtin_modules.ts).

import type { SecretsFamily } from 'movement-engine/public/secrets';

import type { CredentialFields, ModuleCredential, ModuleKv } from './define';

/**
 * The credential stored at `ref` in `secrets`, as a module reads it: its
 * fields read per call, a provider's change written back through the family
 * (under the store's lock). An OAuth 2 credential is not refreshed here: an
 * embedder whose modules hold one refreshes through the family
 * (`declaredRefresher`, public/secrets) before the call.
 */
export function secretsCredential(input: { name: string; ref: string; secrets: SecretsFamily }): ModuleCredential {
  const { name, ref, secrets } = input;
  return {
    name,
    fields: async (): Promise<CredentialFields> => (await secrets.resolve(ref)).fields,
    update: async (fields) => {
      await secrets.update(ref, fields);
    },
  };
}

/** Module state in memory: one process, gone when it exits. */
export function memoryKv(): ModuleKv {
  const entries = new Map<string, unknown>();
  return {
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
    },
    list: async (prefix) => [...entries].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  };
}
