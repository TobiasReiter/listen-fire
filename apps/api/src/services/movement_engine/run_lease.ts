// The per-run lease: at most one process steps a run at a time. Every entry
// into a run — its first firing, an await wake, a callback body, a timer, an
// operator's limit resume, an abort — holds the run's lease while it runs.
//
// The holder is the run-host core's (run_host/lease.ts); the lease itself is a
// row lease on `trigger_run`, served by the Postgres backend
// (run_host_store.ts). A holder that dies stops renewing, and its lease lapses
// after ORPHAN_AFTER — the same silence after which the orphan sweep calls a
// running segment dead — so a crashed holder needs no sweep of its own.
//
// The in-process single-flight slot (`runResumeSlot`) stays in front of this
// as the cheap first gate: it orders this process's own entries into a run;
// the lease orders processes.

import {
  takeRunLease as takeCoreRunLease,
  withRunLease as withCoreRunLease,
  RUN_LEASE_TTL_MS as CORE_RUN_LEASE_TTL_MS,
  type HeldRunLease,
} from 'movement-engine/public/run-host';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { hostedLeaseOptions } from './run_host';
import { postgresRunHostStore } from './run_host_store';

export type { HeldRunLease };

/** A segment beats every 5s (the recorder's live-trace tick) and a lease
 *  holder renews every third of this; a minute of silence is a dead process,
 *  not a slow one. One rule for both: a running segment gone this silent is
 *  orphaned, and a lease unrenewed this long has lapsed. */
export const ORPHAN_AFTER = CORE_RUN_LEASE_TTL_MS;

/** Another process (or another entry of this one) holds the run's lease. */
export class RunBusy extends Error {
  constructor(readonly runId: TriggerRunId) {
    super(`run ${runId} is being stepped elsewhere right now — try again in a moment`);
    this.name = 'RunBusy';
  }
}

// The signal a segment that lost its lease stops with is the engine's own
// control flow (errors.ts); re-exported for the host side.
export { RunLeaseLost } from 'movement-engine/public/run-support';

/** Take the run's lease for this process, or null while it is held elsewhere.
 *  `ttlMs` shortens it for tests; production takes the stale-heartbeat rule. */
export function takeRunLease(runId: TriggerRunId, opts: { ttlMs?: number } = {}): Promise<HeldRunLease | null> {
  return takeCoreRunLease(postgresRunHostStore.leases, runId, hostedLeaseOptions(opts));
}

/** `fn` under the run's lease, released however `fn` ends; `busy` when the
 *  lease is held elsewhere, and `fn` does not run. Not re-entrant: an entry
 *  already holding the run's lease calls its body directly. */
export function withRunLease<T>(
  runId: TriggerRunId,
  fn: (lease: HeldRunLease) => Promise<T>,
  opts: { ttlMs?: number } = {},
): Promise<{ kind: 'held'; value: T } | { kind: 'busy' }> {
  return withCoreRunLease(postgresRunHostStore.leases, runId, fn, hostedLeaseOptions(opts));
}
