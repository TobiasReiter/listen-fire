// Image generation on OpenAI's images endpoint.

import { z } from 'zod';

import type { Resolved } from 'movement-engine/lib/models/map';
import type { GeneratedImage, ImageRequest } from './index';

import { logger } from 'movement-engine/services/logger';
import { recordLlmUsage } from '../../llm_usage';
import { openAiClient } from '../providers/openai';


// The values gpt-image-1 takes, from the images reference
// (https://developers.openai.com/api/reference/python/resources/images/methods/generate,
// checked 2026-09-24) and the SDK's `ImageGenerateParams`. Parsed rather than
// asserted: an unknown value should fail here naming the field, not as a 400
// naming nothing we wrote. Unset knobs are not sent, so OpenAI's own `auto`
// applies. `style` and `response_format` are gone because the endpoint now
// refuses them as unknown parameters, and a GPT image model always answers in
// base64.
const GptImageOptions = z.object({
  size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).optional(),
  quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
});

export async function openAiGenerateImage(
  resolved: Resolved,
  req: ImageRequest,
  env: NodeJS.ProcessEnv,
): Promise<GeneratedImage> {
  const { wireModel } = resolved;
  const options = GptImageOptions.safeParse({ size: req.size, quality: req.quality });
  if (!options.success) {
    throw new Error(`An image request OpenAI cannot take: ${options.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { size, quality } = options.data;
  logger.info(`OpenAI image submitted ${req.label ? `(${req.label})` : ''}`, { model: wireModel });
  const response = await openAiClient(env).images.generate({
    model: wireModel,
    prompt: req.prompt,
    n: 1,
    ...(size === undefined ? {} : { size }),
    ...(quality === undefined ? {} : { quality }),
  });

  // Priced per token like any other call: the reply counts the prompt's tokens
  // and the image's.
  if (response.usage) {
    recordLlmUsage({
      resolved,
      callType: 'image',
      label: req.label,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }).catch(() => {});
  }

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${wireModel} returned no image data.`);
  return { bytes: Buffer.from(b64, 'base64'), mimeType: `image/${response.output_format ?? 'png'}` };
}
