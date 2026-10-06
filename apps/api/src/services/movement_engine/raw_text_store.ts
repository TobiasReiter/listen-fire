// Context-free raw-text dedup/store for the movement engine.
//
// The authorized `RawTextService` (a Prisma ModelService) requires the request
// Context AsyncLocalStorage, which a movement firing does not establish — the
// engine is Kysely-first and Context-free. This is the same checksum-keyed
// getOrCreate (trim → checksum → find-or-insert → stable id), team-scoped off
// the ambient LLM-usage context the firing always runs inside. Embedding is
// intentionally NOT triggered here: the movement path stores raw text as
// extraction provenance, not as search-indexed knowledge.

import { getKnowledgeQb } from '../../lib/kysely';
import { currentLlmUsageContext } from '../../lib/llm_usage';
import { checksum } from '../../lib/utils/hash';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { RawTextStore } from './host';

export const postgresRawTextStore: RawTextStore = { getOrCreateId: getOrCreateRawTextId };

async function getOrCreateRawTextId(content: string): Promise<string | undefined> {
  const teamId = currentLlmUsageContext()?.data.teamId;
  if (!teamId) return undefined;
  const trimmed = content.trim();
  const sum = checksum(trimmed);
  const existing = await getKnowledgeQb(['raw_text'])
    .selectFrom('raw_text')
    .where('team_id', '=', teamId as TeamId)
    .where('checksum', '=', sum)
    .select(['id'])
    .executeTakeFirst();
  if (existing) return String(existing.id);
  const inserted = await getKnowledgeQb(['raw_text'])
    .insertInto('raw_text')
    .values({
      content: trimmed,
      checksum: sum,
      team_id: teamId as TeamId,
    } as never)
    .returning('id')
    .executeTakeFirst();
  return inserted ? String(inserted.id) : undefined;
}
