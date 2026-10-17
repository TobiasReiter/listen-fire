// Speech to text behind the map: who hears the audio, what each vendor is sent,
// and what each refuses by name rather than sending and hoping.

const transcriptionsCreate = jest.fn();
jest.mock('../../providers/openai', () => ({
  openAiClient: () => ({ audio: { transcriptions: { create: transcriptionsCreate } } }),
}));

const generateContent = jest.fn();
jest.mock('../../providers/gemini', () => ({
  geminiClient: () => ({ models: { generateContent } }),
}));

const recordLlmUsage = jest.fn().mockResolvedValue(undefined);

import { transcribe } from '..';
import { testHost } from '../../__test__/test_host';

const host = (env: NodeJS.ProcessEnv) => testHost(env, (usage) => recordLlmUsage(usage));
import { geminiAudioMimeType } from '../audio_format';
import { GEMINI_INLINE_AUDIO_MAX_BYTES } from '../gemini';

/** An Ogg container's first four bytes are the whole claim. */
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);
const M4A = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(64)]);
const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
const FLAC = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16)]);
const UNKNOWN = Buffer.alloc(20);
const NOT_AUDIO = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(64)]);

const GEMINI_ENV = {
  MODEL_MAP: JSON.stringify({ 'whisper-1': 'gemini/gemini-3.8-flash' }),
};

beforeEach(() => {
  transcriptionsCreate.mockReset().mockResolvedValue({ text: 'hello world', duration: 2.4 });
  generateContent.mockReset().mockResolvedValue({
    candidates: [{ content: { parts: [{ text: 'the words ' }, { text: 'that were said' }] } }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 },
  });
  recordLlmUsage.mockClear();
});

describe('who hears the audio', () => {
  it('is OpenAI when the map says nothing', async () => {
    const result = await transcribe('whisper-1', { audio: OGG, name: 'voice.ogg' }, host({}));
    expect(result).toEqual({ text: 'hello world', durationSeconds: 2.4 });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('is Gemini, under the map’s own wire model, where the map sends Whisper there', async () => {
    const result = await transcribe('whisper-1', { audio: OGG }, host(GEMINI_ENV));
    expect(result).toEqual({ text: 'the words that were said' });
    expect(transcriptionsCreate).not.toHaveBeenCalled();
    expect(generateContent.mock.calls[0][0].model).toBe('gemini-3.8-flash');
  });

  it("follows Whisper's own map line rather than Claude's", async () => {
    await transcribe('whisper-1', { audio: OGG }, host({ MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'vertex/x' }) }));
    expect(transcriptionsCreate).toHaveBeenCalled();
  });
});

describe('OpenAI', () => {
  async function uploadedName(audio: Buffer, options: { name?: string; contentType?: string }) {
    await transcribe('whisper-1', { audio, ...options }, host({}));
    const [params] = transcriptionsCreate.mock.calls[0];
    return params.file.name;
  }

  it('asks for verbose_json under the wire model, and retries as the old queue did', async () => {
    await transcribe('whisper-1', { audio: OGG, name: 'voice.ogg' }, host({}));
    const [params, options] = transcriptionsCreate.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ model: 'whisper-1', response_format: 'verbose_json' }));
    expect(options).toEqual({ maxRetries: 3 });
  });

  it('appends the sniffed extension when the name has none (the WhatsApp voice-note case)', async () => {
    expect(await uploadedName(OGG, { name: 'wamid.HBgMNDQ3', contentType: 'audio/ogg; codecs=opus' })).toBe(
      'wamid.HBgMNDQ3.ogg',
    );
  });

  it.each([
    ['mp3 (ID3)', MP3_ID3, 'mp3'],
    ['wav (RIFF/WAVE)', WAV, 'wav'],
    ['m4a (ftyp)', M4A, 'm4a'],
    ['webm (EBML)', WEBM, 'webm'],
    ['flac', FLAC, 'flac'],
  ])('sniffs %s from the bytes', async (_label, bytes, ext) => {
    expect(await uploadedName(bytes, { name: 'nameless' })).toBe(`nameless.${ext}`);
  });

  it('keeps a name that already carries a supported extension', async () => {
    expect(await uploadedName(OGG, { name: 'note.mp3' })).toBe('note.mp3');
  });

  it('falls back to the content type, then to ogg', async () => {
    expect(await uploadedName(UNKNOWN, { name: 'blob', contentType: 'audio/mpeg' })).toBe('blob.mp3');
    transcriptionsCreate.mockClear();
    expect(await uploadedName(UNKNOWN, {})).toBe('audio.ogg');
  });
});

describe('Gemini', () => {
  it('sends the audio inline under Gemini’s spelling of its MIME type, at temperature 0', async () => {
    await transcribe('whisper-1', { audio: OGG, contentType: 'audio/mpeg' }, host(GEMINI_ENV));
    const [request] = generateContent.mock.calls[0];
    expect(request.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'audio/ogg', data: OGG.toString('base64') },
    });
    expect(request.contents[0].parts[1].text).toMatch(/^Transcribe this audio verbatim/);
    expect(request.config).toEqual({ temperature: 0 });
  });

  it('reads a blocked candidate as nothing said, not as an error', async () => {
    generateContent.mockResolvedValue({ candidates: [{}] });
    await expect(transcribe('whisper-1', { audio: OGG }, host(GEMINI_ENV))).resolves.toEqual({ text: '' });
  });

  it('bills Gemini under the wire model, keeping the name the caller asked for', async () => {
    await transcribe('whisper-1', { audio: OGG, label: 'l' }, host(GEMINI_ENV));
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: { preferred: 'whisper-1', provider: 'gemini', wireModel: 'gemini-3.8-flash' },
        inputTokens: 30,
        outputTokens: 5,
      }),
    );
  });

  it('refuses a format by name rather than sending it and hoping', async () => {
    await expect(
      transcribe('whisper-1', { audio: NOT_AUDIO, name: 'recording.aiff', contentType: 'audio/aiff' }, host(GEMINI_ENV)),
    ).rejects.toThrow(/does not accept this audio format.*audio\/aiff/s);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('names the inline size limit rather than letting Google discover it', async () => {
    const tooBig = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(GEMINI_INLINE_AUDIO_MAX_BYTES)]);
    await expect(transcribe('whisper-1', { audio: tooBig }, host(GEMINI_ENV))).rejects.toThrow(
      new RegExp(`over the ${GEMINI_INLINE_AUDIO_MAX_BYTES}-byte limit`),
    );
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe('naming the format Gemini is given', () => {
  it('believes the bytes over the declared content type', () => {
    // WhatsApp calls an Ogg/Opus voice note `audio/mpeg` often enough to matter.
    expect(geminiAudioMimeType(OGG, { contentType: 'audio/mpeg' })).toBe('audio/ogg');
  });

  it('spells each container the way Gemini does', () => {
    expect(geminiAudioMimeType(WAV, {})).toBe('audio/wav');
    expect(geminiAudioMimeType(M4A, {})).toBe('audio/m4a');
    expect(geminiAudioMimeType(OGG, {})).toBe('audio/ogg');
  });

  it('falls back to the content type when the bytes say nothing', () => {
    // Opus rides in an Ogg container, and AAC is `audio/x-aac` to Gemini.
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/ogg; codecs=opus' })).toBe('audio/ogg');
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/aac' })).toBe('audio/x-aac');
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/x-m4a' })).toBe('audio/m4a');
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/webm' })).toBe('audio/webm');
  });

  it('knows nothing about a format Gemini does not serve', () => {
    expect(geminiAudioMimeType(NOT_AUDIO, { contentType: 'audio/aiff' })).toBeUndefined();
    expect(geminiAudioMimeType(NOT_AUDIO, {})).toBeUndefined();
  });
});
