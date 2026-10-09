// Fail a run + reap its parks (P14). An ERROR / operator abort / unresumable
// strand takes down the whole run: the trigger_run → `failed`, the live
// `parked_run` + `join_pending` rows dropped, and the ONE cancellation signal
// (drop every awaitable adapter's correlation for the run) delivered. An ask the
// run was still awaiting is CLOSED along with it — the run minted that ask and
// is its only consumer, so an `open` ask outliving its run is a link promising a
// workflow that is over. Prior external writes STAY committed (P14) — we never
// touch them.

import { sql } from 'kysely';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getQb } from '../../lib/kysely';
import { clearJoins } from '../movement_engine/join_pending';
import { dropAwaitCorrelationsForRun } from '../translation_graph/adapters/await_correlation';
import { awaitKeepers } from '../translation_graph/adapters/packages';
import { revokeRunCallbacks } from '../movement_engine/callback_store';
import { withRunLease } from '../movement_engine/run_lease';
import { logger } from '../logger';

/**
 * Settle a run that has been stamped `cancel_requested_at` (operator abort, or
 * a cancel that raced a park/resume) — the shared tail-check helper used by the
 * park sink and every resume driver to close the cancel-vs-park/resume race
 * (runs-cancel task 3). Reads the stamped `cancel_reason` back so the run's
 * `failure_reason` matches what the operator actually requested, then reuses
 * `failRunAndCancelRequests` unchanged (still valid on a `parked` run — the
 * park row this call is settling gets dropped along with everything else).
 */
export async function settleCancelledRun(runId: TriggerRunId): Promise<void> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .select('cancel_reason')
    .where('id', '=', runId)
    .executeTakeFirst();
  await failRunAndCancelRequests({
    runId,
    message: row?.cancel_reason ?? 'Cancelled by an operator',
  });
}

/**
 * Settle a parked run that can NEVER resume — its pinned `movement_version` is
 * gone, so there is no source to re-enter (P11). The pin is nulled by the
 * `trigger_run_movement_version_id_fkey ON DELETE SET NULL` cascade when a
 * movement is deleted, which strands every run parked against it.
 *
 * This exists because "unresumable" and "not ready yet" are NOT the same
 * state, and a resume driver that treats them alike is writing an immortal
 * run: its scan re-selects the leaf every tick, logs, and returns, forever.
 * A run that cannot make progress must reach a terminal state and say why —
 * on the runs page, where the dropped work is visible — rather than sit in
 * `parked` emitting error lines nobody is watching.
 */
export async function settleUnresumableRun(input: {
  runId: TriggerRunId;
  reason: string;
}): Promise<void> {
  await failRunAndCancelRequests({ runId: input.runId, message: input.reason });
}

/**
 * Settle every run still PARKED against any of these triggers, called before
 * the triggers are deleted. Deleting a movement retires its triggers and
 * cascades its `movement_version` rows away — which nulls the pin on any run
 * parked against them — so without this the run is stranded: no listener, no
 * source, no way to ever resume, and no terminal state either. Whoever deletes
 * the listener is the last actor that still knows the work is being dropped;
 * settling here is what makes that visible instead of silent.
 *
 * Covers ALL park reasons: an ask, a timer and an await park are each stranded
 * by a deletion exactly as thoroughly as the others.
 */
export async function settleRunsParkedOnTriggers(input: {
  triggerIds: string[];
  reason: string;
}): Promise<void> {
  if (input.triggerIds.length === 0) return;
  // `parked_run` holds only LIVE leaves (a settled one is deleted), so this is
  // bounded live state rather than run history — cheap to read whole, and this
  // runs only when a listener is actually being retired.
  // A leaf another instance is resuming right now (`resuming`) counts too:
  // missed, its run would be stranded on a retired trigger the moment that
  // resume parks again. Such a run is busy below, and is stamped.
  const parked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('status', 'in', ['parked', 'resuming'])
    .select('run_id')
    .execute();
  const parkedRunIds = [...new Set(parked.map((p) => p.run_id))];
  if (parkedRunIds.length === 0) return;

  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', 'in', parkedRunIds)
    .where('trigger_id', 'in', input.triggerIds)
    .select('id')
    .execute();
  for (const run of runs) {
    // Under the run's lease. A run another instance is resuming right now is
    // stamped instead: its cancel gate stops it at the next statement and
    // settles it with this reason (or the park sink does, should it park).
    const settled = await withRunLease(run.id, () =>
      settleUnresumableRun({ runId: run.id, reason: input.reason }),
    );
    if (settled.kind === 'busy') {
      await stampCancelRequested(run.id, { reason: input.reason, statuses: ['running', 'parked'] });
    }
  }
}

/**
 * The cancel-race closure for parked runs: every run that still holds a
 * parked leaf and carries a `cancel_requested_at` stamp, whatever the leaf is
 * parked on (a timer, an await, a limit). A cancel is stamped rather than
 * settled when another entry holds the run; that entry's cancel gate, or its
 * park sink's tail check, normally settles it. A resume that finished without
 * reaching either (it completed its branch before the gate read the stamp,
 * and parked nothing new) leaves the run parked on its other leaves with the
 * stamp unread. Settling here bounds that to one sweep, rather than waiting
 * for a wake that may be hours away or never come.
 */
export async function settleStampedParkedRuns(): Promise<void> {
  const rows = await getAutomationsQb(['trigger_run', 'parked_run'])
    .selectFrom('trigger_run')
    .innerJoin('parked_run', 'parked_run.run_id', 'trigger_run.id')
    .where('trigger_run.cancel_requested_at', 'is not', null)
    .select('trigger_run.id as run_id')
    .distinct()
    .execute();
  for (const row of rows) {
    try {
      // Under the run's lease; a run another instance is stepping is that
      // holder's to settle (its cancel gate sees the stamp), or the next pass's.
      await withRunLease(row.run_id, () => settleCancelledRun(row.run_id));
    } catch (err) {
      logger.error('[RunFailure] settling a stamped parked run failed', {
        runId: row.run_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** The guarded stamp: only lands on a run that is STILL in one of `statuses`
 *  (`running` unless said) with no cancel already in flight. Returns whether
 *  it won the race. */
export async function stampCancelRequested(
  runId: TriggerRunId,
  opts: { reason: string; statuses?: ReadonlyArray<'running' | 'parked'> },
): Promise<boolean> {
  const { reason, statuses = ['running'] } = opts;
  const row = await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ cancel_requested_at: sql`now()`, cancel_reason: reason })
    .where('id', '=', runId)
    .where('status', 'in', [...statuses])
    .where('cancel_requested_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function failRunAndCancelRequests(input: {
  runId: TriggerRunId;
  message: string;
}): Promise<void> {
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ status: 'failed', failed_at: sql`now()`, failure_reason: input.message })
    .where('id', '=', input.runId)
    .where('status', 'in', ['running', 'parked'])
    .execute();

  await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', input.runId).execute();
  await clearJoins(input.runId);

  // An ask this run was waiting on is CLOSED with the run: the run is over, so
  // nothing is left to consume an answer, and leaving the ask `open` would leave
  // its link offering a live form and promising a workflow that has already
  // settled. (This closes an ask the run ASKED and still awaited — an ask
  // already answered is untouched by the store's `WHERE state = 'open'` guard.)
  for (const keeper of awaitKeepers()) await keeper.abandon({ runId: input.runId });

  // The ONE cancellation signal to every remaining in-flight AWAIT of the run
  // (P17): drop EVERY awaitable adapter's correlation entries in one
  // adapter-agnostic reap (one generic table, no per-adapter fan-out). A Slack
  // thread reply still lands as data — that record is a conversation the run
  // does not own, unlike an ask, which the run minted and is the only consumer of.
  await dropAwaitCorrelationsForRun(input.runId);

  // Ruling (b), callback-primitive layer 1: a run that ends — here by failure /
  // cancel / unresumability — revokes its outstanding callbacks. Unlike an ask
  // (whose record outlives the run), a callback IS the run's own capability: a
  // late tap gets the closed-request-wins ack because there is nothing left to
  // resume into.
  await revokeRunCallbacks(input.runId);
}
