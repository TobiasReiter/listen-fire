// A secrets store another process serves: `SecretsBackend` (movement-engine
// services/secrets/family.ts) forwarded over the process's stdin/stdout, one
// JSON-RPC 2.0 message per line — how the secrets contract suite, written
// once in TypeScript, holds the Rust lf-host's stores (`lf-host
// --contract-secrets <file | env>`) to the same meaning as lf's own. The
// transport is the run host bridge's (`RpcStoreBackend`).

import { z } from 'zod';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import type { SecretFields, SecretRecord, SecretsBackend, WriteBackOutcome } from 'movement-engine/public/secrets';

const Record = z.object({ fields: z.record(z.string(), z.string()), version: z.string() });
const Outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('written'), record: Record }),
  z.object({ kind: z.literal('not_persisted'), record: Record, why: z.string() }),
  z.object({ kind: z.literal('conflict'), current: Record }),
  z.object({ kind: z.literal('missing') }),
]);
const Nothing = z.null();

export class RpcSecretsBackend implements SecretsBackend {
  private readonly rpc: RpcStoreBackend;
  exclusive?: <T>(ref: string, body: (store: SecretsBackend) => Promise<T>) => Promise<T>;

  /** `target`: a secrets file, or `env` for the environment store. A file
   *  store's lock is its lock file, taken through the process. */
  constructor(binary: string, target: string) {
    this.rpc = new RpcStoreBackend(binary, ['--contract-secrets', target]);
    if (target !== 'env') {
      this.exclusive = async (ref, body) => {
        await this.rpc.call('lock', { ref }, Nothing);
        try {
          return await body(this);
        } finally {
          await this.rpc.call('unlock', { ref }, Nothing);
        }
      };
    }
  }

  async resolve(ref: string): Promise<SecretRecord | null> {
    return this.rpc.call('resolve', { ref }, Record.nullable());
  }

  async writeBack(ref: string, fields: SecretFields, expectedVersion: string): Promise<WriteBackOutcome> {
    return this.rpc.call('writeBack', { ref, fields, expectedVersion }, Outcome);
  }

  async assertWritable(ref: string): Promise<void> {
    await this.rpc.call('assertWritable', { ref }, Nothing);
  }

  /** A variable the environment store reads from now on. */
  async setEnv(key: string, value: string): Promise<void> {
    await this.rpc.call('env.set', { key, value }, Nothing);
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}
