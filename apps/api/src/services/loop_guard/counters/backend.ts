// The loop guard's bucket counters sit behind this seam so Redis is one backend among others. The
// windowing (bucket stamps, which buckets a window sums) lives in ../store.ts and is the same for
// every backend; a backend only adds to a bucket, reads buckets, and drops them.

export interface BucketBackend {
  /**
   * Add `amount` to `bucketKey` and renew its time-to-live to `ttlSeconds`, then return the values
   * of `readKeys` in order (0 for an absent or expired key). Rejects when the backend is broken;
   * the caller treats that as fail-open.
   */
  addAndRead(input: {
    bucketKey: string;
    amount: number;
    ttlSeconds: number;
    readKeys: string[];
    nowMs: number;
  }): Promise<number[]>;

  remove(keys: string[]): Promise<void>;
}
