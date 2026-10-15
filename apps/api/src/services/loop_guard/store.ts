// Loop guard — the sliding-window counter store (the hot path).
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
// The buckets live in Redis when MESSAGE_QUEUE_REDIS_HOSTNAME is set and in this process's memory
// otherwise (./counters). The backend is picked once, at load. Memory is exact for one process; with
// several API instances and no Redis each counts only its own firings.
//
// FAIL-OPEN: every backend operation is wrapped so that a connection
// error, timeout, or unexpected reply degrades to "no signal" — `increment`
// returns the amount as if it succeeded-but-empty, and reads return 0. A broken
// guard must NEVER block legitimate work (P4).

import { redisConfigured } from '../../redisPool';
import { logger } from 'movement-engine/services/logger';
import type { BucketBackend } from './counters/backend';
import { createMemoryBucketBackend } from './counters/memory';
import { redisBucketBackend } from './counters/redis';

export { resetAcquireBackoffForTests } from './counters/redis';

/** Bucket granularity. One bucket per second keeps windows precise to ~1s. */
const BUCKET_SECONDS = 1;

const backend: BucketBackend = redisConfigured() ? redisBucketBackend : createMemoryBucketBackend();
// A deployment that meant to share counters across instances but lost its Redis setting would
// otherwise count per instance without a trace.
logger.info(`[LoopGuard] counters kept in ${redisConfigured() ? 'Redis' : 'process memory'}`);

function bucketStamp(nowMs: number): number {
  return Math.floor(nowMs / 1000 / BUCKET_SECONDS);
}

/**
 * Increment a sliding-window metric and return its current windowed total
 * (count over the trailing `windowSeconds`), all in ONE pipelined round-trip.
 *
 * The bucket key gets a TTL of `windowSeconds + a small slack` so it survives
 * exactly long enough to be summed and no longer.
 *
 * Fail-open: on any backend error the metric is treated as 0 (well under any
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
    const values = await backend.addAndRead({
      bucketKey: currentKey,
      amount: input.amount,
      ttlSeconds: input.windowSeconds + BUCKET_SECONDS * 2,
      readKeys,
      nowMs,
    });
    return { total: values.reduce((sum, n) => sum + n, 0), failOpen: false };
  } catch (err) {
    logger.warn('[LoopGuard] incrementAndSum failed — failing open', {
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
    await backend.remove(keys);
  } catch (err) {
    logger.warn('[LoopGuard] resetWindow failed', {
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
