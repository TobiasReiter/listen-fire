// The core's work: every core kind's handler, and the periodic rows that keep
// the core's sweeps and every registered unit's periodic kinds running. Units
// register their own kinds (`registerWorkKinds`, drain.ts); the deployment
// that runs the drain composes them (startup/automations.ts).

import { SECOND } from '../../constants';
import { registerAwaitWork } from '../movement_engine/await_resume';
import { registerCallbackFireWork } from '../movement_engine/callback_fire';
import { registerTimerWork } from '../movement_engine/timer_resume';
import { registerCronWork } from '../movement_scheduler/worker';
import { registerPollWork } from '../poll_source/worker';
import { registerRunOrphanSweepWork } from '../translation_graph/runs/trigger_run';
import { registerDispatchWork } from '../translation_graph/triggers/dispatch_event';
import { periodicUnitWorkKinds, type CoreWorkKind } from './kinds';
import { ensurePeriodicWork, removeRetiredWork } from './store';

const CORE_PERIODIC_WORK: ReadonlyArray<{ kind: CoreWorkKind; intervalMs: number }> = [
  { kind: 'cron_reconcile', intervalMs: 30 * SECOND },
  { kind: 'poll_reconcile', intervalMs: 30 * SECOND },
  { kind: 'timer_sweep', intervalMs: 30 * SECOND },
  { kind: 'run_orphan_sweep', intervalMs: 30 * SECOND },
];

/** Kinds a past build ran and this one does not. Their periodic rows would
 *  otherwise sit in the table forever, claimed and released for want of a
 *  handler, so they are deleted where the periodic rows are ensured. */
const RETIRED_WORK_KINDS: readonly string[] = ['await_resume_sweep'];

/** Upsert every periodic row — the core's and each registered unit's — and
 *  delete the retired kinds' rows. Idempotent; the drain loop retries it until
 *  it succeeds once. */
async function ensureAutomationsPeriodicWork(): Promise<void> {
  await Promise.all([
    ...[...CORE_PERIODIC_WORK, ...periodicUnitWorkKinds()].map(({ kind, intervalMs }) =>
      ensurePeriodicWork({ kind, key: kind, intervalMs }),
    ),
    removeRetiredWork(RETIRED_WORK_KINDS),
  ]);
}

/** Register every core kind's handler. */
function registerCoreWork(): void {
  registerTimerWork();
  registerCronWork();
  registerPollWork();
  registerDispatchWork();
  registerAwaitWork();
  registerCallbackFireWork();
  registerRunOrphanSweepWork();
}

export { ensureAutomationsPeriodicWork, registerCoreWork };
