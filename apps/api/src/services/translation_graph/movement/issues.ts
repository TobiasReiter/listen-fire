// Sentry-shaped aggregation of movement run failures (validity lifecycle
// layer 2, plans/2026-07-13-movement-validity-lifecycle).
//
// Occurrences group into ISSUES by fingerprint — one row per
// (movement, failure-class + normalized message). Alerts fire on state
// TRANSITIONS, never per occurrence:
//   - a NEW issue (first time this fingerprint appears),
//   - a REGRESSION (a resolved issue reopening),
//   - the count CROSSING the threshold (once per open episode).
// Everything between rolls silently into the count. A clean run of the
// movement resolves its open issues (the close half of the prediction rule's
// surprise-success path).
//
// This replaces the old per-failure Slack SUPPORT ping in execute.ts — same
// surface (sendSlackNotification), transition-gated instead of per-run.

import { createHash } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { sendSlackNotification } from '../../../lib/slack';
import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from 'movement-engine/services/logger';

/** Alert once when an open issue's count reaches this many failures. */
export const ISSUE_COUNT_ALERT_THRESHOLD = 10;

const SAMPLE_RUN_CAP = 5;

/**
 * Classify + fingerprint a failure message. The class is the engine's error
 * code when one is present (`MOVENG_*` / `MOV_*`), else 'runtime'. The
 * fingerprint hashes the class + the message with volatile fragments
 * (UUIDs, numbers, quoted values) stripped, so "unknown edge 'X' on line 15"
 * and a re-fire of the same failure land in ONE issue while a different
 * failure opens another.
 */
export function fingerprintFailure(message: string): {
  failureClass: string;
  fingerprint: string;
} {
  const codeMatch = message.match(/\b(MOVENG_[A-Z_]+|MOV_[A-Z_]+)\b/);
  const failureClass = codeMatch?.[1] ?? 'runtime';
  const normalized = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    .replace(/\d+/g, '<n>')
    .trim();
  const fingerprint = createHash('sha256')
    .update(`${failureClass}\n${normalized}`)
    .digest('hex');
  return { failureClass, fingerprint };
}

interface IssueRow {
  id: string;
  count: number;
  state: string;
  threshold_alerted: boolean;
  sample_run_ids: unknown;
}

/**
 * Record one failure occurrence into its issue. Best-effort — callers wrap
 * or ignore errors; issue bookkeeping must never mask a run outcome.
 * Returns the transition that fired (for tests/telemetry).
 */
export async function recordMovementFailureIssue(input: {
  teamId: string;
  movementId: string;
  movementName: string;
  triggerName: string;
  runId: string;
  message: string;
}): Promise<'new' | 'regression' | 'threshold' | 'counted'> {
  const { failureClass, fingerprint } = fingerprintFailure(input.message);
  const qb = getAutomationsQb(['movement_issue']);

  const existing = (await qb
    .selectFrom('movement_issue')
    .where('movement_id', '=', input.movementId as MovementId)
    .where('fingerprint', '=', fingerprint)
    .select(['id', 'count', 'state', 'threshold_alerted', 'sample_run_ids'])
    .executeTakeFirst()) as IssueRow | undefined;

  const sampleRuns = (prev: unknown): string[] => {
    const list = Array.isArray(prev) ? (prev as string[]) : [];
    return [input.runId, ...list.filter((r) => r !== input.runId)].slice(0, SAMPLE_RUN_CAP);
  };

  if (!existing) {
    await qb
      .insertInto('movement_issue')
      .values({
        team_id: input.teamId as TeamId,
        movement_id: input.movementId as MovementId,
        fingerprint,
        failure_class: failureClass,
        message: input.message,
        count: 1,
        state: 'open',
        sample_run_ids: JSON.stringify([input.runId]) as never,
      } as never)
      .execute();
    await notify(
      `New automation issue: ${input.movementName} failed (${failureClass})\n${input.message}\n• trigger: ${input.triggerName}\n• team: ${input.teamId}`,
    );
    return 'new';
  }

  const reopened = existing.state === 'resolved';
  const newCount = existing.count + 1;
  // A reopen starts a fresh episode — the threshold alert may fire again.
  const thresholdCrossed =
    !reopened && !existing.threshold_alerted && newCount >= ISSUE_COUNT_ALERT_THRESHOLD;

  await qb
    .updateTable('movement_issue')
    .set({
      count: newCount,
      state: 'open',
      message: input.message,
      last_seen_at: new Date(),
      updated_at: new Date(),
      sample_run_ids: JSON.stringify(sampleRuns(existing.sample_run_ids)) as never,
      ...(reopened ? { resolved_at: null, threshold_alerted: false } : {}),
      ...(thresholdCrossed ? { threshold_alerted: true } : {}),
    } as never)
    .where('id', '=', existing.id as never)
    .execute();

  if (reopened) {
    await notify(
      `Automation issue REGRESSED: ${input.movementName} (${failureClass}) — previously resolved, failing again\n${input.message}\n• team: ${input.teamId}`,
    );
    return 'regression';
  }
  if (thresholdCrossed) {
    await notify(
      `Automation issue at ${newCount} failures: ${input.movementName} (${failureClass})\n${input.message}\n• team: ${input.teamId}`,
    );
    return 'threshold';
  }
  return 'counted';
}

/**
 * Resolve a movement's open issues — called on a clean live run (the
 * surprise-success close). Quiet: resolution needs no alert.
 */
export async function resolveMovementIssues(input: { movementId: string }): Promise<void> {
  await getAutomationsQb(['movement_issue'])
    .updateTable('movement_issue')
    .set({
      state: 'resolved',
      resolved_at: new Date(),
      updated_at: new Date(),
    } as never)
    .where('movement_id', '=', input.movementId as MovementId)
    .where('state', '=', 'open')
    .execute();
}

async function notify(text: string): Promise<void> {
  await sendSlackNotification({ type: 'SUPPORT', text }).catch((err) =>
    logger.warn('[MovementIssues] alert notification failed', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
