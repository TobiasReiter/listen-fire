// Embeddings behind the map: which vendor, what width is asked for, and what
// happens to a text or a vector that does not fit.

const embeddingsCreate = jest.fn();
jest.mock('../../providers/openai', () => ({
  openAiClient: () => ({ embeddings: { create: embeddingsCreate } }),
}));

const embedContent = jest.fn();
jest.mock('../../providers/gemini', () => ({
  geminiClient: () => ({ models: { embedContent } }),
}));

const recordLlmUsage = jest.fn().mockResolvedValue(undefined);

import { embed } from '..';
import { testHost } from '../../__test__/test_host';

const host = (env: NodeJS.ProcessEnv) => testHost(env, (usage) => recordLlmUsage(usage));

const GEMINI_ENV = {
  MODEL_MAP: JSON.stringify({
    'text-embedding-3-large': 'gemini/gemini-embedding-001',
    'text-embedding-3-small': 'gemini/gemini-embedding-001',
  }),
};

/** A Gemini embedding of `width` ones, so its magnitude is sqrt(width). */
function geminiResponds(width: number) {
  embedContent.mockResolvedValue({
    embeddings: [{ values: Array.from({ length: width }, () => 1), statistics: { tokenCount: 4 } }],
  });
}

beforeEach(() => {
  embeddingsCreate.mockReset();
  embedContent.mockReset();
  recordLlmUsage.mockClear();
});

it('asks nobody when there is nothing to embed', async () => {
  await expect(embed('text-embedding-3-large', { input: [] }, host({}))).resolves.toEqual({ embeddings: [] });
  expect(embeddingsCreate).not.toHaveBeenCalled();
  expect(embedContent).not.toHaveBeenCalled();
});

describe('OpenAI, where the map leaves embeddings at home', () => {
  const vector = (n: number) => Array.from({ length: n }, () => 0.1);

  it('omits dimensions at the model’s native width', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ embedding: vector(3072) }], usage: { total_tokens: 7 } });
    await embed('text-embedding-3-large', { input: ['hello'], dimensions: 3072 }, host({}));
    expect(embeddingsCreate).toHaveBeenCalledWith({ model: 'text-embedding-3-large', input: ['hello'] });
  });

  it('names a shorter width', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ embedding: vector(256) }], usage: { total_tokens: 7 } });
    await embed('text-embedding-3-small', { input: ['hello'], dimensions: 256 }, host({}));
    expect(embeddingsCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: ['hello'],
      dimensions: 256,
    });
  });

  it('bills OpenAI', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ embedding: vector(3072) }], usage: { total_tokens: 7 } });
    await embed('text-embedding-3-large', { input: ['hello'], label: 'l' }, host({}));
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: { preferred: 'text-embedding-3-large', provider: 'openai', wireModel: 'text-embedding-3-large' },
        inputTokens: 7,
      }),
    );
  });
});

describe('Gemini, where the map sends embeddings', () => {
  it('asks for the width, one text per request, and refuses silent truncation', async () => {
    geminiResponds(3072);
    await embed('text-embedding-3-large', { input: ['one', 'two'], dimensions: 3072 }, host(GEMINI_ENV));
    expect(embedContent).toHaveBeenCalledTimes(2);
    expect(embedContent.mock.calls[1][0]).toEqual({
      model: 'gemini-embedding-001',
      contents: 'two',
      config: { autoTruncate: false, outputDimensionality: 3072 },
    });
  });

  it('puts a shortened vector back on the unit sphere', async () => {
    geminiResponds(256);
    const { embeddings } = await embed('text-embedding-3-small', { input: ['hello'], dimensions: 256 }, host(GEMINI_ENV));
    const magnitude = Math.sqrt(embeddings[0].reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it('leaves a full-length vector alone, because Google normalised it already', async () => {
    geminiResponds(3072);
    const { embeddings } = await embed('text-embedding-3-large', { input: ['hello'], dimensions: 3072 }, host(GEMINI_ENV));
    expect(embeddings[0][0]).toBe(1);
  });

  it('refuses a text over the model’s per-text token limit', async () => {
    const huge = 'word '.repeat(9000);
    await expect(embed('text-embedding-3-large', { input: [huge] }, host(GEMINI_ENV))).rejects.toThrow(
      /over the 2048-token limit of gemini-embedding-001/,
    );
    expect(embedContent).not.toHaveBeenCalled();
  });

  it('bills Gemini, under the wire model', async () => {
    geminiResponds(3072);
    await embed('text-embedding-3-large', { input: ['hello'], label: 'l' }, host(GEMINI_ENV));
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: { preferred: 'text-embedding-3-large', provider: 'gemini', wireModel: 'gemini-embedding-001' },
        callType: 'embedding',
        inputTokens: 4,
      }),
    );
  });
});

describe('whatever the vendor', () => {
  it('refuses a vector that is not the width it asked for', async () => {
    geminiResponds(768);
    await expect(
      embed('text-embedding-3-large', { input: ['hello'], dimensions: 3072 }, host(GEMINI_ENV)),
    ).rejects.toThrow(/gemini\/gemini-embedding-001 returned a 768-dimension vector where 3072 were asked for/);
  });

  it('refuses a count of vectors that does not match the texts', async () => {
    embeddingsCreate.mockResolvedValue({ data: [], usage: { total_tokens: 0 } });
    await expect(embed('text-embedding-3-large', { input: ['a'] }, host({}))).rejects.toThrow(/returned 0 embeddings for 1 texts/);
  });
});
