// Loop guard — the cause-agnostic safety floor (Phase 1).
//
// This is the SAFETY NET that lets the old per-linked_object circuit breaker be
// removed: a coarse, movement-level backstop that bounds cost regardless of the
// loop's shape. It sits on the LIVE dispatch path, consulted ONCE per movement
// run inside `dispatchTriggerByIdEvent`, composed with the existing run_mode
// gate (the established "don't run this" precedent).
//
// Two floor signals:
//   - per-trigger minute-level RATE  → `throttle` (defer the run; queue, don't
//     drop). The delay is itself a weapon: a loop that can only iterate once a
//     minute is cheap and trivially catchable.
//   - per-team rolling USAGE BUDGET (movement runs / external writes / LLM
//     tokens) → `pause` (set the guard-paused state, notify, skip until a human
//     resumes).
//
// TWO STANDING DISCIPLINES, both load-bearing:
//   1. FAIL-OPEN (P4). Any Redis/guard error → allow the run. A broken guard
//      must never block legitimate work. Every Redis touch in store.ts already
//      degrades to "no signal"; this module additionally try/catches the whole
//      evaluation and allows on throw.
//   2. OBSERVE-BY-DEFAULT. In observe mode (the default) we compute the same
//      decision and LOG "would-throttle / would-pause", but return it with
//      `enforced: false` so the caller still runs. Flipping to enforce is a
//      one-liner: `LOOP_GUARD_MODE=enforce`.
//
// the floor

import type { GuardDecision } from './types';

import { logger } from 'movement-engine/public/log';
import { guardKeys, incrementAndSum } from './store';
import { guardEnabled, guardMode, resolveThresholds } from './thresholds';

export type { GuardDecision } from './types';
export { recordExternalWrites, recordLlmTokens } from './usage';
export { clearGuardPaused, loadGuardPausedState, setGuardPaused } from './pause';

export interface GuardEvaluateInput {
  teamId: string;
  triggerId: string;
  movementId: string | null;
  triggerName: string;
  /** Clock injection for tests. */
  nowMs?: number;
}

/**
 * Consult the guard before a movement run. Increments the per-trigger rate and
 * the per-team run counters (the increments ARE the observation — the floor
 * only ever counts what actually dispatches), then returns the verdict.
 *
 * Order matters: the per-team BUDGET (pause) is checked before the per-trigger
 * RATE (throttle). A budget breach is the harder stop (the whole team is over
 * its cost cap), so it wins; a single hot trigger that's merely over its rate
 * gets the softer queue-don't-drop throttle.
 */
export async function evaluate(input: GuardEvaluateInput): Promise<GuardDecision> {
  if (!guardEnabled()) return { kind: 'allow' };
  const mode = guardMode();
  const enforced = mode === 'enforce';

  try {
    const t = resolveThresholds();
    const nowMs = input.nowMs ?? Date.now();

    // Count this dispatch against both windows in parallel.
    const [rate, teamRuns] = await Promise.all([
      incrementAndSum({
        key: guardKeys.triggerRate(input.teamId, input.triggerId),
        windowSeconds: t.rateWindowSeconds,
        amount: 1,
        nowMs,
      }),
      incrementAndSum({
        key: guardKeys.teamRuns(input.teamId),
        windowSeconds: t.teamWindowSeconds,
        amount: 1,
        nowMs,
      }),
    ]);

    // Team budget breach → pause (the coarse cost cap). Checked first.
    if (teamRuns.total > t.teamRunsPerWindow) {
      const reason =
        `team made ${teamRuns.total} movement runs in ${t.teamWindowSeconds}s ` +
        `(budget ${t.teamRunsPerWindow})`;
      logGuard(mode, 'pause', input, reason);
      return { kind: 'pause', signal: 'team_budget', reason, enforced };
    }

    // Per-trigger rate breach → throttle (queue-don't-drop). Released later.
    if (rate.total > t.triggerRatePerWindow) {
      const reason =
        `automation fired ${rate.total} times in ${t.rateWindowSeconds}s ` +
        `(rate limit ${t.triggerRatePerWindow})`;
      logGuard(mode, 'throttle', input, reason);
      return {
        kind: 'throttle',
        signal: 'trigger_rate',
        reason,
        retryAfterMs: t.rateWindowSeconds * 1000,
        enforced,
      };
    }

    return { kind: 'allow' };
  } catch (err) {
    // FAIL-OPEN: a guard error must never block a legitimate run.
    logger.warn('[LoopGuard] evaluate threw — failing open (allowing run)', {
      triggerId: input.triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'allow' };
  }
}

function logGuard(
  mode: ReturnType<typeof guardMode>,
  outcome: 'pause' | 'throttle',
  input: GuardEvaluateInput,
  reason: string,
): void {
  const verb = mode === 'enforce' ? outcome : `would-${outcome}`;
  logger.warn(`[LoopGuard] ${verb}: ${reason}`, {
    mode,
    triggerId: input.triggerId,
    triggerName: input.triggerName,
    teamId: input.teamId,
    movementId: input.movementId,
  });
}
