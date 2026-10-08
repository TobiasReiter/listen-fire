// Embeddings on OpenAI.

import { recordLlmUsage } from '../../llm_usage';
import { openAiClient } from '../providers/openai';
import type { Resolved } from '../map';
import type { EmbeddingRequest, EmbeddingResult } from './index';
import { OPENAI_EMBEDDING_DIMENSIONS } from './range';

export async function openAiEmbed(
  resolved: Resolved,
  req: EmbeddingRequest,
  env: NodeJS.ProcessEnv,
): Promise<EmbeddingResult> {
  const { wireModel } = resolved;
  const native = OPENAI_EMBEDDING_DIMENSIONS[wireModel]?.max;
  const response = await openAiClient(env).embeddings.create({
    model: wireModel,
    input: req.input,
    // Omitted at the native width: naming it changes nothing but the request,
    // and the request without it is the one that has always worked.
    ...(req.dimensions === undefined || req.dimensions === native ? {} : { dimensions: req.dimensions }),
  });

  recordLlmUsage({
    resolved,
    callType: 'embedding',
    label: req.label,
    inputTokens: response.usage.total_tokens,
    outputTokens: 0,
  }).catch(() => {});

  return { embeddings: response.data.map((d) => d.embedding) };
}
