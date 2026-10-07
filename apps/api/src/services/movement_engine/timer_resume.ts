// The timer-resume driver (movement `sleep`, plans/2026-07-01-movement-sleep §4)
// — the wake driver. A near-clone of the cost-resume worker
// (the retired cost-resume driver), which was itself the ask-resume sibling
// (`interaction/resume.ts`). All three share the serialize/rehydrate +
// `join_pending` substrate; they differ only in WHAT parks and HOW the leaf
// resumes.
//
// A `sleep` parks the branch AT the sleep statement via `commitTimerPark`
// (`park_reason='timer'`, an absolute `wake_at`, no `interaction_request`, no
// answer, `state.bindingName = null`) and arms the run's `resume_timer` work
// row (timer_wake.ts) for that `wake_at`; the drain hands the row to
// `resumeTimerHandler`, which drives each due leaf of that run forward.
//
// Resume mode (the one thing that differs from cost-resume): a slept leaf's
// statement is DONE — the sleep already happened — so resume must step PAST it,
// exactly like the ask worker (`reenter=false`, the default), NOT re-enter AT it
// (which cost-resume does). It binds NOTHING: `answer` is omitted and the parked
// `state.bindingName` is null, so the interpreter's step-past path
// (`resumeAlongAddress`, run.ts) declares nothing and continues from the
// statement AFTER the sleep. Using `reenter=true` would re-run the sleep and
// re-park forever — so we omit it.
//
// One run is stepped by one process at a time (the run lease; a run held
// elsewhere re-arms its row a few seconds on), and idempotent: a crash mid-drain leaves the timer-parked rows for the re-claim to
// re-process; a completed leaf's `parked_run` is deleted, so it's skipped. A
// not-yet-due sibling leaf (fan-out sleep) stays parked and holds the join —
// verified separately (§9), not broken here.

import { sql } from 'kysely';
import { z } from 'zod';
import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { loadPinnedVersion } from '../translation_graph/movement/version_store';
import { logger } from '../logger';
import { settleCancelledRun, settleStampedParkedRuns, settleUnresumableRun } from '../interaction/run_failure';
import { runningSegment } from '../translation_graph/runs/trigger_run';
import { claimParkedLeaf, finishResumedLeaf, ORPHAN_AFTER, withRunLease, type HeldRunLease } from './run_lease';
import { neverAsAny } from '../../lib/utils/types';
import type { WorkHandler } from '../work/kinds';
import { registerWorkHandler } from '../work/drain';
import { armTimerWake, timerWorkKey } from './timer_wake';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { ParkedScopeState } from './serialize';
import { runHasPendingJoins, clearJoins } from './join_pending';
import { resumeMovementFiring } from '../translation_graph/movement/execute';
import { loadTriggerById } from '../translation_graph/storage/tg_table';
import { triggerEventSchema, type TriggerEvent } from '../translation_graph/triggers/types';
import type { TriggerRunTriggerType } from '../translation_graph/runs/trigger_run';

export { timerWorkKey } from './timer_wake';

// A leaf still due after its run was handled could not be resumed (its trigger
// or pinned version is gone); retry it at the old scan's cadence, not every drain.
const UNRESUMED_RETRY = 30 * SECOND;

// A run held by another process is looked at again this soon.
const BUSY_RETRY = 5 * SECOND;

interface TimerParkedRunRow {
  runId: TriggerRunId;
  teamId: TeamId;
}

const resumeTimerPayloadSchema = z.object({
  runId: z.custom<TriggerRunId>((value) => z.uuid().safeParse(value).success),
});

/** Wakes one run's due timer leaves, then re-arms the run's row for its next leaf. */
export const resumeTimerHandler: WorkHandler = {
  async run(payload, ctx) {
    const { runId } = resumeTimerPayloadSchema.parse(payload);
    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select(['team_id'])
      .executeTakeFirst();
    if (!run) return;
    // `trigger_run.team_id` is an opaque tenant uuid (D3 dropped the FK, and
    // with it the brand); naming it as core's team id is the boundary conversion.
    const teamId = run.team_id as TeamId;
    const stepped = await withRunLease(runId, async (lease) => {
      // Read again under the lease: a cancel stamped while another instance
      // held the run is this holder's to settle.
      if (await cancelRequested(runId)) {
        await settleCancelledRun(runId);
        return;
      }
      // A lost lease leaves every row as it is, the timer row included: the
      // run is the new holder's to re-arm.
      if ((await resumeTimerParkedRun({ runId, teamId }, ctx.now, lease)) === 'lease_lost') return;
      await rearmForNextLeaf({ runId, teamId, now: ctx.now });
    });
    // Another process is stepping the run (its first firing, a wake): look
    // again shortly. The leaves stay parked and due.
    if (stepped.kind === 'busy') {
      await armTimerWake({ runId, teamId, wakeAt: new Date(ctx.now.getTime() + BUSY_RETRY) });
    }
  },

  // Any re-claim lands here: a lapsed lease, or a retry after a throw. Only a run
  // left `running` with no heartbeat was cut off mid-segment; nothing can finish
  // that segment, so it fails. A live heartbeat may be the dead process's last
  // beat (the lease lapses before the heartbeat goes stale), so the row looks
  // again once it would be; the orphan sweep is the primary net. A parked run
  // lost nothing and runs again.
  async recover(payload, ctx) {
    const { runId } = resumeTimerPayloadSchema.parse(payload);
    const segment = await runningSegment(runId, { now: ctx.now, staleAfterMs: ORPHAN_AFTER });
    switch (segment) {
      case 'orphaned':
        await settleUnresumableRun({
          runId,
          reason: 'segment did not complete: lease lapsed or the previous attempt failed',
        });
        return;
      case 'live':
        await recheckLiveRunLater({ runId, now: ctx.now });
        return;
      case 'not_running':
        await resumeTimerHandler.run(payload, ctx);
        return;
      default:
        neverAsAny(segment);
    }
  },
};

async function cancelRequested(runId: TriggerRunId): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select('cancel_requested_at')
    .executeTakeFirst();
  return row?.cancel_requested_at != null;
}

async function recheckLiveRunLater(input: { runId: TriggerRunId; now: Date }): Promise<void> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', input.runId)
    .select('team_id')
    .executeTakeFirst();
  if (!run) return;
  await armTimerWake({
    runId: input.runId,
    teamId: run.team_id,
    wakeAt: new Date(input.now.getTime() + ORPHAN_AFTER),
  });
}

/** The periodic `timer_sweep`: the cancel-race closure for every parked run
 *  (whatever it is parked on), then re-arms any timer park that has no work
 *  row (parked before work rows existed, or whose enqueue failed after its
 *  parked_run was written). */
export const settleCancelledTimersHandler: WorkHandler = {
  async run() {
    await settleStampedParkedRuns();
    await armUnarmedTimerParks();
  },
};

export function registerTimerWork(): void {
  registerWorkHandler('resume_timer', resumeTimerHandler);
  registerWorkHandler('timer_sweep', settleCancelledTimersHandler);
}

// Several leaves share the run's row and only the earliest was due; the rest
// still need a wake. The row may be leased by this very claim, which enqueueWork
// honours by keeping it alive at the new time.
async function rearmForNextLeaf(input: {
  runId: TriggerRunId;
  teamId: TeamId;
  now: Date;
}): Promise<void> {
  const next = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', input.runId)
    .where('park_reason', '=', 'timer')
    .where('status', '=', 'parked')
    .select((eb) => eb.fn.min('wake_at').as('wake_at'))
    .executeTakeFirst();
  if (!next?.wake_at) return;
  const wakeAt = new Date(next.wake_at);
  const retryAt = new Date(input.now.getTime() + UNRESUMED_RETRY);
  await armTimerWake({
    runId: input.runId,
    teamId: input.teamId,
    wakeAt: wakeAt <= input.now ? retryAt : wakeAt,
  });
}

// One enqueue per parked run is enough: an unleased row keeps the earlier of its
// own and this due time. A leased row is skipped: its handler re-arms it from the
// leaves it leaves behind, and an enqueue now would replace that with a stale time.
async function armUnarmedTimerParks(): Promise<void> {
  const leased = await getAutomationsQb(['work'])
    .selectFrom('work')
    .where('kind', '=', 'resume_timer')
    .where('lease_until', '>', sql<Date>`now()`)
    .select('key')
    .execute();
  const leasedKeys = new Set(leased.map((row) => row.key));
  const runs = await getAutomationsQb(['trigger_run', 'parked_run'])
    .selectFrom('trigger_run')
    .innerJoin('parked_run', 'parked_run.run_id', 'trigger_run.id')
    .where('parked_run.park_reason', '=', 'timer')
    .where('parked_run.status', '=', 'parked')
    .where('trigger_run.cancel_requested_at', 'is', null)
    .groupBy(['trigger_run.id', 'trigger_run.team_id'])
    .select((eb) => [
      'trigger_run.id as runId',
      'trigger_run.team_id as teamId',
      eb.fn.min('parked_run.wake_at').as('wakeAt'),
    ])
    .execute();
  for (const run of runs) {
    if (!run.wakeAt || leasedKeys.has(timerWorkKey(run.runId))) continue;
    await armTimerWake({ runId: run.runId, teamId: run.teamId, wakeAt: new Date(run.wakeAt) });
  }
}

/**
 * Resume one timer-parked run, draining every DUE timer leaf (a fan-out sleep
 * parks N leaves; each steps PAST its own sleep and runs that branch forward).
 * The pinned version + inbound event are loaded once. After a branch completes
 * (no re-park, no error) the leaf's enclosing join decrements; the run finalises
 * `success` only when the last branch closes (linear = no join = finalise on
 * complete). A not-yet-due sibling leaf is left parked (its `wake_at` window
 * bounds the query), holding the join until its own wake.
 */
export async function resumeTimerParkedRun(
  run: TimerParkedRunRow,
  now: Date,
  /** The run lease the caller holds: each resumed segment watches it. */
  lease?: HeldRunLease,
): Promise<'done' | 'lease_lost'> {
  const { runId, teamId } = run;
  const triggerRun = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['trigger_id', 'trigger_type', 'trigger_payload', 'movement_version_id'])
    .executeTakeFirst();
  if (!triggerRun || !triggerRun.trigger_payload) {
    logger.error('[TimerResume] trigger_run missing or has no payload', { runId });
    return 'done';
  }

  const trigger = await loadTriggerById(triggerRun.trigger_id);
  if (!trigger || !trigger.movementId) {
    logger.error('[TimerResume] trigger gone or not movement-derived', {
      runId,
      triggerId: triggerRun.trigger_id,
    });
    return 'done';
  }

  const pinned = triggerRun.movement_version_id
    ? await loadPinnedVersion(triggerRun.movement_version_id)
    : null;
  if (!pinned) {
    logger.error('[TimerResume] no pinned movement_version source — cannot resume (P11)', {
      runId,
      movementVersionId: triggerRun.movement_version_id,
    });
    return 'done';
  }

  const event = triggerEventSchema.parse(triggerRun.trigger_payload) as TriggerEvent;

  // Each DUE timer leaf, drained in turn (serialised under the run's work lease —
  // the atomic join decrement is the only shared state).
  const leaves = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('park_reason', '=', 'timer')
    .where('status', '=', 'parked')
    .where('wake_at', '<=', now)
    .select(['address', 'state'])
    .execute();

  for (const leaf of leaves) {
    if (!leaf.state) {
      await deleteLeaf(runId, leaf.address);
      continue;
    }
    // Claimed before it is stepped: a leaf an earlier step of this batch
    // cancelled (a race loser) is not parked any more.
    const claimed = await claimParkedLeaf({ runId, address: leaf.address, parkReason: 'timer' });
    if (claimed === null || !claimed.state) continue;
    const state = claimed.state as ParkedScopeState;
    // An `await until(…)` park (chunk D, F12) RE-ENTERS to re-evaluate its
    // condition rather than stepping past like a `sleep`. Unmet ⇒ it re-parks at
    // the SAME address with a fresh (future) `wake_at`; met ⇒ it binds + continues.
    const isUntil = state.until === true;

    const outcome = await resumeMovementFiring({
      teamId,
      triggerId: triggerRun.trigger_id,
      triggerName: trigger.name,
      ...(trigger.firedMovementName !== null
        ? { firedMovementName: trigger.firedMovementName }
        : {}),
      pinnedSource: pinned.source,
      pinnedLanguageVersion: pinned.languageVersion,
      movementVersionId: triggerRun.movement_version_id,
      runId,
      movementId: trigger.movementId,
      event,
      recordingTriggerType: triggerRun.trigger_type as TriggerRunTriggerType,
      state,
      // A `sleep` already happened — step PAST it (`reenter` omitted ⇒ false),
      // binding nothing. An `until` must RE-ENTER at the statement to re-check its
      // condition live (a plain sleep re-entering would re-park forever — the
      // reason the default is step-past).
      ...(isUntil ? { reenter: true } : {}),
      settleBranchComplete: () => settleBranchComplete(runId, leaf.address),
      ...(lease !== undefined ? { lease } : {}),
    });

    // The lease was lost mid-step: the run may be another instance's now, so
    // this one leaves every row as it is.
    if (outcome.leaseLost) return 'lease_lost';
    if (outcome.error) {
      // An engine ERROR in any branch fails the whole run (P14): drop the timer
      // rows + pending joins; prior writes (incl. this branch's, before the
      // error) stay committed. No ask requests to cancel (timer parks never
      // created any).
      await settleFailure(runId);
      return 'done';
    }


    if (outcome.result?.parked) {
      if (isUntil && (await untilReArmed(runId, leaf.address, now))) {
        // The `until` condition was still unmet: it re-parked at this same
        // address with a FRESH future `wake_at`. Leave that row ALONE — it's the
        // next tick's park; deleting it would silently kill the recurring wait.
        continue;
      }
      // Re-parked deeper (a met `until`'s continuation hit a later await/sleep, a
      // slept branch parked again, or the run's cost limit). The new park rows
      // were written by the resumed interpreter; drop THIS leaf's superseded
      // timer row. Only while it is still the claimed row: an `until` woken while
      // its run was paused at a limit suspended AT this same address, rewriting
      // the row as `parked`, and it is now the run's to resume. No join decrement (the branch did not
      // complete). The run stays parked.
      await finishResumedLeaf(runId, leaf.address);
      continue;
    }

    // The branch completed — `settleBranchComplete` already decremented the join.
    await finishResumedLeaf(runId, leaf.address);
  }

  // Fully settled (no pending join, no parked leaf left) ⇒ sweep residual live
  // state. The last completer's firing finalised `success`. A not-yet-due timer
  // leaf still counts as parked here, so the sweep correctly holds off.
  if (!(await runHasPendingJoins(runId))) {
    const remaining = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .where('status', '=', 'parked')
      .select('id')
      .executeTakeFirst();
    if (remaining === undefined) {
      await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
      await clearJoins(runId);
    }
  }
  return 'done';
}

/**
 * The branch-complete settle (§6.3): a pure run-wide quiescence query. The engine
 * already decremented this leaf's enclosing join during the resume unwind
 * (run.ts), so this only asks whether anything is still waiting — no join with
 * `pending > 0`, and no OTHER parked leaf (a not-yet-due timer sibling, or a
 * sibling under a different join). This branch's own row is deleted by the driver
 * AFTER the firing, so exclude it here.
 */
async function settleBranchComplete(
  runId: TriggerRunId,
  leafAddress: string,
): Promise<{ runComplete: boolean }> {
  if (await runHasPendingJoins(runId)) return { runComplete: false };
  const otherParked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '!=', leafAddress)
    .where('status', '=', 'parked')
    .select('id')
    .executeTakeFirst();
  return { runComplete: otherParked === undefined };
}

/**
 * After re-entering an `await until(…)` leaf, did its condition stay UNMET so it
 * re-parked in place? The re-park upserts the same (run_id, address) row with a
 * FRESH `wake_at = now + every` (always in the future relative to this wake's
 * `now`, since the cadence floor is 1m). A future `wake_at` at the same address
 * therefore means "re-armed" — leave it; a past/unchanged one means the until
 * was met and moved on (delete it). One claim per run, so no torn read.
 */
async function untilReArmed(
  runId: TriggerRunId,
  address: string,
  scanNow: Date,
): Promise<boolean> {
  const row = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .where('status', '=', 'parked')
    .where('park_reason', '=', 'timer')
    .where('wake_at', '>', scanNow)
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

async function deleteLeaf(runId: TriggerRunId, address: string): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .deleteFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .execute();
}

async function settleFailure(runId: TriggerRunId): Promise<void> {
  // An ERROR in any branch fails the whole run (P14): drop the timer-parked rows +
  // pending joins (prior writes stand). No ask requests to cancel (timer parks
  // never created any).
  await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
  await clearJoins(runId);
}

