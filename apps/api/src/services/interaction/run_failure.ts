// Fail a run + reap its parks (P14). An ERROR / operator abort / unresumable
// strand takes down the whole run: the trigger_run → `failed`, the live
// `parked_run` + `join_pending` rows dropped, and the ONE cancellation signal
// (drop every awaitable adapter's correlation for the run) delivered. An ask the
// run was still awaiting is CLOSED along with it — the run minted that ask and
// is its only consumer, so an `open` ask outliving its run is a link promising a
// workflow that is over. Prior external writes STAY committed (P14) — we never
// touch them.

import { sql } from 'kysely';
import { failRun, settleIfCancelRequested } from 'movement-engine/public/run-host';
import { logger } from 'movement-engine/public/log';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../lib/kysely';
import { hostedRunHost } from '../movement_engine/run_host';
import { withRunLease } from '../movement_engine/run_lease';

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
      await withRunLease(row.run_id, (lease) =>
        settleIfCancelRequested(hostedRunHost(), { runId: row.run_id, fence: lease.token }),
      );
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

/**
 * Fail the run and tear its live state down (the run host's `failRun`): the
 * run row → `failed` with `message`, every parked leaf and join dropped, every
 * ask the run was still awaiting closed (the run minted it and was its only
 * consumer, so an `open` ask outliving its run is a link promising a workflow
 * that is over), every correlation dropped (a Slack reply still lands as
 * data), and its outstanding callbacks revoked. Prior external writes STAY
 * committed (P14).
 */
export async function failRunAndCancelRequests(input: { runId: TriggerRunId; message: string }): Promise<void> {
  await failRun(hostedRunHost(), input);
}
