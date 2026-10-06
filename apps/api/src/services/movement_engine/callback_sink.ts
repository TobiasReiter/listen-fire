// The callback seam — injected so the pure interpreter never touches the DB
// directly (mirrors `ParkSink` / `resolveAdapter` / `writeSink`). Separate from
// `ParkSink` on purpose: a park is a leaf the run is WAITING on, a callback is
// not one, and the two must not be conflated at the seam any more than they are
// in the tables.

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { CallbackId } from '../../generated/kysely/automations/Callback';
import type { TriggerRunRecorder } from '../translation_graph/runs/trigger_run';
import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb, getQb } from '../../lib/kysely';
import {
  registerAwaitCorrelation,
  type ResolvableAwait,
} from '../translation_graph/adapters/await_correlation';
import {
  callbackUrl,
  mintCallback,
  readCallbackCalls,
} from './callback_store';
import type { CallbackSink } from './host';

/** The adapter-agnostic correlation map's `adapter_type` for a callback await.
 *  A RESERVED engine identity, not a system: the map is keyed on opaque text and
 *  its reaps are adapter-agnostic by construction, so a callback await gets the
 *  run-death / race-loss cleanup for free. */
export const CALLBACK_AWAIT_TYPE = 'callback';

// Re-exported only for the conformance corpora; live code imports it from
// `host.ts`.
export type { CallbackSink };

/**
 * The callback half of the resume worker's POLL — the durable backstop behind
 * the event-driven wake. A fire records its call and then nudges the awaiters;
 * if that nudge is lost (a restart between the claim and the wake), the call is
 * still on the ledger, so the park is still resolvable. Without this a lost
 * nudge would strand the run parked forever, deaf to a tap that DID happen —
 * the absence of a guarantee, not a weaker one.
 *
 * Resolvability is per-adapter and lives outside the generic correlation map,
 * exactly as the ask's does: load this type's rows, then keep the ones whose
 * callback has at least one recorded call.
 */
export async function loadResolvableCallbackAwaits(
  opts: { runId?: TriggerRunId } = {},
): Promise<ResolvableAwait[]> {
  let corr = getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', CALLBACK_AWAIT_TYPE);
  if (opts.runId !== undefined) corr = corr.where('run_id', '=', opts.runId);
  const rows = await corr.select(['run_id', 'team_id', 'address', 'correlation_key']).execute();
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.correlation_key))] as CallbackId[];
  const fired = await getAutomationsQb(['callback'])
    .selectFrom('callback')
    .where('id', 'in', ids)
    .where(({ eb, fn, val }) => eb(fn('jsonb_array_length', ['calls']), '>', val(0)))
    .select('id')
    .execute();
  const firedIds = new Set<string>(fired.map((f) => f.id));

  return rows
    .filter((r) => firedIds.has(r.correlation_key))
    // `adapter_await.team_id` is an opaque tenant uuid (D3 dropped the FK, and
    // with it the brand); naming it as core's team id is the boundary conversion.
    .map((r) => ({ runId: r.run_id, teamId: r.team_id as TeamId, address: r.address }));
}

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
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      });
      return { id: record.id, url: callbackUrl(record.id) };
    },

    calls(callbackId) {
      return readCallbackCalls(callbackId);
    },

    async correlateAwait(input) {
      await registerAwaitCorrelation({
        adapterType: CALLBACK_AWAIT_TYPE,
        correlationKey: input.callbackId,
        runId,
        teamId,
        address: input.address,
      });
    },
  };
}
