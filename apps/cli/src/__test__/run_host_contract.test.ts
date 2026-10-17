// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against the Rust lf's SQLite backend, driven over its
// stdio JSON-RPC bridge (`lf --contract-store`) by `RpcStoreBackend`:
// the same cases the hosted Postgres backend is
// held to (the live state families, the callbacks and the cancel cases), one
// fresh state file per case.

import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
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

for (const contractCase of [...runHostContractCases, ...callbackContractCases, ...cancelContractCases]) {
  test(contractCase.name, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db');
    const backend = new RpcStoreBackend(lfBinary(), ['--contract-store', path]);
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
