import { getQb } from '../kysely';
import { retentionCutoff } from './types';
import { logger } from 'movement-engine/services/logger';

export async function sweepOpsEvents(now = new Date()): Promise<number> {
  const res = await getQb(['ops_event'])
    .deleteFrom('ops_event')
    .where('created_at', '<', retentionCutoff(now))
    .executeTakeFirst();
  const deleted = Number(res.numDeletedRows ?? 0);
  logger.info('ops_event retention sweep', { deleted });
  return deleted;
}
