// The await-resume worker (asks-as-adapter §A) — the engine half of the
// awaitable capability, adapter-agnostic. ONE entry point: a `wake_await` row
// names an adapter identity (an ask id, a callback id, `channel:thread_ts`) and
// `resumeAwaitsForCorrelation` drives the parks correlated to it. Every door
// queues that row — an inbound signal, an answered ask, the ask service's
// expiry sweep, a fired callback's backstop — so a wake survives the process
// that raised it. There is no engine-side poll.
//
// Each wake feeds `resumeAwaitRun`, which RE-ENTERS each leaf at its await (the
// await re-checks the edge live via `resolveAwait` and binds its own landing)
// rather than injecting an answer.
//
// F21 (batched resume, one movement instance at a time): the single-flight
// per-run slot orders this process's entries into a run and the run's lease
// (run_lease.ts) orders processes; each of a run's resolvable leaves is
// claimed and stepped forward in turn, so a multi-winner tie (F18) settles in
// one batch. A crash mid-drain leaves the `adapter_await` rows, the claimed
// leaf (`resuming`, parked again once the lease lapses) and the leased wake
// row, which is re-claimed (idempotent — a resolved leaf has no parked_run left).

import { getQb, getAutomationsQb } from '../../lib/kysely';
import { loadPinnedVersion } from '../translation_graph/movement/version_store';
import { logger } from 'movement-engine/services/logger';
import type { WorkHandler } from '../work/kinds';
import { registerWorkHandler, WorkDeferred } from '../work/drain';
import { wakeAwaitPayloadSchema } from './await_wake';
import { settleCancelledRun } from '../interaction/run_failure';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import { runHasPendingJoins } from './join_pending';
import { dropRunLeaves } from './lease_fence';
import { awaitKeepers } from '../translation_graph/adapters/packages';
import { loadResolvableCallbackAwaits } from './callback_sink';
import {
  dropAwaitCorrelation,
  dropAwaitCorrelationsForRun,
  loadCorrelatedParks,
  type ResolvableAwait,
} from '../translation_graph/adapters/await_correlation';
import type { TeamId } from '../../generated/kysely/core/Team';
import { createSingleFlight } from './single_flight';
import { claimParkedLeaf, finishResumedLeaf, withRunLease, type HeldRunLease } from './run_lease';
import { resumeMovementFiring } from '../translation_graph/movement/execute';
import { loadTriggerById } from '../translation_graph/storage/tg_table';
import { triggerEventSchema, type TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TriggerRunTriggerType } from '../translation_graph/runs/trigger_run';

// Single-flight per run (F18/F21): concurrent wakes for the SAME run
// coalesce — one drain runs, gathering ALL of that run's currently-resolvable
// leaves as one batch (which is what makes the multi-winner tie deterministic);
// a wake arriving mid-drain queues exactly one follow-up rather than racing a
// second overlapping drain that would double-settle the same race frame.
/** Exported so the CALLBACK fire path shares the very same slot: a fire's body
 *  segment and an await resume of the same run must never overlap (one movement
 *  instance at a time, F21). A drain enters through `coalesce` — it re-gathers
 *  the run's resolvable leaves every pass, so arrivals mid-flight collapse onto
 *  one follow-up; a fire enters through `exclusive` — its body belongs to ONE
 *  recorded call and must never be replayed. A caller already inside the slot
 *  must use `drainRunAwaits` directly — re-entering the slot for its own key
 *  would await its own promise. */
export const runResumeSlot = createSingleFlight<string>();

/**
 * The wake: something has happened on an adapter identity (an ask settled, a
 * callback fired, a reply landed on `channel:thread_ts`). Look up the parks
 * awaiting that identity and drive each of their runs through the per-run
 * single-flight slot — so an ask leaf and a Slack leaf resolving in the same
 * window still batch under one drain (F18/F21). The passed-in leaves are folded
 * into the run's batch; `resolveAwait` re-checks each live at re-entry.
 */
export async function resumeAwaitsForCorrelation(input: {
  adapterType: string;
  teamId: TeamId;
  correlationKey: string;
}): Promise<void> {
  const parks = await loadCorrelatedParks(input);
  if (parks.length === 0) return;
  const byRun = new Map<TriggerRunId, ResolvableAwait[]>();
  for (const park of parks) {
    const list = byRun.get(park.runId) ?? [];
    list.push(park);
    byRun.set(park.runId, list);
  }
  // The in-process slot first (this process's own wakes of the run collapse
  // onto one pass), then the run's lease (no other process steps it meanwhile).
  // A run held elsewhere is not lost: the wake row retries with backoff, and
  // its re-gather finds whatever is still resolvable then.
  const busy: TriggerRunId[] = [];
  const outcomes = await Promise.allSettled(
    [...byRun.entries()].map(([runId, extra]) =>
      runResumeSlot.coalesce(runId, async () => {
        const drained = await withRunLease(runId, (lease) => drainRunAwaits(runId, extra, lease));
        if (drained.kind === 'busy') busy.push(runId);
      }),
    ),
  );
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  if (busy.length > 0) throw new WorkDeferred(`run ${busy.join(', ')} is held by another process`);
}

/** The per-run drain body, run under the run's lease: gather ALL of the
 *  run's currently-resolvable leaves fresh (one batch) and step them forward.
 *  Ask + callback leaves come from their own resolvability reads; `extraLeaves`
 *  are the event-driven ones the caller already knows are resolvable (Slack, and
 *  a just-fired callback). Deduped by address so a leaf resolvable via both
 *  paths is stepped once. */
export async function drainRunAwaits(
  runId: TriggerRunId,
  extraLeaves: ResolvableAwait[] = [],
  /** The run lease the caller holds: each resumed segment watches it. */
  lease?: HeldRunLease,
): Promise<void> {
  try {
    const keptLeaves: ResolvableAwait[] = [];
    for (const keeper of awaitKeepers()) keptLeaves.push(...(await keeper.loadResolvable({ runId })));
    const callbackLeaves = await loadResolvableCallbackAwaits({ runId });
    const byAddress = new Map<string, ResolvableAwait>();
    for (const leaf of [...keptLeaves, ...callbackLeaves, ...extraLeaves]) {
      byAddress.set(leaf.address, leaf);
    }
    const leaves = [...byAddress.values()];
    if (leaves.length === 0) return;
    await resumeAwaitRun(runId, leaves, lease);
  } catch (err) {
    logger.error('[AwaitResume] run resume failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Rethrown so the wake row that brought us here is released for a backoff
    // retry rather than completed: with no poll behind it, a wake that fails on
    // a transient fault and is then deleted would strand the run.
    throw err;
  }
}

/** Resume one run, draining every resolvable await leaf. The run's pinned
 *  version + inbound event load once; each leaf RE-ENTERS at its await (the
 *  await re-checks the now-settled edge live and binds its landing). */
async function resumeAwaitRun(
  runId: TriggerRunId,
  leaves: ResolvableAwait[],
  lease: HeldRunLease | undefined,
): Promise<void> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select([
      'trigger_id',
      'trigger_type',
      'trigger_payload',
      'movement_version_id',
      'cancel_requested_at',
    ])
    .executeTakeFirst();
  if (!run || !run.trigger_payload) {
    logger.error('[AwaitResume] trigger_run missing or has no payload', { runId });
    return;
  }

  if (run.cancel_requested_at != null) {
    // Cancel-vs-resume race: an operator stamped this run. Settle it as a
    // cancellation and drop its correlations (F7) instead of driving it forward.
    try {
      await settleCancelledRun(runId);
      await dropAwaitCorrelationsForRun(runId);
    } catch (err) {
      logger.error('[AwaitResume] settle-cancelled failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const trigger = await loadTriggerById(run.trigger_id);
  if (!trigger || !trigger.movementId) {
    logger.error('[AwaitResume] trigger gone or not movement-derived', { runId });
    return;
  }
  const pinned = run.movement_version_id
    ? await loadPinnedVersion(run.movement_version_id)
    : null;
  if (!pinned) {
    logger.error('[AwaitResume] no pinned movement_version source — cannot resume (P11)', { runId });
    return;
  }
  const event = triggerEventSchema.parse(run.trigger_payload) as TriggerEvent;

  // The BATCH (F18/F21): every resolvable leaf runs its branch to completion-or-
  // re-park BEFORE any race settles. A race branch that completes DEFERS its
  // frame (`deferRaceSettlement`) instead of settling inline — so multiple
  // branches resolving in this batch are ALL winners. Post-batch we settle each
  // deferred frame once, with every winner's export on the receipt.
  const deferredFrames = new Map<string, ParkedScopeState>();

  for (const leaf of leaves) {
    // A lease lost since the last leaf: the run may be another instance's now.
    if (lease?.isLost()) return;
    // Claimed before it is stepped: a leaf another entry already took (or a
    // race cancelled) is not parked any more.
    const parked = await claimParkedLeaf({ runId, address: leaf.address });
    if (!parked || !parked.state) {
      // Not ours to judge once the lease is lost: the new holder may have
      // claimed the leaf itself.
      if (lease?.isLost()) return;
      // Already drained in a prior pass (or cancelled as a race loser) — clear
      // its correlation so later wakes do not re-drive it.
      await dropAwaitCorrelation({ runId, address: leaf.address });
      continue;
    }
    const state = parked.state as ParkedScopeState;

    const outcome = await resumeMovementFiring({
      teamId: leaf.teamId,
      triggerId: run.trigger_id,
      triggerName: trigger.name,
      ...(trigger.firedMovementName !== null ? { firedMovementName: trigger.firedMovementName } : {}),
      pinnedSource: pinned.source,
      pinnedLanguageVersion: pinned.languageVersion,
      movementVersionId: run.movement_version_id,
      runId,
      movementId: trigger.movementId,
      event,
      recordingTriggerType: run.trigger_type as TriggerRunTriggerType,
      state,
      // RE-ENTER at the await: the await re-evaluates the (now-settled) edge live
      // and binds its own landing (no injected answer).
      reenter: true,
      // Batch mode: a completing race branch is recorded, not settled inline.
      deferRaceSettlement: true,
      settleBranchComplete: () => settleBranchComplete(runId, leaf.address),
      ...(lease !== undefined ? { lease } : {}),
    });

    // The lease was lost mid-step: the run may be another instance's now, so
    // this one leaves every row as it is.
    if (outcome.leaseLost) return;
    if (outcome.error) {
      // An engine ERROR fails the whole run (P14): drop every correlation +
      // parked/join row; prior writes stand.
      await settleFailure(runId, lease);
      return;
    }


    // A race branch that completed DEFERRED its frame — remember it (+ this
    // completed leaf's state, whose scope chain the settlement re-enters through).
    for (const frame of outcome.result?.deferredRaceFrames ?? []) {
      if (!deferredFrames.has(frame)) deferredFrames.set(frame, state);
    }

    if (outcome.result?.parked) {
      // Two re-park shapes land here, told apart by WHERE the interpreter parked:
      //   • DEEPER/ELSEWHERE (parkedAddress ≠ leaf.address): this leaf's await
      //     RESOLVED and the resumed body parked at a further await/sleep. The new
      //     park's rows were written by the resumed interpreter — drop THIS leaf's
      //     now-stale correlation + parked row.
      //   • SAME address (parkedAddress == leaf.address): the await RE-ARMED
      //     without resolving — a WHERE-narrowed await whose live landings still
      //     don't match (B.1), or a still-pending edge. `commitAwaitPark` just
      //     re-registered the correlation and re-upserted the parked_run at THIS
      //     address; deleting them would strand the run parked forever, deaf to
      //     the later matching candidate. Leave everything intact (the re-park
      //     wrote the row back as `parked`).
      if (outcome.result.parkedAddress !== leaf.address) {
        await resolveAwaitLeaf(runId, leaf.address, lease);
      }
      continue;
    }

    // The branch completed — resolve this leaf (drop correlation + parked row).
    await resolveAwaitLeaf(runId, leaf.address, lease);
  }

  // Post-batch: settle each race whose branches completed this batch, ONCE, with
  // every winner on the receipt (F18/F21). Cancels the still-parked losers. All
  // leaves of a run share its team.
  const teamId = leaves[0]?.teamId;
  if (teamId !== undefined) {
    for (const [frameAddress, state] of deferredFrames) {
      const outcome = await resumeMovementFiring({
        teamId,
        triggerId: run.trigger_id,
        triggerName: trigger.name,
        ...(trigger.firedMovementName !== null
          ? { firedMovementName: trigger.firedMovementName }
          : {}),
        pinnedSource: pinned.source,
        pinnedLanguageVersion: pinned.languageVersion,
        movementVersionId: run.movement_version_id,
        runId,
        movementId: trigger.movementId,
        event,
        recordingTriggerType: run.trigger_type as TriggerRunTriggerType,
        state,
        settleRaceFrameAddress: frameAddress,
        settleBranchComplete: () => settleBranchComplete(runId, frameAddress),
        ...(lease !== undefined ? { lease } : {}),
      });
      if (outcome.leaseLost) return;
      if (outcome.error) {
        await settleFailure(runId, lease);
        return;
      }
    }
  }

  // Sweep residual live state once the run is fully quiescent (last completer
  // finalised `success`).
  if (!(await runHasPendingJoins(runId))) {
    const remaining = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .where('status', '=', 'parked')
      .select('id')
      .executeTakeFirst();
    // Under the lease that stepped the run: a holder that lost it leaves the
    // new holder's rows alone.
    if (remaining === undefined) await dropRunLeaves(runId, lease);
  }
}

/** Branch-complete quiescence check (mirrors interaction/resume). This leaf's
 *  parked row is deleted by the driver AFTER the firing, so exclude it here. */
async function settleBranchComplete(
  runId: TriggerRunId,
  leafAddress: string,
): Promise<{ runComplete: boolean }> {
  if (await runHasPendingJoins(runId)) return { runComplete: false };
  const otherParked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '!=', leafAddress)
    .where('status', '=', 'parked')
    .select('id')
    .executeTakeFirst();
  return { runComplete: otherParked === undefined };
}

/** Drop one resolved await leaf: its correlation entry + its claimed row.
 *  An await woken while its run was paused at a limit suspended at this same
 *  address instead of re-checking: that row was written back as `parked`, and
 *  is the run's to resume (limit_pause.ts). */
async function resolveAwaitLeaf(runId: TriggerRunId, address: string, lease: HeldRunLease | undefined): Promise<void> {
  await dropAwaitCorrelation({ runId, address });
  await finishResumedLeaf(runId, address, lease);
}

async function settleFailure(runId: TriggerRunId, lease: HeldRunLease | undefined): Promise<void> {
  // An ERROR in any branch fails the whole run (P14). Every parked row and
  // join goes, then any ask the run was still awaiting is closed with it — the
  // run is over, so its link must stop offering a live form — and every
  // remaining correlation. The fenced drop goes first and gates the rest: a
  // holder whose lease lapsed tears down nothing of the new holder's.
  if (lease?.isLost()) return;
  if (!(await dropRunLeaves(runId, lease))) return;
  for (const keeper of awaitKeepers()) await keeper.abandon({ runId });
  await dropAwaitCorrelationsForRun(runId);
}

export const wakeAwaitHandler: WorkHandler = {
  async run(payload) {
    await resumeAwaitsForCorrelation(wakeAwaitPayloadSchema.parse(payload));
  },
};

export function registerAwaitWork(): void {
  registerWorkHandler('wake_await', wakeAwaitHandler);
}
