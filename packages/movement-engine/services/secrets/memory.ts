// The in-memory vault: the secrets store an embedder starts from (and the
// reference the contract suite checks first). An embedder with a real vault
// implements `SecretsBackend` over it the same way.

import { contentVersion, type SecretFields, type SecretRecord, type SecretsBackend, type WriteBackOutcome } from './family';

export interface MemoryVault extends SecretsBackend {
  /** Store a credential outright (seeding; a connect flow). */
  put(ref: string, fields: SecretFields): SecretRecord;
}

export function createMemoryVault(initial: Record<string, SecretFields> = {}): MemoryVault {
  const stored = new Map<string, SecretRecord>();
  const locks = new Map<string, Promise<unknown>>();

  const put = (ref: string, fields: SecretFields): SecretRecord => {
    const record = { fields: { ...fields }, version: contentVersion(fields) };
    stored.set(ref, record);
    return record;
  };
  for (const [ref, fields] of Object.entries(initial)) put(ref, fields);

  const vault: MemoryVault = {
    put,
    async resolve(ref) {
      return stored.get(ref) ?? null;
    },
    async writeBack(ref, fields, expectedVersion): Promise<WriteBackOutcome> {
      const current = stored.get(ref);
      if (current === undefined) return { kind: 'missing' };
      if (current.version !== expectedVersion) return { kind: 'conflict', current };
      return { kind: 'written', record: put(ref, { ...current.fields, ...fields }) };
    },
    async exclusive(ref, body) {
      const before = locks.get(ref) ?? Promise.resolve();
      const run = before.then(() => body(vault));
      const settled = run.catch(() => undefined);
      locks.set(ref, settled);
      try {
        return await run;
      } finally {
        if (locks.get(ref) === settled) locks.delete(ref);
      }
    },
  };
  return vault;
}
