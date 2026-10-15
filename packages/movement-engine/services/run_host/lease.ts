// The per-run lease: at most one process steps a run at a time. Every entry
// into a run (its first firing, a wake, a timer, a callback body, an operator's
// resume) holds the run's lease while it runs. The backend keeps it as a row
// lease (claim succeeds only while free or lapsed, fenced afterwards by the
// token it handed out); this module is the holder: it renews every third of
// the lease's life and judges, by its own deadline, when it can no longer be
// sure the run is its own.

import type { RunLeaseStore } from './store';

/** A minute of silence is a dead process, not a slow one. */
export const RUN_LEASE_TTL_MS = 60_000;

/** A lease this process holds, renewing itself until released. */
export interface HeldRunLease {
  readonly runId: string;
  readonly token: string;
  /** True once this holder can no longer be sure the run is still its own: a
   *  renewal found the lease taken or lapsed, or the lease outlived its last
   *  successful renewal. It never comes back. */
  isLost(): boolean;
  release(): Promise<void>;
}

export interface LeaseOptions {
  ttlMs?: number;
  /** Runs before the run's lease is given back (the hosted product lands the
   *  segment's engine record first, so a queued resume reads it). */
  beforeRelease?: (runId: string) => Promise<void>;
  /** A lease the holder lost, or a renewal that failed. */
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

/** Take the run's lease for this process, or null while it is held elsewhere. */
export async function takeRunLease(
  leases: RunLeaseStore,
  runId: string,
  opts: LeaseOptions = {},
): Promise<HeldRunLease | null> {
  const ttlMs = opts.ttlMs ?? RUN_LEASE_TTL_MS;
  // The local deadline: the lease is ours for one life past the moment we asked
  // for it (or last renewed it). Taken before the round trip, so the backend's
  // own expiry is never earlier than ours.
  let deadline = Date.now() + ttlMs;
  const claimed = await leases.claim({ runId, ttlMs });
  if (claimed === null) return null;
  const { token } = claimed;
  let lost = false;
  let released = false;
  const markLost = (reason: string, error?: unknown): void => {
    if (lost) return;
    lost = true;
    clearInterval(timer);
    opts.warn?.('[RunLease] lease lost while held', { runId, reason, ...(error !== undefined ? { error } : {}) });
  };
  const renew = async (): Promise<void> => {
    const attemptedAt = Date.now();
    if (attemptedAt > deadline) {
      markLost('expired');
      return;
    }
    try {
      if (await leases.renew({ runId, token, ttlMs })) {
        if (!lost) deadline = attemptedAt + ttlMs;
      } else {
        markLost('taken or lapsed');
      }
    } catch (error) {
      // One failed renewal is not a lost lease: the deadline is what marks a
      // lease that truly lapsed.
      opts.warn?.('[RunLease] renewal failed; retrying at the next tick', { runId, error });
    }
  };
  const timer = setInterval(() => {
    if (!lost && !released) void renew();
  }, ttlMs / 3);
  timer.unref?.();
  return {
    runId,
    token,
    isLost: () => {
      if (!lost && !released && Date.now() > deadline) markLost('expired');
      return lost;
    },
    release: async () => {
      released = true;
      clearInterval(timer);
      if (opts.beforeRelease !== undefined) await opts.beforeRelease(runId);
      try {
        await leases.release({ runId, token });
      } catch (error) {
        opts.warn?.('[RunLease] release failed; the lease will lapse instead', { runId, error });
      }
    },
  };
}

/** `fn` under the run's lease, released however `fn` ends; `busy` when the
 *  lease is held elsewhere, and `fn` does not run. Not re-entrant. */
export async function withRunLease<T>(
  leases: RunLeaseStore,
  runId: string,
  fn: (lease: HeldRunLease) => Promise<T>,
  opts: LeaseOptions = {},
): Promise<{ kind: 'held'; value: T } | { kind: 'busy' }> {
  const lease = await takeRunLease(leases, runId, opts);
  if (lease === null) return { kind: 'busy' };
  try {
    return { kind: 'held', value: await fn(lease) };
  } finally {
    await lease.release();
  }
}
