// The run host's contract suite (movement-engine run_host/contract.ts) against
// the hosted Postgres backend: the same cases lf's SQLite backend is held to.
// Every case's runs are fresh trigger_run rows of one throwaway team; their
// live state goes with them.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import {
  callbackContractCases,
  cancelContractCases,
  runHostContractCases,
  type RecordsContractBackend,
} from 'movement-engine/services/run_host/contract';

import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../../lib/kysely';
import { postgresCallbackStore } from '../callback_store';
import { hostedRunHost } from '../run_host';
import { postgresRunHostStore, triggerRunIdOf } from '../run_host_store';

const TEAM_ID = randomUUID();
const runs: TriggerRunId[] = [];

async function newRun(): Promise<string> {
  const row = await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({ team_id: TEAM_ID, trigger_id: `run-host-contract-${randomUUID()}`, trigger_type: 'webhook', status: 'parked' })
    .returning('id')
    .executeTakeFirstOrThrow();
  runs.push(row.id);
  return row.id;
}

const backend: RecordsContractBackend = {
  store: postgresRunHostStore,
  callbacks: postgresCallbackStore,
  runs: hostedRunHost().runs,
  teamId: TEAM_ID,
  newRun,
  async requestCancel({ runId, reason }) {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ cancel_requested_at: sql`now()`, cancel_reason: reason })
      .where('id', '=', triggerRunIdOf(runId))
      .execute();
  },
  async runStatus(runId) {
    const row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', triggerRunIdOf(runId))
      .select('status')
      .executeTakeFirstOrThrow();
    return row.status;
  },
  async completeRun(runId) {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ status: 'success' })
      .where('id', '=', triggerRunIdOf(runId))
      .execute();
  },
};

afterAll(async () => {
  if (runs.length === 0) return;
  await getAutomationsQb(['callback']).deleteFrom('callback').where('run_id', 'in', runs).execute();
  await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', 'in', runs).execute();
});

describe('the run host contract on Postgres', () => {
  for (const contractCase of runHostContractCases) {
    it(contractCase.name, () => contractCase.run(backend));
  }
});

describe('the callback and cancel contract on Postgres', () => {
  for (const contractCase of [...callbackContractCases, ...cancelContractCases]) {
    it(contractCase.name, () => contractCase.run(backend));
  }
});
