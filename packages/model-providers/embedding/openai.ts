// Embeddings on OpenAI.

import type { ModelHost } from '../host';
import type { Resolved } from 'movement-engine/lib/models/map';
import type { EmbeddingRequest, EmbeddingResult } from './index';

import { openAiClient } from '../providers/openai';
import { OPENAI_EMBEDDING_DIMENSIONS } from 'movement-engine/lib/models/embedding/range';

export async function openAiEmbed(
  resolved: Resolved,
  req: EmbeddingRequest,
  host: ModelHost,
): Promise<EmbeddingResult> {
  const { wireModel } = resolved;
  const native = OPENAI_EMBEDDING_DIMENSIONS[wireModel]?.max;
  const response = await openAiClient(host.env).embeddings.create({
    model: wireModel,
    input: req.input,
    // Omitted at the native width: naming it changes nothing but the request,
    // and the request without it is the one that has always worked.
    ...(req.dimensions === undefined || req.dimensions === native ? {} : { dimensions: req.dimensions }),
  });

  host.recordUsage({
    resolved,
    callType: 'embedding',
    label: req.label,
    inputTokens: response.usage.total_tokens,
    outputTokens: 0,
  }).catch(() => {});

  return { embeddings: response.data.map((d) => d.embedding) };
}
