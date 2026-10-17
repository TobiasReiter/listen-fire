// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against lf's SQLite backend: the same cases the hosted
// Postgres backend is held to, one fresh state file per case.

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
import { LOCAL_TENANT } from '../host';
import { localRunRecords } from '../parks';
import { State } from '../state';

function backendOf(state: State): RecordsContractBackend {
  return {
    store: state.store,
    callbacks: state.callbacks,
    runs: localRunRecords(state),
    teamId: LOCAL_TENANT,
    newRun: async () => {
      const id = randomUUID();
      state.startRun({ id, file: 'f', movement: 'm', started_at: new Date().toISOString(), input: '{}' });
      return id;
    },
    requestCancel: async ({ runId, reason }) => {
      state.requestCancel(runId, reason);
    },
    runStatus: async (runId) => state.run(runId)?.status ?? 'missing',
    completeRun: async (runId) => state.settleRun(runId, 'completed', null, new Date().toISOString()),
  };
}

for (const contractCase of [...runHostContractCases, ...callbackContractCases, ...cancelContractCases]) {
  test(contractCase.name, async () => {
    const state = new State(join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db'));
    try {
      await contractCase.run(backendOf(state));
    } finally {
      state.close();
    }
  });
}
