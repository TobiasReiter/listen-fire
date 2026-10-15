import Anthropic from '@anthropic-ai/sdk';

// The chat seam's user turn as blocks — what the extraction call sends so it
// can say where its cacheable prefix ends — and, beside it, the string form
// every other caller sends, which must reach the API exactly as before.

const finalMessage = jest.fn();
const stream = jest.fn((_request: unknown) => ({ finalMessage }));

jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ messages: { stream } })),
  };
});

jest.mock('../../llm_usage', () => ({
  recordLlmUsage: jest.fn().mockResolvedValue(undefined),
  runFields: jest.fn().mockReturnValue({}),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { anthropicChatDetailed } from '../index';

function reply(): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: '{}', citations: null }],
    usage: {
      input_tokens: 120,
      output_tokens: 7,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 90,
    },
  } as Anthropic.Message;
}

beforeEach(() => {
  stream.mockClear();
  finalMessage.mockReset();
  finalMessage.mockResolvedValue(reply());
});

const sent = () => stream.mock.calls[0][0] as { system: unknown; messages: unknown };

describe('anthropicChatDetailed — the user turn', () => {
  it('a string is sent as the string it is, with the one cached system block', async () => {
    await anthropicChatDetailed({ system: 's', userMessage: 'u', maxTokens: 100 });
    expect(sent().system).toEqual([{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }]);
    expect(sent().messages).toEqual([{ role: 'user', content: 'u' }]);
  });

  it('blocks are sent in order, a breakpoint only where the caller marked one', async () => {
    await anthropicChatDetailed({
      system: 's',
      userMessage: [{ text: 'a' }, { text: 'b', cacheControl: 'ephemeral' }, { text: 'shape' }],
      maxTokens: 100,
    });
    expect(sent().messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'shape' },
        ],
      },
    ]);
  });

  it('reports the tokens the call spent, cache reads and writes included', async () => {
    const result = await anthropicChatDetailed({ system: 's', userMessage: 'u', maxTokens: 100 });
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 7,
      cacheReadTokens: 90,
      cacheCreationTokens: 30,
    });
  });
});
