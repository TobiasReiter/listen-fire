// Retention prune for trigger_run. Disabled by default; enable by scheduling
// `pnpm tg:prune` (or the exported function) on a cron when volume warrants.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../../lib/kysely';

export interface PruneTriggerRunsInput {
  /** Rows older than this many days are deleted. Defaults to 7. */
  olderThanDays?: number;
  /** Optional team scope — if omitted, prunes across all teams. */
  teamId?: TeamId;
}

export interface PruneTriggerRunsResult {
  deleted: number;
  cutoff: string;
  /**
   * The runs that went. Everything inside `automations` cascaded away with
   * them; anything OUTSIDE the schema that referenced them (the residual
   * `llm_usage` lines) has no constraint to act on any more (D3/D8) and is the
   * caller's to release — see `releaseLlmUsageRunReferences` (lib/llm_usage.ts).
   */
  deletedRunIds: TriggerRunId[];
}

export async function pruneTriggerRuns(
  input: PruneTriggerRunsInput = {},
): Promise<PruneTriggerRunsResult> {
  const days = input.olderThanDays ?? 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let q = getAutomationsQb(['trigger_run'])
    .deleteFrom('trigger_run')
    .where('created_at', '<', cutoff);
  if (input.teamId) {
    q = q.where('team_id', '=', input.teamId);
  }
  const deletedRuns = await q.returning('id').execute();
  return {
    deleted: deletedRuns.length,
    cutoff: cutoff.toISOString(),
    deletedRunIds: deletedRuns.map((r) => r.id),
  };
}
