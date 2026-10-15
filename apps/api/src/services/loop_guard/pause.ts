// Loop guard — the graceful-disable (guard-paused) state on a trigger.
//
// The breach write to Postgres is RARE (only on the transition into paused),
// so it's off the hot path's steady state — the steady state is pure Redis.
// "Paused" means the RUN is skipped; the inbound receipt (public.trigger_event)
// is stored upstream and stays replayable. No data is lost.
//
// Manual resume only (auto-resume is deliberately not the default — the looping
// condition usually persists and would oscillate). Resume clears the columns
// AND resets the Redis windows so the automation starts clean.

import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { GuardSignal } from './types';

import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/services/logger';
import { guardKeys, resetWindow } from './store';
import { resolveThresholds } from './thresholds';


export interface GuardPausedState {
  pausedAt: Date | null;
  reason: string | null;
  signal: string | null;
}

/** Read the guard-paused state for the dispatch gate. */
export async function loadGuardPausedState(triggerId: string): Promise<GuardPausedState> {
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', triggerId as TriggerId)
    .select(['guard_paused_at', 'guard_paused_reason', 'guard_paused_signal'])
    .executeTakeFirst();
  if (!row) return { pausedAt: null, reason: null, signal: null };
  return {
    pausedAt: row.guard_paused_at,
    reason: row.guard_paused_reason,
    signal: row.guard_paused_signal,
  };
}

/**
 * Set the guard-paused state on a trigger. Idempotent — re-breaching an
 * already-paused trigger leaves the original pause timestamp/reason in place
 * (the `where guard_paused_at is null` clause), so the audit reflects the FIRST
 * breach, not the latest.
 */
export async function setGuardPaused(input: {
  triggerId: string;
  reason: string;
  signal: GuardSignal;
}): Promise<{ newlyPaused: boolean }> {
  const result = await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({
      guard_paused_at: new Date(),
      guard_paused_reason: input.reason,
      guard_paused_signal: input.signal,
    })
    .where('id', '=', input.triggerId as TriggerId)
    .where('guard_paused_at', 'is', null)
    .executeTakeFirst();
  const newlyPaused = Number(result.numUpdatedRows) > 0;
  if (newlyPaused) {
    logger.warn('[LoopGuard] trigger guard-paused', {
      triggerId: input.triggerId,
      signal: input.signal,
      reason: input.reason,
    });
  }
  return { newlyPaused };
}

/**
 * Clear the guard-paused state (manual resume) and reset the Redis windows so
 * the automation resumes from a clean slate. Returns whether a pause was
 * actually cleared.
 */
export async function clearGuardPaused(input: {
  triggerId: string;
  teamId: string;
  resumedBy: string;
}): Promise<{ resumed: boolean }> {
  const result = await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({ guard_paused_at: null, guard_paused_reason: null, guard_paused_signal: null })
    .where('id', '=', input.triggerId as TriggerId)
    .where('guard_paused_at', 'is not', null)
    .executeTakeFirst();
  const resumed = Number(result.numUpdatedRows) > 0;
  if (!resumed) return { resumed: false };

  const thresholds = resolveThresholds();
  await Promise.all([
    resetWindow({
      key: guardKeys.triggerRate(input.teamId, input.triggerId),
      windowSeconds: thresholds.rateWindowSeconds,
    }),
    resetWindow({
      key: guardKeys.teamRuns(input.teamId),
      windowSeconds: thresholds.teamWindowSeconds,
    }),
  ]);
  logger.info('[LoopGuard] trigger resumed from guard-pause', {
    triggerId: input.triggerId,
    resumedBy: input.resumedBy,
  });
  return { resumed: true };
}
