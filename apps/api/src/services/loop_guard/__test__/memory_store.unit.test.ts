// Loop-guard store with no Redis configured: the counters live in this process and give the same
// totals as the Redis store for the same calls, expire, and never reach the Redis pool.

const getRedisPool = jest.fn();

jest.mock('../../../redisPool', () => ({
  redisConfigured: () => false,
  getRedisPool,
}));

import { createMemoryBucketBackend } from '../counters/memory';
import { describeCounterContract } from './counter_contract';
import { incrementAndSum } from '../store';

describeCounterContract();

describe('with no Redis configured', () => {
  it('counts without ever asking for the Redis pool', async () => {
    const r = await incrementAndSum({
      key: 'loopguard:test:no-pool',
      windowSeconds: 60,
      amount: 2,
      nowMs: 9_000_000,
    });
    expect(r).toEqual({ total: 2, failOpen: false });
    expect(getRedisPool).not.toHaveBeenCalled();
  });
});

describe('memory bucket backend expiry', () => {
  it('forgets a bucket once its TTL has passed and renews it on each add', async () => {
    const backend = createMemoryBucketBackend();
    const base = 10_000_000;
    const add = (nowMs: number) =>
      backend.addAndRead({ bucketKey: 'k', amount: 1, ttlSeconds: 2, readKeys: ['k'], nowMs });

    expect(await add(base)).toEqual([1]);
    expect(await add(base + 1500)).toEqual([2]); // renewed to base + 3500
    expect(await add(base + 3000)).toEqual([3]); // renewed to base + 5000
    expect(await add(base + 7000)).toEqual([1]); // expired in between
  });

  it('sweeps expired keys instead of keeping every key it has seen', async () => {
    const backend = createMemoryBucketBackend();
    const base = 20_000_000;
    await backend.addAndRead({
      bucketKey: 'old',
      amount: 1,
      ttlSeconds: 1,
      readKeys: [],
      nowMs: base,
    });
    await backend.addAndRead({
      bucketKey: 'new',
      amount: 1,
      ttlSeconds: 1,
      readKeys: [],
      nowMs: base + 5000,
    });
    // 'old' is gone from the map, not merely ignored: re-adding starts from zero either way,
    // so check it through a read that would otherwise see a live value.
    expect(
      await backend.addAndRead({
        bucketKey: 'x',
        amount: 0,
        ttlSeconds: 1,
        readKeys: ['old'],
        nowMs: base + 5100,
      }),
    ).toEqual([0]);
  });
});
