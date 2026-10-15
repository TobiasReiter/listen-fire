import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { getDatabaseUrl } from '../../../prisma';
import { logger } from 'movement-engine/services/logger';
import { PostgresWriteLocks, type PostgresWriteLockHolder } from '../postgres';

const connectionString = requireUrl(getDatabaseUrl(false).url);

function requireUrl(url: string | undefined): string {
  if (!url) throw new Error('no database url for the integration test');
  return url;
}

let observer: Client;
const holders: PostgresWriteLockHolder[] = [];

function holderOf(locks: PostgresWriteLocks, scope: string): PostgresWriteLockHolder {
  const holder = locks.holder(scope);
  holders.push(holder);
  return holder;
}

function tracked(promise: Promise<void>): { settled: () => boolean } {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  return { settled: () => done };
}

async function advisoryLockCount(pid: number): Promise<number> {
  const result = await observer.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory' AND pid = $1 AND granted`,
    [pid],
  );
  return Number(result.rows[0].count);
}

async function backendPidOf(holder: PostgresWriteLockHolder): Promise<number> {
  const pid = await holder.debugBackendPid();
  if (pid === undefined) throw new Error('holder has no session');
  return pid;
}

beforeAll(async () => {
  observer = new Client({ connectionString });
  await observer.connect();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(holders.splice(0).map((holder) => holder.release()));
});

afterAll(async () => {
  await observer.end();
});

describe('PostgresWriteLocks', () => {
  it('makes a second holder wait until the first releases', async () => {
    const locks = new PostgresWriteLocks({ connectionString });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);

    await a.acquire(['record attio 1']);
    const bAcquire = b.acquire(['record attio 1']);
    const bState = tracked(bAcquire);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bState.settled()).toBe(false);

    await a.release();
    await bAcquire;
  });

  it('frees the locks of a holder whose session died without unlocking', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);

    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await a.acquire(['record attio 1', 'record attio 2']);
    await observer.query('SELECT pg_terminate_backend($1)', [await backendPidOf(a)]);

    await b.acquire(['record attio 2', 'record attio 1']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A re-acquire must not pass as reentrant: A no longer holds anything.
    await expect(a.acquire(['record attio 1'])).rejects.toMatchObject({
      code: 'MOVENG_RUNTIME',
      message: expect.stringContaining('write lock session lost'),
    });
    // The dead holder's release must still settle cleanly.
    await a.release();
    expect(warn).toHaveBeenCalledWith('[write_locks] lock session dropped', expect.anything());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('may have run unprotected'), {
      names: ['record attio 1', 'record attio 2'],
    });
  });

  it('rejects with the lock name when the lock stays held past the timeout', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 500 });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);

    await a.acquire(['record attio 1']);
    await expect(b.acquire(['record attio 1'])).rejects.toMatchObject({
      code: 'MOVENG_RUNTIME',
      message: expect.stringContaining('write lock timeout: record attio 1'),
    });
  });

  it('holds many names on one session and leaves no advisory locks behind', async () => {
    const locks = new PostgresWriteLocks({ connectionString });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const names = Array.from({ length: 50 }, (_, i) => `record attio ${i}`);

    await a.acquire(names);
    await a.acquire(names.slice(0, 10));
    const pid = await backendPidOf(a);
    expect(await advisoryLockCount(pid)).toBe(50);

    await a.release();
    expect(await advisoryLockCount(pid)).toBe(0);

    const b = holderOf(locks, scope);
    await b.acquire(names);
  });

  it('keeps scopes apart', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 500 });
    const a = holderOf(locks, randomUUID());
    const b = holderOf(locks, randomUUID());
    await a.acquire(['record attio 1']);
    await b.acquire(['record attio 1']);
  });

  it('rejects the waiting acquire as a lost session when its backend is terminated mid-wait', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await a.acquire(['record attio 1']);
    await b.acquire(['record attio 0']);
    const pid = await backendPidOf(b);
    const waiting = b.acquire(['record attio 1']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await observer.query('SELECT pg_terminate_backend($1)', [pid]);

    await expect(waiting).rejects.toMatchObject({
      code: 'MOVENG_RUNTIME',
      message: expect.stringContaining('write lock session lost: record attio 1'),
    });
    await b.release();
    expect(warn).toHaveBeenCalled();
  });

  it('fails one side of a cross-holder deadlock as a timeout, and the other side completes', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 500 });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);

    await a.acquire(['record attio 1']);
    await b.acquire(['record attio 2']);
    // The loser's segment ends on the failure, which lets the winner through.
    const releasingOnFailure = (holder: PostgresWriteLockHolder, name: string) =>
      holder.acquire([name]).catch(async (err: unknown) => {
        await holder.release();
        throw err;
      });
    // B starts waiting later, so A's deadline comes first. Two waits begun at
    // the same instant would both time out: both fail loudly, neither hangs.
    const started = Date.now();
    const aWaits = releasingOnFailure(a, 'record attio 2');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const results = await Promise.allSettled([aWaits, releasingOnFailure(b, 'record attio 1')]);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        code: 'MOVENG_RUNTIME',
        message: expect.stringContaining('write lock timeout: record attio 2'),
      },
    });
    expect(results[1]!.status).toBe('fulfilled');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a sibling waiting on a contended lock does not hold up another sibling's unlock", async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);

    await a.acquire(['record attio 1']);
    await b.acquire(['record attio 2']);
    const waiting = tracked(b.acquire(['record attio 1']));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = Date.now();
    await b.release(['record attio 2']);
    expect(Date.now() - started).toBeLessThan(50);
    expect(waiting.settled()).toBe(false);
    // The unlock reached Postgres: another holder can take the name now.
    const c = holderOf(locks, scope);
    await c.acquire(['record attio 2']);
  });

  it('reconnects on the next acquire when the session dropped while holding nothing', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const a = holderOf(locks, randomUUID());
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await a.acquire(['record attio 1']);
    await a.release(['record attio 1']);
    const before = await backendPidOf(a);
    await observer.query('SELECT pg_terminate_backend($1)', [before]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await a.acquire(['record attio 2']);
    const after = await backendPidOf(a);
    expect(after).not.toBe(before);
    expect(await advisoryLockCount(after)).toBe(1);
    const reconnects = warn.mock.calls.filter(([message]) => String(message).includes('reconnecting'));
    expect(reconnects).toHaveLength(1);
  });

  it('refuses after a drop while holding, and names what was held when it releases', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const a = holderOf(locks, randomUUID());
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await a.acquire(['record attio 1']);
    await observer.query('SELECT pg_terminate_backend($1)', [await backendPidOf(a)]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect(a.acquire(['record attio 2'])).rejects.toMatchObject({
      code: 'MOVENG_RUNTIME',
      message: expect.stringContaining('write lock session lost'),
    });
    await a.release(['record attio 1']);
    await a.release();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('may have run unprotected'),
      { names: ['record attio 1'] },
    );
  });

  it('a drop first found by an unlock is reported as one that took the lock with it', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const a = holderOf(locks, randomUUID());
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await a.acquire(['record attio 1']);
    await observer.query('SELECT pg_terminate_backend($1)', [await backendPidOf(a)]);
    await a.release(['record attio 1']);

    await expect(a.acquire(['record attio 2'])).rejects.toMatchObject({
      message: expect.stringContaining('write lock session lost'),
    });
    await a.release();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('may have run unprotected'), {
      names: ['record attio 1'],
    });
  });

  it('releasing a holder stops its polling acquire instead of waiting out the timeout', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);

    await a.acquire(['record attio 1']);
    const waiting = b.acquire(['record attio 1']);
    const rejection = expect(waiting).rejects.toMatchObject({
      message: expect.stringContaining('write lock holder is closed'),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    await b.release();
    await rejection;
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('release waits for an acquire still in flight, so a lock it is granted is not leaked', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 500 });
    const scope = randomUUID();
    const b = holderOf(locks, scope);

    // The acquire's try-lock is on the wire when the release begins.
    const bAcquire = b.acquire(['record attio 1']);
    await b.release();
    await Promise.allSettled([bAcquire]);

    const c = holderOf(locks, scope);
    await c.acquire(['record attio 1']);
  });

  it('counts two acquires of one name on one session and unlocks only at the last release', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const scope = randomUUID();
    const a = holderOf(locks, scope);
    const b = holderOf(locks, scope);

    await Promise.all([a.acquire(['identity attio companies']), a.acquire(['identity attio companies'])]);
    const pid = await backendPidOf(a);
    expect(await advisoryLockCount(pid)).toBe(1);

    const bAcquire = b.acquire(['identity attio companies']);
    const bState = tracked(bAcquire);
    await a.release(['identity attio companies']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await advisoryLockCount(pid)).toBe(1);
    expect(bState.settled()).toBe(false);

    await a.release(['identity attio companies']);
    expect(await advisoryLockCount(pid)).toBe(0);
    await bAcquire;
  });

  it('releasing named locks keeps the others and the session', async () => {
    const locks = new PostgresWriteLocks({ connectionString, timeoutMs: 10_000 });
    const a = holderOf(locks, randomUUID());

    await a.acquire(['record attio 1', 'record attio 2', 'record attio 3']);
    const pid = await backendPidOf(a);
    await a.release(['record attio 1', 'record attio 3']);
    expect(await advisoryLockCount(pid)).toBe(1);
    expect(await backendPidOf(a)).toBe(pid);
  });
});
