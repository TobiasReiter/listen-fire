// The hosted product as a run host: the core's rules (movement-engine
// run_host/) over the Postgres backend, the keepers of record-backed awaits,
// and the product's own run records (the run's status row, its callbacks).
// Every hosted entry into a parked run goes through the core with this host.

import { logger } from 'movement-engine/services/logger';
import { sql } from 'kysely';

import type { LeaseOptions } from 'movement-engine/services/run_host/lease';
import type { RunHost, RunRecords } from 'movement-engine/services/run_host/rules';

import { getAutomationsQb } from '../../lib/kysely';
import { awaitKeepers } from '../translation_graph/adapters/packages';
import { callbackAwaitKeeper } from './callback_sink';
import { revokeRunCallbacks } from './callback_store';
import { settleRunEngineRecord } from './run_engine_record';
import { postgresRunHostStore, triggerRunIdOf } from './run_host_store';

/** What the hosted product keeps about a run beyond its live state. */
const hostedRunRecords: RunRecords = {
  async cancelRequest({ runId }) {
    const row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', triggerRunIdOf(runId))
      .select(['cancel_requested_at', 'cancel_reason'])
      .executeTakeFirst();
    return row?.cancel_requested_at != null ? { reason: row.cancel_reason } : null;
  },

  async markFailed({ runId, message }) {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ status: 'failed', failed_at: sql`now()`, failure_reason: message })
      .where('id', '=', triggerRunIdOf(runId))
      .where('status', 'in', ['running', 'parked'])
      .execute();
  },

  // A callback IS the run's own capability (unlike an ask, whose record
  // outlives the run): a run that ends revokes its outstanding callbacks, so
  // a late tap gets the closed-request answer.
  async closeRun({ runId }) {
    await revokeRunCallbacks(triggerRunIdOf(runId));
  },
};

/** The hosted run host. Built at call time: the keepers come from the adapter
 *  registry, which must never be captured half-loaded in an import cycle. */
export function hostedRunHost(): RunHost {
  return {
    store: postgresRunHostStore,
    keepers: [...awaitKeepers(), callbackAwaitKeeper],
    runs: hostedRunRecords,
    log: logger,
  };
}

/** How the hosted product holds a run's lease. */
export function hostedLeaseOptions(opts: { ttlMs?: number } = {}): LeaseOptions {
  return {
    ...opts,
    // The segment's engine decision is written fire-and-forget; it must land
    // before the lease frees, or a queued resume could read no engine.
    beforeRelease: (runId) => settleRunEngineRecord(triggerRunIdOf(runId)),
    warn: (message, fields) => logger.warn(message, fields),
  };
}
