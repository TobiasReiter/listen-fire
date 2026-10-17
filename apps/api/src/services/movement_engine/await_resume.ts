// The await-resume worker (asks-as-adapter §A) — the engine half of the
// awaitable capability, adapter-agnostic. ONE entry point: a `wake_await` row
// names an adapter identity (an ask id, a callback id, `channel:thread_ts`) and
// `resumeAwaitsForCorrelation` drives the parks correlated to it. Every door
// queues that row — an inbound signal, an answered ask, the ask service's
// expiry sweep, a fired callback's backstop — so a wake survives the process
// that raised it. There is no engine-side poll.
//
// The drain is the run-host core's (`wakeAwaits` / `drainAwaits`): each run
// is stepped under its lease, every resolvable leaf of it in one batch, each
// RE-ENTERING at its await (the await re-checks the edge live and binds its
// own landing) rather than being handed an answer; a race whose branches
// completed in the batch settles once, with every winner. This module supplies
// the hosted pieces: the per-run single-flight slot, the step (resume_step.ts)
// and the work handler.

import { drainAwaits, wakeAwaits, type StepperFor } from 'movement-engine/services/run_host/drain';
import { logger } from 'movement-engine/services/logger';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { WorkHandler } from '../work/kinds';

import { registerWorkHandler, WorkDeferred } from '../work/drain';
import { wakeAwaitPayloadSchema } from './await_wake';
import { createSingleFlight } from './single_flight';
import { hostedLeaseOptions, hostedRunHost } from './run_host';
import { triggerRunIdOf } from './run_host_store';
import { parkedRunStep } from './resume_step';

// Single-flight per run (F18/F21): concurrent wakes for the SAME run
// coalesce — one drain runs, gathering ALL of that run's currently-resolvable
// leaves as one batch (which is what makes the multi-winner tie deterministic);
// a wake arriving mid-drain queues exactly one follow-up rather than racing a
// second overlapping drain that would double-settle the same race frame.
/** Exported so the CALLBACK fire path shares the very same slot: a fire's body
 *  segment and an await resume of the same run must never overlap (one movement
 *  instance at a time, F21). A drain enters through `coalesce` — it re-gathers
 *  the run's resolvable leaves every pass, so arrivals mid-flight collapse onto
 *  one follow-up; a fire enters through `exclusive` — its body belongs to ONE
 *  recorded call and must never be replayed. A caller already inside the slot
 *  must use `drainRunAwaits` directly — re-entering the slot for its own key
 *  would await its own promise. */
export const runResumeSlot = createSingleFlight<string>();

export const awaitStepper: StepperFor = ({ runId, lease }) => parkedRunStep({ runId: triggerRunIdOf(runId), lease, log: 'AwaitResume' });

/**
 * The wake: something has happened on an adapter identity (an ask settled, a
 * callback fired, a reply landed on `channel:thread_ts`). Drive each run
 * parked on it through the per-run slot (this process's own wakes of a run
 * collapse onto one pass), then the run's lease (no other process steps it
 * meanwhile). A run held elsewhere is not lost: the wake row retries with
 * backoff, and its re-gather finds whatever is still resolvable then.
 */
export async function resumeAwaitsForCorrelation(input: {
  adapterType: string;
  teamId: TeamId;
  correlationKey: string;
}): Promise<void> {
  const { busy } = await logged(input, () =>
    wakeAwaits(hostedRunHost(), {
      wake: input,
      stepper: awaitStepper,
      around: (runId, body) => runResumeSlot.coalesce(runId, body),
      lease: hostedLeaseOptions(),
    }),
  );
  if (busy.length > 0) throw new WorkDeferred(`run ${busy.join(', ')} is held by another process`);
}

/** A failed drain is logged, then rethrown so the wake row that brought it is
 *  released for a backoff retry rather than completed: with no poll behind it,
 *  a wake that failed on a transient fault and was then deleted would strand
 *  the run. */
async function logged<T>(context: Record<string, unknown>, drain: () => Promise<T>): Promise<T> {
  try {
    return await drain();
  } catch (err) {
    logger.error('[AwaitResume] run resume failed', { ...context, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export const wakeAwaitHandler: WorkHandler = {
  async run(payload) {
    await resumeAwaitsForCorrelation(wakeAwaitPayloadSchema.parse(payload));
  },
};

export function registerAwaitWork(): void {
  registerWorkHandler('wake_await', wakeAwaitHandler);
}
