// Every pgvector column this repo writes, the registry model that fills it,
// and its width.
//
// A vector's width belongs to the COLUMN, not to the model: the same text
// embedded for `extraction_fact` is 256 numbers wide because that column is,
// and asking the provider for anything else writes a row Postgres refuses.
// That is why boot validation reads this table: a map line that sends a
// column's model to a wire model that cannot produce the column's width is
// refused before the first row is written, never renormalised into the index.
//
// Vectors written by one provider are deliberately NOT required to be
// comparable with vectors written by another, so nothing here tries to
// reconcile the two models' spaces.
//
// Kept apart from the embedding service so boot validation can read it
// without importing the database layer the service writes through.

import type { EmbeddingModelName } from '../registry';

interface EmbeddingDestination {
  /** The column, as an operator reading a refusal would look for it. */
  column: string;
  model: EmbeddingModelName;
  dimensions: number;
}

export const embeddingDestinations = {
  raw_text: {
    column: 'knowledge.raw_text.embedding (and knowledge.raw_text_part.embedding)',
    model: 'text-embedding-3-large',
    dimensions: 3072,
  },
  extraction_fact: {
    column: 'knowledge.extraction_fact.embedding',
    model: 'text-embedding-3-small',
    dimensions: 256,
  },
} as const satisfies Record<string, EmbeddingDestination>;

export type EmbeddingDestinationName = keyof typeof embeddingDestinations;
