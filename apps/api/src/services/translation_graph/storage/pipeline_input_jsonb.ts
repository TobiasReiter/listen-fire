// Consumer-level event-mode body for `pipeline_input` — the shared
// NodeMappings + Edges map read/written by the kept v3 input editor.
//
// This is NOT translation-graph storage (that's retired, kill-tg phase
// 6): it reads/writes `pipeline_input.tg_event_body` JSONB directly.

import { sql } from 'kysely';

import type { Insertable } from 'kysely';
import type { PipelineInputId } from '../../../generated/kysely/public/PipelineInput';

import { getQb } from '../../../lib/kysely';
import { parsePipelineEventBodyLenient, type PipelineEventBody } from '../types';

/**
 * Read the consumer-level event-mode body — the shared NodeMappings +
 * Edges map for all event-mode triggers on this pipeline_input. Returns
 * an empty body when the column is NULL (no event-mode authored yet).
 */
export async function loadPipelineInputEventBody(
  pipelineInputId: string,
): Promise<PipelineEventBody> {
  const qb = getQb(['pipeline_input']);
  const row = await qb
    .selectFrom('pipeline_input')
    .where('id', '=', pipelineInputId as PipelineInputId)
    .select(['tg_event_body'])
    .executeTakeFirst();
  if (!row) throw new Error(`pipeline_input ${pipelineInputId} not found`);
  return parsePipelineEventBodyLenient(row.tg_event_body);
}

/**
 * Replace the consumer-level event-mode body. Authors save this via the
 * dedicated map editor; runtime dispatch reads it alongside each
 * event-mode trigger's filter when constructing the engine call.
 */
export async function savePipelineInputEventBody(
  pipelineInputId: string,
  body: PipelineEventBody,
): Promise<void> {
  const qb = getQb(['pipeline_input']);
  const result = await qb
    .updateTable('pipeline_input')
    .set({
      tg_event_body: sql`${JSON.stringify(body)}::jsonb` as unknown as Insertable<{
        tg_event_body: unknown;
      }>['tg_event_body'],
      updated_at: new Date(),
    })
    .where('id', '=', pipelineInputId as PipelineInputId)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0n) === 0) {
    throw new Error(`pipeline_input ${pipelineInputId} not found`);
  }
}
