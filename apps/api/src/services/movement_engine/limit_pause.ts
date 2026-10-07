// A run PAUSED at a limit — today the per-run cost cap (MOVEMENT_MAX_RUN_COST_USD,
// lib/run_cost.ts). Everything about the pause that touches the database lives
// here: marking the run paused, saying so (the `Run Paused` system event),
// reading the pause back for a run's status, and resuming the run.
//
// The model (Henry's rulings, 2026-10-05):
//
//   · Meeting the cap SUSPENDS the run instead of failing it. The flow that met
//     it parks just before the statement that would have spent; every other
//     flow of the run finishes its current statement and parks before its next
//     (run.ts, `suspendAtLimit`). Each parked flow is a `parked_run` row with
//     `park_reason='limit'`; the run row carries `limit_pause`.
//   · A limit pause pauses the WHOLE run. A branch already waiting on something
//     ordinary (an answer, a reply, a timer) stays waiting; if its event arrives
//     while the run is paused, it takes the event and then suspends before its
//     next statement, joining the paused set (`RunMovementInput.limitPaused`).
//     It never runs past the pause on its own.
//   · Only resuming the run lifts the pause, and it resumes every
//     limit-suspended flow together. Resuming RESETS the run's usage: the cap
//     counts from what the run had spent at that moment
//     (`trigger_run.cost_cap_baseline_microdollars`). An ordinary park never
//     resets anything.
//
// "Together" is one action over every suspended flow, driven one leaf at a time
// as the other resume drivers do (the join substrate decides which leaf closes
// each frame). A flow that meets the cap again while the run is being resumed
// pauses it again; the leaves not yet reached then stay paused with it.

import { sql } from 'kysely';
import { z } from 'zod';

import { getAutomationsQb } from '../../lib/kysely';
import { formatUsd, RUN_COST_CAP_ENV_VAR } from '../../lib/run_cost';
import { logger } from '../logger';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { MovementId } from '../../generated/kysely/automations/Movement';
import type { TeamId } from '../../generated/kysely/core/Team';
import { recordSystemEvent, webBaseUrl } from '../translation_graph/adapters/system/events';
import { RUN_PAUSED } from '../translation_graph/adapters/system/types';
import { loadPinnedVersion } from '../translation_graph/movement/version_store';
import { resumeMovementFiring } from '../translation_graph/movement/execute';
import { loadTriggerById } from '../translation_graph/storage/tg_table';
import { triggerEventSchema, type TriggerEvent } from '../translation_graph/triggers/types';
import { runSpentMicrodollars, type TriggerRunTriggerType } from '../translation_graph/runs/trigger_run';
import { clearJoins, runHasPendingJoins } from './join_pending';
import type { RunLimitPause } from './run';
import type { ParkedScopeState } from './serialize';
import { MovementEngineError } from './errors';
import { claimParkedLeaf, finishResumedLeaf } from './run_lease';

/** What `trigger_run.limit_pause` holds while the run is paused. */
const StoredLimitPauseSchema = z.object({
  limit: z.literal('cost'),
  capMicrodollars: z.number(),
  spentMicrodollars: z.number(),
  pausedAt: z.string(),
});

export type StoredLimitPause = z.infer<typeof StoredLimitPauseSchema>;

/** The run's pause, off its row — null when it is not paused (or the column
 *  holds something this release cannot read, which it then treats as not
 *  paused rather than inventing a limit). */
export function readLimitPause(value: unknown): StoredLimitPause | null {
  if (value === null || value === undefined) return null;
  const parsed = StoredLimitPauseSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn('[LimitPause] unreadable limit_pause on a run row', { value });
    return null;
  }
  return parsed.data;
}

/** The pause in an author's words — the run's status and the event's reason. */
export function describeLimitPause(pause: Pick<StoredLimitPause, 'capMicrodollars' | 'spentMicrodollars'>): string {
  return (
    `Paused: cost limit reached. This run has spent ${formatUsd(pause.spentMicrodollars)} on model calls and paid services ` +
    `since it started (or was last resumed), and the limit set by ${RUN_COST_CAP_ENV_VAR} is ${formatUsd(pause.capMicrodollars)}. ` +
    'Every branch stopped before its next statement. Resume the run to carry on from there; resuming resets its usage, ' +
    'so the limit applies afresh.'
  );
}

/**
 * Mark the run paused and say so. Once per pause: a second segment of the same
 * run meeting the cap while it is already paused changes nothing, so the event
 * is not repeated. The run row must already exist (the park sink ensures it).
 */
export async function markRunLimitPaused(input: {
  runId: TriggerRunId;
  teamId: TeamId;
  triggerId: string;
  pause: RunLimitPause;
}): Promise<void> {
  const stored: StoredLimitPause = { ...input.pause, pausedAt: new Date().toISOString() };
  const marked = await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ limit_pause: sql`${JSON.stringify(stored)}::jsonb` })
    .where('id', '=', input.runId)
    .where('limit_pause', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (marked === undefined) return;
  try {
    await recordRunPausedEvent({ ...input, stored });
  } catch (err) {
    // The pause itself is what matters; a lost notice must not undo it.
    logger.error('[LimitPause] could not record the Run Paused event', {
      runId: input.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function recordRunPausedEvent(input: {
  runId: TriggerRunId;
  teamId: TeamId;
  triggerId: string;
  stored: StoredLimitPause;
}): Promise<void> {
  const trigger = await loadTriggerById(input.triggerId);
  const movementId = trigger?.movementId ?? null;
  const movement =
    movementId === null
      ? undefined
      : await getAutomationsQb(['movement'])
          .selectFrom('movement')
          .where('id', '=', movementId as MovementId)
          .select(['id', 'name'])
          .executeTakeFirst();
  await recordSystemEvent({
    teamId: input.teamId as unknown as string,
    kind: RUN_PAUSED,
    payload: {
      automation: movement?.name ?? '',
      automationId: (movement?.id as string | undefined) ?? '',
      runId: input.runId as unknown as string,
      version: '',
      reason: describeLimitPause(input.stored),
      url:
        movement === undefined
          ? `${webBaseUrl()}/automations`
          : `${webBaseUrl()}/movements/${encodeURIComponent(movement.id as string)}?view=activity`,
      at: input.stored.pausedAt,
    },
  });
}

/**
 * Resume a run paused at a limit: lift the pause, reset its usage, and resume
 * every limit-suspended flow, each re-entering the statement it stopped before
 * (the calls that statement had finished are replayed, not made again).
 * Returns how many flows were resumed. Throws when the run is not paused at a
 * limit. The caller owns the run (team-scoped) and serialises it against the
 * run's other resumes.
 */
export async function resumeLimitPausedRun(runId: TriggerRunId): Promise<{ resumed: number }> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select([
      'team_id',
      'status',
      'trigger_id',
      'trigger_type',
      'trigger_payload',
      'movement_version_id',
      'diagnostics',
      'limit_pause',
      'cancel_requested_at',
    ])
    .executeTakeFirst();
  if (run === undefined) throw new MovementEngineError('MOVENG_RUNTIME', `run ${runId} not found`);

  const leaves = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('park_reason', '=', 'limit')
    .where('status', '=', 'parked')
    .select(['address', 'state', 'updated_at'])
    .orderBy('created_at', 'asc')
    .execute();
  if (run.status !== 'parked' || run.cancel_requested_at !== null || (leaves.length === 0 && readLimitPause(run.limit_pause) === null)) {
    throw new MovementEngineError(
      'MOVENG_RUNTIME',
      `run ${runId} is not paused at a limit (it is ${run.status}) — only a run paused at its cost limit can be resumed`,
    );
  }

  const trigger = await loadTriggerById(run.trigger_id);
  if (!trigger?.movementId || !run.trigger_payload) {
    throw new MovementEngineError('MOVENG_RUNTIME', `run ${runId}'s automation is gone — it cannot be resumed`);
  }
  const pinned = run.movement_version_id ? await loadPinnedVersion(run.movement_version_id) : null;
  if (!pinned) {
    throw new MovementEngineError('MOVENG_RUNTIME', `run ${runId}'s pinned version is gone — it cannot be resumed`);
  }
  const event = triggerEventSchema.parse(run.trigger_payload) as TriggerEvent;

  // Lift the pause and reset the usage BEFORE resuming anything, so a flow
  // that meets the cap again pauses the run afresh (and is told apart from
  // this pause below).
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({
      limit_pause: null,
      cost_cap_baseline_microdollars: String(runSpentMicrodollars(run.diagnostics)),
    })
    .where('id', '=', runId)
    .execute();

  let resumed = 0;
  for (const leaf of leaves) {
    if (!leaf.state) {
      await deleteLeafIfUnchanged(runId, leaf.address, leaf.updated_at);
      continue;
    }
    // Claimed before it is stepped: an earlier flow's step may have cancelled
    // it (a race it lost), and then it is not parked any more.
    const claimed = await claimParkedLeaf({ runId, address: leaf.address, parkReason: 'limit' });
    if (claimed === null || !claimed.state) continue;
    const outcome = await resumeMovementFiring({
      teamId: run.team_id as TeamId,
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
      state: claimed.state as ParkedScopeState,
      // An engine suspension re-runs its statement: nothing to bind, and the
      // calls it had finished replay from its journal.
      reenter: true,
      settleBranchComplete: () => settleBranchComplete(runId, leaf.address),
    });
    resumed += 1;
    if (outcome.error) {
      // An error in any branch fails the whole run (P14); its other branches go
      // with it. Prior writes stand.
      await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
      await clearJoins(runId);
      return { resumed };
    }
    // Completed, or parked somewhere else: this leaf is done. Suspended again
    // at the same statement (it met the cap at once): its row was rewritten
    // as `parked`, and stays.
    await finishResumedLeaf(runId, leaf.address);
    if (outcome.result?.parked && (await runIsLimitPaused(runId))) break;
  }

  if (!(await runHasPendingJoins(runId))) {
    const remaining = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .where('status', '=', 'parked')
      .select('id')
      .executeTakeFirst();
    if (remaining === undefined) {
      await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
      await clearJoins(runId);
    }
  }
  return { resumed };
}

async function runIsLimitPaused(runId: TriggerRunId): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select('limit_pause')
    .executeTakeFirst();
  return readLimitPause(row?.limit_pause) !== null;
}

/** Drop a resumed leaf's row — unless the resume wrote it again (the flow
 *  suspended at the same statement), which leaves it current. The driver read
 *  `updated_at` back at millisecond precision, so compare at that. */
async function deleteLeafIfUnchanged(runId: TriggerRunId, address: string, updatedAt: Date): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .deleteFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .where(sql<Date>`date_trunc('milliseconds', updated_at)`, '=', updatedAt)
    .execute();
}

/** A branch finished: is the run? Not while a join waits or another leaf is
 *  parked (this leaf's own row is dropped after the firing). */
async function settleBranchComplete(runId: TriggerRunId, leafAddress: string): Promise<{ runComplete: boolean }> {
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
