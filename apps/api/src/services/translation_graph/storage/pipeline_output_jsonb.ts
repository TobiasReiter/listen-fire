// Consumer-level event-mode body for `pipeline_output` — the shared
// NodeMappings + Edges map read/written by the kept v3 output editor.
//
// This is NOT translation-graph storage (that's retired, kill-tg phase
// 6): it reads/writes `pipeline_output.tg_event_body` JSONB directly.

import { sql } from 'kysely';

import type { Insertable } from 'kysely';
import type { PipelineOutputId } from '../../../generated/kysely/public/PipelineOutput';

import { getQb } from '../../../lib/kysely';
import { parsePipelineEventBodyLenient, type PipelineEventBody } from '../types';

/**
 * Read the consumer-level event-mode body for pipeline_output. Mirror of
 * the pipeline_input variant. See
 * `plans/2026-05-12-tg-event-execution/2_architecture.md`.
 */
export async function loadPipelineOutputEventBody(
  pipelineOutputId: string,
): Promise<PipelineEventBody> {
  const qb = getQb(['pipeline_output']);
  const row = await qb
    .selectFrom('pipeline_output')
    .where('id', '=', pipelineOutputId as PipelineOutputId)
    .select(['tg_event_body'])
    .executeTakeFirst();
  if (!row) throw new Error(`pipeline_output ${pipelineOutputId} not found`);
  return parsePipelineEventBodyLenient(row.tg_event_body);
}

/**
 * Replace the consumer-level event-mode body for pipeline_output.
 */
export async function savePipelineOutputEventBody(
  pipelineOutputId: string,
  body: PipelineEventBody,
): Promise<void> {
  const qb = getQb(['pipeline_output']);
  const result = await qb
    .updateTable('pipeline_output')
    .set({
      tg_event_body: sql`${JSON.stringify(body)}::jsonb` as unknown as Insertable<{
        tg_event_body: unknown;
      }>['tg_event_body'],
      updated_at: new Date(),
    })
    .where('id', '=', pipelineOutputId as PipelineOutputId)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0n) === 0) {
    throw new Error(`pipeline_output ${pipelineOutputId} not found`);
  }
}
