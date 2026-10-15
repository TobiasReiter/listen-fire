// The callback seam — injected so the pure interpreter never touches the DB
// directly (mirrors `ParkSink` / `resolveAdapter` / `writeSink`). Separate from
// `ParkSink` on purpose: a park is a leaf the run is WAITING on, a callback is
// not one, and the two must not be conflated at the seam any more than they are
// in the tables.

import { sql } from 'kysely';
import { CALLBACK_AWAIT_TYPE } from 'engine-contracts';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { CallbackId } from '../../generated/kysely/automations/Callback';
import type { TriggerRunRecorder } from '../translation_graph/runs/trigger_run';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { AwaitKeeper, CorrelatedAwait } from 'movement-engine/services/run_host/store';
import type { CallbackSink } from 'movement-engine/services/movement_engine/host';

import { getAutomationsQb } from '../../lib/kysely';
import { triggerRunIdOf } from './run_host_store';
import {
  callbackUrl,
  mintCallback,
  readCallbackCalls,
} from './callback_store';



// Re-exported only for the conformance corpora; live code imports it from
// `host.ts`.
export type { CallbackSink };

/**
 * The callback half of the resume drain's resolvability read: a park on a
 * callback is resolvable once one of its calls has LANDED — its body has
 * started (`LedgerCall`). The body runs under the run's lease and the drain
 * reads this under it too, so a started body is a finished one unless its
 * holder died mid-body; an awaiter never resumes ahead of the body its call
 * fired. A fire wakes its awaiters in-process after the body and also queues
 * a delayed `wake_await` row (`callback_fire.ts`), so a wake lost to a restart
 * still finds the landed call — without that a run would sit parked forever,
 * deaf to a tap that DID happen.
 *
 * Resolvability is per-adapter and lives outside the generic correlation map,
 * exactly as the ask's does: load this type's rows, then keep the ones whose
 * callback has a landed call.
 */
async function loadResolvableCallbackAwaits(opts: { runId: TriggerRunId }): Promise<CorrelatedAwait[]> {
  const rows = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', CALLBACK_AWAIT_TYPE)
    .where('run_id', '=', opts.runId)
    .select(['run_id', 'team_id', 'address', 'correlation_key'])
    .execute();
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.correlation_key))] as CallbackId[];
  const fired = await getAutomationsQb(['callback'])
    .selectFrom('callback')
    .where('id', 'in', ids)
    .where(sql<boolean>`EXISTS (SELECT 1 FROM jsonb_array_elements(calls) AS call WHERE call ? 'bodyStartedAt')`)
    .select('id')
    .execute();
  const firedIds = new Set<string>(fired.map((f) => f.id));

  return rows
    .filter((r) => firedIds.has(r.correlation_key))
    .map((r) => ({ runId: r.run_id, teamId: r.team_id, address: r.address }));
}

/** The callback's awaits as the run host reaches them. A withdrawn callback
 *  await closes nothing of its own: the callback is the run's, revoked when the
 *  run ends (the run host's `closeRun`), and a lost race arm's correlation is
 *  dropped by the core. */
export const callbackAwaitKeeper: AwaitKeeper = {
  adapterType: CALLBACK_AWAIT_TYPE,
  loadResolvable: ({ runId }) => loadResolvableCallbackAwaits({ runId: triggerRunIdOf(runId) }),
  abandon: async () => {},
};

export function makeRecorderCallbackSink(
  recorder: TriggerRunRecorder,
  teamId: TeamId,
): CallbackSink {
  const runId = recorder.triggerRunId;
  return {
    async mint(input) {
      // The run row must exist before the FK-bearing callback row — a movement
      // may mint a callback before it has parked on anything.
      await recorder.ensureStarted();
      const record = await mintCallback({
        teamId,
        runId,
        address: input.address,
        params: input.params,
        state: input.state,
        singleUse: input.singleUse,
        ...(input.expiresAt !== undefined ? { expiresAt: new Date(input.expiresAt) } : {}),
      });
      return { id: record.id, url: callbackUrl(record.id) };
    },

    calls({ callbackId }) {
      return readCallbackCalls(callbackId);
    },

  };
}
