// Speech to text on OpenAI: the audio travels as a multipart upload, and the
// endpoint reads its FORMAT from the uploaded filename's extension.

import { toFile } from 'openai';

import type { TranscriptionRequest, TranscriptionResult } from './index';

import { logger } from '../../../services/logger';
import { openAiClient } from '../providers/openai';
import { sniffContainer } from './audio_format';

// The endpoint 400s on any extension outside this set, and a channel that
// delivers nameless audio (a WhatsApp voice note's name falls back to the
// message id) needs the extension derived, not trusted.
const SUPPORTED_EXTENSIONS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

const EXTENSION_BY_CONTENT_TYPE: Array<[string, string]> = [
  ['audio/ogg', 'ogg'],
  ['audio/opus', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/aac', 'm4a'], // AAC usually arrives in an MP4 container in practice
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/webm', 'webm'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
];

function extensionFromContentType(contentType?: string): string | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.toLowerCase();
  return EXTENSION_BY_CONTENT_TYPE.find(([prefix]) => normalized.startsWith(prefix))?.[1];
}

/** The multipart filename OpenAI reads the format from: keep a name that
 *  already ends in a supported extension; otherwise append one derived from
 *  the bytes, then the content type, then the ogg default (voice notes are
 *  the overwhelmingly common nameless case). */
export function uploadName(audio: Buffer, options: { name?: string; contentType?: string }): string {
  const name = options.name ?? 'audio';
  const lower = name.toLowerCase();
  if (SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`))) return name;
  const extension = sniffContainer(audio) ?? extensionFromContentType(options.contentType) ?? 'ogg';
  return `${name}.${extension}`;
}

/** Four attempts in all, as the queue this replaced made: a voice note is
 *  worth waiting out a rate limit for, and the SDK's backoff honours
 *  `retry-after`. */
const MAX_RETRIES = 3;

export async function openAiTranscribe(
  wireModel: string,
  req: TranscriptionRequest,
  env: NodeJS.ProcessEnv,
): Promise<TranscriptionResult> {
  const name = uploadName(req.audio, req);
  logger.info(`OpenAI transcription submitted ${req.label ? `(${req.label})` : ''}`, {
    model: wireModel,
    name,
    bytes: req.audio.length,
  });
  const transcription = await openAiClient(env).audio.transcriptions.create(
    {
      file: await toFile(req.audio, name),
      model: wireModel,
      // verbose_json is the format that carries the audio's duration.
      response_format: 'verbose_json',
    },
    { maxRetries: MAX_RETRIES },
  );
  return { text: transcription.text ?? '', durationSeconds: transcription.duration };
}
