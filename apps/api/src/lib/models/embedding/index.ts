// Embeddings behind the model map, bound to the hosted product's environment,
// usage ledger and tokenizer. The vendors live in packages/model-providers.

import type { EmbeddingModelName } from 'movement-engine/lib/models/registry';
import type { EmbeddingRequest, EmbeddingResult } from 'model-providers/embedding';

import { embed as embedWith } from 'model-providers/embedding';
import { hostedModelHost } from '../host';

export function embed(
  name: EmbeddingModelName,
  req: EmbeddingRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddingResult> {
  return embedWith(name, req, hostedModelHost(env));
}

export type { EmbeddingRequest, EmbeddingResult };
