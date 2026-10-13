import type { BucketBackend } from './backend';

/**
 * In-process counters, for when no Redis is configured. Exact for one process; with several API
 * instances and no Redis each instance counts only its own firings, so a threshold is reached
 * later than the team's total traffic would reach it.
 */
export function createMemoryBucketBackend(): BucketBackend {
  const buckets = new Map<string, { value: number; expiresAtMs: number }>();
  let lastSweepMs = 0;

  // Expired entries are ignored on read; sweeping at most once a second keeps the map from
  // growing with every key that has gone quiet.
  function sweep(nowMs: number): void {
    if (nowMs - lastSweepMs < 1000 && nowMs >= lastSweepMs) return;
    lastSweepMs = nowMs;
    for (const [key, bucket] of buckets) {
      if (bucket.expiresAtMs <= nowMs) buckets.delete(key);
    }
  }

  function live(key: string, nowMs: number): number {
    const bucket = buckets.get(key);
    return bucket && bucket.expiresAtMs > nowMs ? bucket.value : 0;
  }

  return {
    async addAndRead({ bucketKey, amount, ttlSeconds, readKeys, nowMs }) {
      sweep(nowMs);
      buckets.set(bucketKey, {
        value: live(bucketKey, nowMs) + amount,
        expiresAtMs: nowMs + ttlSeconds * 1000,
      });
      return readKeys.map((key) => live(key, nowMs));
    },

    async remove(keys) {
      for (const key of keys) buckets.delete(key);
    },
  };
}
