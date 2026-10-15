// Anthropic's server-side web tools, as the wrapper reads them back.
//
// Three shapes decide whether a caller sees the truth: a search whose result
// is a LIST of hits, a search whose result is an error OBJECT inside the same
// 200, and a turn that stops at `pause_turn` because the server-side loop hit
// its own ceiling. The first two are indistinguishable to a reader that
// assumes a list, and the third is a silently truncated answer.

import Anthropic from '@anthropic-ai/sdk';

const finalMessage = jest.fn();
const stream = jest.fn(
  (_params: Record<string, unknown>, _options?: { signal?: AbortSignal }) => ({ finalMessage }),
);

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { stream } })),
}));

jest.mock('@anthropic-ai/vertex-sdk', () => ({
  __esModule: true,
  AnthropicVertex: jest.fn().mockImplementation(() => ({ messages: { stream } })),
}));

jest.mock('../../llm_usage', () => ({
  recordLlmUsage: jest.fn().mockResolvedValue(undefined),
  runFields: jest.fn().mockReturnValue({}),
}));

const warn = jest.fn();
const info = jest.fn();
jest.mock('movement-engine/services/logger', () => ({
  logger: { info, warn, error: jest.fn() },
}));

import { anthropicWebChat, meterAnthropicUsage } from '../index';

// The tool result blocks postdate the pinned SDK's types, so the fixtures are
// the wire shapes rather than SDK values — which is the point: the wrapper has
// to read them structurally.
function reply(options: {
  content: unknown[];
  stopReason: Anthropic.StopReason;
  searches?: number;
  fetches?: number;
}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    container: null,
    stop_reason: options.stopReason,
    stop_details: null,
    stop_sequence: null,
    content: options.content as Anthropic.Message['content'],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: {
        web_search_requests: options.searches ?? 0,
        web_fetch_requests: options.fetches ?? 0,
      },
    } as unknown as Anthropic.Usage,
  };
}

const SEARCH_ASKED = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'web_search',
  input: { query: '"Larkfield" canteen Denmark' },
};

const FETCH_ASKED = {
  type: 'server_tool_use',
  id: 'srvtoolu_2',
  name: 'web_fetch',
  input: { url: 'https://larkfield.example' },
};

/** Our own page reader's handler, standing in for the scraper. */
const fetchPage = jest.fn(async (url: string) => ({ text: `the text of ${url}` }));

/** One client-side page read, as the model asks for it. */
function pageAsked(id: string, url: unknown) {
  return { type: 'tool_use', id, name: 'web_fetch', input: { url } };
}

/** Runs `fn` with the default model mapped to Vertex, where there is no hosted
 *  page reader. */
async function onVertex<T>(fn: () => Promise<T>): Promise<T> {
  const restore = { ...process.env };
  Object.assign(process.env, {
    MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
    GOOGLE_PRIVATE_KEY: 'pk',
    GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
    GOOGLE_PROJECT_ID: 'a-project',
  });
  try {
    return await fn();
  } finally {
    process.env = restore;
  }
}

/** The tool results one request carried back, in order. */
function toolResultsOf(callIndex: number): Array<Record<string, unknown>> {
  const request = stream.mock.calls[callIndex][0] as unknown as Anthropic.MessageCreateParams;
  const last = request.messages[request.messages.length - 1];
  return Array.isArray(last.content)
    ? last.content.flatMap((block) =>
        typeof block === 'object' && block.type === 'tool_result'
          ? [block as unknown as Record<string, unknown>]
          : [],
      )
    : [];
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchPage.mockImplementation(async (url: string) => ({ text: `the text of ${url}` }));
});

function call() {
  return anthropicWebChat({
    system: 'research one subject',
    userMessage: 'Subject: Larkfield',
    maxSearches: 6,
    maxFetches: 3,
  });
}

describe('a search that returned hits', () => {
  it('reads the hits, and pairs them with the query that asked for them', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        searches: 1,
        content: [
          SEARCH_ASKED,
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://larkfield.example',
                title: 'Larkfield — canteen software',
                page_age: '2026-01-02',
                encrypted_content: 'xxx',
              },
              {
                type: 'web_search_result',
                url: 'https://news.example/larkfield',
                title: 'Larkfield raises',
                page_age: null,
                encrypted_content: 'yyy',
              },
            ],
          },
          { type: 'text', text: 'Larkfield sells canteen software.' },
        ],
      }),
    );

    const result = await call();

    expect(result.text).toBe('Larkfield sells canteen software.');
    expect(result.events).toEqual([
      {
        kind: 'search',
        query: '"Larkfield" canteen Denmark',
        results: [
          { url: 'https://larkfield.example', title: 'Larkfield — canteen software', pageAge: '2026-01-02' },
          { url: 'https://news.example/larkfield', title: 'Larkfield raises', pageAge: null },
        ],
      },
    ]);
    expect(result.usage.searches).toBe(1);
    expect(result.resumes).toBe(0);
  });
});

describe('a server tool that failed inside a 200', () => {
  it('reads the error object as a failure rather than as an empty result', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        searches: 1,
        content: [
          SEARCH_ASKED,
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
          },
          FETCH_ASKED,
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'srvtoolu_2',
            content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
          },
          { type: 'text', text: 'I could not check.' },
        ],
      }),
    );

    const result = await call();

    expect(result.events).toEqual([
      { kind: 'search_failed', query: '"Larkfield" canteen Denmark', errorCode: 'max_uses_exceeded' },
      { kind: 'fetch_failed', url: 'https://larkfield.example', errorCode: 'url_not_accessible' },
    ]);
  });
});

describe('a page that was read', () => {
  it('carries the address, the timestamp and the text back', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        fetches: 1,
        content: [
          FETCH_ASKED,
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'srvtoolu_2',
            content: {
              type: 'web_fetch_result',
              url: 'https://larkfield.example',
              retrieved_at: '2026-09-10T00:00:00Z',
              content: {
                type: 'document',
                title: 'Larkfield',
                citations: null,
                source: { type: 'text', media_type: 'text/plain', data: 'Canteen ordering.' },
              },
            },
          },
        ],
      }),
    );

    const result = await call();

    expect(result.events).toEqual([
      {
        kind: 'fetch',
        url: 'https://larkfield.example',
        retrievedAt: '2026-09-10T00:00:00Z',
        text: 'Canteen ordering.',
      },
    ]);
    expect(result.usage.fetches).toBe(1);
  });
});

describe('a paused turn', () => {
  it('re-sends the conversation unchanged and keeps both halves of the answer', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply({
          stopReason: 'pause_turn',
          searches: 1,
          content: [
            SEARCH_ASKED,
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
            { type: 'text', text: 'Still looking. ' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        reply({
          stopReason: 'end_turn',
          searches: 1,
          content: [{ type: 'text', text: 'Larkfield sells canteen software.' }],
        }),
      );

    const result = await call();

    expect(result.resumes).toBe(1);
    expect(result.text).toBe('Still looking. Larkfield sells canteen software.');
    expect(result.stopReason).toBe('end_turn');
    // Both halves of the usage, and both turns' searches.
    expect(result.usage.searches).toBe(2);
    expect(result.usage.inputTokens).toBe(200);

    // The resume is the paused assistant turn appended and nothing else — an
    // added "continue" user turn is the one thing that stops the server
    // resuming on its own.
    const second = stream.mock.calls[1][0] as unknown as Anthropic.MessageCreateParams;
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1].role).toBe('assistant');
  });

  it('stops at the resume ceiling rather than pausing forever', async () => {
    finalMessage.mockResolvedValue(
      reply({ stopReason: 'pause_turn', content: [{ type: 'text', text: 'x' }] }),
    );

    const result = await call();

    expect(result.stopReason).toBe('pause_turn');
    expect(result.resumes).toBe(3);
    expect(stream).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      '[anthropic] web chat still paused at the resume ceiling',
      expect.anything(),
    );
  });
});

describe('the request', () => {
  it('declares both tools at the caller’s caps, with no beta header', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );

    await anthropicWebChat({
      system: 's',
      userMessage: 'u',
      maxSearches: 4,
      maxFetches: 2,
      effort: 'medium',
    });

    const request = stream.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(request.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
      // Uncapped, one large page rides along in every later server-side
      // iteration — which is where a five-minute turn's time goes.
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, max_content_tokens: 6000 },
    ]);
    expect(request.betas).toBeUndefined();
    expect(request.output_config).toEqual({ effort: 'medium' });
  });

  it('sends basic search and OUR page reader on Vertex', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );

    await onVertex(() =>
      anthropicWebChat({
        system: 's',
        userMessage: 'u',
        maxSearches: 4,
        maxFetches: 2,
        fetchPage,
      }),
    );

    const request = stream.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    // Vertex serves web search in its first version only and no hosted page
    // reader at all, so the second tool is an ordinary client tool this loop
    // answers — same name, so the prompt reads the same either way.
    const tools = request.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 4 });
    expect(tools[1]).toMatchObject({ name: 'web_fetch', input_schema: expect.anything() });
    expect(tools[1].type).toBeUndefined();
    expect(String(tools[1].description)).toContain('at most 2 page(s)');
  });

  it('declares our page reader on Anthropic too, when asked for it', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );

    // Not only Vertex's fallback: our fetcher renders pages the hosted one
    // returns empty, so it is a real choice on either provider.
    await anthropicWebChat({
      system: 's',
      userMessage: 'u',
      maxSearches: 4,
      maxFetches: 2,
      pageReader: 'own',
      fetchPage,
    });

    const tools = stream.mock.calls[0][0].tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 4 });
    expect(tools[1].name).toBe('web_fetch');
    expect(tools[1].type).toBeUndefined();
  });

  it('refuses the hosted reader on a provider that has none', async () => {
    await expect(
      onVertex(() => anthropicWebChat({ system: 's', userMessage: 'u', pageReader: 'hosted' })),
    ).rejects.toThrow(/hosted page reader does not exist on the vertex provider/);
    expect(stream).not.toHaveBeenCalled();
  });

  it('refuses our page reader with nothing to answer it', async () => {
    await expect(
      anthropicWebChat({ system: 's', userMessage: 'u', pageReader: 'own' }),
    ).rejects.toThrow(/no `fetchPage` handler was supplied/);
    expect(stream).not.toHaveBeenCalled();
  });

  it('hands the caller’s abort signal to the streaming request', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );
    const controller = new AbortController();

    await anthropicWebChat({ system: 's', userMessage: 'u', signal: controller.signal });

    // A caller with a deadline needs the request CANCELLED, not abandoned: an
    // abandoned turn goes on searching and billing after nobody is waiting.
    expect(stream.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });
});

describe('a page read by our own fetcher', () => {
  function ownCall(options: Partial<Parameters<typeof anthropicWebChat>[0]> = {}) {
    return anthropicWebChat({
      system: 'research one subject',
      userMessage: 'Subject: Larkfield',
      maxSearches: 6,
      maxFetches: 3,
      pageReader: 'own',
      fetchPage,
      ...options,
    });
  }

  it('answers the model’s tool call and carries the answer into the next turn', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply({
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: 'Reading the site. ' },
            pageAsked('toolu_1', 'https://larkfield.example'),
          ],
        }),
      )
      .mockResolvedValueOnce(
        reply({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Larkfield sells canteen software.' }],
        }),
      );

    const result = await ownCall();

    expect(fetchPage).toHaveBeenCalledWith('https://larkfield.example');
    expect(result.text).toBe('Reading the site. Larkfield sells canteen software.');
    expect(result.turns).toBe(2);
    expect(result.pageReader).toBe('own');
    expect(result.stopReason).toBe('end_turn');

    // The trace reads exactly as the hosted reader's does.
    expect(result.events).toEqual([
      {
        kind: 'fetch',
        url: 'https://larkfield.example',
        retrievedAt: expect.any(String),
        text: 'the text of https://larkfield.example',
      },
    ]);
    // Anthropic billed no fetch, and a page was still read.
    expect(result.usage.fetches).toBe(1);

    const results = toolResultsOf(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tool_use_id: 'toolu_1',
      content: 'the text of https://larkfield.example',
    });
    expect(results[0].is_error).toBeUndefined();
  });

  it('tells the model a page would not open, rather than handing it nothing', async () => {
    fetchPage.mockRejectedValueOnce(new Error('403 Forbidden'));
    finalMessage
      .mockResolvedValueOnce(
        reply({ stopReason: 'tool_use', content: [pageAsked('toolu_1', 'https://dead.example')] }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'I could not read it.' }] }),
      );

    const result = await ownCall();

    expect(result.events).toEqual([
      { kind: 'fetch_failed', url: 'https://dead.example', errorCode: '403 Forbidden' },
    ]);
    const results = toolResultsOf(1);
    expect(results[0].is_error).toBe(true);
    expect(String(results[0].content)).toContain('403 Forbidden');
    // A read that failed is not a read that happened.
    expect(result.usage.fetches).toBe(1);
  });

  it('answers several page reads from one turn in one user turn', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply({
          stopReason: 'tool_use',
          content: [
            pageAsked('toolu_1', 'https://larkfield.example'),
            pageAsked('toolu_2', 'https://news.example/larkfield'),
          ],
        }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Both read.' }] }),
      );

    const result = await ownCall();

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(stream).toHaveBeenCalledTimes(2);
    const results = toolResultsOf(1);
    expect(results.map((r) => r.tool_use_id)).toEqual(['toolu_1', 'toolu_2']);
    expect(result.usage.fetches).toBe(2);
    expect(result.events.map((e) => e.kind)).toEqual(['fetch', 'fetch']);
  });

  it('refuses a read past the caller’s ceiling and says the budget is spent', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply({ stopReason: 'tool_use', content: [pageAsked('toolu_1', 'https://one.example')] }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'tool_use', content: [pageAsked('toolu_2', 'https://two.example')] }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Answering anyway.' }] }),
      );

    const result = await ownCall({ maxFetches: 1 });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith('https://one.example');
    const refused = toolResultsOf(2);
    expect(refused[0].is_error).toBe(true);
    expect(String(refused[0].content)).toContain('budget');
    expect(result.events).toEqual([
      { kind: 'fetch', url: 'https://one.example', retrievedAt: expect.any(String), text: expect.any(String) },
      { kind: 'fetch_failed', url: 'https://two.example', errorCode: 'max_uses_exceeded' },
    ]);
    expect(result.text).toBe('Answering anyway.');
  });

  it('cuts a long page down to the ceiling the caller named', async () => {
    fetchPage.mockResolvedValueOnce({ text: 'x'.repeat(50_000) });
    finalMessage
      .mockResolvedValueOnce(
        reply({ stopReason: 'tool_use', content: [pageAsked('toolu_1', 'https://long.example')] }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'read' }] }),
      );

    await ownCall({ maxFetchContentTokens: 100 });

    // Three characters per token, deliberately low: the familiar four
    // undercounts real tokens on the text we actually fetch.
    expect(String(toolResultsOf(1)[0].content)).toHaveLength(300);
  });

  it('stops at the turn ceiling rather than reading forever', async () => {
    finalMessage.mockResolvedValue(
      reply({
        stopReason: 'tool_use',
        content: [{ type: 'text', text: 'x' }, pageAsked('toolu_1', 'https://loop.example')],
      }),
    );

    const result = await ownCall({ maxTurns: 3 });

    expect(stream).toHaveBeenCalledTimes(3);
    expect(result.turns).toBe(3);
    expect(result.stopReason).toBe('tool_use');
    expect(result.text).toBe('xxx');
    expect(warn).toHaveBeenCalledWith(
      '[anthropic] web chat hit its turn ceiling',
      expect.objectContaining({ maxTurns: 3 }),
    );
  });

  it('sums the usage of every turn, pauses and page reads alike', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply({
          stopReason: 'pause_turn',
          searches: 1,
          content: [
            SEARCH_ASKED,
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
          ],
        }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'tool_use', content: [pageAsked('toolu_1', 'https://larkfield.example')] }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'end_turn', searches: 1, content: [{ type: 'text', text: 'done' }] }),
      );

    const { value: result, usage } = await meterAnthropicUsage(() => ownCall());

    // A paused turn and a page read are different continuations of one
    // conversation, and both are ordinary turns for the meter.
    expect(result.turns).toBe(3);
    expect(result.resumes).toBe(1);
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.searches).toBe(2);
    expect(result.usage.fetches).toBe(1);
    expect(usage).toMatchObject({ calls: 3, inputTokens: 300, searches: 2, fetches: 1 });
    expect(result.events.map((e) => e.kind)).toEqual(['search', 'fetch']);
  });

  it('answers a page read with no address rather than stalling the conversation', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply({ stopReason: 'tool_use', content: [pageAsked('toolu_1', 42)] }),
      )
      .mockResolvedValueOnce(
        reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
      );

    const result = await ownCall();

    expect(fetchPage).not.toHaveBeenCalled();
    expect(toolResultsOf(1)[0].is_error).toBe(true);
    expect(result.events).toEqual([{ kind: 'fetch_failed', url: null, errorCode: 'no_url' }]);
    expect(result.usage.fetches).toBe(0);
  });
});

describe('the usage meter', () => {
  it('reports what the calls underneath it spent', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({
        stopReason: 'end_turn',
        searches: 2,
        fetches: 1,
        content: [{ type: 'text', text: 'ok' }],
      }),
    );

    const { usage } = await meterAnthropicUsage(() => call());

    expect(usage).toMatchObject({
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      searches: 2,
      fetches: 1,
    });
  });

  it('counts nothing outside a metered scope', async () => {
    finalMessage.mockResolvedValueOnce(
      reply({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
    );
    await expect(call()).resolves.toBeDefined();
  });
});
