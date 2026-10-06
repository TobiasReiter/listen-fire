// Golden fixtures for the Gemini translator, one per row of the design's
// translation table: an Anthropic request in and the exact `generateContent`
// request out; canned streamed chunks in and the exact Anthropic message out.
// The SDK client is mocked at its constructor, so nothing reaches a network;
// the wire itself is proven against the fake Gemini in apps/fake-channels.

import type Anthropic from '@anthropic-ai/sdk';
import {
  FinishReason,
  FunctionCallingConfigMode,
  GenerateContentResponse,
  ThinkingLevel,
} from '@google/genai';
import type { Content, GenerateContentConfig, Part } from '@google/genai';

const genaiCtor = jest.fn();
const generateContentStream = jest.fn();

jest.mock('@google/genai', () => ({
  ...jest.requireActual('@google/genai'),
  GoogleGenAI: jest.fn().mockImplementation(function (this: unknown, options: unknown) {
    genaiCtor(options);
    return { models: { generateContentStream: (params: unknown) => generateContentStream(params) } };
  }),
}));

const GOOGLE = {
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
  GOOGLE_PROJECT_LOCATION: 'europe-west4',
  GOOGLE_MODEL_REGION: 'us-central1',
};

// Re-imported per test: the provider is memoised for the process.
function load(env: NodeJS.ProcessEnv = GOOGLE) {
  let mod: typeof import('../gemini') | undefined;
  jest.isolateModules(() => {
    mod = require('../gemini');
  });
  if (!mod) throw new Error('module did not load');
  return mod.geminiChatProvider(env);
}

function chunk(fields: Partial<GenerateContentResponse>): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), fields);
}

function parts(list: Part[], finishReason?: FinishReason): GenerateContentResponse {
  return chunk({ candidates: [{ content: { role: 'model', parts: list }, ...(finishReason ? { finishReason } : {}) }] });
}

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 5 };

function replyWith(chunks: GenerateContentResponse[]): void {
  generateContentStream.mockImplementation(async () =>
    (async function* () {
      for (const c of chunks) yield c;
    })(),
  );
}

const DONE = [chunk({ responseId: 'r1', usageMetadata: USAGE, candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: FinishReason.STOP }] })];

const BASE = { model: 'gemini-3-pro', max_tokens: 1024 } as const;

/** What the translator hands the SDK: always a list of contents, never the
 *  SDK's looser single-content shorthands. */
type SentRequest = { model: string; contents: Content[]; config?: GenerateContentConfig };

/** The request the SDK was handed for one Anthropic call. */
async function requestFor(params: Anthropic.MessageCreateParamsNonStreaming): Promise<SentRequest> {
  generateContentStream.mockClear();
  replyWith(DONE);
  await load().messages.create(params);
  expect(generateContentStream).toHaveBeenCalledTimes(1);
  const sent: SentRequest = generateContentStream.mock.calls[0][0];
  return sent;
}

async function messageFor(chunks: GenerateContentResponse[]): Promise<Anthropic.Message> {
  replyWith(chunks);
  return load().messages.create({ ...BASE, messages: [{ role: 'user', content: 'hi' }] });
}

beforeEach(() => jest.clearAllMocks());

describe('the client', () => {
  it('addresses Vertex with the service account, in the model region rather than the project location', () => {
    load();
    expect(genaiCtor).toHaveBeenCalledWith({
      vertexai: true,
      project: 'a-project',
      location: 'us-central1',
      apiVersion: 'v1',
      googleAuthOptions: {
        credentials: { client_email: 'robot@example.iam.gserviceaccount.com', private_key: 'pk' },
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    });
  });

  it('addresses the global endpoint when no model region is set', () => {
    load({ ...GOOGLE, GOOGLE_MODEL_REGION: '' });
    expect(genaiCtor).toHaveBeenCalledWith(expect.objectContaining({ location: 'global' }));
  });

  it('talks to a redirected base URL with a stub key rather than minting a token', () => {
    load({ ...GOOGLE, GEMINI_BASE_URL: 'http://localhost:5556/gemini' });
    expect(genaiCtor).toHaveBeenCalledWith({
      vertexai: true,
      project: 'a-project',
      location: 'us-central1',
      apiVersion: 'v1',
      apiKey: 'dev-loop-gemini-key',
      httpOptions: { baseUrl: 'http://localhost:5556/gemini' },
    });
  });

  it('passes the abort signal through and streams for both entry points', async () => {
    const controller = new AbortController();
    replyWith(DONE);
    const provider = load();
    const params = { ...BASE, messages: [{ role: 'user' as const, content: 'hi' }] };
    const created = await provider.messages.create(params, { signal: controller.signal });
    replyWith(DONE);
    const streamed = await provider.messages.stream(params, { signal: controller.signal }).finalMessage();
    expect(streamed).toEqual(created);
    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(generateContentStream.mock.calls[0][0].config.abortSignal).toBe(controller.signal);
  });
});

describe('request: Anthropic in, Gemini out', () => {
  it('system text goes to systemInstruction, with cache_control stripped everywhere', async () => {
    expect(
      await requestFor({
        ...BASE,
        cache_control: { type: 'ephemeral' },
        system: [
          { type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Answer in English.' },
        ],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
      }),
    ).toEqual({
      model: 'gemini-3-pro',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: {
        maxOutputTokens: 1024,
        systemInstruction: { parts: [{ text: 'You are terse.' }, { text: 'Answer in English.' }] },
      },
    });
  });

  it('a string system prompt is one part', async () => {
    const request = await requestFor({ ...BASE, system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }] });
    expect(request.config?.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  });

  it('text, base64 image and PDF blocks become text and inlineData parts', async () => {
    const request = await requestFor({
      ...BASE,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in these?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } },
          ],
        },
      ],
    });
    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'What is in these?' },
          { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
          { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0x' } },
        ],
      },
    ]);
  });

  it('an image by URL raises, naming the feature and the provider', async () => {
    await expect(
      requestFor({
        ...BASE,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
      }),
    ).rejects.toThrow(/An image from a url source cannot be sent to gemini/);
  });

  it('tools become function declarations with their JSON schema', async () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const request = await requestFor({
      ...BASE,
      tools: [{ name: 'search', description: 'Search the web', input_schema: schema, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request.config?.tools).toEqual([
      { functionDeclarations: [{ name: 'search', description: 'Search the web', parametersJsonSchema: schema }] },
    ]);
  });

  it('a recursive tool schema is refused before anything is sent', async () => {
    const recursive = {
      type: 'object' as const,
      properties: { root: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } },
    };
    await expect(
      requestFor({ ...BASE, tools: [{ name: 'tree', input_schema: recursive }], messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/The JSON schema for "tree" is recursive, and MODEL_MAP sends this call to gemini/);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('a reused, non-recursive $defs schema is sent', async () => {
    const reused = {
      type: 'object' as const,
      properties: { a: { $ref: '#/$defs/Name' }, b: { $ref: '#/$defs/Name' } },
      $defs: { Name: { type: 'string' } },
    };
    const request = await requestFor({ ...BASE, tools: [{ name: 'pair', input_schema: reused }], messages: [{ role: 'user', content: 'hi' }] });
    expect(request.config?.tools).toEqual([{ functionDeclarations: [{ name: 'pair', parametersJsonSchema: reused }] }]);
  });

  it.each([
    [{ type: 'auto' as const }, { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }],
    [{ type: 'any' as const }, { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } }],
    [
      { type: 'tool' as const, name: 'search' },
      { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['search'] } },
    ],
  ])('tool_choice %j becomes %j', async (toolChoice, toolConfig) => {
    const request = await requestFor({
      ...BASE,
      tools: [{ name: 'search', input_schema: { type: 'object' } }],
      tool_choice: toolChoice,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request.config?.toolConfig).toEqual(toolConfig);
  });

  it('tool_use in history becomes functionCall, and tool_result a functionResponse by name', async () => {
    const request = await requestFor({
      ...BASE,
      messages: [
        { role: 'user', content: 'Look it up' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching.' },
            { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'acme' } },
            { type: 'tool_use', id: 'toolu_2', name: 'fetch', input: { url: 'https://acme.test' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'page' }] },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'no results', is_error: true },
          ],
        },
      ],
    });
    expect(request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Look it up' }] },
      {
        role: 'model',
        parts: [
          { text: 'Searching.' },
          { functionCall: { name: 'search', args: { query: 'acme' } } },
          { functionCall: { name: 'fetch', args: { url: 'https://acme.test' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'fetch', response: { output: 'page' } } },
          { functionResponse: { name: 'search', response: { error: 'no results' } } },
        ],
      },
    ]);
  });

  it('a failed tool_result becomes an error response, with empty content said to be empty', async () => {
    const request = await requestFor({
      ...BASE,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
            { type: 'tool_use', id: 'toolu_2', name: 'fetch', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'rate limited' }], is_error: true },
            { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true },
          ],
        },
      ],
    });
    expect(request.contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'search', response: { error: 'rate limited' } } },
        { functionResponse: { name: 'fetch', response: { error: '(no output)' } } },
      ],
    });
  });

  it('a non-text block inside a tool_result still raises', async () => {
    await expect(
      requestFor({
        ...BASE,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'shot', input: {} }] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                is_error: true,
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('A "image" block inside a tool_result cannot be sent to gemini');
  });

  it('a tool_result answers the most recent tool_use with its id, since ids restart every reply', async () => {
    const request = await requestFor({
      ...BASE,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'fetch', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'b' }] },
      ],
    });
    expect(request.contents[4]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'fetch', response: { output: 'b' } } }],
    });
  });

  it('a tool_result with no matching tool_use earlier in the request raises (review focus 2)', async () => {
    await expect(
      requestFor({
        ...BASE,
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'orphan' }] }],
      }),
    ).rejects.toThrow(/A tool_result answers "toolu_9", but no tool_use with that id comes before it/);
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it.each([
    ['low', ThinkingLevel.LOW],
    ['medium', ThinkingLevel.MEDIUM],
    ['high', ThinkingLevel.HIGH],
    ['xhigh', ThinkingLevel.HIGH],
    ['max', ThinkingLevel.HIGH],
  ] as const)('adaptive thinking at effort %s becomes thinking level %s', async (effort, level) => {
    const request = await requestFor({
      ...BASE,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request.config?.thinkingConfig).toEqual({ thinkingLevel: level, includeThoughts: true });
  });

  it('adaptive thinking with no effort is Anthropic’s default, high', async () => {
    const request = await requestFor({ ...BASE, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }] });
    expect(request.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.HIGH, includeThoughts: true });
  });

  it('budgeted thinking becomes a thinking budget; omitted display asks for no thoughts', async () => {
    const request = await requestFor({
      ...BASE,
      thinking: { type: 'enabled', budget_tokens: 4096, display: 'omitted' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request.config?.thinkingConfig).toEqual({ thinkingBudget: 4096, includeThoughts: false });
  });

  describe('a call that asked for no thinking', () => {
    const FLASH = { model: 'gemini-3.8-flash', max_tokens: 1024 } as const;
    const hi = [{ role: 'user' as const, content: 'hi' }];

    it('on Flash with thinking absent, turns thinking off', async () => {
      const request = await requestFor({ ...FLASH, messages: hi });
      expect(request.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    it('on Flash with thinking disabled, turns thinking off', async () => {
      const request = await requestFor({ ...FLASH, thinking: { type: 'disabled' }, messages: hi });
      expect(request.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    it('on Flash with an effort, thinks at that effort’s level', async () => {
      const request = await requestFor({ ...FLASH, output_config: { effort: 'low' }, messages: hi });
      expect(request.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    });

    it('on Pro with thinking disabled, thinks at the lowest level Pro accepts', async () => {
      const request = await requestFor({ ...BASE, thinking: { type: 'disabled' }, messages: hi });
      expect(request.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    });

    it('on Pro with thinking absent, leaves Pro at its own default', async () => {
      const request = await requestFor({ ...BASE, messages: hi });
      expect(request.config?.thinkingConfig).toBeUndefined();
    });
  });

  it('adaptive thinking at high effort on Flash is thinking level high, not off', async () => {
    const request = await requestFor({
      model: 'gemini-3.8-flash',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.HIGH, includeThoughts: true });
  });

  it('max_tokens, temperature and stop_sequences carry over', async () => {
    const request = await requestFor({
      ...BASE,
      max_tokens: 777,
      temperature: 0.2,
      stop_sequences: ['</answer>'],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request.config).toEqual({ maxOutputTokens: 777, temperature: 0.2, stopSequences: ['</answer>'] });
  });

  it.each([
    [{ type: 'web_search_20250305' as const, name: 'web_search' as const }, 'web_search_20250305'],
    [{ type: 'web_fetch_20250910' as const, name: 'web_fetch' as const }, 'web_fetch_20250910'],
  ])('the server tool %j raises naming itself and the provider', async (tool, type) => {
    await expect(requestFor({ ...BASE, tools: [tool], messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      `The server tool "${type}" cannot be sent to gemini`,
    );
  });

  it('a parameter off the table raises rather than being dropped', async () => {
    await expect(requestFor({ ...BASE, top_p: 0.5, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'request.top_p cannot be sent to gemini',
    );
  });
});

describe('reply: Gemini chunks in, Anthropic message out', () => {
  it('streamed text fragments join into one text block', async () => {
    expect(
      await messageFor([
        chunk({ responseId: 'r1', candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] }),
        chunk({
          usageMetadata: USAGE,
          candidates: [{ content: { role: 'model', parts: [{ text: ', world' }] }, finishReason: FinishReason.STOP }],
        }),
      ]),
    ).toEqual({
      id: 'msg_gemini_r1',
      type: 'message',
      role: 'assistant',
      model: 'gemini-3-pro',
      content: [{ type: 'text', text: 'Hello, world', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
    });
  });

  it('function calls become tool_use blocks with ids stable within the message', async () => {
    const message = await messageFor([
      chunk({ responseId: 'r2', candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'a' } } }] } }] }),
      parts([{ functionCall: { name: 'fetch', args: { url: 'u' } } }], FinishReason.STOP),
    ]);
    expect(message.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'a' }, caller: { type: 'direct' } },
      { type: 'tool_use', id: 'toolu_2', name: 'fetch', input: { url: 'u' }, caller: { type: 'direct' } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
  });

  it('text and a function call in one candidate yield both blocks and stop for the tool (review focus 3)', async () => {
    const message = await messageFor([
      parts([{ text: 'Let me check.' }, { functionCall: { name: 'search', args: {} } }], FinishReason.STOP),
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'Let me check.', citations: null },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: {}, caller: { type: 'direct' } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
  });

  it('MAX_TOKENS becomes max_tokens', async () => {
    const message = await messageFor([parts([{ text: 'cut o' }], FinishReason.MAX_TOKENS)]);
    expect(message.stop_reason).toBe('max_tokens');
  });

  it('a safety stop raises with Gemini’s own reason', async () => {
    await expect(
      messageFor([chunk({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: FinishReason.SAFETY, finishMessage: 'blocked' }] })]),
    ).rejects.toThrow('gemini stopped with SAFETY (blocked)');
  });

  it('usage: cached tokens move out of input, thoughts count as output', async () => {
    const message = await messageFor([
      chunk({
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 50, thoughtsTokenCount: 200 },
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: FinishReason.STOP }],
      }),
    ]);
    expect(message.usage).toMatchObject({ input_tokens: 400, cache_read_input_tokens: 600, output_tokens: 250 });
  });
});

describe('thought signatures round trip through the wrapper’s verbatim history', () => {
  /** What the wrapper's tool loop does: the reply's blocks, unchanged, as the
   *  next request's assistant turn, then the tool results. */
  async function nextTurnFor(reply: Anthropic.Message): Promise<SentRequest> {
    const toolUses = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    return requestFor({
      ...BASE,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: reply.content },
        ...(toolUses.length > 0
          ? [{ role: 'user' as const, content: toolUses.map((t) => ({ type: 'tool_result' as const, tool_use_id: t.id, content: 'done' })) }]
          : []),
      ],
    });
  }

  it('a signature on a function call is a thinking block before it, and goes back on that call', async () => {
    const reply = await messageFor([
      parts([{ text: 'Planning the search.', thought: true }]),
      parts([{ functionCall: { name: 'search', args: { q: 'a' } }, thoughtSignature: 'c2lnLTE=' }, { functionCall: { name: 'fetch', args: {} } }], FinishReason.STOP),
    ]);
    expect(reply.content).toEqual([
      { type: 'thinking', thinking: 'Planning the search.', signature: 'c2lnLTE=' },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'a' }, caller: { type: 'direct' } },
      { type: 'tool_use', id: 'toolu_2', name: 'fetch', input: {}, caller: { type: 'direct' } },
    ]);

    const next = await nextTurnFor(reply);
    expect(next.contents[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { name: 'search', args: { q: 'a' } }, thoughtSignature: 'c2lnLTE=' },
        { functionCall: { name: 'fetch', args: {} } },
      ],
    });
  });

  it('a signature alone on a trailing empty part comes back on an empty part', async () => {
    const reply = await messageFor([
      parts([{ text: 'The answer is 4.' }]),
      parts([{ text: '', thoughtSignature: 'c2lnLTI=' }], FinishReason.STOP),
    ]);
    expect(reply.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'c2lnLTI=' },
      { type: 'text', text: 'The answer is 4.', citations: null },
    ]);

    const next = await nextTurnFor(reply);
    expect(next.contents[1]).toEqual({ role: 'model', parts: [{ text: 'The answer is 4.', thoughtSignature: 'c2lnLTI=' }] });
  });

  it('a signature after a function call with no text keeps its own empty part', async () => {
    const reply = await messageFor([
      parts([{ functionCall: { name: 'search', args: {} } }, { text: '', thoughtSignature: 'c2lnLTM=' }], FinishReason.STOP),
    ]);
    expect(reply.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: {}, caller: { type: 'direct' } },
      { type: 'thinking', thinking: '', signature: 'c2lnLTM=' },
    ]);
    const next = await nextTurnFor(reply);
    expect(next.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'search', args: {} } }, { text: '', thoughtSignature: 'c2lnLTM=' }],
    });
  });

  it('an unsigned thought summary is surfaced but never sent back', async () => {
    const reply = await messageFor([parts([{ text: 'Hmm.', thought: true }, { text: 'Yes.' }], FinishReason.STOP)]);
    expect(reply.content).toEqual([
      { type: 'thinking', thinking: 'Hmm.', signature: '' },
      { type: 'text', text: 'Yes.', citations: null },
    ]);
    const next = await nextTurnFor(reply);
    expect(next.contents[1]).toEqual({ role: 'model', parts: [{ text: 'Yes.' }] });
  });
});
