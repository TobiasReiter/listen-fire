// Loop-guard store — the Redis sliding-window counter (the backend contract is shared with
// memory_store.unit.test.ts).
//
// Covers: bucketed windowing (sum over trailing buckets, old buckets fall off),
// the single-pipeline increment+read, the reset, and FAIL-OPEN on Redis error.
//
// The pooled ioredis client is replaced with an in-memory fake that implements
// exactly the surface store.ts touches (pipeline → incrby/expire/mget, del),
// plus a switch to make every op throw so we can prove fail-open.

const fakeStore = new Map<string, number>();
let failNext = false;

class FakePipeline {
  private ops: Array<() => unknown> = [];
  incrby(key: string, amount: number) {
    this.ops.push(() => {
      fakeStore.set(key, (fakeStore.get(key) ?? 0) + amount);
      return fakeStore.get(key);
    });
    return this;
  }
  expire() {
    this.ops.push(() => 1);
    return this;
  }
  mget(...keys: string[]) {
    this.ops.push(() => keys.map((k) => (fakeStore.has(k) ? String(fakeStore.get(k)) : null)));
    return this;
  }
  async exec() {
    if (failNext) throw new Error('redis down');
    return this.ops.map((op) => [null, op()] as [Error | null, unknown]);
  }
}

const fakeClient = {
  pipeline: () => new FakePipeline(),
  del: async (...keys: string[]) => {
    if (failNext) throw new Error('redis down');
    let n = 0;
    for (const k of keys) if (fakeStore.delete(k)) n += 1;
    return n;
  },
};

jest.mock('../../../redisPool', () => ({
  redisConfigured: () => true,
  getRedisPool: () => ({
    acquire: async () => fakeClient,
    release: async () => {},
  }),
}));

import { describeCounterContract } from './counter_contract';
import { guardKeys, incrementAndSum } from '../store';

beforeEach(() => {
  fakeStore.clear();
  failNext = false;
});

describeCounterContract();

describe('incrementAndSum on Redis', () => {
  it('FAILS OPEN on a Redis error (total reflects amount, failOpen flagged)', async () => {
    failNext = true;
    const r = await incrementAndSum({
      key: 'loopguard:test:d',
      windowSeconds: 60,
      amount: 1,
      nowMs: 4_000_000,
    });
    expect(r.failOpen).toBe(true);
    // The amount is returned (never NaN/huge) so a downstream threshold check
    // can't spuriously trip on a broken Redis.
    expect(r.total).toBe(1);
  });
});

describe('guardKeys', () => {
  it('namespaces per team and per trigger', () => {
    expect(guardKeys.triggerRate('team1', 'trig1')).toBe('loopguard:rate:team1:trig1');
    expect(guardKeys.teamRuns('team1')).toBe('loopguard:team:runs:team1');
    expect(guardKeys.teamExternalWrites('team1')).toBe('loopguard:team:writes:team1');
  });
});
