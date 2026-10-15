// The per-run lease against the real database: one UPDATE claims it while it
// is free or lapsed, the token fences every later call, and a holder that
// stops renewing loses it by expiry. Two claimers on two connection pools —
// two processes, as far as Postgres can tell — never both win.

import { randomUUID } from 'node:crypto';

import { getAutomationsQb } from '../../../lib/kysely';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { takeRunLease, withRunLease } from '../run_lease';
import { postgresRunHostStore, returnLeavesOfLapsedLeases } from '../run_host_store';

type RunLeaseModule = typeof import('../run_lease');
type RunHostStoreModule = typeof import('../run_host_store');

const { leases, parks } = postgresRunHostStore;

/** The same modules loaded afresh: their own kysely pool and their own owner,
 *  the way a second process would hold them. */
function secondProcess(): RunLeaseModule & RunHostStoreModule {
  let loaded: (RunLeaseModule & RunHostStoreModule) | undefined;
  jest.isolateModules(() => {
    loaded = { ...jest.requireActual<RunLeaseModule>('../run_lease'), ...jest.requireActual<RunHostStoreModule>('../run_host_store') };
  });
  if (loaded === undefined) throw new Error('test: the second process did not load');
  return loaded;
}

const TEAM_ID = randomUUID();
const runs: TriggerRunId[] = [];

async function seedRun(): Promise<TriggerRunId> {
  const row = await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({ team_id: TEAM_ID, trigger_id: `run-lease-${randomUUID()}`, trigger_type: 'webhook', status: 'parked' })
    .returning('id')
    .executeTakeFirstOrThrow();
  runs.push(row.id);
  return row.id;
}

async function leaseOf(runId: TriggerRunId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['lease_owner', 'lease_until', 'lease_token', 'last_heartbeat_at'])
    .executeTakeFirstOrThrow();
}

async function park(runId: TriggerRunId, address: string, status: 'parked' | 'resuming'): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .insertInto('parked_run')
    .values({ run_id: runId, address, status, park_reason: 'await', state: JSON.stringify({ address }) })
    .execute();
}

async function statusOf(runId: TriggerRunId, address: string): Promise<string | undefined> {
  const row = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .select('status')
    .executeTakeFirst();
  return row?.status;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  if (runs.length > 0) await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', 'in', runs).execute();
});

describe('the run lease', () => {
  it('is claimed while free, refused while held, and claimable again once released', async () => {
    const runId = await seedRun();
    const first = await leases.claim({ runId, ttlMs: 60_000 });
    expect(first).not.toBeNull();
    expect(await leases.claim({ runId, ttlMs: 60_000 })).toBeNull();

    // A stale token releases nothing.
    await leases.release({ runId, token: randomUUID() });
    expect((await leaseOf(runId)).lease_token).toBe(first?.token);

    await leases.release({ runId, token: first!.token });
    expect(await leaseOf(runId)).toMatchObject({ lease_owner: null, lease_until: null, lease_token: null });
    expect(await leases.claim({ runId, ttlMs: 60_000 })).not.toBeNull();
  });

  it('renews only for its own token, extending the lease and stamping the heartbeat in one statement', async () => {
    const runId = await seedRun();
    const lease = await leases.claim({ runId, ttlMs: 1_000 });
    const before = await leaseOf(runId);
    expect(before.last_heartbeat_at).toBeNull();

    expect(await leases.renew({ runId, token: lease!.token, ttlMs: 60_000 })).toBe(true);
    const after = await leaseOf(runId);
    expect(after.lease_until!.getTime()).toBeGreaterThan(before.lease_until!.getTime() + 30_000);
    expect(after.last_heartbeat_at).not.toBeNull();

    expect(await leases.renew({ runId, token: randomUUID(), ttlMs: 60_000 })).toBe(false);
  });

  it('a lapsed lease cannot be revived by its own token', async () => {
    const runId = await seedRun();
    const lapsed = await leases.claim({ runId, ttlMs: 1 });
    await wait(20);
    expect(await leases.renew({ runId, token: lapsed!.token, ttlMs: 60_000 })).toBe(false);
    // Still free for anyone to claim.
    expect(await leases.claim({ runId, ttlMs: 60_000 })).not.toBeNull();
  });

  it('lapses by expiry: another holder claims it, and the old token can neither renew nor release it', async () => {
    const runId = await seedRun();
    const stale = await leases.claim({ runId, ttlMs: 1 });
    await wait(20);

    const fresh = await leases.claim({ runId, ttlMs: 60_000 });
    expect(fresh).not.toBeNull();
    expect(await leases.renew({ runId, token: stale!.token, ttlMs: 60_000 })).toBe(false);
    await leases.release({ runId, token: stale!.token });
    expect(await leaseOf(runId)).toMatchObject({ lease_token: fresh!.token });
  });

  it('two processes claiming at once: exactly one wins', async () => {
    const other = secondProcess();
    for (let round = 0; round < 10; round++) {
      const runId = await seedRun();
      const claims = await Promise.all([
        leases.claim({ runId, ttlMs: 60_000 }),
        other.postgresRunHostStore.leases.claim({ runId, ttlMs: 60_000 }),
      ]);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    }
  });

  it('withRunLease runs nothing while the lease is held elsewhere, and releases however its body ends', async () => {
    const runId = await seedRun();
    const elsewhere = await secondProcess().takeRunLease(runId);
    const body = jest.fn(async () => 'stepped');
    expect(await withRunLease(runId, body)).toEqual({ kind: 'busy' });
    expect(body).not.toHaveBeenCalled();
    await elsewhere!.release();

    expect(await withRunLease(runId, body)).toEqual({ kind: 'held', value: 'stepped' });
    await expect(
      withRunLease(runId, async () => {
        throw new Error('the step failed');
      }),
    ).rejects.toThrow('the step failed');
    expect((await leaseOf(runId)).lease_token).toBeNull();
  });
});

describe('leaves claimed under the lease', () => {
  it('a leaf is claimed once; the claimed row is deleted after its step, a re-parked one stays', async () => {
    const runId = await seedRun();
    await park(runId, 's0', 'parked');
    await park(runId, 's1', 'parked');

    expect(await parks.claimLeaf({ runId, address: 's0' })).toEqual({ state: { address: 's0' }, reason: 'await' });
    expect(await parks.claimLeaf({ runId, address: 's0' })).toBeNull();
    expect(await statusOf(runId, 's0')).toBe('resuming');
    await parks.finishLeaf({ runId, address: 's0' });
    expect(await statusOf(runId, 's0')).toBeUndefined();

    // s1's step parked again at the same address: its row is `parked` again.
    await parks.claimLeaf({ runId, address: 's1' });
    await getAutomationsQb(['parked_run'])
      .updateTable('parked_run')
      .set({ status: 'parked' })
      .where('run_id', '=', runId)
      .where('address', '=', 's1')
      .execute();
    await parks.finishLeaf({ runId, address: 's1' });
    expect(await statusOf(runId, 's1')).toBe('parked');
  });

  it('the next holder of the run parks again a leaf a dead holder left resuming', async () => {
    const runId = await seedRun();
    await park(runId, 's0', 'resuming');
    const lease = await takeRunLease(runId);
    expect(await statusOf(runId, 's0')).toBe('parked');
    await lease!.release();
  });

  it('the orphan sweep parks again the leaves of lapsed or free leases, never of a live one', async () => {
    const lapsed = await seedRun();
    const live = await seedRun();
    // Leased first: taking a lease itself returns a dead holder's leaves.
    await leases.claim({ runId: lapsed, ttlMs: 1 });
    await leases.claim({ runId: live, ttlMs: 60_000 });
    await park(lapsed, 's0', 'resuming');
    await park(live, 's0', 'resuming');
    await wait(20);

    await returnLeavesOfLapsedLeases();

    expect(await statusOf(lapsed, 's0')).toBe('parked');
    expect(await statusOf(live, 's0')).toBe('resuming');
  });
});
