// The run host's contract suite (packages/movement-engine/services/run_host/
// contract.ts) against lf's SQLite backend: the same cases the hosted
// Postgres backend is held to, one fresh state file per case.

import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHostContractCases } from 'movement-engine/services/run_host/contract';
import { LOCAL_TENANT } from '../host';
import { State } from '../state';

for (const contractCase of runHostContractCases) {
  test(contractCase.name, async () => {
    const state = new State(join(mkdtempSync(join(tmpdir(), 'lf-contract-')), 'state.db'));
    try {
      await contractCase.run({
        store: state.store,
        teamId: LOCAL_TENANT,
        newRun: async () => {
          const id = randomUUID();
          state.startRun({ id, file: 'f', movement: 'm', started_at: new Date().toISOString(), input: '{}' });
          return id;
        },
      });
    } finally {
      state.close();
    }
  });
}
