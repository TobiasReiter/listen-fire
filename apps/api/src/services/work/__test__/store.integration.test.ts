import { randomUUID } from 'node:crypto';

import type { WorkKind, WorkRow } from '../kinds';

import { getAutomationsQb } from '../../../lib/kysely';
import {
  claimDueWork,
  completeWork,
  enqueueWork,
  ensurePeriodicWork,
  heartbeatWork,
  listWorkByKind,
  releaseWork,
  removeWork,
} from '../store';

// Claims run against a clock in 2001 so only rows this file backdates are due:
// the shared test DB may hold other suites' rows due "now". A lease taken at that
// clock has already expired by the database clock unless it is LIVE_LEASE_MS long.
const T0 = new Date('2001-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const LEASE_MS = 30_000;
const LIVE_LEASE_MS = 200 * 365 * 24 * 3600 * 1000;

const keys: string[] = [];
function freshKey(kind: string): string {
  const key = `${kind}:${randomUUID()}`;
  keys.push(key);
  return key;
}

async function rowByKey(
  key: string,
  kind: WorkKind = 'resume_timer',
): Promise<WorkRow | undefined> {
  return (await listWorkByKind(kind)).find((r) => r.key === key);
}

async function claimMine(input: {
  owner: string;
  now: Date;
  leaseMs?: number;
}): Promise<WorkRow[]> {
  const rows = await claimDueWork({
    owner: input.owner,
    limit: 100,
    leaseMs: input.leaseMs ?? LEASE_MS,
    now: input.now,
  });
  return rows.filter((r) => keys.includes(r.key));
}

afterEach(async () => {
  for (const key of keys.splice(0)) await removeWork({ key });
});

describe('work store', () => {
  it('enqueueWork against an unleased row keeps the earliest due_at and takes the new payload', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'a' }, dueAt: at(60_000) });
    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'b' }, dueAt: at(0) });
    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'c' }, dueAt: at(30_000) });

    const row = await rowByKey(key);
    expect(row?.dueAt).toEqual(at(0));
    expect(row?.payload).toEqual({ runId: 'c' });
  });

  it('enqueueWork against a row whose lease expired behaves as unleased', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'a' }, dueAt: at(0) });
    await claimMine({ owner: 'drainer-1', now: at(1_000) });

    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'b' }, dueAt: at(60_000) });

    const row = await rowByKey(key);
    expect(row?.dueAt).toEqual(at(0));
    expect(row?.payload).toEqual({ runId: 'b' });
  });

  it('a re-arm during a live lease survives completeWork with the new due_at and no lease', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'a' }, dueAt: at(0) });
    const [claimed] = await claimMine({
      owner: 'drainer-1',
      now: at(1_000),
      leaseMs: LIVE_LEASE_MS,
    });
    if (!claimed) throw new Error('expected a claim');

    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'b' }, dueAt: at(60_000) });
    await completeWork({
      id: claimed.id,
      owner: 'drainer-1',
      claimedUpdatedAt: claimed.updatedAt,
      now: at(2_000),
    });

    expect(await rowByKey(key)).toMatchObject({
      dueAt: at(60_000),
      payload: { runId: 'b' },
      leaseOwner: null,
      leaseUntil: null,
      attempts: 0,
    });
  });

  it('claimDueWork takes only due, unleased rows and leases them', async () => {
    const due = freshKey('resume_timer');
    const notDue = freshKey('resume_timer');
    const leased = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key: leased, payload: { runId: 'l' }, dueAt: at(0) });
    await claimMine({ owner: 'other', now: at(500) });
    await enqueueWork({ kind: 'resume_timer', key: due, payload: { runId: 'd' }, dueAt: at(0) });
    await enqueueWork({
      kind: 'resume_timer',
      key: notDue,
      payload: { runId: 'n' },
      dueAt: at(60_000),
    });

    const claimed = await claimMine({ owner: 'drainer-1', now: at(1_000) });

    expect(claimed.map((r) => r.key)).toEqual([due]);
    expect(claimed[0]).toMatchObject({
      kind: 'resume_timer',
      payload: { runId: 'd' },
      attempts: 1,
      leaseOwner: 'drainer-1',
      leaseUntil: at(1_000 + LEASE_MS),
    });
  });

  it('a live lease blocks other owners; a lapsed lease is re-claimable with attempts 2', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    await claimMine({ owner: 'drainer-1', now: at(1_000) });

    expect(await claimMine({ owner: 'drainer-2', now: at(1_000 + LEASE_MS - 1) })).toEqual([]);

    const reclaimed = await claimMine({ owner: 'drainer-2', now: at(1_000 + LEASE_MS + 1) });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ key, attempts: 2, leaseOwner: 'drainer-2' });
  });

  it('heartbeatWork extends the holder lease and refuses a non-holder', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const [claimed] = await claimMine({ owner: 'drainer-1', now: at(1_000) });
    if (!claimed) throw new Error('expected a claim');

    expect(
      await heartbeatWork({
        id: claimed.id,
        owner: 'drainer-1',
        leaseMs: LEASE_MS,
        now: at(20_000),
      }),
    ).toBe(true);
    expect((await rowByKey(key))?.leaseUntil).toEqual(at(20_000 + LEASE_MS));

    expect(
      await heartbeatWork({
        id: claimed.id,
        owner: 'drainer-2',
        leaseMs: LEASE_MS,
        now: at(25_000),
      }),
    ).toBe(false);
    expect((await rowByKey(key))?.leaseUntil).toEqual(at(20_000 + LEASE_MS));

    // A heartbeat is not a re-arm: completion still deletes the row.
    await completeWork({
      id: claimed.id,
      owner: 'drainer-1',
      claimedUpdatedAt: claimed.updatedAt,
      now: at(30_000),
    });
    expect(await rowByKey(key)).toBeUndefined();
  });

  it('completeWork deletes a one-shot row', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const [claimed] = await claimMine({ owner: 'drainer-1', now: at(1_000) });
    if (!claimed) throw new Error('expected a claim');

    await completeWork({
      id: claimed.id,
      owner: 'drainer-1',
      claimedUpdatedAt: claimed.updatedAt,
      now: at(2_000),
    });

    expect(await rowByKey(key)).toBeUndefined();
  });

  it('completeWork reschedules a periodic row at now + interval and clears its lease', async () => {
    const key = freshKey('cron_reconcile');
    await ensurePeriodicWork({ kind: 'cron_reconcile', key, intervalMs: 60_000, dueAt: at(0) });
    const [claimed] = await claimMine({ owner: 'drainer-1', now: at(1_000) });
    if (!claimed) throw new Error('expected a claim');

    await completeWork({
      id: claimed.id,
      owner: 'drainer-1',
      claimedUpdatedAt: claimed.updatedAt,
      now: at(2_000),
    });

    const row = await rowByKey(key, 'cron_reconcile');
    expect(row).toMatchObject({
      attempts: 0,
      dueAt: at(62_000),
      leaseOwner: null,
      leaseUntil: null,
      intervalMs: 60_000,
    });
  });

  it('releaseWork clears the lease and keeps due_at', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const [claimed] = await claimMine({ owner: 'drainer-1', now: at(1_000) });
    if (!claimed) throw new Error('expected a claim');

    await releaseWork({ id: claimed.id, owner: 'drainer-1' });

    expect(await rowByKey(key)).toMatchObject({ dueAt: at(0), leaseOwner: null, leaseUntil: null });
  });

  it('ensurePeriodicWork is idempotent and keeps an existing due_at', async () => {
    const key = freshKey('cron_reconcile');
    await ensurePeriodicWork({ kind: 'cron_reconcile', key, intervalMs: 60_000, dueAt: at(0) });
    await ensurePeriodicWork({
      kind: 'cron_reconcile',
      key,
      intervalMs: 60_000,
      dueAt: at(90_000),
    });

    const rows = (await listWorkByKind('cron_reconcile')).filter((r) => r.key === key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dueAt).toEqual(at(0));
  });

  it('claimDueWork never claims a row of unknown kind and still claims the rest', async () => {
    const bogus = freshKey('bogus');
    const known = freshKey('resume_timer');
    await getAutomationsQb(['work'])
      .insertInto('work')
      .values({ kind: 'bogus', key: bogus, due_at: at(0) })
      .execute();
    await enqueueWork({ kind: 'resume_timer', key: known, dueAt: at(0) });

    const claimed = await claimMine({ owner: 'drainer-1', now: at(1_000) });

    expect(claimed.map((r) => r.key)).toEqual([known]);
    const [raw] = await getAutomationsQb(['work'])
      .selectFrom('work')
      .selectAll()
      .where('key', '=', bogus)
      .execute();
    expect(raw).toMatchObject({ lease_owner: null, attempts: 0 });
  });

  it('stores team_id and the default payload', async () => {
    const key = freshKey('resume_timer');
    const teamId = randomUUID();
    await enqueueWork({ kind: 'resume_timer', key, teamId, dueAt: at(0) });

    const [raw] = await getAutomationsQb(['work'])
      .selectFrom('work')
      .selectAll()
      .where('key', '=', key)
      .execute();
    expect(raw?.team_id).toBe(teamId);
    expect(raw?.payload).toEqual({});
  });
});
