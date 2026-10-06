// Context-free raw-text dedup/store for movement runs.
//
// The authorized `RawTextService` (a Prisma ModelService) requires the request
// Context AsyncLocalStorage, which a movement firing does not establish — the
// engine is Kysely-first and Context-free. This is the same checksum-keyed
// getOrCreate (trim → checksum → find-or-insert → stable id), scoped to the
// team the host serves. Embedding is intentionally NOT triggered here: the
// movement path stores raw text as extraction provenance, not as
// search-indexed knowledge.

import { getKnowledgeQb } from '../../../lib/kysely';
import { checksum } from '../../../lib/utils/hash';
import type { TeamId } from '../../../generated/kysely/core/Team';

/** Extracted text, stored once per distinct content: the stable id a file's
 *  text is cited by. Undefined when nothing was stored. */
export interface RawTextStore {
  getOrCreateId(content: string): Promise<string | undefined>;
}

/** A store that keeps nothing past the run: a test run must leave no
 *  `raw_text` rows behind, yet its file text still needs ids to be cited by. */
export function inMemoryRawTextStore(): RawTextStore {
  const ids = new Map<string, string>();
  return {
    async getOrCreateId(content) {
      const trimmed = content.trim();
      let id = ids.get(trimmed);
      if (id === undefined) {
        id = `raw-text-${ids.size + 1}`;
        ids.set(trimmed, id);
      }
      return id;
    },
  };
}

export function postgresRawTextStore(teamId: TeamId): RawTextStore {
  return { getOrCreateId: (content) => getOrCreateRawTextId(teamId, content) };
}

async function getOrCreateRawTextId(teamId: TeamId, content: string): Promise<string | undefined> {
  const trimmed = content.trim();
  const sum = checksum(trimmed);
  const existing = await getKnowledgeQb(['raw_text'])
    .selectFrom('raw_text')
    .where('team_id', '=', teamId)
    .where('checksum', '=', sum)
    .select(['id'])
    .executeTakeFirst();
  if (existing) return String(existing.id);
  const inserted = await getKnowledgeQb(['raw_text'])
    .insertInto('raw_text')
    .values({
      content: trimmed,
      checksum: sum,
      team_id: teamId,
    } as never)
    .returning('id')
    .executeTakeFirst();
  return inserted ? String(inserted.id) : undefined;
}
