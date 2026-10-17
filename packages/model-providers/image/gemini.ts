// Image generation on Gemini: a `generateContent` call to an image model, asked
// for an image back, whose reply carries the picture as an inline part.

import type { GeneratedImage, ImageRequest } from './index';

import { logger } from 'movement-engine/public/log';
import { geminiClient } from '../providers/gemini';

/** What Gemini draws: the square, 1K picture image generation on Google has
 *  always asked for. */
const IMAGE_CONFIG = { aspectRatio: '1:1', imageSize: '1K' };

/**
 * `size` and `quality` are gpt-image-1's vocabulary, and neither has an honest
 * Gemini reading: a pixel size is not an aspect ratio and resolution tier, and
 * Gemini has no quality knob. Set, each is refused by name rather than dropped,
 * because a caller that asked for a landscape image and got a square one was
 * told nothing.
 */
function refuseUnhonoured(feature: 'size' | 'quality', value: string | undefined): void {
  if (value === undefined) return;
  throw new Error(
    `Image ${feature} "${value}" is not supported by the gemini provider. ` +
      `Leave ${feature} unset, or map the image model to openai.`,
  );
}

export async function geminiGenerateImage(
  wireModel: string,
  req: ImageRequest,
  env: NodeJS.ProcessEnv,
): Promise<GeneratedImage> {
  refuseUnhonoured('size', req.size);
  refuseUnhonoured('quality', req.quality);
  logger.info(`Gemini image submitted ${req.label ? `(${req.label})` : ''}`, { model: wireModel });
  // The model region, like every other Gemini call: GOOGLE_PROJECT_LOCATION is
  // the OCR location, which can be a multi-region such as `eu` that serves no
  // model at all (proven 2026-09-25 with a 404 on Project A's project).
  const client = geminiClient(env);
  const response = await client.models.generateContent({
    model: wireModel,
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: IMAGE_CONFIG },
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part.inlineData?.mimeType?.startsWith('image/'))?.inlineData;
  if (!image?.data || !image.mimeType) throw new Error(`${wireModel} returned no image data.`);
  return { bytes: Buffer.from(image.data, 'base64'), mimeType: image.mimeType };
}
