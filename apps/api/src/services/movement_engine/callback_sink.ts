// The callback seam — injected so the pure interpreter never touches the DB
// directly (mirrors `ParkSink` / `resolveAdapter` / `writeSink`). Separate from
// `ParkSink` on purpose: a park is a leaf the run is WAITING on, a callback is
// not one, and the two must not be conflated at the seam any more than they are
// in the tables.

import type { TriggerRunRecorder } from '../translation_graph/runs/trigger_run';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { AwaitKeeper } from 'movement-engine/services/run_host/store';
import type { CallbackSink } from 'movement-engine/services/movement_engine/host';

import { callbackAwaitKeeper as coreCallbackAwaitKeeper, callbackSink } from 'movement-engine/public/run-host';
import { postgresRunHostStore } from './run_host_store';
import { callbackUrl, postgresCallbackStore } from './callback_store';

// Re-exported only for the conformance corpora; live code imports it from
// `host.ts`.
export type { CallbackSink };

/**
 * The callback's awaits as the run host reaches them (the core's keeper over
 * the Postgres backend): a park on a callback is resolvable once one of its
 * calls has LANDED — its body has started. The body runs under the run's
 * lease and the drain reads this under it too, so an awaiter never resumes
 * ahead of the body its call fired. A fire wakes its awaiters in-process
 * after the body and also queues a delayed `wake_await` row
 * (`callback_fire.ts`), so a wake lost to a restart still finds the landed
 * call. A withdrawn callback await closes nothing of its own: the callback is
 * the run's, revoked when the run ends (the run host's `closeRun`).
 */
export const callbackAwaitKeeper: AwaitKeeper = coreCallbackAwaitKeeper(postgresRunHostStore, postgresCallbackStore);

export function makeRecorderCallbackSink(
  recorder: TriggerRunRecorder,
  teamId: TeamId,
): CallbackSink {
  return callbackSink(postgresCallbackStore, {
    runId: recorder.triggerRunId,
    teamId,
    url: callbackUrl,
    // The run row must exist before the FK-bearing callback row — a movement
    // may mint a callback before it has parked on anything.
    ensureRun: () => recorder.ensureStarted(),
  });
}
