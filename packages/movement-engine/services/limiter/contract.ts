// The limiter slot's contract suite: one set of cases every limiter is held
// to — the built-in in this process (MemoryLimiter), lf's Rust one over the
// limiter wire (`lf --contract-limiter`), and a limiter module lf drives as
// a process (`lf --contract-limiter-slot`), all in apps/cli's tests. A
// limiter shared by many hosts passes these cases to fill the slot.
//
// Runner-agnostic, as the run host's suite is: each case is a name and an
// async body that throws on failure (node:assert). Every case uses keys of
// its own, so one limiter can serve the whole list.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HOLD_MS, type LimitBucket, type LimitGrant, type Limiter, type LimitRequest } from './limiter';

export interface LimiterContractCase {
  name: string;
  run(limiter: Limiter): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function key(name: string): string {
  return `${name}:${randomUUID()}`;
}

function request(limits: LimitBucket[], extra: Partial<LimitRequest> = {}): LimitRequest {
  return { key: key('caller'), cost: 1, limits, holdMs: HOLD_MS, ...extra };
}

function permitOf(grant: LimitGrant): string {
  assert.ok(grant.granted, `expected a grant, got ${JSON.stringify(grant)}`);
  return grant.permit;
}

/** The refusal's retry instant, in epoch milliseconds. */
function refusedUntil(grant: LimitGrant): number {
  assert.ok(!grant.granted, `expected a refusal, got ${JSON.stringify(grant)}`);
  const at = Date.parse(grant.retryAt);
  assert.ok(Number.isFinite(at), `retryAt ${grant.retryAt} is an instant`);
  return at;
}

export const limiterContractCases: LimiterContractCase[] = [
  {
    name: 'a call under no limit is granted, and releasing a permit twice, or one never given, changes nothing',
    async run(limiter) {
      const permit = permitOf(await limiter.acquire(request([])));
      await limiter.release(permit);
      await limiter.release(permit);
      await limiter.release('not-a-permit');
    },
  },
  {
    name: 'a concurrency limit grants that many at once; a release frees a place',
    async run(limiter) {
      const at = request([{ key: key('concurrent'), concurrent: 2 }]);
      const first = permitOf(await limiter.acquire(at));
      permitOf(await limiter.acquire(at));
      const before = Date.now();
      assert.ok(refusedUntil(await limiter.acquire(at)) > before, 'the refusal names a later instant');
      await limiter.release(first);
      permitOf(await limiter.acquire(at));
    },
  },
  {
    name: 'a rate limit grants that many per window, and its refusal says when there is room',
    async run(limiter) {
      const at = request([{ key: key('rate'), calls: 3, perMs: 600 }]);
      for (let i = 0; i < 3; i++) permitOf(await limiter.acquire(at));
      const before = Date.now();
      const retryAt = refusedUntil(await limiter.acquire(at));
      assert.ok(retryAt > before && retryAt <= before + 650, `room within the window (retryAt ${retryAt - before}ms on)`);
      await sleep(retryAt - Date.now() + 20);
      permitOf(await limiter.acquire(at));
    },
  },
  {
    name: 'a call costing more counts for more against a rate limit',
    async run(limiter) {
      const bucket = { key: key('rate'), calls: 5, perMs: 60_000 };
      permitOf(await limiter.acquire(request([bucket], { cost: 3 })));
      refusedUntil(await limiter.acquire(request([bucket], { cost: 3 })));
      permitOf(await limiter.acquire(request([bucket], { cost: 2 })));
    },
  },
  {
    name: 'a throttle refuses its key until then, and no other key',
    async run(limiter) {
      const throttled = request([]);
      const until = Date.now() + 400;
      await limiter.throttle({ key: throttled.key, until: new Date(until).toISOString() });
      assert.ok(refusedUntil(await limiter.acquire(throttled)) >= until - 1, 'refused until the throttle ends');
      permitOf(await limiter.acquire(request([])));
      await sleep(until - Date.now() + 30);
      permitOf(await limiter.acquire(throttled));
    },
  },
  {
    name: 'a refused call spends nothing in its other limits',
    async run(limiter) {
      const rate = { key: key('rate'), calls: 2, perMs: 60_000 };
      const one = { key: key('concurrent'), concurrent: 1 };
      const first = permitOf(await limiter.acquire(request([rate, one])));
      refusedUntil(await limiter.acquire(request([rate, one])));
      await limiter.release(first);
      // Had the refusal spent its call, this one would be refused too.
      permitOf(await limiter.acquire(request([rate, one])));
      refusedUntil(await limiter.acquire(request([rate])));
    },
  },
  {
    name: 'limits on different buckets are counted apart',
    async run(limiter) {
      permitOf(await limiter.acquire(request([{ key: key('a'), concurrent: 1 }])));
      permitOf(await limiter.acquire(request([{ key: key('b'), concurrent: 1 }])));
    },
  },
  {
    name: 'a permit never released lapses after its hold',
    async run(limiter) {
      const at = request([{ key: key('concurrent'), concurrent: 1 }], { holdMs: 300 });
      permitOf(await limiter.acquire(at));
      refusedUntil(await limiter.acquire(at));
      await sleep(400);
      permitOf(await limiter.acquire(at));
    },
  },
];
