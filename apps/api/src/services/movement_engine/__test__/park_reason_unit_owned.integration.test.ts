// The database no longer names the ask unit's park reason. A reason is any
// non-empty string a unit chooses; the core's own (`timer`, `await`, `limit`)
// are only what the core writes. A row parked as `ask` before the migration
// (the one reason the old CHECK allowed besides the core's) stays valid and
// resumes through the same claim/finish path as any other.

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

import { getAutomationsQb } from '../../../lib/kysely';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { claimParkedLeaf, finishResumedLeaf } from '../run_lease';

const TEAM_ID = randomUUID();
let runId: TriggerRunId;

async function park(address: string, reason: string): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .insertInto('parked_run')
    .values({ run_id: runId, address, status: 'parked', park_reason: reason, state: JSON.stringify({ address }) })
    .execute();
}

async function exists(address: string): Promise<boolean> {
  const row = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

beforeAll(async () => {
  const row = await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({ team_id: TEAM_ID, trigger_id: `park-reason-${randomUUID()}`, trigger_type: 'webhook', status: 'parked' })
    .returning('id')
    .executeTakeFirstOrThrow();
  runId = row.id;
});

afterAll(async () => {
  await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', '=', runId).execute();
});

describe('park reasons owned by units', () => {
  it('a leaf parked as ask (the pre-migration reason) loads and resumes through the normal claim and finish', async () => {
    await park('legacy-ask', 'ask');
    expect(await claimParkedLeaf({ runId, address: 'legacy-ask', parkReason: 'ask' })).toEqual({
      state: { address: 'legacy-ask' },
    });
    await finishResumedLeaf(runId, 'legacy-ask');
    expect(await exists('legacy-ask')).toBe(false);
  });

  it('a new unit-owned reason is accepted and claimable by that reason only', async () => {
    await park('unit-owned', 'approval_test');
    expect(await claimParkedLeaf({ runId, address: 'unit-owned', parkReason: 'await' })).toBeNull();
    expect(await claimParkedLeaf({ runId, address: 'unit-owned', parkReason: 'approval_test' })).toEqual({
      state: { address: 'unit-owned' },
    });
  });

  it('refuses the empty reason', async () => {
    await expect(park('empty', '')).rejects.toThrow(/parked_run_park_reason_check/);
  });

  it('has no default reason: a park names its owner', async () => {
    const { rows } = await sql<{ column_default: string | null }>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'automations' AND table_name = 'parked_run' AND column_name = 'park_reason'`.execute(
      getAutomationsQb(['parked_run']),
    );
    expect(rows).toEqual([{ column_default: null }]);
  });
});
