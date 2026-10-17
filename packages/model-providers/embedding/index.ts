// Embeddings behind the model map: the caller names a registry model and a
// width, and the map decides which vendor computes the vectors.

import type { ModelHost } from '../host';
import type { Resolved } from 'movement-engine/public/models';
import type { EmbeddingModelName } from 'movement-engine/public/models';

import { assertRunBudget } from 'movement-engine/public/models';
import { neverAsAny } from 'movement-engine/public/types';
import { assertCallable, resolveModel } from 'movement-engine/public/models';
import { geminiEmbed } from './gemini';
import { openAiEmbed } from './openai';

export interface EmbeddingRequest {
  input: string[];
  /** The width the vectors must have; the vendor's native width when absent. */
  dimensions?: number;
  label?: string;
}

export interface EmbeddingResult {
  embeddings: number[][];
}

export async function embed(
  name: EmbeddingModelName,
  req: EmbeddingRequest,
  host: ModelHost,
): Promise<EmbeddingResult> {
  const { env } = host;
  if (req.input.length === 0) return { embeddings: [] };
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  assertRunBudget();
  const { provider, wireModel } = resolved;
  const result = await embedOn(resolved, req, host);
  if (result.embeddings.length !== req.input.length) {
    throw new Error(
      `${provider}/${wireModel} returned ${result.embeddings.length} embeddings for ${req.input.length} texts.`,
    );
  }
  // A vector of the wrong width is a row Postgres refuses, or worse, one it
  // accepts into the wrong index; either way it never leaves here.
  const wrong = result.embeddings.find((v) => req.dimensions !== undefined && v.length !== req.dimensions);
  if (wrong) {
    throw new Error(
      `${provider}/${wireModel} returned a ${wrong.length}-dimension vector where ${req.dimensions} were asked for.`,
    );
  }
  return result;
}

function embedOn(resolved: Resolved, req: EmbeddingRequest, host: ModelHost): Promise<EmbeddingResult> {
  const { provider, preferred: name } = resolved;
  switch (provider) {
    case 'openai':
      return openAiEmbed(resolved, req, host);
    case 'gemini':
      return geminiEmbed(resolved, req, host);
    case 'anthropic':
    case 'vertex':
      // Boot validation refuses this map line; reaching it means the map was
      // never validated.
      throw new Error(`MODEL_MAP sends "${name}" to ${provider}, which does not serve embeddings.`);
    default:
      return neverAsAny(provider);
  }
}
