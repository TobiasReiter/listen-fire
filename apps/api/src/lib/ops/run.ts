import type { OpsEventId } from '../../generated/kysely/public/OpsEvent';
import type { TeamId } from '../../generated/kysely/core/Team';

import { getQb } from '../kysely';
import { logger } from '../../services/logger';
import { unsafeCurrentContext } from '../../services/context';
import { dispatchPush } from './push';
import OpsEventType from '../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../generated/kysely/public/OpsSeverity';
import OpsRunStatus from '../../generated/kysely/public/OpsRunStatus';
import OpsDetailLevel from '../../generated/kysely/automations/OpsDetailLevel';
import { meetsDetailLevel } from './types';
import { getTeamDetailLevel } from '../../services/team/ops_detail';

function requestId(): string | null {
  return unsafeCurrentContext()?.id ?? null;
}

export async function startOpsRun(input: {
  type: OpsEventType;
  title: string;
  teamId: string | null;
}): Promise<string> {
  const now = new Date();
  const row = await getQb(['ops_event'])
    .insertInto('ops_event')
    .values({
      type: input.type,
      severity: OpsSeverity.info,
      status: OpsRunStatus.running,
      team_id: (input.teamId ?? null) as TeamId | null,
      title: input.title,
      updated_at: now,
      request_id: requestId(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function addOpsRunMessage(
  runId: string,
  input: {
    title: string;
    level: OpsDetailLevel;
    severity?: OpsSeverity;
    detail?: unknown;
    teamId: string | null;
  },
): Promise<void> {
  const teamLevel = await getTeamDetailLevel(input.teamId);
  if (!meetsDetailLevel(teamLevel, input.level)) {
    // Below the team's threshold — still reflect activity on the run root.
    await touchRun(runId, input.title);
    return;
  }
  await getQb(['ops_event'])
    .insertInto('ops_event')
    .values({
      type: OpsEventType.AUTOMATION,
      severity: input.severity ?? OpsSeverity.info,
      team_id: (input.teamId ?? null) as TeamId | null,
      title: input.title,
      detail: input.detail == null ? null : (input.detail as unknown),
      parent_run_id: runId as OpsEventId,
      request_id: requestId(),
    })
    .execute();
  await touchRun(runId, input.title);
}

async function touchRun(runId: string, statusLine: string): Promise<void> {
  await getQb(['ops_event'])
    .updateTable('ops_event')
    .set({ updated_at: new Date(), title: statusLine })
    .where('id', '=', runId as OpsEventId)
    .where('status', 'in', [OpsRunStatus.running, OpsRunStatus.parked])
    .execute();
}

export async function updateOpsRunStatus(runId: string, statusLine: string): Promise<void> {
  await touchRun(runId, statusLine);
}

/**
 * Mark the feed run as WAITING ON A PERSON. Distinct from `running`, which now
 * means the automation is actually working: a run parked at an `ask` can sit
 * here for days, and showing it as running made the feed unreadable and the
 * "running now" count meaningless.
 *
 * Not terminal — `adoptOpsRun` flips it back to `running` when the answer
 * arrives, and `finish()` closes it as usual.
 */
export async function parkOpsRun(runId: string, input?: { summary?: string }): Promise<void> {
  await getQb(['ops_event'])
    .updateTable('ops_event')
    .set({
      status: OpsRunStatus.parked,
      title: input?.summary ?? 'Waiting for a person',
      updated_at: new Date(),
    })
    .where('id', '=', runId as OpsEventId)
    .where('status', '=', OpsRunStatus.running)
    .execute();
}

/** Back to work: a parked run whose answer arrived. */
export async function unparkOpsRun(runId: string): Promise<void> {
  await getQb(['ops_event'])
    .updateTable('ops_event')
    .set({ status: OpsRunStatus.running, updated_at: new Date() })
    .where('id', '=', runId as OpsEventId)
    .where('status', '=', OpsRunStatus.parked)
    .execute();
}

export async function completeOpsRun(runId: string, input?: { summary?: string }): Promise<void> {
  await getQb(['ops_event'])
    .updateTable('ops_event')
    .set({
      status: OpsRunStatus.completed,
      severity: OpsSeverity.notable,
      title: input?.summary ?? 'Completed',
      updated_at: new Date(),
    })
    .where('id', '=', runId as OpsEventId)
    .execute();
}

export async function failOpsRun(runId: string, input?: { error?: string }): Promise<void> {
  await getQb(['ops_event'])
    .updateTable('ops_event')
    .set({
      status: OpsRunStatus.failed,
      severity: OpsSeverity.warn,
      title: input?.error ?? 'Run failed',
      updated_at: new Date(),
    })
    .where('id', '=', runId as OpsEventId)
    .execute();
  void dispatchPush(runId).catch((e) =>
    logger.warn('ops push dispatch failed (failOpsRun)', { eventId: runId, error: e }),
  );
}
