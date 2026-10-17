// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against the Rust lf-host's SQLite backend, driven over its
// stdio JSON-RPC bridge (`lf-host --contract-store`) by `RpcStoreBackend`:
// the same cases the TypeScript SQLite and the hosted Postgres backends are
// held to (the live state families, the callbacks and the cancel cases), one
// fresh state file per case.

import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callbackContractCases, cancelContractCases, runHostContractCases } from 'movement-engine/services/run_host/contract';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { LOCAL_TENANT } from '../host';
import { lfHostBinary } from './lf_host';

for (const contractCase of [...runHostContractCases, ...callbackContractCases, ...cancelContractCases]) {
  test(contractCase.name, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-host-contract-')), 'state.db');
    const backend = new RpcStoreBackend(lfHostBinary(), ['--contract-store', path]);
    try {
      await contractCase.run({
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
      });
    } finally {
      await backend.close();
    }
  });
}
