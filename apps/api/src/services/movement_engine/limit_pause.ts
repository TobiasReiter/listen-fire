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
// Resuming the run is limit_resume.ts (its own module: the park sink records a
// pause, and must not reach the engine's resume path through this one).
//
// "Together" is one action over every suspended flow, driven one leaf at a time
// as the other resume drivers do (the join substrate decides which leaf closes
// each frame). A flow that meets the cap again while the run is being resumed
// pauses it again; the leaves not yet reached then stay paused with it.

import { sql } from 'kysely';
import { z } from 'zod';
import { formatUsd, RUN_COST_CAP_ENV_VAR } from 'movement-engine/lib/run_cost';
import { logger } from 'movement-engine/services/logger';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { MovementId } from '../../generated/kysely/automations/Movement';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { RunLimitPause } from 'movement-engine/services/movement_engine/run';

import { recordSystemEvent, webBaseUrl } from '../translation_graph/adapters/system/events';
import { RUN_PAUSED } from '../translation_graph/adapters/system/types';
import { loadTriggerById } from '../translation_graph/storage/tg_table';
import { getAutomationsQb } from '../../lib/kysely';

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
