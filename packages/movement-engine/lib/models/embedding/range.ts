// What width of vector each wire model can produce, read by boot validation
// and by each provider's embedding call. Its own module because the map
// imports it, and the embedding entry point imports the map; and free of the
// provider clients, so reading a model's width loads none of them.

import type { Provider } from '../map';

import { neverAsAny } from '../../utils/types';

/** The widths a wire model can produce, inclusive. */
export interface EmbeddingRange {
  min: number;
  max: number;
}

/**
 * The widths each OpenAI embedding model can produce. `dimensions` shortens
 * a text-embedding-3 vector to any width up to its native one; the native
 * width is the maximum. Source, checked 2026-09-24: "By default, the length of
 * the embedding vector is 1536 for text-embedding-3-small or 3072 for
 * text-embedding-3-large" (https://developers.openai.com/api/docs/guides/embeddings),
 * and the SDK's own `dimensions` doc: "Only supported in `text-embedding-3`
 * and later models" — which is why ada-002 is not listed.
 */
export const OPENAI_EMBEDDING_DIMENSIONS: Readonly<Record<string, EmbeddingRange>> = {
  'text-embedding-3-large': { min: 1, max: 3072 },
  'text-embedding-3-small': { min: 1, max: 1536 },
};

export interface GeminiEmbeddingModel extends EmbeddingRange {
  /** Per text; past it Google would silently embed a prefix. */
  maxInputTokens: number;
}

/**
 * The widths each Gemini embedding model can produce, and the longest text
 * each takes. Source, checked 2026-09-24: gemini-embedding-001 outputs "a
 * 3072-dimensional embedding" by default, sized "128 - 3072" through
 * `outputDimensionality` (https://ai.google.dev/gemini-api/docs/embeddings);
 * the 2048 token input limit is on Vertex's text embeddings page
 * (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings).
 */
export const GEMINI_EMBEDDING_MODELS: Readonly<Record<string, GeminiEmbeddingModel>> = {
  'gemini-embedding-001': { min: 128, max: 3072, maxInputTokens: 2048 },
};

/**
 * What `wireModel` on `provider` can produce, or nothing when its provider
 * file does not list it: a wire model nobody wrote down cannot promise the
 * width a column needs, so boot validation refuses it rather than guessing.
 */
export function embeddingRange(provider: Provider, wireModel: string): EmbeddingRange | undefined {
  switch (provider) {
    case 'openai':
      return OPENAI_EMBEDDING_DIMENSIONS[wireModel];
    case 'gemini':
      return GEMINI_EMBEDDING_MODELS[wireModel];
    case 'anthropic':
    case 'vertex':
      return undefined;
    default:
      return neverAsAny(provider);
  }
}
