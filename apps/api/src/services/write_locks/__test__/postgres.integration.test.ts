import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { getDatabaseUrl } from '../../../prisma';
import { logger } from '../../logger';
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
});
