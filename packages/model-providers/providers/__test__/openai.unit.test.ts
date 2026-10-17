// Golden fixtures for the OpenAI translator: one per row of the model map
// design's translation table (§3) that applies to OpenAI. Each request fixture
// asserts the exact OpenAI body that goes out; each reply fixture asserts the
// exact Anthropic message that comes back.

import OpenAI from 'openai';

import type Anthropic from '@anthropic-ai/sdk';

import {
  assembleOpenAiMessage,
  openAiChatProviderOver,
  toOpenAiRequest,
} from '../openai';

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Delta = Chunk['choices'][number]['delta'];
type Finish = Chunk['choices'][number]['finish_reason'];

const REQUEST: Anthropic.MessageCreateParamsNonStreaming = {
  model: 'gpt-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
};

/** What {@link REQUEST} becomes on its own; each fixture adds its row. */
const BODY = {
  model: 'gpt-5',
  max_completion_tokens: 1024,
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'Hello' }],
};

const PNG = 'iVBORw0KGgo=';
const PDF = 'JVBERi0xLjQ=';

const WEATHER_SCHEMA = {
  type: 'object' as const,
  properties: { city: { type: 'string' } },
  required: ['city'],
};

describe('Anthropic request to OpenAI body', () => {
  it('max_tokens becomes max_completion_tokens, and the stream always asks for usage', () => {
    expect(toOpenAiRequest(REQUEST)).toEqual(BODY);
  });

  it('a system string becomes one system message', () => {
    expect(toOpenAiRequest({ ...REQUEST, system: 'Be brief.' })).toEqual({
      ...BODY,
      messages: [{ role: 'system', content: 'Be brief.' }, ...BODY.messages],
    });
  });

  it('system blocks are joined into one system message, cache_control stripped', () => {
    expect(
      toOpenAiRequest({
        ...REQUEST,
        cache_control: { type: 'ephemeral' },
        system: [
          { type: 'text', text: 'Static prompt.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Running state.' },
        ],
      }),
    ).toEqual({
      ...BODY,
      messages: [{ role: 'system', content: 'Static prompt.\n\nRunning state.' }, ...BODY.messages],
    });
  });

  it('text, a base64 image and a PDF document become text, a data URL and a file part', () => {
    expect(
      toOpenAiRequest({
        ...REQUEST,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in these?', cache_control: { type: 'ephemeral' } },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
              {
                type: 'document',
                title: 'deck.pdf',
                source: { type: 'base64', media_type: 'application/pdf', data: PDF },
              },
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
            ],
          },
        ],
      }),
    ).toEqual({
      ...BODY,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in these?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
            { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}`, filename: 'deck.pdf' } },
            { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}`, filename: 'document.pdf' } },
          ],
        },
      ],
    });
  });

  it('tools with input_schema become function tools', () => {
    expect(
      toOpenAiRequest({
        ...REQUEST,
        tools: [
          { name: 'lookup_weather', description: 'Weather for a city', input_schema: WEATHER_SCHEMA },
          { name: 'no_description', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
        ],
      }),
    ).toEqual({
      ...BODY,
      tools: [
        {
          type: 'function',
          function: { name: 'lookup_weather', description: 'Weather for a city', parameters: WEATHER_SCHEMA },
        },
        { type: 'function', function: { name: 'no_description', parameters: { type: 'object' } } },
      ],
    });
  });

  it('an empty tools array is left off, since OpenAI refuses one', () => {
    expect(toOpenAiRequest({ ...REQUEST, tools: [] })).toEqual(BODY);
  });

  it.each<[Anthropic.ToolChoice, unknown]>([
    [{ type: 'auto' }, 'auto'],
    [{ type: 'any' }, 'required'],
    [{ type: 'tool', name: 'lookup_weather' }, { type: 'function', function: { name: 'lookup_weather' } }],
  ])('tool_choice %j becomes %j', (choice, expected) => {
    expect(toOpenAiRequest({ ...REQUEST, tool_choice: choice })).toEqual({ ...BODY, tool_choice: expected });
  });

  it('tool_use in assistant history becomes a tool_calls entry, and thinking with its signature is dropped', () => {
    expect(
      toOpenAiRequest({
        ...REQUEST,
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I should look it up.', signature: 'sig-abc' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'call_1', name: 'lookup_weather', input: { city: 'Paris' } },
            ],
          },
        ],
      }),
    ).toEqual({
      ...BODY,
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: 'Checking.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } },
          ],
        },
      ],
    });
  });

  it('an assistant turn that only called a tool carries no content', () => {
    const body = toOpenAiRequest({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'go', input: {} }] },
      ],
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'go', arguments: '{}' } }],
    });
  });

  it('tool_result becomes a tool message by tool_call_id, ahead of the rest of the user turn', () => {
    expect(
      toOpenAiRequest({
        ...REQUEST,
        messages: [
          { role: 'user', content: 'Weather in Paris and Rome?' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'lookup_weather', input: { city: 'Paris' } },
              { type: 'tool_use', id: 'call_2', name: 'lookup_weather', input: { city: 'Rome' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: '{"c":21}' },
              {
                type: 'tool_result',
                tool_use_id: 'call_2',
                content: [{ type: 'text', text: 'Sunny' }, { type: 'text', text: '25C' }],
                cache_control: { type: 'ephemeral' },
              },
              { type: 'text', text: 'Now compare them.' },
            ],
          },
        ],
      }).messages,
    ).toEqual([
      { role: 'user', content: 'Weather in Paris and Rome?' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_2', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Rome"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"c":21}' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Sunny\n25C' },
      { role: 'user', content: [{ type: 'text', text: 'Now compare them.' }] },
    ]);
  });

  it.each<[string, Anthropic.ToolResultBlockParam['content'], string]>([
    ['with text', 'Page would not open: 404', 'Tool error: Page would not open: 404'],
    ['with text blocks', [{ type: 'text', text: 'timed out' }], 'Tool error: timed out'],
    ['with empty content', '', 'Tool error: (no output)'],
    ['with no content', undefined, 'Tool error: (no output)'],
  ])('a tool_result with is_error %s becomes a tool message prefixed "Tool error: "', (_label, content, expected) => {
    expect(
      toOpenAiRequest({
        ...REQUEST,
        messages: [
          { role: 'user', content: 'Read it' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_page', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, ...(content !== undefined ? { content } : {}) }],
          },
        ],
      }).messages[2],
    ).toEqual({ role: 'tool', tool_call_id: 'call_1', content: expected });
  });

  it.each<[Anthropic.OutputConfig['effort'], string]>([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ])('thinking adaptive with effort %s becomes reasoning_effort %s', (effort, expected) => {
    expect(
      toOpenAiRequest({ ...REQUEST, thinking: { type: 'adaptive' }, output_config: { effort } }),
    ).toEqual({ ...BODY, reasoning_effort: expected });
  });

  it('thinking adaptive with no effort runs at Anthropic’s default, high', () => {
    expect(toOpenAiRequest({ ...REQUEST, thinking: { type: 'adaptive' } })).toEqual({
      ...BODY,
      reasoning_effort: 'high',
    });
  });

  it.each([
    [1024, 'low'],
    [4095, 'low'],
    [4096, 'medium'],
    [8000, 'medium'],
    [16383, 'medium'],
    [16384, 'high'],
    [32000, 'high'],
  ])('thinking enabled with budget_tokens %i becomes reasoning_effort %s', (budget, expected) => {
    expect(
      toOpenAiRequest({ ...REQUEST, thinking: { type: 'enabled', budget_tokens: budget } }),
    ).toEqual({ ...BODY, reasoning_effort: expected });
  });

  it('temperature and stop_sequences pass through as temperature and stop', () => {
    expect(
      toOpenAiRequest({ ...REQUEST, temperature: 0.2, stop_sequences: ['END', '###'] }),
    ).toEqual({ ...BODY, temperature: 0.2, stop: ['END', '###'] });
  });

  it.each<[Anthropic.ToolUnion, string]>([
    [{ type: 'web_search_20250305', name: 'web_search' }, 'web_search_20250305'],
    [{ type: 'web_search_20260209', name: 'web_search' }, 'web_search_20260209'],
    [{ type: 'web_fetch_20250910', name: 'web_fetch' }, 'web_fetch_20250910'],
  ])('the server tool %j raises, naming the feature and the provider', (tool, type) => {
    expect(() => toOpenAiRequest({ ...REQUEST, tools: [tool] })).toThrow(
      `The \`${type}\` server tool cannot be sent to the openai provider`,
    );
  });

  describe('anything off the table raises rather than being dropped', () => {
    it.each<[string, Anthropic.MessageCreateParamsNonStreaming, string]>([
      ['top_k', { ...REQUEST, top_k: 5 }, 'The request field `top_k`'],
      ['tool_choice none', { ...REQUEST, tool_choice: { type: 'none' } }, '`tool_choice: none`'],
      [
        'disable_parallel_tool_use',
        { ...REQUEST, tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
        '`tool_choice.disable_parallel_tool_use`',
      ],
      [
        'output_config.format',
        {
          ...REQUEST,
          output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
        },
        'The request field output_config `format`',
      ],
      [
        'a url image',
        {
          ...REQUEST,
          messages: [
            { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] },
          ],
        },
        'An image with a url source',
      ],
      [
        'an image inside a tool_result',
        {
          ...REQUEST,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'c',
                  content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }],
                },
              ],
            },
          ],
        },
        'A `image` block inside a tool_result',
      ],
      [
        'strict tools',
        { ...REQUEST, tools: [{ name: 't', input_schema: { type: 'object' }, strict: true }] },
        'Tool "t"’s `strict`',
      ],
    ])('%s', (_label, params, feature) => {
      expect(() => toOpenAiRequest(params)).toThrow(`${feature} cannot be sent to the openai provider`);
    });
  });
});

// ── reply ────────────────────────────────────────────────────────────────

function chunk(delta: Delta, finish: Finish = null): Chunk {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-5-2026-01-01',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function usageChunk(prompt: number, completion: number, cached?: number): Chunk {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-5-2026-01-01',
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  };
}

async function* stream(chunks: Chunk[]): AsyncIterable<Chunk> {
  yield* chunks;
}

function message(overrides: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'chatcmpl-1',
    type: 'message',
    role: 'assistant',
    model: 'gpt-5-2026-01-01',
    content: [],
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
    ...overrides,
  };
}

function weatherCallChunks(finish: Finish): Chunk[] {
  return [
    chunk({ role: 'assistant', content: 'Let me check. ' }),
    chunk({
      tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'lookup_weather', arguments: '' } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
    chunk({
      tool_calls: [{ index: 1, id: 'call_def', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Rome"}' } }],
    }),
    chunk({}, finish),
    usageChunk(10, 5),
  ];
}

describe('OpenAI stream to Anthropic message', () => {
  it('reply text becomes one text block, and stop becomes end_turn', async () => {
    const reply = await assembleOpenAiMessage(
      stream([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Hello' }),
        chunk({ content: ', world' }),
        chunk({}, 'stop'),
        usageChunk(10, 5),
      ]),
    );
    expect(reply).toEqual(
      message({ content: [{ type: 'text', text: 'Hello, world', citations: null }], stop_reason: 'end_turn' }),
    );
  });

  it('usage: cached tokens become cache_read_input_tokens and leave the input count', async () => {
    const reply = await assembleOpenAiMessage(
      stream([chunk({ content: 'x' }), chunk({}, 'stop'), usageChunk(1000, 40, 600)]),
    );
    expect(reply.usage).toEqual(
      message({
        usage: {
          input_tokens: 400,
          output_tokens: 40,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 0,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
        },
      }).usage,
    );
  });

  it('tool calls become tool_use blocks keeping the vendor id, and tool_calls becomes tool_use', async () => {
    expect(await assembleOpenAiMessage(stream(weatherCallChunks('tool_calls')))).toEqual(
      message({
        content: [
          { type: 'text', text: 'Let me check. ', citations: null },
          { type: 'tool_use', id: 'call_abc', name: 'lookup_weather', input: { city: 'Paris' }, caller: { type: 'direct' } },
          { type: 'tool_use', id: 'call_def', name: 'lookup_weather', input: { city: 'Rome' }, caller: { type: 'direct' } },
        ],
        stop_reason: 'tool_use',
      }),
    );
  });

  it('a forced tool call, which OpenAI finishes with stop, is still tool_use', async () => {
    const reply = await assembleOpenAiMessage(stream(weatherCallChunks('stop')));
    expect(reply.stop_reason).toBe('tool_use');
    expect(reply.content.filter((b) => b.type === 'tool_use')).toHaveLength(2);
  });

  it('length becomes max_tokens', async () => {
    expect(
      await assembleOpenAiMessage(
        stream([chunk({ content: 'The answer is a long' }), chunk({}, 'length'), usageChunk(10, 5)]),
      ),
    ).toEqual(
      message({
        content: [{ type: 'text', text: 'The answer is a long', citations: null }],
        stop_reason: 'max_tokens',
      }),
    );
  });

  // Review focus 4: the wrapper's truncation recovery keys on max_tokens with
  // no tool_use block; a fragment would be a JSON parse error instead.
  it('length with partial tool call JSON is max_tokens with no tool_use block', async () => {
    expect(
      await assembleOpenAiMessage(
        stream([
          chunk({
            tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'save', arguments: '{"rows":[{"na' } }],
          }),
          chunk({}, 'length'),
          usageChunk(10, 5),
        ]),
      ),
    ).toEqual(message({ content: [], stop_reason: 'max_tokens' }));
  });

  it('complete tool call arguments that are not JSON raise rather than reaching the caller', async () => {
    await expect(
      assembleOpenAiMessage(
        stream([
          chunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'save', arguments: '{nope' } }] }),
          chunk({}, 'tool_calls'),
          usageChunk(1, 1),
        ]),
      ),
    ).rejects.toThrow('finished a "save" tool call whose arguments are not JSON');
  });

  it('a finish reason off the table raises', async () => {
    await expect(
      assembleOpenAiMessage(stream([chunk({}, 'content_filter'), usageChunk(1, 1)])),
    ).rejects.toThrow('finished with "content_filter"');
  });

  it('a refusal raises with its text', async () => {
    await expect(
      assembleOpenAiMessage(stream([chunk({ refusal: 'I cannot help.' }), chunk({}, 'stop'), usageChunk(1, 1)])),
    ).rejects.toThrow('The openai provider refused: I cannot help.');
  });

  it('a stream with no usage raises rather than billing the call as free', async () => {
    await expect(assembleOpenAiMessage(stream([chunk({ content: 'x' }), chunk({}, 'stop')]))).rejects.toThrow(
      'carried no usage',
    );
  });
});

// ── through the SDK ──────────────────────────────────────────────────────

function sse(chunks: Chunk[]): string {
  return [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');
}

function fakeOpenAi(chunks: Chunk[]) {
  const requests: Array<{ url: string; body: unknown; signal: AbortSignal | null | undefined }> = [];
  const client = new OpenAI({
    apiKey: 'sk-test',
    baseURL: 'http://fake.openai/v1',
    maxRetries: 0,
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
      });
      if (init?.signal?.aborted) throw new Error('aborted');
      return new Response(sse(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  return { provider: openAiChatProviderOver(client), requests };
}

const TEXT_REPLY = [chunk({ content: 'Hi' }), chunk({}, 'stop'), usageChunk(10, 5)];

describe('the provider over the OpenAI SDK', () => {
  it('create() streams the translated body to chat/completions and assembles the reply', async () => {
    const { provider, requests } = fakeOpenAi(TEXT_REPLY);
    const reply = await provider.messages.create({ ...REQUEST, system: 'Be brief.' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://fake.openai/v1/chat/completions');
    expect(requests[0].body).toEqual({
      ...BODY,
      messages: [{ role: 'system', content: 'Be brief.' }, ...BODY.messages],
    });
    expect(reply).toEqual(message({ content: [{ type: 'text', text: 'Hi', citations: null }] }));
  });

  it('stream().finalMessage() shares the assembly, and asking twice is one request', async () => {
    const { provider, requests } = fakeOpenAi(TEXT_REPLY);
    const handle = provider.messages.stream(REQUEST);
    const [first, second] = await Promise.all([handle.finalMessage(), handle.finalMessage()]);
    expect(first).toEqual(await provider.messages.create(REQUEST));
    expect(second).toBe(first);
    expect(requests).toHaveLength(2);
  });

  it('passes the abort signal through to the request in flight', async () => {
    let seen: AbortSignal | null | undefined;
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'http://fake.openai/v1',
      maxRetries: 0,
      // Answers only by failing once the caller gives up.
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const controller = new AbortController();
    const reply = openAiChatProviderOver(client).messages.create(REQUEST, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(reply).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
  });
});
