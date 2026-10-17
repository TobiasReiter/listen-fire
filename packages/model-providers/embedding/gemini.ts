// Embeddings on Gemini, through `@google/genai`. For `gemini-embedding-001` on
// Vertex the SDK speaks the model's `:predict` method, one text per instance.

import type { ModelHost } from '../host';
import type { Resolved } from 'movement-engine/public/models';
import type { EmbeddingRequest, EmbeddingResult } from './index';

import { geminiClient } from '../providers/gemini';
import { GEMINI_EMBEDDING_MODELS } from 'movement-engine/public/model-calls';

/**
 * `gemini-embedding-001` truncates a vector to `outputDimensionality` WITHOUT
 * renormalising it, and the whole reason cosine distance and dot product agree
 * on the full-length vector is that it arrives normalised. A truncated one has
 * to be put back on the unit sphere here, or every distance the database
 * computes against it is measuring length as well as direction. ("If you are
 * using gemini-embedding-001, you must manually normalize non-3072
 * dimensions", on the page cited above.)
 */
function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return magnitude === 0 ? values : values.map((v) => v / magnitude);
}

export async function geminiEmbed(
  resolved: Resolved,
  req: EmbeddingRequest,
  host: ModelHost,
): Promise<EmbeddingResult> {
  const { wireModel } = resolved;
  const model = GEMINI_EMBEDDING_MODELS[wireModel];
  if (!model) {
    throw new Error(
      `MODEL_MAP names "${wireModel}" as a Gemini embedding model, which this code does not know. ` +
        `Known: ${Object.keys(GEMINI_EMBEDDING_MODELS).join(', ')}.`,
    );
  }
  // Nothing we send can reach the limit without something upstream having
  // broken, so a refusal names that break instead of embedding a prefix and
  // calling it the text.
  const tooLong = req.input.find((text) => host.countTokens(text) > model.maxInputTokens);
  if (tooLong !== undefined) {
    throw new Error(
      `A text of ${host.countTokens(tooLong)} tokens was sent for embedding, over the ` +
        `${model.maxInputTokens}-token limit of ${wireModel}. ` +
        'Chunk it before embedding rather than embedding a prefix of it.',
    );
  }

  const client = geminiClient(host.env);
  const embeddings: number[][] = [];
  // One text per request. The docs give three different numbers on one page —
  // 250 input texts, then five, then "for gemini-embedding-001, each request
  // can only include a single input text". One is the only figure all three
  // readings allow.
  for (const text of req.input) {
    const response = await client.models.embedContent({
      model: wireModel,
      contents: text,
      config: {
        // No `taskType`: the callers do not divide into a document side and a
        // query side, so there is no honest pair to map onto Google's.
        autoTruncate: false,
        ...(req.dimensions === undefined ? {} : { outputDimensionality: req.dimensions }),
      },
    });
    const [embedding, ...extra] = response.embeddings ?? [];
    if (!embedding?.values || extra.length > 0) {
      throw new Error(`Gemini returned ${response.embeddings?.length ?? 0} embeddings for one text.`);
    }
    embeddings.push(embedding.values.length < model.max ? normalize(embedding.values) : embedding.values);

    host.recordUsage({
      resolved,
      callType: 'embedding',
      label: req.label,
      inputTokens: embedding.statistics?.tokenCount ?? 0,
      outputTokens: 0,
    }).catch(() => {});
  }
  return { embeddings };
}
