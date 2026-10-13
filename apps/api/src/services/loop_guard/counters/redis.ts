import type { Redis } from 'ioredis';

import { getRedisPool } from '../../../redisPool';
import type { BucketBackend } from './backend';

/** Cap a Redis op so a stalled connection can't blow the latency budget. */
const REDIS_OP_TIMEOUT_MS = 20;

/** Race a promise against a timeout; on timeout the rejection drives fail-open. */
async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('loop_guard redis op timed out')),
      REDIS_OP_TIMEOUT_MS,
    );
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

/** The increment, its TTL and the window read go out as ONE pipelined round-trip. */
export const redisBucketBackend: BucketBackend = {
  addAndRead: ({ bucketKey, amount, ttlSeconds, readKeys }) =>
    withClient(async (client) => {
      const pipeline = client.pipeline();
      pipeline.incrby(bucketKey, amount);
      pipeline.expire(bucketKey, ttlSeconds);
      pipeline.mget(...readKeys);
      const results = await withTimeout(pipeline.exec());
      if (!results) throw new Error('loop_guard redis pipeline returned no replies');

      // results: [[err, incrReply], [err, expireReply], [err, mgetReply]]
      const mgetEntry = results[2];
      if (!mgetEntry || mgetEntry[0]) throw new Error('loop_guard redis mget failed');
      const values = mgetEntry[1];
      if (!Array.isArray(values)) throw new Error('loop_guard redis mget reply is not a list');
      return values.map((v) => {
        const n = typeof v === 'string' ? Number(v) : 0;
        return Number.isFinite(n) ? n : 0;
      });
    }),

  remove: async (keys) => {
    await withClient((client) => withTimeout(client.del(...keys)));
  },
};
