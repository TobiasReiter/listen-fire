// The durable-park sink — the production implementation of the engine's
// `ParkSink` seam (run.ts). When a movement reaches a timer / await
// park, or the engine suspends a flow at a limit, the interpreter hands this
// the leaf's address + serialized scope; the sink ensures the run row exists as
// `running` (lazy — via the firing's TriggerRunRecorder), records the
// `parked_run` leaf, and flips the run to `parked`. An await park also writes
// the correlation from the adapter's key to the park; the engine re-checks it
// once afterwards and asks the host's `park.wake` if it already resolved.
//
// This keeps every DB concern OUT of the pure interpreter (which takes the sink
// as an injected dependency, exactly like `resolveAdapter`/`writeSink`).

import { sql } from 'kysely';
import { getAutomationsQb, getQb } from '../../lib/kysely';
import { logger } from '../logger';
import { settleCancelledRun } from '../interaction/run_failure';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { TriggerRunRecorder } from '../translation_graph/runs/trigger_run';
import type { ParkSink, RunLimitPause } from './run';
import { markRunLimitPaused } from './limit_pause';
import {
  collectBranchExports,
  decrementJoinClose,
  persistBranchExport,
} from './join_pending';
import { isAncestorOrSelf, parseAddress } from './address';
import {
  dropAwaitCorrelation,
  registerAwaitCorrelation,
} from '../translation_graph/adapters/await_correlation';
import { abandonAskAwaits } from '../translation_graph/adapters/ask/await_store';
import { armTimerWake } from './timer_wake';

/**
 * Build the firing's park sink, backed by its `TriggerRunRecorder` (the run
 * identity + version pin live there). Each commit* method ensures the run row
 * exists before any FK-bearing park row is written.
 */
export function makeRecorderParkSink(recorder: TriggerRunRecorder): ParkSink {
  const runId = recorder.triggerRunId;
  return {
    async commitTimerPark(input: {
      address: string;
      state: unknown;
      wakeAt: string;
    }): Promise<void> {
      const wakeAt = new Date(input.wakeAt);
      // A timer park (`sleep` statement): the run row must exist before its
      // FK-bearing parked_run. Idempotent ensureStarted.
      await recorder.ensureStarted();
      // UPSERT on (run_id, address): a re-reached sleep re-stamps the same row
      // (wake_at recomputes from the replay; crash-recovery only). NO
      // interaction_request, NO token — the wake driver resumes without a human
      // answer.
      await getAutomationsQb(['parked_run'])
        .insertInto('parked_run')
        .values({
          run_id: runId,
          address: input.address,
          status: 'parked',
          park_reason: 'timer',
          wake_at: wakeAt,
          state: jsonb(input.state),
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'address']).doUpdateSet({
            state: jsonb(input.state),
            // A leaf re-parked by its own resume is parked again, not the
            // claimed row its driver deletes once the step is over.
            status: 'parked',
            park_reason: 'timer',
            wake_at: wakeAt,
          }),
        )
        .execute();
      // The parked_run row stays the truth; the work row only says when to look.
      await armTimerWake({ runId, teamId: recorder.teamId, wakeAt });
      await recorder.markParked();
      await settleIfCancelledDuringPark(runId);
    },

    async commitAwaitPark(input: {
      address: string;
      state: unknown;
      adapterType: string;
      correlationKey: string;
    }): Promise<void> {
      // An await park (`await x-[:E]->`): the run row must exist before its
      // FK-bearing parked_run AND before the correlation row (which FKs the
      // run). UPSERT on (run_id, address) — a re-reached await (re-enter that
      // stayed pending) re-stamps the same row. NO interaction_request, NO
      // token: a wake on the correlation key drives resume, and resume
      // RE-ENTERS at the await to re-check live.
      //
      // The parked row first: it is the truth, the correlation only an index
      // onto it. A wake that runs between the two writes either finds no
      // correlation (a no-op the engine's re-check covers) or finds both —
      // never a correlation without its park, which it would drop as "already
      // drained" and leave the run deaf.
      await recorder.ensureStarted();
      await getAutomationsQb(['parked_run'])
        .insertInto('parked_run')
        .values({
          run_id: runId,
          address: input.address,
          status: 'parked',
          park_reason: 'await',
          state: jsonb(input.state),
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'address']).doUpdateSet({
            state: jsonb(input.state),
            status: 'parked',
            park_reason: 'await',
          }),
        )
        .execute();
      await registerAwaitCorrelation({
        adapterType: input.adapterType,
        correlationKey: input.correlationKey,
        runId,
        teamId: recorder.teamId,
        address: input.address,
      });
      await recorder.markParked();
      await settleIfCancelledDuringPark(runId);
    },

    async commitLimitPause(pause: RunLimitPause): Promise<void> {
      await recorder.ensureStarted();
      await markRunLimitPaused({ runId, teamId: recorder.teamId, triggerId: recorder.triggerId, pause });
    },

    async commitSuspension(input: { address: string; state: unknown }): Promise<void> {
      // A flow suspended at a limit (`park_reason='limit'`): no correlation, no
      // wake time — only resuming the run resumes it (limit_pause.ts). UPSERT on
      // (run_id, address): a branch that was waiting on something ordinary and
      // took its event while the run was paused re-parks here as a limit leaf,
      // and a suspended flow that meets the limit again at once rewrites its own
      // row (`updated_at` is what tells the resume driver it was rewritten).
      await recorder.ensureStarted();
      // An await that took the pause before re-checking drops its correlation:
      // resuming the run re-enters the await, which re-checks live and
      // re-registers if it is still waiting. Left in place, every poll would
      // wake it into the pause again.
      await dropAwaitCorrelation({ runId, address: input.address });
      await getAutomationsQb(['parked_run'])
        .insertInto('parked_run')
        .values({
          run_id: runId,
          address: input.address,
          status: 'parked',
          park_reason: 'limit',
          wake_at: null,
          state: jsonb(input.state),
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'address']).doUpdateSet({
            state: jsonb(input.state),
            status: 'parked',
            park_reason: 'limit',
            wake_at: null,
            updated_at: sql`now()`,
          }),
        )
        .execute();
      await recorder.markParked();
      await settleIfCancelledDuringPark(runId);
    },

    async recordJoin(input: { frameAddress: string; parkedChildren: number }): Promise<void> {
      // The JOIN frame's pending-count (§5.4) — UPSERT so a re-run that
      // re-reaches the same frame OVERWRITES to the same deterministic count (the
      // frontier is stable under P11), never double-counting. The atomic
      // decrement on resume (join_pending.ts) drives completion.
      await getAutomationsQb(['join_pending'])
        .insertInto('join_pending')
        .values({
          run_id: runId,
          frame_address: input.frameAddress as never,
          pending: input.parkedChildren,
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'frame_address']).doUpdateSet({
            pending: input.parkedChildren,
            updated_at: new Date(),
          }),
        )
        .execute();
    },

    async decrementJoin(input: {
      frameAddress: string;
      branchAddress: string;
      leafAddress: string;
    }): Promise<{ closed: boolean }> {
      return decrementJoinClose({
        runId,
        frameAddress: input.frameAddress,
        branchAddress: input.branchAddress,
        leafAddress: input.leafAddress,
      });
    },

    async persistBranchExport(input: {
      frameAddress: string;
      branchAddress: string;
      branchIndex: number;
      exports: unknown;
    }): Promise<void> {
      await persistBranchExport({
        runId,
        frameAddress: input.frameAddress,
        branchAddress: input.branchAddress,
        branchIndex: input.branchIndex,
        exports: input.exports,
      });
    },

    async collectBranchExports(input: {
      frameAddress: string;
    }): Promise<Array<{ branchAddress: string; branchIndex: number; exports: unknown }>> {
      return collectBranchExports({ runId, frameAddress: input.frameAddress });
    },

    async cancelSubtrees(input: {
      subtreeAddresses: string[];
      excludeLeaf?: string;
    }): Promise<void> {
      await cancelRaceSubtrees(runId, input.subtreeAddresses, input.excludeLeaf);
    },
  };
}

/**
 * Deliver the race cancellation cascade (asks-as-adapter chunk C, P17): every
 * park at-or-below one of the loser subtree prefixes is cleaned. The prefix
 * algebra runs on the PARSED address (not raw string prefix — `s1.b1` must not
 * match `s1.b10`). Each cancelled leaf's correlation is dropped, and an ask a
 * cancelled leaf was awaiting is CLOSED with it (`abandonAskAwaits`) — the arm
 * lost, so nothing is left to consume an answer and the ask's link must stop
 * offering one. The `parked_run` row and any `join_pending` frame inside the
 * subtree go with it (S19). Idempotent.
 */
async function cancelRaceSubtrees(
  runId: TriggerRunId,
  subtreeAddresses: string[],
  /** A leaf to SPARE inside the prefixes — the combinator race winner, whose
   *  own parked row may still exist mid-resume (layer 13 C3). Exclusion is by
   *  address, never by ordering assumptions. */
  excludeLeaf?: string,
): Promise<void> {
  if (subtreeAddresses.length === 0) return;
  const prefixes = subtreeAddresses.map(parseAddress);
  const inSubtree = (address: string): boolean => {
    if (excludeLeaf !== undefined && address === excludeLeaf) return false;
    const parsed = parseAddress(address);
    return prefixes.some((p) => isAncestorOrSelf(p, parsed));
  };

  const parked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('status', '=', 'parked')
    .select('address')
    .execute();
  const doomed = parked.map((r) => r.address).filter(inSubtree);
  if (doomed.length === 0) return;

  // The loser parks awaiting an ask are withdrawn record-and-all: correlation
  // dropped AND the ask closed, so its link renders the already-closed page
  // rather than a live form promising a workflow that is over.
  await abandonAskAwaits({ runId, addresses: doomed });

  // Then the one signal per remaining loser park: drop its correlation,
  // adapter-agnostic — the generic map is keyed on the park, so this reaps a
  // Slack thread correlation the same way (and no-ops on the ask rows already
  // reaped above). A timer park has no correlation (deleting its parked_run row
  // is the whole cancel).
  for (const address of doomed) {
    await dropAwaitCorrelation({ runId, address });
  }
  await getAutomationsQb(['parked_run'])
    .deleteFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', 'in', doomed)
    .execute();

  // Clear join_pending frames inside the cancelled subtrees (no dangling
  // bookkeeping, S19). A frame address at-or-below a loser prefix is dead.
  const joins = await getAutomationsQb(['join_pending'])
    .selectFrom('join_pending')
    .where('run_id', '=', runId)
    .select('frame_address')
    .execute();
  const deadFrames = joins.map((r) => r.frame_address as string).filter(inSubtree);
  if (deadFrames.length > 0) {
    await getAutomationsQb(['join_pending', 'join_branch_export'])
      .transaction()
      .execute(async (trx) => {
        await trx
          .deleteFrom('join_pending')
          .where('run_id', '=', runId)
          .where('frame_address', 'in', deadFrames as never[])
          .execute();
        await trx
          .deleteFrom('join_branch_export')
          .where('run_id', '=', runId)
          .where('frame_address', 'in', deadFrames as never[])
          .execute();
      });
  }
}

/**
 * The cancel-vs-park race closure (runs-cancel task 3): a park write can land
 * in the same window as an operator's `abortRun` stamp on a `running` run —
 * either could win. Reading `cancel_requested_at` at the END of each commit*
 * method — AFTER the park row is written and AFTER `recorder.markParked()` —
 * means that if the stamp is already there, the park
 * we just committed is stale: we convert it straight to a cancelled
 * termination via `settleCancelledRun`, which deletes the parked_run row(s) it
 * just wrote along with everything else. Ordering matters the OTHER way too: a
 * crash between the park-write and this check leaves a genuinely parked run
 * carrying a stamp with nobody having settled it. The periodic sweep
 * (`settleStampedParkedRuns`) closes that gap for every park reason, a timer,
 * an await and a limit alike: it settles every stamped run that still holds a
 * parked leaf, within one sweep interval.
 * Best-effort: never let a settle failure break the park path.
 */
async function settleIfCancelledDuringPark(runId: TriggerRunId): Promise<void> {
  try {
    const row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .select('cancel_requested_at')
      .where('id', '=', runId)
      .executeTakeFirst();
    if (row?.cancel_requested_at != null) {
      await settleCancelledRun(runId);
    }
  } catch (err) {
    logger.error('[ParkSink] cancel-race settle failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}
