// Web search where the provider hosts none.
//
// Only the two Claude doors run server tools. When the model map sends the web
// chat to a translator, a server tool would be dropped without a word and the
// model would answer from memory, so search travels as an ordinary client tool
// the loop answers with the caller's search handler — exactly as page reads
// already do.

import Anthropic from '@anthropic-ai/sdk';

import type { Provider } from 'movement-engine/lib/models/map';

const finalMessage = jest.fn();
const stream = jest.fn(
  (_params: Record<string, unknown>, _options?: { signal?: AbortSignal }) => ({ finalMessage }),
);

let provider: Provider = 'openai';
jest.mock('../../models/chat', () => ({
  chatCallFor: (name: string) => ({
    client: { messages: { stream } },
    wireModel: `${provider}-wire`,
    resolved: { preferred: name, provider, wireModel: `${provider}-wire` },
  }),
}));

jest.mock('../../llm_usage', () => ({
  recordLlmUsage: jest.fn().mockResolvedValue(undefined),
  runFields: jest.fn().mockReturnValue({}),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { anthropicWebChat } from '../index';

function reply(content: unknown[], stopReason: Anthropic.StopReason): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'openai-wire',
    container: null,
    stop_reason: stopReason,
    stop_details: null,
    stop_sequence: null,
    content: content as Anthropic.Message['content'],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as unknown as Anthropic.Usage,
  };
}

function searchAsked(id: string, query: unknown) {
  return { type: 'tool_use', id, name: 'web_search', input: { query } };
}

const searchWeb = jest.fn(async (query: string) => ({
  hits: [
    { url: 'https://larkfield.example', title: 'Larkfield — canteen software', snippet: `about ${query}` },
  ],
}));
const fetchPage = jest.fn(async (url: string) => ({ text: `the text of ${url}` }));

function toolsOf(callIndex: number): Array<Record<string, unknown>> {
  return stream.mock.calls[callIndex][0].tools as Array<Record<string, unknown>>;
}

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

function call(options: Partial<Parameters<typeof anthropicWebChat>[0]> = {}) {
  return anthropicWebChat({
    system: 'research one subject',
    userMessage: 'Subject: Larkfield',
    maxSearches: 4,
    maxFetches: 2,
    searchWeb,
    fetchPage,
    ...options,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  provider = 'openai';
});

describe('web search on a provider without hosted search', () => {
  it('declares search as a client tool and sends no server tool at all', async () => {
    finalMessage.mockResolvedValueOnce(reply([{ type: 'text', text: 'ok' }], 'end_turn'));

    await call();

    const tools = toolsOf(0);
    expect(tools.map((t) => t.name)).toEqual(['web_search', 'web_fetch']);
    // A server tool carries a versioned `type`; a client tool carries a schema.
    for (const tool of tools) {
      expect(tool.type).toBeUndefined();
      expect(tool.input_schema).toBeDefined();
    }
    expect(String(tools[0].description)).toContain('at most 4');
  });

  it('answers a web_search tool call from the search handler', async () => {
    finalMessage
      .mockResolvedValueOnce(reply([searchAsked('toolu_1', 'Larkfield canteen Denmark')], 'tool_use'))
      .mockResolvedValueOnce(
        reply([{ type: 'text', text: 'Larkfield sells canteen software.' }], 'end_turn'),
      );

    const result = await call();

    expect(searchWeb).toHaveBeenCalledWith('Larkfield canteen Denmark');
    const results = toolResultsOf(1);
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('toolu_1');
    expect(results[0].is_error).toBeUndefined();
    expect(String(results[0].content)).toContain('https://larkfield.example');
    expect(String(results[0].content)).toContain('Larkfield — canteen software');

    // The trace reads as a hosted search's does, and the search is counted.
    expect(result.events).toEqual([
      {
        kind: 'search',
        query: 'Larkfield canteen Denmark',
        results: [{ url: 'https://larkfield.example', title: 'Larkfield — canteen software', pageAge: null }],
      },
    ]);
    expect(result.usage.searches).toBe(1);
    expect(result.text).toBe('Larkfield sells canteen software.');
  });

  it('answers a search and a page read asked in the same turn together', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply(
          [
            searchAsked('toolu_1', 'Larkfield'),
            { type: 'tool_use', id: 'toolu_2', name: 'web_fetch', input: { url: 'https://larkfield.example' } },
          ],
          'tool_use',
        ),
      )
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'done' }], 'end_turn'));

    const result = await call();

    expect(toolResultsOf(1).map((r) => r.tool_use_id).sort()).toEqual(['toolu_1', 'toolu_2']);
    expect(result.usage).toMatchObject({ searches: 1, fetches: 1 });
  });

  it('tells the model a search failed rather than that it found nothing', async () => {
    searchWeb.mockRejectedValueOnce(new Error('SERP zone is not provisioned'));
    finalMessage
      .mockResolvedValueOnce(reply([searchAsked('toolu_1', 'Larkfield')], 'tool_use'))
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'no luck' }], 'end_turn'));

    const result = await call();

    const [told] = toolResultsOf(1);
    expect(told.is_error).toBe(true);
    expect(String(told.content)).toContain('SERP zone is not provisioned');
    expect(result.events).toEqual([
      { kind: 'search_failed', query: 'Larkfield', errorCode: 'SERP zone is not provisioned' },
    ]);
  });

  it('refuses a search past the caller’s ceiling and says the budget is spent', async () => {
    finalMessage
      .mockResolvedValueOnce(
        reply([searchAsked('toolu_1', 'one'), searchAsked('toolu_2', 'two')], 'tool_use'),
      )
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'answering' }], 'end_turn'));

    const result = await call({ maxSearches: 1 });

    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(searchWeb).toHaveBeenCalledWith('one');
    const results = toolResultsOf(1);
    expect(results[1].is_error).toBe(true);
    expect(String(results[1].content)).toContain('budget');
    expect(result.usage.searches).toBe(1);
  });

  it('refuses to start with nothing to answer the model’s searches', async () => {
    await expect(call({ searchWeb: undefined })).rejects.toThrow(
      /openai provider, which has no hosted web search, but no `searchWeb` handler/,
    );
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('web search on the Claude doors', () => {
  it.each([
    ['anthropic', 'web_search_20260209'],
    ['vertex', 'web_search_20250305'],
  ] as const)('stays hosted on %s and never asks the handler', async (door, type) => {
    provider = door;
    finalMessage.mockResolvedValueOnce(reply([{ type: 'text', text: 'ok' }], 'end_turn'));

    await call({ pageReader: 'own' });

    expect(toolsOf(0)[0]).toEqual({ type, name: 'web_search', max_uses: 4 });
    expect(searchWeb).not.toHaveBeenCalled();
  });
});
