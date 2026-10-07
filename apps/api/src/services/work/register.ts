// Every work kind's handler, and the periodic rows that keep the sweeps
// running — the whole of what the automations drain needs before it claims.

import { SECOND } from '../../constants';
import {
  AIRTABLE_WEBHOOK_SCAN_INTERVAL,
  registerAirtableWebhookRefreshWork,
} from '../airtable_webhook_refresh/worker';
import { EXPOSED_FILE_SWEEP_INTERVAL, registerExposedFileWork } from '../exposed_file/worker';
import { registerAwaitWork } from '../movement_engine/await_resume';
import { registerTimerWork } from '../movement_engine/timer_resume';
import { registerCronWork } from '../movement_scheduler/worker';
import { registerPollWork } from '../poll_source/worker';
import { registerAskExpiryWork } from '../translation_graph/adapters/ask/expiry_sweep';
import { registerRunOrphanSweepWork } from '../translation_graph/runs/trigger_run';
import { registerDispatchWork } from '../translation_graph/triggers/dispatch_event';
import { registerLinkedObjectWork } from '../webhook_sync/linked_object_refresh';
import type { WorkKind } from './kinds';
import { ensurePeriodicWork } from './store';

const PERIODIC_WORK: ReadonlyArray<{ kind: WorkKind; intervalMs: number }> = [
  { kind: 'cron_reconcile', intervalMs: 30 * SECOND },
  { kind: 'poll_reconcile', intervalMs: 30 * SECOND },
  { kind: 'ask_expiry_sweep', intervalMs: 30 * SECOND },
  { kind: 'timer_sweep', intervalMs: 30 * SECOND },
  { kind: 'exposed_file_sweep', intervalMs: EXPOSED_FILE_SWEEP_INTERVAL },
  { kind: 'airtable_webhook_refresh', intervalMs: AIRTABLE_WEBHOOK_SCAN_INTERVAL },
  { kind: 'run_orphan_sweep', intervalMs: 30 * SECOND },
];

/** Upsert every periodic row. Idempotent; the drain loop retries it until it succeeds once. */
async function ensureAutomationsPeriodicWork(): Promise<void> {
  await Promise.all(
    PERIODIC_WORK.map(({ kind, intervalMs }) => ensurePeriodicWork({ kind, key: kind, intervalMs })),
  );
}

/** Register every handler, then make sure each periodic row exists. Handlers
 *  go first, before any await, so this process's first drain pass finds them. */
async function registerAutomationsWork(): Promise<void> {
  registerTimerWork();
  registerCronWork();
  registerPollWork();
  registerDispatchWork();
  registerAwaitWork();
  registerAskExpiryWork();
  registerLinkedObjectWork();
  registerExposedFileWork();
  registerAirtableWebhookRefreshWork();
  registerRunOrphanSweepWork();

  await ensureAutomationsPeriodicWork();
}

export { ensureAutomationsPeriodicWork, registerAutomationsWork };
