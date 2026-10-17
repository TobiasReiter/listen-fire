// Speech to text behind the model map: the caller names a registry model, and
// the map decides which vendor hears the audio.

import type { ModelHost } from '../host';
import type { TranscriptionModelName } from 'movement-engine/public/models';

import { assertRunBudget } from 'movement-engine/public/models';
import { neverAsAny } from 'movement-engine/public/utils';
import { assertCallable, resolveModel } from 'movement-engine/public/models';
import { geminiTranscribe } from './gemini';
import { openAiTranscribe } from './openai';

export interface TranscriptionRequest {
  audio: Buffer;
  /** The file's own name, when it has one; OpenAI reads the format from it. */
  name?: string;
  contentType?: string;
  label?: string;
}

export interface TranscriptionResult {
  text: string;
  /**
   * Length of the source audio in seconds, where the provider hands it over
   * for free (OpenAI's `verbose_json` does). Nothing reads it today, so a
   * provider that does not volunteer the number leaves it out rather than
   * decoding the audio to produce one.
   */
  durationSeconds?: number;
}

export async function transcribe(
  name: TranscriptionModelName,
  req: TranscriptionRequest,
  host: ModelHost,
): Promise<TranscriptionResult> {
  const { env } = host;
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  assertRunBudget();
  const { provider, wireModel } = resolved;
  switch (provider) {
    case 'openai':
      return openAiTranscribe(wireModel, req, env);
    case 'gemini':
      return geminiTranscribe(resolved, req, host);
    case 'anthropic':
    case 'vertex':
      // Boot validation refuses this map line; reaching it means the map was
      // never validated.
      throw new Error(`MODEL_MAP sends "${name}" to ${provider}, which does not transcribe audio.`);
    default:
      return neverAsAny(provider);
  }
}
