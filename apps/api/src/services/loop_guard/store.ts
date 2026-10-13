// Loop guard — the Redis sliding-window store (the hot path).
//
// Sliding-window-by-buckets: each metric is counted into a per-SECOND-bucket
// key with a short TTL; a "current value" is the SUM of the buckets covering
// the last `windowSeconds`. Bucketing keeps each increment O(1) and lets the
// window slide without a sorted set or any read-modify-write — incrementing a
// bucket and reading the recent buckets are independent pipelined ops.
//
// All keys are short-TTL and self-expiring: nothing here needs cleanup, and a
// metric that goes quiet simply ages out. No DB on this path.
//
// FAIL-OPEN: every operation that touches Redis is wrapped so that a connection
// error, timeout, or unexpected reply degrades to "no signal" — `increment`
// returns the amount as if it succeeded-but-empty, and reads return 0. A broken
// guard must NEVER block legitimate work (P4).

import type { Redis } from 'ioredis';

import { getRedisPool } from '../../redisPool';
import { logger } from '../logger';

/** Bucket granularity. One bucket per second keeps windows precise to ~1s. */
const BUCKET_SECONDS = 1;

/** Cap a Redis op so a stalled connection can't blow the latency budget. */
const REDIS_OP_TIMEOUT_MS = 20;

function bucketStamp(nowMs: number): number {
  return Math.floor(nowMs / 1000 / BUCKET_SECONDS);
}

/** Race a promise against a timeout; on timeout the rejection drives fail-open. */
async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('loop_guard redis op timed out')), REDIS_OP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Longest the guard waits for a client. Generous next to the per-op budget because the first
 * acquire pays a one-time connect + ping; short next to everything else a dispatch does.
 */
const ACQUIRE_TIMEOUT_MS = 500;

/** After an acquire fails, skip Redis this long so each dispatch doesn't pay the wait again. */
const ACQUIRE_BACKOFF_MS = 5000;

let skipRedisUntilMs = 0;

/** Test seam: forget a recorded outage. */
export function resetAcquireBackoffForTests(): void {
  skipRedisUntilMs = 0;
}

/**
 * Run a function with a pooled Redis client, always releasing it. The pool `acquire()` is NOT under
 * the tight op-timeout (the first acquire pays a one-time TCP-connect + ping cost that exceeds the
 * per-op budget); it is bounded separately by ACQUIRE_TIMEOUT_MS, and the pool itself rejects when
 * the connection cannot be made. A dead Redis therefore fails in at most ACQUIRE_TIMEOUT_MS on the
 * first call and instantly for ACQUIRE_BACKOFF_MS after: the acquire rejects and the caller's catch
 * fails open.
 */
async function withClient<T>(fn: (client: Redis) => Promise<T>): Promise<T> {
  if (Date.now() < skipRedisUntilMs) throw new Error('loop_guard redis unavailable (backing off)');
  const pool = getRedisPool();
  const acquiring = pool.acquire();
  let timer: NodeJS.Timeout | undefined;
  let client: Redis;
  try {
    client = await Promise.race([
      acquiring,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('loop_guard redis acquire timed out')),
          ACQUIRE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    skipRedisUntilMs = Date.now() + ACQUIRE_BACKOFF_MS;
    // A client that arrives after we gave up goes straight back to the pool.
    acquiring.then((late) => pool.release(late)).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
  try {
    return await fn(client);
  } finally {
    pool.release(client).catch(() => {});
  }
}

/**
 * Increment a sliding-window metric and return its current windowed total
 * (count over the trailing `windowSeconds`), all in ONE pipelined round-trip.
 *
 * The bucket key gets a TTL of `windowSeconds + a small slack` so it survives
 * exactly long enough to be summed and no longer.
 *
 * Fail-open: on any Redis error the metric is treated as 0 (well under any
 * threshold) so the caller allows the run.
 */
export async function incrementAndSum(input: {
  /** Base key, e.g. `loopguard:rate:{teamId}:{triggerId}`. */
  key: string;
  /** Window length to sum over. */
  windowSeconds: number;
  /** Amount to add to the current bucket (1 for a firing; N for N writes/tokens). */
  amount: number;
  /** Clock injection point for tests. */
  nowMs?: number;
}): Promise<{ total: number; failOpen: boolean }> {
  const nowMs = input.nowMs ?? Date.now();
  const current = bucketStamp(nowMs);
  const bucketCount = Math.ceil(input.windowSeconds / BUCKET_SECONDS);
  const oldest = current - bucketCount + 1;

  const currentKey = `${input.key}:${current}`;
  const readKeys: string[] = [];
  for (let b = oldest; b <= current; b += 1) readKeys.push(`${input.key}:${b}`);

  try {
    return await withClient(async (client) => {
      const pipeline = client.pipeline();
      pipeline.incrby(currentKey, input.amount);
      pipeline.expire(currentKey, input.windowSeconds + BUCKET_SECONDS * 2);
      pipeline.mget(...readKeys);
      const results = await withTimeout(pipeline.exec());
      if (!results) return { total: input.amount, failOpen: true };

      // results: [[err, incrReply], [err, expireReply], [err, mgetReply]]
      const mgetEntry = results[2];
      if (!mgetEntry || mgetEntry[0]) {
        // mget failed — fall back to the increment reply alone.
        return { total: input.amount, failOpen: true };
      }
      const values = mgetEntry[1];
      if (!Array.isArray(values)) return { total: input.amount, failOpen: true };
      let total = 0;
      for (const v of values) {
        if (typeof v === 'string') {
          const n = Number(v);
          if (Number.isFinite(n)) total += n;
        }
      }
      return { total, failOpen: false };
    });
  } catch (err) {
    logger.warn('[LoopGuard] redis incrementAndSum failed — failing open', {
      key: input.key,
      error: err instanceof Error ? err.message : String(err),
    });
    return { total: input.amount, failOpen: true };
  }
}

/**
 * Reset a sliding-window metric (delete all its buckets). Called on resume so a
 * resumed automation starts from a clean window rather than immediately
 * re-tripping on stale counts.
 */
export async function resetWindow(input: {
  key: string;
  windowSeconds: number;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  const current = bucketStamp(nowMs);
  const bucketCount = Math.ceil(input.windowSeconds / BUCKET_SECONDS) + 2;
  const keys: string[] = [];
  for (let b = current - bucketCount + 1; b <= current + 1; b += 1) {
    keys.push(`${input.key}:${b}`);
  }
  try {
    await withClient((client) => withTimeout(client.del(...keys)));
  } catch (err) {
    logger.warn('[LoopGuard] redis resetWindow failed', {
      key: input.key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Key builders — one place so the families in §2.5 stay consistent. */
export const guardKeys = {
  triggerRate: (teamId: string, triggerId: string) => `loopguard:rate:${teamId}:${triggerId}`,
  teamRuns: (teamId: string) => `loopguard:team:runs:${teamId}`,
  teamExternalWrites: (teamId: string) => `loopguard:team:writes:${teamId}`,
  teamLlmTokens: (teamId: string) => `loopguard:team:tokens:${teamId}`,
};
