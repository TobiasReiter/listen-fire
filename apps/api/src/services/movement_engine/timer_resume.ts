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
// row (the run-host core's `armTimerWake`) for that `wake_at`; the drain hands the row to
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
import { drainDueTimers, nextTimerWake } from 'movement-engine/services/run_host/drain';
import { armTimerWake, settleIfCancelRequested, timerWorkKey } from 'movement-engine/services/run_host/rules';
import { neverAsAny } from 'movement-engine/lib/utils/types';

import type { WorkHandler } from '../work/kinds';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { settleStampedParkedRuns, settleUnresumableRun } from '../interaction/run_failure';
import { runningSegment } from '../translation_graph/runs/trigger_run';
import { ORPHAN_AFTER, withRunLease, type HeldRunLease } from './run_lease';
import { registerWorkHandler } from '../work/drain';
import { hostedRunHost } from './run_host';
import { postgresRunHostStore } from './run_host_store';
import { parkedRunStep } from './resume_step';

export { timerWorkKey };

/** Arm the run's timer row for `wakeAt` (one row per run, due at its earliest
 *  leaf). */
function armTimer(input: { runId: string; teamId: string; wakeAt: Date }): Promise<void> {
  return armTimerWake(postgresRunHostStore, { runId: input.runId, teamId: input.teamId, wakeAt: input.wakeAt.toISOString() });
}


// A leaf still due after its run was handled could not be resumed (its trigger
// or pinned version is gone); retry it at the old scan's cadence, not every drain.
const UNRESUMED_RETRY = 30 * SECOND;

// A run held by another process is looked at again this soon.
const BUSY_RETRY = 5 * SECOND;

interface TimerParkedRunRow {
  runId: TriggerRunId;
  teamId: string;
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
    const teamId = run.team_id;
    const stepped = await withRunLease(runId, async (lease) => {
      // A lost lease leaves every row as it is, the timer row included: the
      // run is the new holder's to re-arm.
      if ((await resumeTimerParkedRun({ runId, teamId }, ctx.now, lease)) === 'lease_lost') return;
      await rearmForNextLeaf({ runId, teamId, now: ctx.now });
    });
    // Another process is stepping the run (its first firing, a wake): look
    // again shortly. The leaves stay parked and due.
    if (stepped.kind === 'busy') {
      await armTimer({ runId, teamId, wakeAt: new Date(ctx.now.getTime() + BUSY_RETRY) });
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

async function recheckLiveRunLater(input: { runId: TriggerRunId; now: Date }): Promise<void> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', input.runId)
    .select('team_id')
    .executeTakeFirst();
  if (!run) return;
  await armTimer({
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
async function rearmForNextLeaf(input: { runId: TriggerRunId; teamId: string; now: Date }): Promise<void> {
  const next = await nextTimerWake(hostedRunHost(), { runId: input.runId });
  if (next === null) return;
  const wakeAt = new Date(next);
  const retryAt = new Date(input.now.getTime() + UNRESUMED_RETRY);
  await armTimer({ runId: input.runId, teamId: input.teamId, wakeAt: wakeAt <= input.now ? retryAt : wakeAt });
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
    await armTimer({ runId: run.runId, teamId: run.teamId, wakeAt: new Date(run.wakeAt) });
  }
}

/**
 * Resume one timer-parked run, draining every DUE timer leaf (a fan-out sleep
 * parks N leaves; each steps PAST its own sleep, or an `await until` re-enters
 * to re-check its condition, and runs that branch forward) through the core's
 * timer drain. A not-yet-due sibling leaf is left parked, holding the join
 * until its own wake.
 */
export async function resumeTimerParkedRun(
  run: TimerParkedRunRow,
  now: Date,
  /** The run lease the caller holds: each resumed segment watches it. */
  lease?: HeldRunLease,
): Promise<'done' | 'lease_lost'> {
  const host = hostedRunHost();
  // A cancel stamped while another instance held the run is this holder's to
  // settle, whether or not a leaf is due.
  if (await settleIfCancelRequested(host, { runId: run.runId, ...(lease !== undefined ? { fence: lease.token } : {}) })) return 'done';
  const due = await host.store.parks.leaves({ runId: run.runId, parkedOnly: true, reason: 'timer', dueBy: now.toISOString() });
  if (due.length === 0) return 'done';
  const step = await parkedRunStep({ runId: run.runId, ...(lease !== undefined ? { lease } : {}), log: 'TimerResume' });
  if (step === null) return 'done';
  const drained = await drainDueTimers(host, { runId: run.runId, dueBy: now.toISOString(), ...(lease !== undefined ? { lease } : {}), step });
  return drained === 'leaseLost' ? 'lease_lost' : 'done';
}
