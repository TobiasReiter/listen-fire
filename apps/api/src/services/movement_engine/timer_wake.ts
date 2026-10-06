// The work row that wakes a run's timer parks. Its own module because the park
// sink arms it and timer_resume (which imports the engine, which imports the
// park sink) consumes it; importing timer_resume from the sink would cycle.

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import { enqueueWork } from '../work/store';

/** One row per run, shared by every timer leaf the run parks. */
export function timerWorkKey(runId: string): string {
  return `resume_timer:${runId}`;
}

export async function armTimerWake(input: {
  runId: TriggerRunId;
  teamId: string;
  wakeAt: Date;
}): Promise<void> {
  await enqueueWork({
    kind: 'resume_timer',
    key: timerWorkKey(input.runId),
    teamId: input.teamId,
    payload: { runId: input.runId },
    dueAt: input.wakeAt,
  });
}
