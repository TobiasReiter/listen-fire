// Resuming a run paused at a limit (limit_pause.ts holds the pause itself):
// lift the pause, reset the run's usage, and resume every limit-suspended flow
// together through the run-host core's drain.

import { MovementEngineError } from 'movement-engine/services/movement_engine/errors';
import { drainRun } from 'movement-engine/services/run_host/drain';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { HeldRunLease } from './run_lease';

import { getAutomationsQb } from '../../lib/kysely';
import { runSpentMicrodollars } from '../translation_graph/runs/trigger_run';
import { readLimitPause } from './limit_pause';
import { hostedRunHost } from './run_host';
import { parkedRunStep } from './resume_step';

/**
 * Resume a run paused at a limit: lift the pause, reset its usage, and resume
 * every limit-suspended flow, each re-entering the statement it stopped before
 * (the calls that statement had finished are replayed, not made again).
 * Returns how many flows were resumed. Throws when the run is not paused at a
 * limit. The caller owns the run (team-scoped) and serialises it against the
 * run's other resumes.
 */
export async function resumeLimitPausedRun(
  runId: TriggerRunId,
  /** The run lease the caller holds: each resumed segment watches it. */
  lease?: HeldRunLease,
): Promise<{ resumed: number }> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['status', 'diagnostics', 'limit_pause', 'cancel_requested_at'])
    .executeTakeFirst();
  if (run === undefined) throw new MovementEngineError('MOVENG_RUNTIME', `run ${runId} not found`);

  const leaves = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('park_reason', '=', 'limit')
    .where('status', '=', 'parked')
    .select('address')
    .orderBy('created_at', 'asc')
    .execute();
  if (run.status !== 'parked' || run.cancel_requested_at !== null || (leaves.length === 0 && readLimitPause(run.limit_pause) === null)) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `run ${runId} is not paused at a limit (it is ${run.status}) — only a run paused at its cost limit can be resumed`,
    );
  }

  // The run's context loads once, and its absence refuses the resume before
  // the pause is lifted.
  const step = await parkedRunStep({ runId, ...(lease !== undefined ? { lease } : {}), log: 'LimitPause' });
  if (step === null) {
    throw new MovementEngineError('MOVENG_RUNTIME', `run ${runId}'s automation or pinned version is gone — it cannot be resumed`);
  }

  // Lift the pause and reset the usage BEFORE resuming anything, so a flow
  // that meets the cap again pauses the run afresh (and is told apart from
  // this pause below).
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({
      limit_pause: null,
      cost_cap_baseline_microdollars: String(runSpentMicrodollars(run.diagnostics)),
    })
    .where('id', '=', runId)
    .execute();

  // Every suspended flow, in the order they suspended, through the core's
  // drain: each re-enters the statement it stopped before (the calls that
  // statement had finished replay from its journal). A flow that meets the cap
  // again pauses the run again, and the flows not yet reached stay paused
  // with it.
  let resumed = 0;
  await drainRun(hostedRunHost(), {
    runId,
    leaves: { addresses: leaves.map((leaf) => leaf.address), reason: 'limit' },
    ...(lease !== undefined ? { lease } : {}),
    step: (request, settle) => {
      if (request.kind === 'leaf') resumed += 1;
      return step(request, settle);
    },
    until: () => runIsLimitPaused(runId),
  });
  return { resumed };
}

async function runIsLimitPaused(runId: TriggerRunId): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select('limit_pause')
    .executeTakeFirst();
  return readLimitPause(row?.limit_pause) !== null;
}
