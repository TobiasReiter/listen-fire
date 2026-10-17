// Image generation behind the model map, bound to the hosted product's
// environment and usage ledger. The vendors live in packages/model-providers.

import type { ImageModelName } from 'movement-engine/lib/models/registry';
import type { GeneratedImage, ImageRequest } from 'model-providers/image';

import { generateImage as generateImageWith } from 'model-providers/image';
import { hostedModelHost } from '../host';

export function generateImage(
  name: ImageModelName,
  req: ImageRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GeneratedImage> {
  return generateImageWith(name, req, hostedModelHost(env));
}

export type { GeneratedImage, ImageRequest };
