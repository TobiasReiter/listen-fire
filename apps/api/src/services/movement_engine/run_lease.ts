// The per-run lease: at most one process steps a run at a time. Every entry
// into a run — its first firing, an await wake, a callback body, a timer, an
// operator's limit resume, an abort — holds the run's lease while it runs.
//
// The lease is a row lease on `trigger_run` (lease_owner, lease_until,
// lease_token), claimed exactly as the work table claims a row: one UPDATE
// that succeeds only while the lease is free or expired, fenced afterwards by
// the token it handed out. No connection is held for the lease's life, so it
// survives transaction pooling and any number of concurrent segments. A holder
// that dies stops renewing, and its lease lapses after ORPHAN_AFTER — the same
// silence after which the orphan sweep calls a running segment dead — so a
// crashed holder needs no sweep of its own.
//
// The in-process single-flight slot (`runResumeSlot`) stays in front of this
// as the cheap first gate: it orders this process's own entries into a run;
// the lease orders processes.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql } from 'kysely';
import type { ParkReason } from 'engine-contracts';

import { SECOND } from '../../constants';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from '../logger';
import { runLeasedTo } from './lease_fence';

/** A segment beats every 5s (the recorder's live-trace tick) and a lease
 *  holder renews every third of this; a minute of silence is a dead process,
 *  not a slow one. One rule for both: a running segment gone this silent is
 *  orphaned, and a lease unrenewed this long has lapsed. */
export const ORPHAN_AFTER = 60 * SECOND;

/** The lease's life: the stale-heartbeat rule itself. */
export const RUN_LEASE_TTL_MS = ORPHAN_AFTER;

// One process is one owner. The owner is only informational (the token
// fences), so a stable name makes the column readable.
const LEASE_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Another process (or another entry of this one) holds the run's lease. */
export class RunBusy extends Error {
  constructor(readonly runId: TriggerRunId) {
    super(`run ${runId} is being stepped elsewhere right now — try again in a moment`);
    this.name = 'RunBusy';
  }
}

function leaseFromNow(ttlMs: number) {
  return sql<Date>`now() + ${ttlMs}::integer * interval '1 millisecond'`;
}

/** Take the run's lease if it is free or expired. Null while someone else
 *  holds it (or the run does not exist). */
export async function claimRunLease(
  runId: TriggerRunId,
  opts: { owner: string; ttlMs: number },
): Promise<{ token: string } | null> {
  const token = randomUUID();
  const row = await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ lease_owner: opts.owner, lease_until: leaseFromNow(opts.ttlMs), lease_token: token })
    .where('id', '=', runId)
    .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', sql<Date>`now()`)]))
    .returning('id')
    .executeTakeFirst();
  return row === undefined ? null : { token };
}

/** Extend a held lease, and stamp the run's heartbeat in the same statement:
 *  a holder renewing is a segment alive. False once the lease is no longer
 *  this token's, or has already lapsed: a lapsed lease is free for anyone to
 *  claim, and renewing it would revive it under a holder that lost it. */
export async function renewRunLease(runId: TriggerRunId, token: string, ttlMs: number): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ lease_until: leaseFromNow(ttlMs), last_heartbeat_at: sql<Date>`now()` })
    .where('id', '=', runId)
    .where('lease_token', '=', token)
    .where('lease_until', '>', sql<Date>`now()`)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Give the lease back. A no-op when it is no longer this token's. */
export async function releaseRunLease(runId: TriggerRunId, token: string): Promise<void> {
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ lease_owner: null, lease_until: null, lease_token: null })
    .where('id', '=', runId)
    .where('lease_token', '=', token)
    .execute();
}

/** A lease this process holds, renewing itself until released. */
export interface HeldRunLease {
  readonly runId: TriggerRunId;
  readonly token: string;
  /** True once this holder can no longer be sure the run is still its own: a
   *  renewal found the lease taken or lapsed, or the lease outlived its last
   *  successful renewal. A segment checks it at every statement boundary
   *  and stops (`RunLeaseLost`); it never comes back. */
  isLost(): boolean;
  release(): Promise<void>;
}

// The signal a segment that lost its lease stops with is the engine's own
// control flow (errors.ts); re-exported for the host side.
export { RunLeaseLost } from './errors';

/**
 * Take the run's lease for this process, or null while it is held elsewhere.
 * Holding it, every leaf of the run left mid-resume (`resuming`) is a dead
 * holder's, and goes back to `parked` before anything reads the run's leaves.
 * The lease renews itself every third of its life until `release`. `ttlMs`
 * shortens it for tests; production takes the stale-heartbeat rule.
 */
export async function takeRunLease(
  runId: TriggerRunId,
  opts: { ttlMs?: number } = {},
): Promise<HeldRunLease | null> {
  const ttlMs = opts.ttlMs ?? RUN_LEASE_TTL_MS;
  // The local deadline: the lease is ours for one life past the moment we
  // asked for it (or last renewed it), and not a moment longer. Taken before
  // the round trip, so the database's own expiry is never earlier than ours.
  let deadline = Date.now() + ttlMs;
  const claimed = await claimRunLease(runId, { owner: LEASE_OWNER, ttlMs });
  if (claimed === null) return null;
  const { token } = claimed;
  let lost = false;
  let released = false;
  const markLost = (reason: string, error?: unknown): void => {
    if (lost) return;
    lost = true;
    clearInterval(timer);
    logger.warn('[RunLease] lease lost while held', { runId, reason, ...(error !== undefined ? { error } : {}) });
  };
  const renew = async (): Promise<void> => {
    // Past the deadline the lease may already be someone else's: never renew
    // it, and touch nothing.
    const attemptedAt = Date.now();
    if (attemptedAt > deadline) {
      markLost('expired');
      return;
    }
    try {
      if (await renewRunLease(runId, token, ttlMs)) {
        if (!lost) deadline = attemptedAt + ttlMs;
      } else {
        markLost('taken or lapsed');
      }
    } catch (error) {
      // One failed renewal is not a lost lease: the next tick tries again,
      // and the deadline is what marks a lease that truly lapsed.
      logger.warn('[RunLease] renewal failed; retrying at the next tick', { runId, error });
    }
  };
  const timer = setInterval(() => {
    if (!lost && !released) void renew();
  }, ttlMs / 3);
  timer.unref?.();
  const isLost = (): boolean => {
    if (!lost && !released && Date.now() > deadline) markLost('expired');
    return lost;
  };
  const release = async (): Promise<void> => {
    released = true;
    clearInterval(timer);
    try {
      await releaseRunLease(runId, token);
    } catch (error) {
      logger.warn('[RunLease] release failed; the lease will lapse instead', { runId, error });
    }
  };
  try {
    await returnAbandonedLeaves(runId);
  } catch (error) {
    await release();
    throw error;
  }
  return { runId, token, isLost, release };
}

/** `fn` under the run's lease (handed the lease, so the segment it steps can
 *  watch it), released however `fn` ends; `busy` when the lease is held
 *  elsewhere, and `fn` does not run. Not re-entrant: an entry already holding
 *  the run's lease calls its body directly. */
export async function withRunLease<T>(
  runId: TriggerRunId,
  fn: (lease: HeldRunLease) => Promise<T>,
  opts: { ttlMs?: number } = {},
): Promise<{ kind: 'held'; value: T } | { kind: 'busy' }> {
  const lease = await takeRunLease(runId, opts);
  if (lease === null) return { kind: 'busy' };
  try {
    return { kind: 'held', value: await fn(lease) };
  } finally {
    await lease.release();
  }
}

// ── Leaves claimed before they resume ───────────────────────────────────────
//
// A resume driver claims a leaf (`parked` → `resuming`) under the run's lease
// before stepping it, and deletes the claimed row once the step is over. A
// step that parks again at the same address rewrites the row as `parked`, so
// the delete leaves that one alone. A holder that dies mid-step leaves a
// `resuming` row: the next lease holder of the run, or the orphan sweep once
// the lease has lapsed, returns it to `parked`.

/** Claim one parked leaf for resuming. Null when it is not parked (already
 *  resumed, or cancelled as a race loser). */
export async function claimParkedLeaf(input: {
  runId: TriggerRunId;
  address: string;
  /** Claim only a leaf parked for this reason — one of the core's, or one a
   *  unit owns. */
  parkReason?: ParkReason;
}): Promise<{ state: unknown } | null> {
  let claim = getAutomationsQb(['parked_run'])
    .updateTable('parked_run')
    .set({ status: 'resuming', updated_at: sql`now()` })
    .where('run_id', '=', input.runId)
    .where('address', '=', input.address)
    .where('status', '=', 'parked');
  if (input.parkReason !== undefined) claim = claim.where('park_reason', '=', input.parkReason);
  const row = await claim.returning('state').executeTakeFirst();
  return row === undefined ? null : { state: row.state };
}

/** The claimed leaf's row is done with: delete it, unless the step parked
 *  again at the same address (the row is `parked` again, and stays). Given
 *  the lease that claimed it, only while the run's lease is still that one: a
 *  holder whose lease lapsed leaves the row to the new holder. */
export async function finishResumedLeaf(
  runId: TriggerRunId,
  address: string,
  lease?: { token: string },
): Promise<void> {
  let finish = getAutomationsQb(['parked_run', 'trigger_run'])
    .deleteFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .where('status', '=', 'resuming');
  if (lease !== undefined) finish = finish.where(runLeasedTo(lease.token));
  await finish.execute();
}

async function returnAbandonedLeaves(runId: TriggerRunId): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .updateTable('parked_run')
    .set({ status: 'parked' })
    .where('run_id', '=', runId)
    .where('status', '=', 'resuming')
    .execute();
}

/** The orphan sweep's half: every `resuming` leaf whose run's lease is free or
 *  lapsed was left by a dead holder, and is parked again. Returns how many. */
export async function returnLeavesOfLapsedLeases(): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    UPDATE automations.parked_run p
    SET status = 'parked'
    FROM automations.trigger_run r
    WHERE p.run_id = r.id AND p.status = 'resuming'
      AND (r.lease_until IS NULL OR r.lease_until < now())
    RETURNING p.id`.execute(getAutomationsQb(['parked_run', 'trigger_run']));
  return rows.length;
}
