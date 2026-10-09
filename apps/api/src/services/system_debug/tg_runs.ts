import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getQb } from '../../lib/kysely';
import { reportedFailureReason } from '../translation_graph/runs/trigger_run';

interface ListTriggerRunsArgs {
  teamId: TeamId;
  triggerId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listTgRuns({
  teamId,
  triggerId,
  status,
  limit = 30,
  offset = 0,
}: ListTriggerRunsArgs) {
  let query = getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_run.team_id', '=', teamId);

  if (triggerId) {
    query = query.where('trigger_run.trigger_id', '=', triggerId);
  }
  if (status) {
    query = query.where('trigger_run.status', '=', status);
  }

  const rows = await query
    .select([
      'trigger_run.id',
      'trigger_run.trigger_id',
      'trigger_run.trigger_type',
      'trigger_run.status',
      'trigger_run.record_id',
      'trigger_run.nodes_written',
      'trigger_run.dry_run',
      'trigger_run.started_at',
      'trigger_run.completed_at',
      'trigger_run.failed_at',
      'trigger_run.failure_reason',
      'trigger_run.engine',
      'trigger_run.engine_reason',
      'trigger_run.created_at',
    ])
    .orderBy('trigger_run.created_at desc')
    .limit(limit)
    .offset(offset)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    triggerId: r.trigger_id,
    triggerType: r.trigger_type,
    status: r.status,
    recordId: r.record_id,
    nodesWritten: r.nodes_written,
    dryRun: r.dry_run,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    failedAt: r.failed_at,
    failureReason: reportedFailureReason(r),
    engine: r.engine,
    engineReason: r.engine_reason,
    createdAt: r.created_at,
  }));
}

interface GetTriggerRunArgs {
  teamId: TeamId;
  runId: TriggerRunId;
}

export async function getTgRun({ teamId, runId }: GetTriggerRunArgs) {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_run.id', '=', runId)
    .where('trigger_run.team_id', '=', teamId)
    .selectAll()
    .executeTakeFirst();

  if (!row) return null;

  return {
    id: row.id,
    triggerId: row.trigger_id,
    triggerType: row.trigger_type,
    status: row.status,
    recordId: row.record_id,
    triggerPayload: row.trigger_payload,
    changedFields: row.changed_fields,
    steps: row.steps,
    diagnostics: row.diagnostics,
    errors: row.errors,
    nodesWritten: row.nodes_written,
    dryRun: row.dry_run,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    failureReason: reportedFailureReason(row),
    engine: row.engine,
    engineReason: row.engine_reason,
    createdAt: row.created_at,
  };
}
