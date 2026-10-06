import { InMemoryWriteLocks, lockKey } from '../write_locks';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function tracked(promise: Promise<void>): { settled: () => boolean } {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  return { settled: () => done };
}

describe('lockKey', () => {
  it('prefixes the scope so two teams never share a lock', () => {
    expect(lockKey('team-a', 'record x 1')).toBe('team-a|record x 1');
  });
});

describe('InMemoryWriteLocks', () => {
  it('acquires names in sorted order whatever order they are asked for', async () => {
    const locks = new InMemoryWriteLocks();
    const a = locks.holder('t');
    const b = locks.holder('t');
    await a.acquire(['m']);

    // B asks for z before m; if it took z first it would hold z while
    // waiting on m, so C (which only wants z) would be stuck behind it.
    const bAcquire = tracked(b.acquire(['z', 'm']));
    await settle();
    const c = locks.holder('t');
    const cAcquire = tracked(c.acquire(['z']));
    await settle();

    expect(bAcquire.settled()).toBe(false);
    expect(cAcquire.settled()).toBe(true);

    await c.release();
    await a.release();
    await settle();
    expect(bAcquire.settled()).toBe(true);
    await b.release();
  });

  it('lets a holder re-acquire a name it already holds', async () => {
    const locks = new InMemoryWriteLocks();
    const a = locks.holder('t');
    await a.acquire(['x']);
    await a.acquire(['x', 'y']);
    await Promise.all([a.acquire(['y']), a.acquire(['y'])]);
    await a.release();

    const b = locks.holder('t');
    await b.acquire(['x', 'y']);
    await b.release();
  });

  it('grants waiters in the order they arrived', async () => {
    const locks = new InMemoryWriteLocks();
    const order: string[] = [];
    const first = locks.holder('t');
    await first.acquire(['x']);

    const waiters = ['second', 'third', 'fourth'].map((label) => {
      const holder = locks.holder('t');
      return holder.acquire(['x']).then(async () => {
        order.push(label);
        await holder.release();
      });
    });
    await settle();
    expect(order).toEqual([]);

    await first.release();
    await Promise.all(waiters);
    expect(order).toEqual(['second', 'third', 'fourth']);
  });

  it('keeps scopes apart', async () => {
    const locks = new InMemoryWriteLocks();
    const a = locks.holder('team-a');
    const b = locks.holder('team-b');
    await a.acquire(['x']);
    await b.acquire(['x']);
    await a.release();
    await b.release();
  });

  it('release is idempotent and frees the lock once', async () => {
    const locks = new InMemoryWriteLocks();
    const a = locks.holder('t');
    await a.acquire(['x']);
    await a.release();
    await a.release();

    const b = locks.holder('t');
    const c = locks.holder('t');
    await b.acquire(['x']);
    const cAcquire = tracked(c.acquire(['x']));
    // A second release of A must not hand B's lock to C.
    await a.release();
    await settle();
    expect(cAcquire.settled()).toBe(false);

    await b.release();
    await settle();
    expect(cAcquire.settled()).toBe(true);
    await c.release();
  });

  it('rejects with the lock name after the timeout, and later waiters still get the lock', async () => {
    const locks = new InMemoryWriteLocks({ timeoutMs: 50 });
    const a = locks.holder('t');
    await a.acquire(['x']);

    const b = locks.holder('t');
    await expect(b.acquire(['x'])).rejects.toMatchObject({
      code: 'MOVENG_RUNTIME',
      message: expect.stringContaining('write lock timeout: x'),
    });

    const c = locks.holder('t');
    const cAcquire = tracked(c.acquire(['x']));
    await a.release();
    await settle();
    expect(cAcquire.settled()).toBe(true);
    await b.release();
    await c.release();
  });

  it('release waits for an acquire still in flight, then frees what it granted', async () => {
    const locks = new InMemoryWriteLocks();
    const a = locks.holder('t');
    await a.acquire(['x']);

    const b = locks.holder('t');
    const bAcquire = tracked(b.acquire(['x']));
    const bRelease = tracked(b.release());
    await settle();
    expect(bAcquire.settled()).toBe(false);
    expect(bRelease.settled()).toBe(false);

    await a.release();
    await settle();
    expect(bAcquire.settled()).toBe(true);
    expect(bRelease.settled()).toBe(true);

    const c = locks.holder('t');
    await c.acquire(['x']);
    await c.release();
  });

  it('gives back named locks one acquire at a time, and lets one go at a count of zero', async () => {
    const locks = new InMemoryWriteLocks();
    const a = locks.holder('t');
    await Promise.all([a.acquire(['x', 'y']), a.acquire(['x'])]);

    const b = locks.holder('t');
    const bY = tracked(b.acquire(['y']));
    const bX = tracked(b.acquire(['x']));
    await a.release(['x', 'y']);
    await settle();
    // y's only acquire is given back; x still has one.
    expect(bY.settled()).toBe(true);
    expect(bX.settled()).toBe(false);

    await a.release(['x']);
    await settle();
    expect(bX.settled()).toBe(true);
    await a.release();
    await b.release();
  });

  it('a failing acquire gives back what that call took', async () => {
    const locks = new InMemoryWriteLocks({ timeoutMs: 50 });
    const a = locks.holder('t');
    await a.acquire(['x']);

    const b = locks.holder('t');
    await expect(b.acquire(['a', 'x'])).rejects.toMatchObject({
      message: expect.stringContaining('write lock timeout: x'),
    });
    const c = locks.holder('t');
    const cAcquire = tracked(c.acquire(['a']));
    await settle();
    expect(cAcquire.settled()).toBe(true);
    await Promise.all([a.release(), b.release(), c.release()]);
  });
});
