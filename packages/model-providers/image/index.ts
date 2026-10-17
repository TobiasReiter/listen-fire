// Image generation behind the model map: the caller names a registry model and
// gpt-image-1's knobs, and the map decides which vendor draws it.

import type { ModelHost } from '../host';
import type { ImageModelName } from 'movement-engine/public/models';

import { assertRunBudget } from 'movement-engine/public/models';
import { neverAsAny } from 'movement-engine/public/utils';
import { assertCallable, resolveModel } from 'movement-engine/public/models';
import { geminiGenerateImage } from './gemini';
import { openAiGenerateImage } from './openai';

/** gpt-image-1's request shape, the interface every image provider answers.
 *  A provider that cannot honour a knob that is set refuses it by name. */
export interface ImageRequest {
  prompt: string;
  /** `1024x1024`, `1536x1024`, `1024x1536` or `auto`. */
  size?: string;
  /** `low`, `medium`, `high` or `auto`. */
  quality?: string;
  label?: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

export async function generateImage(
  name: ImageModelName,
  req: ImageRequest,
  host: ModelHost,
): Promise<GeneratedImage> {
  const { env } = host;
  const resolved = resolveModel(name, env);
  assertCallable(resolved, env);
  assertRunBudget();
  const { provider, wireModel } = resolved;
  switch (provider) {
    case 'openai':
      return openAiGenerateImage(resolved, req, host);
    case 'gemini':
      return geminiGenerateImage(wireModel, req, env);
    case 'anthropic':
    case 'vertex':
      // Boot validation refuses this map line; reaching it means the map was
      // never validated.
      throw new Error(`MODEL_MAP sends "${name}" to ${provider}, which does not generate images.`);
    default:
      return neverAsAny(provider);
  }
}
