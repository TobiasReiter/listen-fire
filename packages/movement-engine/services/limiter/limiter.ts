// The limiter slot: what keeps a host's calls to modules and models inside
// the provider's limits (plans/cloud-native-2026-10-06/22_everywhere_plan.md,
// Henry 2026-10-18). The engine knows nothing of limits; the host asks the
// slot before each call to a module (the remote adapter) and each model
// request (lib/anthropic), and holds the call until it is granted.
//
// The contract (docs/contracts/limiter-slot.md) never waits: `acquire`
// answers granted (with a permit to release) or refused (with when to ask
// again), so a limiter shared by many hosts is just another module filling
// the slot. Every request carries the limits it is under, so no limiter reads
// a manifest. The built-in, `@lf/memory-limiter`, keeps them in this process
// (`MemoryLimiter`); lf's Rust one is the same (crates/lf/src/limiter.rs).

import { randomUUID } from 'node:crypto';
import type { WireDeclaredLimitShape, WireLimitScopeShape } from 'engine-contracts';

/** One limit a request is under, resolved to the bucket it counts in. */
export interface LimitBucket {
  key: string;
  /** At most `calls` per `perMs`; the two go together. */
  calls?: number;
  perMs?: number;
  concurrent?: number;
}

/** Granted only when every bucket has room and `key` is not throttled, and
 *  then counted in all of them at once, so a refused call spends nothing. */
export interface LimitRequest {
  /** The caller's own identity: where a provider's throttle lands. */
  key: string;
  cost: number;
  limits: LimitBucket[];
  /** A permit never released lapses after this long. */
  holdMs: number;
}

export type LimitGrant = { granted: true; permit: string } | { granted: false; retryAt: string };

/** The slot's contract. No method waits. */
export interface Limiter {
  acquire(request: LimitRequest): Promise<LimitGrant>;
  release(permit: string): Promise<void>;
  /** The provider asked for no call on `key` before `until`. */
  throttle(input: { key: string; until: string }): Promise<void>;
  /** In this process only: `wait` resolves when a permit is released, so a
   *  waiter asks again before its `retryAt`; `stop` stops listening. */
  released?(): { wait: Promise<void>; stop(): void };
}

/** No call outlives a segment's wall clock (its default), so a permit its
 *  holder never released lapses then. */
export const HOLD_MS = 900_000;

/** Who a call is made as: what each scope counts it by. */
export interface Caller {
  module: string;
  install?: string;
  credential?: string;
  team: string;
}

/** Where a provider's throttle lands: the credential, else the install, else the module. */
export function throttleKey(caller: Caller): string {
  return `${caller.module}|throttle|${caller.credential ?? caller.install ?? ''}`;
}

function scopeValue(caller: Caller, scope: WireLimitScopeShape): string {
  switch (scope) {
    case 'module':
      return '';
    case 'team':
      return caller.team;
    case 'install':
      return caller.install ?? '';
    case 'credential':
      return caller.credential ?? caller.install ?? '';
  }
}

const DURATION = /^([1-9][0-9]*)(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `500ms`, `10s`, `1m`, `1h`, `1d` (`WireLimitDuration`). */
export function durationMs(text: string): number | undefined {
  const match = DURATION.exec(text);
  if (match === null) return undefined;
  const unit = match[2];
  if (unit !== 'ms' && unit !== 's' && unit !== 'm' && unit !== 'h' && unit !== 'd') return undefined;
  return Number(match[1]) * UNIT_MS[unit];
}

/** The request for one call by `caller` under its module's declared `limits`. */
export function limitRequest(caller: Caller, limits: readonly WireDeclaredLimitShape[], cost = 1): LimitRequest {
  return {
    key: throttleKey(caller),
    cost,
    holdMs: HOLD_MS,
    limits: limits.map((limit, index) => {
      const perMs = limit.per !== undefined ? durationMs(limit.per) : undefined;
      return {
        // The index keeps two limits on one scope (per minute, per day) apart.
        key: `${caller.module}|${limit.scope}|${scopeValue(caller, limit.scope)}|${index}`,
        ...(limit.calls !== undefined && perMs !== undefined ? { calls: limit.calls, perMs } : {}),
        ...(limit.concurrent !== undefined ? { concurrent: limit.concurrent } : {}),
      };
    }),
  };
}

/** A granted call: release it when the call is done. */
export interface Held {
  release(): Promise<void>;
}

/** Acquire `request` from `limiter`, waiting in this process while it is refused. */
export async function acquireOrWait(limiter: Limiter, request: LimitRequest): Promise<Held> {
  for (;;) {
    // Listening before asking, so a release between the refusal and the wait still wakes it.
    const released = limiter.released?.();
    const grant = await limiter.acquire(request);
    if (grant.granted) {
      released?.stop();
      const { permit } = grant;
      return { release: () => limiter.release(permit) };
    }
    // THE PAUSE SEAM (CONCERNS.md, r-limits): a host that parks a segment on
    // a limit (park reason `limit`, woken at `retryAt`) would hand the run
    // back here instead of holding it in process. Today the host waits.
    const waitMs = Math.max(0, Date.parse(grant.retryAt) - Date.now());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)));
    await (released !== undefined ? Promise.race([timeout, released.wait]) : timeout);
    clearTimeout(timer);
    released?.stop();
  }
}

/** Run `call` once `limiter` grants `request`; its permit released after. */
export async function limited<T>(limiter: Limiter, request: LimitRequest, call: () => Promise<T>): Promise<T> {
  const held = await acquireOrWait(limiter, request);
  try {
    return await call();
  } finally {
    await held.release();
  }
}

// ── The slot this process's calls ask ───────────────────────────────────────

let slot: Limiter | undefined;

/** The limiter filling the slot: the built-in until a host installs another. */
export function limiterSlot(): Limiter {
  slot ??= new MemoryLimiter();
  return slot;
}

export function installLimiter(limiter: Limiter): void {
  slot = limiter;
}

// ── @lf/memory-limiter ──────────────────────────────────────────────────────

/** How soon a call refused for concurrency asks again, if no release wakes
 *  it first (a permit lapsing frees a place with no release). */
const CONCURRENCY_RECHECK_MS = 1_000;

interface BucketState {
  tokens: number;
  filledAt: number;
  held: number;
}

/** The limits kept in this process: a token bucket per `calls`/`perMs` limit
 *  (full at first, refilled evenly), a count of held permits per
 *  `concurrent` one, and the throttles providers reported. */
export class MemoryLimiter implements Limiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly permits = new Map<string, { holds: string[]; lapsesAt: number }>();
  private readonly throttles = new Map<string, number>();
  private readonly waiters = new Set<() => void>();

  async acquire(request: LimitRequest): Promise<LimitGrant> {
    const now = Date.now();
    this.lapsePermits(now);
    const until = this.throttles.get(request.key);
    if (until !== undefined) {
      if (until > now) return { granted: false, retryAt: new Date(until).toISOString() };
      this.throttles.delete(request.key);
    }
    let retryAt: number | undefined;
    const later = (at: number) => (retryAt = retryAt === undefined ? at : Math.max(retryAt, at));
    for (const limit of request.limits) {
      const bucket = this.bucket(limit, now);
      if (limit.calls !== undefined && limit.perMs !== undefined) {
        const rate = limit.calls / limit.perMs;
        bucket.tokens = Math.min(limit.calls, bucket.tokens + (now - bucket.filledAt) * rate);
        bucket.filledAt = now;
        // A call costing more than the whole window waits for a full one.
        const cost = Math.min(request.cost, limit.calls);
        if (bucket.tokens < cost) later(now + Math.ceil((cost - bucket.tokens) / rate));
      }
      if (limit.concurrent !== undefined && bucket.held >= limit.concurrent) {
        const soonestLapse = Math.min(...[...this.permits.values()].map((p) => p.lapsesAt));
        later(Math.min(soonestLapse, now + CONCURRENCY_RECHECK_MS));
      }
    }
    if (retryAt !== undefined) return { granted: false, retryAt: new Date(retryAt).toISOString() };
    const holds: string[] = [];
    for (const limit of request.limits) {
      const bucket = this.bucket(limit, now);
      if (limit.calls !== undefined) bucket.tokens -= Math.min(request.cost, limit.calls);
      if (limit.concurrent !== undefined) {
        bucket.held += 1;
        holds.push(limit.key);
      }
    }
    const permit = randomUUID();
    if (holds.length > 0) this.permits.set(permit, { holds, lapsesAt: now + request.holdMs });
    return { granted: true, permit };
  }

  async release(permit: string): Promise<void> {
    if (this.free(permit)) this.wake();
  }

  async throttle({ key, until }: { key: string; until: string }): Promise<void> {
    const at = Date.parse(until);
    if (!Number.isFinite(at)) throw new Error(`throttle until ${JSON.stringify(until)}: not an instant`);
    this.throttles.set(key, Math.max(this.throttles.get(key) ?? at, at));
  }

  released(): { wait: Promise<void>; stop(): void } {
    let wake: () => void = () => {};
    const wait = new Promise<void>((resolve) => (wake = resolve));
    this.waiters.add(wake);
    return { wait, stop: () => this.waiters.delete(wake) };
  }

  private bucket(limit: LimitBucket, now: number): BucketState {
    let bucket = this.buckets.get(limit.key);
    if (bucket === undefined) {
      bucket = { tokens: limit.calls ?? 0, filledAt: now, held: 0 };
      this.buckets.set(limit.key, bucket);
    }
    return bucket;
  }

  private lapsePermits(now: number): void {
    let lapsed = false;
    for (const [id, permit] of this.permits) {
      if (permit.lapsesAt <= now) lapsed = this.free(id) || lapsed;
    }
    if (lapsed) this.wake();
  }

  private free(id: string): boolean {
    const permit = this.permits.get(id);
    if (permit === undefined) return false;
    this.permits.delete(id);
    for (const key of permit.holds) {
      const bucket = this.buckets.get(key);
      if (bucket !== undefined) bucket.held = Math.max(0, bucket.held - 1);
    }
    return true;
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
