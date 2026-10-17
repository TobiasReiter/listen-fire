// Image generation behind the map: who draws it, what each vendor is sent, and
// what comes back as bytes.

const imagesGenerate = jest.fn();
jest.mock('../../providers/openai', () => ({
  openAiClient: () => ({ images: { generate: imagesGenerate } }),
}));

const generateContent = jest.fn();
const geminiClient = jest.fn(() => ({ models: { generateContent } }));
jest.mock('../../providers/gemini', () => ({
  geminiClient: (...args: unknown[]) => geminiClient(...(args as [])),
}));

jest.mock('movement-engine/services/logger', () => ({ logger: { info: jest.fn() } }));

const recordLlmUsage = jest.fn().mockResolvedValue(undefined);

import { generateImage } from '..';
import { testHost } from '../../__test__/test_host';

const host = (env: NodeJS.ProcessEnv) => testHost(env, (usage) => recordLlmUsage(usage));

const PNG_B64 = Buffer.from('png-bytes').toString('base64');

const GEMINI_ENV = {
  MODEL_MAP: JSON.stringify({ 'gpt-image-1': 'gemini/gemini-3.1-flash-image-preview' }),
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
  GOOGLE_PROJECT_LOCATION: 'europe-west4',
};

const USAGE = { input_tokens: 12, output_tokens: 272, total_tokens: 284, input_tokens_details: { text_tokens: 12, image_tokens: 0 } };

beforeEach(() => {
  imagesGenerate.mockReset().mockResolvedValue({ data: [{ b64_json: PNG_B64 }], usage: USAGE });
  generateContent.mockReset().mockResolvedValue({
    candidates: [
      { content: { parts: [{ text: 'Here it is.' }, { inlineData: { mimeType: 'image/jpeg', data: PNG_B64 } }] } },
    ],
  });
  geminiClient.mockClear();
  recordLlmUsage.mockClear();
});

describe('OpenAI, where the map leaves gpt-image-1 at home', () => {
  it('sends only the prompt when nothing else is asked for, whatever Google credentials exist', async () => {
    const image = await generateImage('gpt-image-1', { prompt: 'a leaf' }, host({ ...GEMINI_ENV, MODEL_MAP: '' }));
    expect(imagesGenerate).toHaveBeenCalledWith({ model: 'gpt-image-1', prompt: 'a leaf', n: 1 });
    expect(image).toEqual({ bytes: Buffer.from('png-bytes'), mimeType: 'image/png' });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('sends size and quality in gpt-image-1’s own words, and never style or response_format', async () => {
    await generateImage('gpt-image-1', { prompt: 'a leaf', size: '1536x1024', quality: 'high' }, host({}));
    const [params] = imagesGenerate.mock.calls[0];
    expect(params).toEqual({ model: 'gpt-image-1', prompt: 'a leaf', n: 1, size: '1536x1024', quality: 'high' });
    expect(params).not.toHaveProperty('style');
    expect(params).not.toHaveProperty('response_format');
  });

  it('names the format the reply says it is in', async () => {
    imagesGenerate.mockResolvedValue({ data: [{ b64_json: PNG_B64 }], output_format: 'webp' });
    const image = await generateImage('gpt-image-1', { prompt: 'a leaf' }, host({}));
    expect(image.mimeType).toBe('image/webp');
  });

  it('refuses a DALL·E size or quality, naming the field', async () => {
    await expect(generateImage('gpt-image-1', { prompt: 'a leaf', size: '1792x1024' }, host({}))).rejects.toThrow(/size/);
    await expect(generateImage('gpt-image-1', { prompt: 'a leaf', quality: 'hd' }, host({}))).rejects.toThrow(/quality/);
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it('bills the tokens the reply counts', async () => {
    await generateImage('gpt-image-1', { prompt: 'a leaf', label: 'l' }, host({}));
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: { preferred: 'gpt-image-1', provider: 'openai', wireModel: 'gpt-image-1' },
        callType: 'image',
        inputTokens: 12,
        outputTokens: 272,
      }),
    );
  });
});

describe('Gemini, where the map sends gpt-image-1', () => {
  it('asks the mapped image model for a square image, in the model region', async () => {
    const image = await generateImage('gpt-image-1', { prompt: 'a leaf' }, host(GEMINI_ENV));
    expect(geminiClient).toHaveBeenCalledWith(GEMINI_ENV);
    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-image-preview',
      contents: [{ role: 'user', parts: [{ text: 'a leaf' }] }],
      config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '1K' } },
    });
    expect(image).toEqual({ bytes: Buffer.from('png-bytes'), mimeType: 'image/jpeg' });
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it('refuses a size or a quality it cannot honour, naming the feature and the provider', async () => {
    await expect(generateImage('gpt-image-1', { prompt: 'a leaf', size: '1536x1024' }, host(GEMINI_ENV))).rejects.toThrow(
      /Image size "1536x1024" is not supported by the gemini provider/,
    );
    await expect(generateImage('gpt-image-1', { prompt: 'a leaf', quality: 'high' }, host(GEMINI_ENV))).rejects.toThrow(
      /Image quality "high" is not supported by the gemini provider/,
    );
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('says so when the reply carries no picture', async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'I cannot.' }] } }] });
    await expect(generateImage('gpt-image-1', { prompt: 'a leaf' }, host(GEMINI_ENV))).rejects.toThrow(
      /gemini-3.1-flash-image-preview returned no image data/,
    );
  });
});
