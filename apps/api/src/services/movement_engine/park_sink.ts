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
import type { CoreParkReason } from 'engine-contracts';
import { getAutomationsQb, getQb } from '../../lib/kysely';
import { logger } from 'movement-engine/services/logger';
import { settleCancelledRun } from '../interaction/run_failure';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { TriggerRunRecorder } from '../translation_graph/runs/trigger_run';
import type { ParkSink, RunLimitPause } from 'movement-engine/services/movement_engine/run';
import { markRunLimitPaused } from './limit_pause';
import {
  collectBranchExports,
  decrementJoinClose,
  persistBranchExport,
} from './join_pending';
import { isAncestorOrSelf, parseAddress } from 'movement-engine/services/movement_engine/address';
import {
  dropAwaitCorrelation,
  registerAwaitCorrelation,
} from '../translation_graph/adapters/await_correlation';
import { awaitKeepers } from '../translation_graph/adapters/packages';
import { armTimerWake } from './timer_wake';
import { RunLeaseLost } from './run_lease';

/**
 * Build the firing's park sink, backed by its `TriggerRunRecorder` (the run
 * identity + version pin live there). Each commit* method ensures the run row
 * exists before any FK-bearing park row is written.
 *
 * Given the run lease the segment holds, every park it commits lands only
 * while the run's lease is still that one (`lease_token`): a holder whose
 * lease lapsed mid-statement is refused (`RunLeaseLost`) rather than
 * overwriting the parks of the instance that took the run over.
 */
export function makeRecorderParkSink(recorder: TriggerRunRecorder, opts: { lease?: { token: string } } = {}): ParkSink {
  const runId = recorder.triggerRunId;
  const fence = opts.lease?.token;
  const park = (leaf: Omit<ParkedLeaf, 'runId' | 'fence'>) =>
    upsertParkedLeaf({ ...leaf, runId, ...(fence !== undefined ? { fence } : {}) });
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
      await park({ address: input.address, reason: 'timer', wakeAt, state: input.state });
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
      await park({ address: input.address, reason: 'await', wakeAt: null, state: input.state });
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
      // The fenced park first: a holder whose lease lapsed is refused here,
      // before it drops anything. Then an await that took the pause before
      // re-checking drops its correlation: resuming the run re-enters the
      // await, which re-checks live and re-registers if it is still waiting.
      // Left in place, every poll would wake it into the pause again.
      await park({ address: input.address, reason: 'limit', wakeAt: null, state: input.state, rewritten: true });
      await dropAwaitCorrelation({ runId, address: input.address });
      await recorder.markParked();
      await settleIfCancelledDuringPark(runId);
    },

    async recordJoin(input: { frameAddress: string; parkedChildren: number }): Promise<void> {
      // The JOIN frame's pending-count (§5.4) — UPSERT so a re-run that
      // re-reaches the same frame OVERWRITES to the same deterministic count (the
      // frontier is stable under P11), never double-counting. The atomic
      // decrement on resume (join_pending.ts) drives completion.
      const recorded = await getAutomationsQb(['join_pending', 'trigger_run'])
        .insertInto('join_pending')
        .columns(['run_id', 'frame_address', 'pending'])
        .expression((eb) => {
          let row = eb
            .selectFrom('trigger_run')
            .select([
              'trigger_run.id as run_id',
              sql<string>`${input.frameAddress}::text`.as('frame_address'),
              sql<number>`${input.parkedChildren}::integer`.as('pending'),
            ])
            .where('trigger_run.id', '=', runId);
          if (fence !== undefined) row = row.where('trigger_run.lease_token', '=', fence);
          return row;
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'frame_address']).doUpdateSet({
            pending: input.parkedChildren,
            updated_at: new Date(),
          }),
        )
        .returning('run_id')
        .executeTakeFirst();
      if (recorded === undefined) throw notWritten(runId, fence);
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
 * match `s1.b10`). Each cancelled leaf's correlation is dropped, and a record a
 * cancelled leaf was awaiting is CLOSED with it by the adapter that keeps it
 * (an `AwaitKeeper`'s `abandon`) — the arm lost, so nothing is left to consume
 * an answer and the record must stop offering one. The `parked_run` row and
 * any `join_pending` frame inside the subtree go with it (S19). Idempotent.
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

  // The loser parks awaiting a record-backed await (an ask) are withdrawn
  // record-and-all by the adapter that keeps them: correlation dropped AND the
  // record closed, so nothing offers an answer to a workflow that is over.
  for (const keeper of awaitKeepers()) await keeper.abandon({ runId, addresses: doomed });

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

interface ParkedLeaf {
  runId: TriggerRunId;
  address: string;
  /** The core's sink writes only the core's reasons; a unit's park is the
   *  unit's to write. */
  reason: CoreParkReason;
  wakeAt: Date | null;
  state: unknown;
  /** Stamp `updated_at` on a rewrite: how the limit resume tells a flow that
   *  suspended again at once from the one it stepped. */
  rewritten?: true;
  /** The run lease token the write must still hold. */
  fence?: string;
}

/** UPSERT on (run_id, address): a re-reached park rewrites its own row, as
 *  `parked` again (a leaf re-parked by its own resume is parked, not the
 *  claimed row its driver deletes once the step is over). Fenced by the
 *  lease when given one: written only while the run's lease is still that
 *  token's, refused otherwise. */
async function upsertParkedLeaf(leaf: ParkedLeaf): Promise<void> {
  const { runId, fence } = leaf;
  const written = await getAutomationsQb(['parked_run', 'trigger_run'])
    .insertInto('parked_run')
    .columns(['run_id', 'address', 'status', 'park_reason', 'wake_at', 'state'])
    .expression((eb) => {
      let row = eb
        .selectFrom('trigger_run')
        .select([
          'trigger_run.id as run_id',
          sql<string>`${leaf.address}::text`.as('address'),
          sql<string>`'parked'`.as('status'),
          sql<string>`${leaf.reason}::text`.as('park_reason'),
          sql<Date | null>`${leaf.wakeAt}::timestamptz`.as('wake_at'),
          sql<unknown>`${JSON.stringify(leaf.state)}::jsonb`.as('state'),
        ])
        .where('trigger_run.id', '=', runId);
      if (fence !== undefined) row = row.where('trigger_run.lease_token', '=', fence);
      return row;
    })
    .onConflict((oc) =>
      oc.columns(['run_id', 'address']).doUpdateSet({
        state: jsonb(leaf.state),
        status: 'parked',
        park_reason: leaf.reason,
        wake_at: leaf.wakeAt,
        ...(leaf.rewritten ? { updated_at: sql<Date>`now()` } : {}),
      }),
    )
    .returning('id')
    .executeTakeFirst();
  if (written === undefined) throw notWritten(runId, fence);
}

/** Why a fenced write wrote nothing: the lease is another's now, or (with no
 *  lease to fence by) the run has no row to write against. */
function notWritten(runId: TriggerRunId, fence: string | undefined): Error {
  return fence !== undefined ? new RunLeaseLost(runId) : new Error(`run ${runId} has no trigger_run row to park on`);
}
