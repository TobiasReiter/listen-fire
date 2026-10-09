import { sql } from 'kysely';
import uniq from 'lodash/uniq';

import type { EmbeddingDestinationName } from '../lib/models/embedding/destinations';

import { getKnowledgeQb } from '../lib/kysely';
import { chunkText, isWithinTokenLimit, CHUNK_SIZE, truncateToTokenLimit } from '../lib/chunking';
import { embed } from '../lib/models/embedding';
import { embeddingDestinations } from '../lib/models/embedding/destinations';
import { UserService } from '../services/user';
import { currentContext } from './context';
import { RawTextId } from '../generated/kysely/knowledge/RawText';
import RawTextPartType from '../generated/kysely/knowledge/RawTextPartType';

/**
 * Embed some texts for one destination column, whichever vendor the model map
 * sends that column's model to. The caller names where the vectors are going,
 * not which model to use: the model and the width are the destination's
 * business.
 */
export async function embedTexts(options: {
  texts: string[];
  destination: EmbeddingDestinationName;
  label?: string;
}): Promise<number[][]> {
  const { model, dimensions } = embeddingDestinations[options.destination];
  const { embeddings } = await embed(model, { input: options.texts, dimensions, label: options.label });
  return embeddings;
}

interface EmbedResult {
  isChunked: boolean;
  chunkCount: number;
}

class Embedding {
  async createEmbedding(text: string, label?: string): Promise<number[]> {
    const [embedding] = await embedTexts({
      // Truncation stays on the caller's side of the map: it is what this path
      // has always done, and the Gemini provider refuses rather than
      // truncates.
      texts: [truncateToTokenLimit(text)],
      destination: 'raw_text',
      label,
    });
    return embedding;
  }

  async embedAndStore(rawTextId: string, content: string, teamId: string): Promise<EmbedResult> {
    if (isWithinTokenLimit(content, CHUNK_SIZE)) {
      const embedding = await this.createEmbedding(content);

      await getKnowledgeQb(['raw_text'])
        .updateTable('raw_text')
        .set({
          embedding: JSON.stringify(embedding),
          is_chunked: false,
        })
        .where('id', '=', rawTextId as RawTextId)
        .execute();

      return { isChunked: false, chunkCount: 0 };
    }

    const chunks = chunkText(content, { maxTokens: CHUNK_SIZE, strategy: 'paragraph' });

    await getKnowledgeQb(['raw_text'])
      .updateTable('raw_text')
      .set({
        embedding: null,
        is_chunked: true,
      })
      .where('id', '=', rawTextId as RawTextId)
      .execute();

    for (const chunk of chunks) {
      const embedding = await this.createEmbedding(chunk.content);

      await getKnowledgeQb(['raw_text_part'])
        .insertInto('raw_text_part')
        .values({
          team_id: teamId,
          raw_text_id: rawTextId as RawTextId,
          type: RawTextPartType.EMBEDDING_CHUNK,
          start: chunk.start,
          end: chunk.end,
          content: chunk.content,
          embedding: JSON.stringify(embedding),
        })
        .execute();
    }

    return { isChunked: true, chunkCount: chunks.length };
  }


}

const EmbeddingService = new Embedding();

export { EmbeddingService };
