// What kind of audio this actually is.
//
// A channel that delivers nameless audio is the normal case, not the edge one —
// a WhatsApp voice note's name falls back to the message id, and a Slack one
// arrives as `audio/ogg; codecs=opus`. Both transcription providers need the same
// answer to the same question, so the sniffing lives here rather than twice.

/** Sniff the container format from its magic bytes — the bytes are the truth
 *  the filename and content type only gesture at. */
export function sniffContainer(audio: Buffer): string | undefined {
  if (audio.length < 12) return undefined;
  if (audio.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (audio.subarray(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (
    audio.subarray(0, 4).toString('latin1') === 'RIFF' &&
    audio.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'wav';
  }
  if (audio.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (audio.readUInt32BE(0) === 0x1a45dfa3) return 'webm'; // EBML (webm/mkv)
  if (audio.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  return undefined;
}

/**
 * The exact MIME spellings Gemini accepts for audio, verified 2026-09-17 against
 * the "Supported MIME types" row of
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash
 * (the same list appears on every 3.x model page).
 *
 * The spellings matter: it is `audio/x-aac`, not `audio/aac`, and `audio/aiff`
 * is absent entirely.
 */
const GEMINI_AUDIO_MIME_TYPES = new Set([
  'audio/x-aac',
  'audio/flac',
  'audio/mp3',
  'audio/m4a',
  'audio/mpeg',
  'audio/mpga',
  'audio/mp4',
  'audio/ogg',
  'audio/pcm',
  'audio/wav',
  'audio/webm',
]);

/** What a sniffed container is called in Gemini's spelling. */
const GEMINI_MIME_BY_CONTAINER: Record<string, string> = {
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  m4a: 'audio/m4a',
  webm: 'audio/webm',
  mp3: 'audio/mp3',
};

/** The content types our channels actually send, in Gemini's spelling. Opus
 *  arrives in an Ogg container, and AAC in an MP4 one — both are named after
 *  their codec upstream and after their container here. */
const GEMINI_MIME_BY_CONTENT_TYPE: Array<[string, string]> = [
  ['audio/ogg', 'audio/ogg'],
  ['audio/opus', 'audio/ogg'],
  ['audio/mpeg', 'audio/mpeg'],
  ['audio/mp3', 'audio/mp3'],
  ['audio/mp4', 'audio/mp4'],
  ['audio/x-m4a', 'audio/m4a'],
  ['audio/m4a', 'audio/m4a'],
  ['audio/aac', 'audio/x-aac'],
  ['audio/x-aac', 'audio/x-aac'],
  ['audio/wav', 'audio/wav'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/wave', 'audio/wav'],
  ['audio/webm', 'audio/webm'],
  ['audio/flac', 'audio/flac'],
  ['audio/x-flac', 'audio/flac'],
];

/**
 * The MIME type to hand Gemini, or nothing when this is a format it does not
 * take. The bytes answer first and the declared content type second, because a
 * channel's content type is a claim and the container is a fact.
 */
export function geminiAudioMimeType(
  audio: Buffer,
  options: { contentType?: string },
): string | undefined {
  const sniffed = sniffContainer(audio);
  if (sniffed && GEMINI_MIME_BY_CONTAINER[sniffed]) return GEMINI_MIME_BY_CONTAINER[sniffed];

  const declared = options.contentType?.toLowerCase();
  if (!declared) return undefined;
  const mapped = GEMINI_MIME_BY_CONTENT_TYPE.find(([prefix]) => declared.startsWith(prefix))?.[1];
  if (mapped) return mapped;

  // A content type that is already one of Gemini's own spellings passes through.
  const bare = declared.split(';')[0].trim();
  return GEMINI_AUDIO_MIME_TYPES.has(bare) ? bare : undefined;
}
