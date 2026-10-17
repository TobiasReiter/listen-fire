// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against the Rust lf-host's Postgres backend — the hosted
// product's automations tables — driven over its stdio JSON-RPC bridge
// (`lf-host --contract-store postgres://… --team <uuid>`) by
// `RpcStoreBackend`: the same cases the hosted Postgres backend and both
// SQLite backends are held to, the callback and cancel cases included.
// Every case's rows are one fresh team's, cleared after it.

import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  callbackContractCases,
  cancelContractCases,
  runHostContractCases,
  type RecordsContractBackend,
} from 'movement-engine/services/run_host/contract';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { lfHostBinary } from '../lf_host';
import { freshTeam, POSTGRES_URL } from './pg';

for (const contractCase of [...runHostContractCases, ...callbackContractCases, ...cancelContractCases]) {
  test(contractCase.name, async () => {
    const { team, clear } = freshTeam();
    const backend = new RpcStoreBackend(lfHostBinary(), ['--contract-store', POSTGRES_URL, '--team', team]);
    const records: RecordsContractBackend = {
      store: backend.store,
      callbacks: backend.callbacks,
      runs: backend.runs,
      teamId: team,
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
      clear();
    }
  });
}
