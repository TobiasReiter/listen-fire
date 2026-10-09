// Which engine ran a run, kept on the run's row. The engine only reports a
// decision (rust_stats.ts `recordRunEngine`); this host side writes it, so the
// engine still writes no row. A run has one row, and a run that parks and
// resumes has several segments: the row says what the latest one ran on.
//
// Fire and forget: a failed write is logged and costs the run nothing. Writes
// are chained so one run's two decisions (a resume right after a firing) land
// in the order they were made.

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from '../logger';
import { setRunEngineRecorder, type RunEngineRecord } from './rust_stats';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTriggerRunId(value: string): value is TriggerRunId {
  return UUID.test(value);
}

let pending: Promise<void> = Promise.resolve();

async function writeRunEngine({ runId, engine, reason }: RunEngineRecord): Promise<void> {
  if (!isTriggerRunId(runId)) return;
  try {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ engine, engine_reason: reason })
      .where('id', '=', runId)
      .execute();
  } catch (error) {
    logger.warn(`movement engine: could not record the engine on run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Makes the engine's decisions land on the run rows. */
export function recordRunEnginesOnRows(): void {
  setRunEngineRecorder((record) => {
    pending = pending.then(() => writeRunEngine(record));
  });
}

/** Resolves once every decision recorded so far is written. */
export function settleRunEngineRecords(): Promise<void> {
  return pending;
}
