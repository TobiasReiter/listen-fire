import { getQb } from '../kysely';
import { logger } from 'movement-engine/services/logger';
import { unsafeCurrentContext } from '../../services/context';
import { TeamId } from '../../generated/kysely/core/Team';
import OpsSeverity from '../../generated/kysely/public/OpsSeverity';
import { OpsEventInput, shouldPush } from './types';
import { dispatchPush } from './push';

export async function emitOpsEvent(input: OpsEventInput): Promise<string> {
  const requestId = unsafeCurrentContext()?.id ?? null;

  const row = await getQb(['ops_event'])
    .insertInto('ops_event')
    .values({
      type: input.type,
      severity: input.severity ?? OpsSeverity.notable,
      team_id: (input.teamId ?? null) as TeamId | null,
      title: input.title,
      detail: input.detail == null ? null : (input.detail as unknown),
      entity_refs: input.entityRefs == null ? null : (input.entityRefs as unknown),
      request_id: requestId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (shouldPush(input.severity ?? OpsSeverity.notable)) {
    void dispatchPush(row.id).catch((e) =>
      logger.warn('ops push dispatch failed', { eventId: row.id, error: e }),
    );
  }

  logger.debug('emitOpsEvent', { id: row.id, type: input.type });

  return row.id;
}
