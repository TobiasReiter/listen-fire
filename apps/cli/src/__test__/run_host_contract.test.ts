// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against lf's SQLite backend, driven over its stdio JSON-RPC
// bridge (`lf --contract-store`) by `RpcStoreBackend`: the same cases the
// hosted Postgres backend is held to (the live state families, the callbacks
// and the cancel cases), one fresh state file per case. Then the same cases
// through a third-party store module filling a project's store slot
// (`lf --contract-store-slot`): lf drives the module over the store wire,
// and the module (store_module/forward.mjs) forwards to `lf --contract-store`.

import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callbackContractCases,
  cancelContractCases,
  runHostContractCases,
  type RecordsContractBackend,
} from 'movement-engine/services/run_host/contract';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
// The tenant every local run belongs to.
const LOCAL_TENANT = 'local';
import { lfBinary } from './lf_bin';
import { withStoreModule } from './store_module/project';

/** A project whose store slot a store module fills, its state in `path`. */
function storeModuleProject(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-contract-slot-'));
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.11.0\n');
  withStoreModule(dir, path);
  return dir;
}

const bridges = [
  { over: 'the SQLite store', args: (path: string) => ['--contract-store', path] },
  { over: 'a store module', args: (path: string) => ['--contract-store-slot', '--dir', storeModuleProject(path)] },
];

for (const bridge of bridges)
for (const contractCase of [...runHostContractCases, ...callbackContractCases, ...cancelContractCases]) {
  test(`${bridge.over}: ${contractCase.name}`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db');
    const backend = new RpcStoreBackend(lfBinary(), bridge.args(path));
    const records: RecordsContractBackend = {
      store: backend.store,
      callbacks: backend.callbacks,
      runs: backend.runs,
      teamId: LOCAL_TENANT,
      newRun: async () => {
        const id = randomUUID();
        await backend.startRun({ id, file: 'f', movement: 'm', startedAt: new Date().toISOString(), input: '{}' });
        return id;
      },
      requestCancel: (input) => backend.requestCancel(input),
      runStatus: (runId) => backend.runStatus(runId),
      completeRun: (runId) => backend.completeRun(runId),
    };
    try {
      await contractCase.run(records);
    } finally {
      await backend.close();
    }
  });
}
