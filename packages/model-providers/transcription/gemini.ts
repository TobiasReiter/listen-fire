// Speech to text on Gemini: the audio travels inside a `generateContent`
// request as an inline part, with its MIME type as a MIME type, and the model
// is asked for the words.

import type { ModelHost } from '../host';
import type { Resolved } from 'movement-engine/public/models';
import type { TranscriptionRequest, TranscriptionResult } from './index';

import { logger } from 'movement-engine/public/log';
import { geminiClient } from '../providers/gemini';
import { geminiAudioMimeType } from './audio_format';

/**
 * How many bytes of audio may travel INSIDE the request.
 *
 * Google publishes no inline ceiling for audio specifically. What it does
 * publish, on the Gemini 3.8 Flash model page, is 7 MB per inline file (stated
 * for images) and 15 MB for audio it fetches from an HTTP URL — so 7 MB is the
 * smaller of the two documented inline figures and the one we hold ourselves
 * to rather than discovering the real number as a failed transcription. Base64
 * inflates the body by a third, which this is the raw-bytes side of.
 *
 * For scale: a ten-minute Opus voice note is well under 1 MB. A file that trips
 * this is a recording, not a message, and the honest answer is to say so.
 */
export const GEMINI_INLINE_AUDIO_MAX_BYTES = 7 * 1024 * 1024;

/**
 * The prompt asks for the words and nothing else on purpose: a model told to
 * "transcribe" will otherwise happily add a summary, a speaker guess or an
 * apology, and every one of those becomes text the extraction downstream
 * treats as something the speaker said.
 */
const TRANSCRIBE_PROMPT =
  'Transcribe this audio verbatim. Output only the spoken words, as plain text. ' +
  'Do not add speaker labels, timestamps, commentary, or any note about the audio ' +
  'itself. If nothing is said, output nothing.';

export async function geminiTranscribe(
  resolved: Resolved,
  req: TranscriptionRequest,
  host: ModelHost,
): Promise<TranscriptionResult> {
  const { wireModel } = resolved;
  // A format Gemini does not take fails by name here rather than being sent
  // and hoped for: the endpoint's own refusal names a MIME type nobody
  // upstream ever wrote down.
  const mimeType = geminiAudioMimeType(req.audio, { contentType: req.contentType });
  if (!mimeType) {
    throw new Error(
      `Gemini does not accept this audio format (name "${req.name ?? 'unnamed'}", ` +
        `content type "${req.contentType ?? 'none'}", and its bytes name no container ` +
        'Gemini serves).',
    );
  }
  if (req.audio.length > GEMINI_INLINE_AUDIO_MAX_BYTES) {
    throw new Error(
      `The audio is ${req.audio.length} bytes, over the ${GEMINI_INLINE_AUDIO_MAX_BYTES}-byte limit ` +
        'for audio sent inside a Gemini request.',
    );
  }

  logger.info(`Gemini transcription submitted ${req.label ? `(${req.label})` : ''}`, {
    model: wireModel,
    mimeType,
    bytes: req.audio.length,
  });

  const startMs = Date.now();
  const response = await geminiClient(host.env).models.generateContent({
    model: wireModel,
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data: req.audio.toString('base64') } }, { text: TRANSCRIBE_PROMPT }],
      },
    ],
    config: { temperature: 0 },
  });

  // Read from the parts rather than the SDK's `text` getter: a safety-blocked
  // candidate carries no parts, which is an empty transcript the caller
  // reports, not an error.
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');

  host.recordUsage({
    resolved,
    callType: 'chat',
    label: req.label,
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    durationMs: Date.now() - startMs,
  }).catch(() => {});

  // No duration: Gemini answers with words, and nothing downstream reads one.
  return { text };
}
