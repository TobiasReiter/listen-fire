import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

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

// Due times live in 2001 so only rows this file backdates are due: the shared
// test DB may hold other suites' rows due "now". Leases run on the database
// clock, so a lapse is simulated by moving lease_until into the past.
const T0 = new Date('2001-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const LEASE_MS = 30_000;

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
  now?: Date;
  leaseMs?: number;
}): Promise<WorkRow[]> {
  const rows = await claimDueWork({
    owner: input.owner,
    limit: 100,
    leaseMs: input.leaseMs ?? LEASE_MS,
    now: input.now ?? at(1_000),
  });
  return rows.filter((r) => keys.includes(r.key));
}

async function claimOne(input: { owner: string; now?: Date; leaseMs?: number }): Promise<WorkRow> {
  const [row] = await claimMine(input);
  if (!row) throw new Error('expected a claim');
  return row;
}

async function expireLease(key: string): Promise<void> {
  await sql`UPDATE automations.work SET lease_until = now() - interval '1 second' WHERE key = ${key}`.execute(
    getAutomationsQb(['work']),
  );
}

async function dbNow(): Promise<number> {
  const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(
    getAutomationsQb(['work']),
  );
  const [row] = rows;
  if (!row) throw new Error('no clock');
  return row.now.getTime();
}

async function expectLeaseFor(key: string, leaseMs: number, during: () => Promise<unknown>) {
  const before = await dbNow();
  await during();
  const after = await dbNow();
  const leaseUntil = (await rowByKey(key))?.leaseUntil?.getTime();
  expect(leaseUntil).toBeGreaterThanOrEqual(before + leaseMs);
  expect(leaseUntil).toBeLessThanOrEqual(after + leaseMs);
}

function claimOf(row: WorkRow) {
  if (!row.leaseToken) throw new Error('expected a claimed row');
  return { id: row.id, leaseToken: row.leaseToken };
}

async function expectStaleClaimIsInert(input: { key: string; stale: WorkRow; live: WorkRow }) {
  const { key, stale, live } = input;
  expect(await heartbeatWork({ ...claimOf(stale), leaseMs: 1 })).toBe(false);
  await releaseWork({ ...claimOf(stale), claimedUpdatedAt: stale.updatedAt });
  await completeWork({ ...claimOf(stale), claimedUpdatedAt: stale.updatedAt, now: at(2_000) });

  expect(await rowByKey(key)).toMatchObject({
    leaseOwner: live.leaseOwner,
    leaseUntil: live.leaseUntil,
    leaseToken: live.leaseToken,
    attempts: live.attempts,
    dueAt: live.dueAt,
  });
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
    await claimOne({ owner: 'drainer-1' });
    await expireLease(key);

    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'b' }, dueAt: at(60_000) });

    const row = await rowByKey(key);
    expect(row?.dueAt).toEqual(at(0));
    expect(row?.payload).toEqual({ runId: 'b' });
  });

  it('enqueueWork keeps the existing team_id when the caller omits it', async () => {
    const key = freshKey('resume_timer');
    const teamId = randomUUID();
    await enqueueWork({ kind: 'resume_timer', key, teamId, dueAt: at(0) });
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });

    expect((await rowByKey(key))?.teamId).toBe(teamId);
  });

  it('a re-arm during a live lease survives completeWork with the new due_at and no lease', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'a' }, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'b' }, dueAt: at(60_000) });
    await completeWork({
      ...claimOf(claimed),
      claimedUpdatedAt: claimed.updatedAt,
      now: at(2_000),
    });

    expect(await rowByKey(key)).toMatchObject({
      dueAt: at(60_000),
      payload: { runId: 'b' },
      leaseOwner: null,
      leaseUntil: null,
      leaseToken: null,
      attempts: 0,
    });
  });

  it('claimDueWork takes only due, unleased rows and leases them on the database clock', async () => {
    const due = freshKey('resume_timer');
    const notDue = freshKey('resume_timer');
    const leased = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key: leased, payload: { runId: 'l' }, dueAt: at(0) });
    await claimOne({ owner: 'other' });
    await enqueueWork({ kind: 'resume_timer', key: due, payload: { runId: 'd' }, dueAt: at(0) });
    await enqueueWork({
      kind: 'resume_timer',
      key: notDue,
      payload: { runId: 'n' },
      dueAt: at(60_000),
    });

    let claimed: WorkRow[] = [];
    await expectLeaseFor(due, LEASE_MS, async () => {
      claimed = await claimMine({ owner: 'drainer-1' });
    });

    expect(claimed.map((r) => r.key)).toEqual([due]);
    expect(claimed[0]).toMatchObject({
      kind: 'resume_timer',
      payload: { runId: 'd' },
      attempts: 1,
      leaseOwner: 'drainer-1',
    });
  });

  it('a live lease blocks other owners; a lapsed lease is re-claimable with attempts 2', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    await claimOne({ owner: 'drainer-1' });

    expect(await claimMine({ owner: 'drainer-2' })).toEqual([]);

    await expireLease(key);
    const reclaimed = await claimMine({ owner: 'drainer-2' });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ key, attempts: 2, leaseOwner: 'drainer-2' });
  });

  it('a stale claim by the same owner cannot heartbeat, release or complete the re-claim', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const stale = await claimOne({ owner: 'drainer-1' });
    await expireLease(key);
    const live = await claimOne({ owner: 'drainer-1' });
    expect(live.leaseToken).not.toBe(stale.leaseToken);

    await expectStaleClaimIsInert({ key, stale, live });
  });

  it('the first claim stays inert after the row is re-armed and re-claimed twice over', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const first = await claimOne({ owner: 'drainer-1' });
    await expireLease(key);
    const second = await claimOne({ owner: 'drainer-1' });
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(500) });
    await completeWork({ ...claimOf(second), claimedUpdatedAt: second.updatedAt, now: at(900) });
    const third = await claimOne({ owner: 'drainer-1' });
    // attempts has wrapped back to the first claim's value; only the token tells them apart.
    expect(third.attempts).toBe(first.attempts);

    await expectStaleClaimIsInert({ key, stale: first, live: third });
  });

  it('heartbeatWork extends the holder lease and refuses another token', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await expectLeaseFor(key, 600_000, async () => {
      expect(await heartbeatWork({ ...claimOf(claimed), leaseMs: 600_000 })).toBe(true);
    });
    const extended = (await rowByKey(key))?.leaseUntil;

    expect(await heartbeatWork({ id: claimed.id, leaseToken: randomUUID(), leaseMs: 1 })).toBe(
      false,
    );
    expect((await rowByKey(key))?.leaseUntil).toEqual(extended);

    // A heartbeat is not a re-arm: completion still deletes the row.
    await completeWork({
      ...claimOf(claimed),
      claimedUpdatedAt: claimed.updatedAt,
      now: at(30_000),
    });
    expect(await rowByKey(key)).toBeUndefined();
  });

  it('completeWork deletes a one-shot row', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await completeWork({
      ...claimOf(claimed),
      claimedUpdatedAt: claimed.updatedAt,
      now: at(2_000),
    });

    expect(await rowByKey(key)).toBeUndefined();
  });

  it('completeWork reschedules a periodic row at now + interval and clears its lease', async () => {
    const key = freshKey('cron_reconcile');
    await ensurePeriodicWork({ kind: 'cron_reconcile', key, intervalMs: 60_000, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await completeWork({
      ...claimOf(claimed),
      claimedUpdatedAt: claimed.updatedAt,
      now: at(2_000),
    });

    expect(await rowByKey(key, 'cron_reconcile')).toMatchObject({
      attempts: 0,
      dueAt: at(62_000),
      leaseOwner: null,
      leaseUntil: null,
      intervalMs: 60_000,
    });
  });

  it('a periodic row re-armed during its run still reschedules at now + interval', async () => {
    const key = freshKey('cron_reconcile');
    await ensurePeriodicWork({ kind: 'cron_reconcile', key, intervalMs: 60_000, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await enqueueWork({ kind: 'cron_reconcile', key, dueAt: at(5_000) });
    await completeWork({
      ...claimOf(claimed),
      claimedUpdatedAt: claimed.updatedAt,
      now: at(2_000),
    });

    expect(await rowByKey(key, 'cron_reconcile')).toMatchObject({
      attempts: 0,
      dueAt: at(62_000),
      leaseOwner: null,
      leaseUntil: null,
    });
  });

  it('releaseWork clears the lease and keeps due_at', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await releaseWork({ ...claimOf(claimed), claimedUpdatedAt: claimed.updatedAt });

    expect(await rowByKey(key)).toMatchObject({
      dueAt: at(0),
      leaseOwner: null,
      leaseUntil: null,
      leaseToken: null,
    });
  });

  it('releaseWork with dueAt moves due_at and clears the lease without bumping updated_at', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await releaseWork({
      ...claimOf(claimed),
      claimedUpdatedAt: claimed.updatedAt,
      dueAt: at(4_000),
    });

    expect(await rowByKey(key)).toMatchObject({
      dueAt: at(4_000),
      leaseOwner: null,
      leaseUntil: null,
      leaseToken: null,
      updatedAt: claimed.updatedAt,
    });
  });

  it('a re-arm during a failing run wins over the release dueAt and the lease still clears', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'a' }, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await enqueueWork({ kind: 'resume_timer', key, payload: { runId: 'b' }, dueAt: at(500) });
    await releaseWork({
      ...claimOf(claimed),
      claimedUpdatedAt: claimed.updatedAt,
      dueAt: at(60_000),
    });

    expect(await rowByKey(key)).toMatchObject({
      dueAt: at(500),
      payload: { runId: 'b' },
      leaseOwner: null,
      leaseUntil: null,
      leaseToken: null,
    });
  });

  it('releaseWork with dueAt under a stale token leaves the row alone', async () => {
    const key = freshKey('resume_timer');
    await enqueueWork({ kind: 'resume_timer', key, dueAt: at(0) });
    const claimed = await claimOne({ owner: 'drainer-1' });

    await releaseWork({
      id: claimed.id,
      leaseToken: randomUUID(),
      claimedUpdatedAt: claimed.updatedAt,
      dueAt: at(4_000),
    });

    expect(await rowByKey(key)).toMatchObject({ dueAt: at(0), leaseToken: claimed.leaseToken });
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

  it('every write stamps updated_at to the millisecond', async () => {
    const oneShot = freshKey('resume_timer');
    const periodic = freshKey('cron_reconcile');
    await enqueueWork({ kind: 'resume_timer', key: oneShot, dueAt: at(60_000) });
    await ensurePeriodicWork({
      kind: 'cron_reconcile',
      key: periodic,
      intervalMs: 60_000,
      dueAt: at(60_000),
    });
    await ensurePeriodicWork({
      kind: 'cron_reconcile',
      key: periodic,
      intervalMs: 30_000,
      dueAt: at(60_000),
    });

    const { rows } = await sql<{ exact: boolean }>`
      SELECT updated_at = date_trunc('milliseconds', updated_at) AS exact
      FROM automations.work WHERE key IN (${oneShot}, ${periodic})`.execute(
      getAutomationsQb(['work']),
    );
    expect(rows.map((r) => r.exact)).toEqual([true, true]);
  });

  it('concurrent claims each honour their limit and take disjoint rows', async () => {
    // An earlier clock than T0 so no other test's rows are due in these claims.
    const t = (ms: number) => new Date(Date.UTC(1990, 0, 1) + ms);
    for (let round = 0; round < 10; round++) {
      const roundKeys = Array.from({ length: 20 }, () => freshKey('resume_timer'));
      for (const key of roundKeys) await enqueueWork({ kind: 'resume_timer', key, dueAt: t(0) });

      const claim = (owner: string) =>
        claimDueWork({ owner, limit: 10, leaseMs: LEASE_MS, now: t(1_000) });
      const [a, b] = await Promise.all([claim('drainer-a'), claim('drainer-b')]);

      expect(a).toHaveLength(10);
      expect(b).toHaveLength(10);
      const ids = new Set([...a, ...b].map((r) => r.id));
      expect(ids.size).toBe(20);
      expect([...a, ...b].every((r) => roundKeys.includes(r.key))).toBe(true);

      for (const key of keys.splice(0)) await removeWork({ key });
    }
  });

  it('claimDueWork never claims a row of unknown kind and still claims the rest', async () => {
    const bogus = freshKey('bogus');
    const known = freshKey('resume_timer');
    await getAutomationsQb(['work'])
      .insertInto('work')
      .values({ kind: 'bogus', key: bogus, due_at: at(0) })
      .execute();
    await enqueueWork({ kind: 'resume_timer', key: known, dueAt: at(0) });

    const claimed = await claimMine({ owner: 'drainer-1' });

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
