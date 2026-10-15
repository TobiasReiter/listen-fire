// The run host's contract suite (movement-engine run_host/contract.ts) against
// the hosted Postgres backend: the same cases lf's SQLite backend is held to.
// Every case's runs are fresh trigger_run rows of one throwaway team; their
// live state goes with them.

import { randomUUID } from 'node:crypto';
import { runHostContractCases } from 'movement-engine/services/run_host/contract';

import { getAutomationsQb } from '../../../lib/kysely';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { postgresRunHostStore } from '../run_host_store';

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

afterAll(async () => {
  if (runs.length > 0) await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', 'in', runs).execute();
});

describe('the run host contract on Postgres', () => {
  for (const contractCase of runHostContractCases) {
    it(contractCase.name, () => contractCase.run({ store: postgresRunHostStore, teamId: TEAM_ID, newRun }));
  }
});
