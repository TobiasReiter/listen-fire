import Anthropic from '@anthropic-ai/sdk';

// The tool loop is non-streaming, so the double stands in for `messages.create`:
// one queued reply per turn.
const create = jest.fn();
const stream = jest.fn(() => ({ finalMessage: jest.fn() }));

jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ messages: { create, stream } })),
  };
});

jest.mock('../../llm_usage', () => ({ recordLlmUsage: jest.fn().mockResolvedValue(undefined) }));

const warn = jest.fn();
const error = jest.fn();
jest.mock('movement-engine/services/logger', () => ({
  logger: { info: jest.fn(), warn, error },
}));

import { anthropicToolLoop } from '../index';

function reply(options: {
  content: Anthropic.Message['content'];
  stopReason: Anthropic.StopReason;
}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: options.stopReason,
    stop_sequence: null,
    content: options.content,
    usage: {
      input_tokens: 10,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message;
}

const text = (value: string) => ({ type: 'text' as const, text: value, citations: null });

const toolUse = (name: string) =>
  ({ type: 'tool_use' as const, id: 'toolu_1', name, input: {} }) as Anthropic.ToolUseBlock;

/** A tool call that ran out of budget mid-JSON: the block never lands in `content`. */
const truncatedToolCall = () => reply({ content: [], stopReason: 'max_tokens' });

const TOOLS = [
  {
    type: 'function' as const,
    name: 'doThing',
    description: 'does a thing',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const params = { system: 's', userMessage: 'u', tools: TOOLS as any };

/**
 * The final message carries the cache breakpoint, so it reaches the API as
 * text blocks rather than the bare string the loop pushed.
 */
function lastMessageText(call: number): string {
  const { messages } = create.mock.calls[call][0];
  const last = messages[messages.length - 1];
  expect(last.role).toBe('user');
  return typeof last.content === 'string'
    ? last.content
    : last.content.map((block: { text?: string }) => block.text ?? '').join('');
}

beforeEach(() => {
  create.mockReset();
  warn.mockReset();
  error.mockReset();
});

/**
 * A turn truncated mid-tool-call carries neither an executable call nor an
 * answer. Returning it as an empty result ends the run in silence — the loop
 * has to say what happened and ask for a smaller step instead.
 */
describe('a tool call truncated at max_tokens', () => {
  it('tells the model its call was cut off and continues the loop', async () => {
    create
      .mockResolvedValueOnce(truncatedToolCall())
      .mockResolvedValueOnce(reply({ content: [text('done')], stopReason: 'end_turn' }));

    await expect(anthropicToolLoop(params)).resolves.toEqual([{ type: 'text', text: 'done' }]);
    expect(create).toHaveBeenCalledTimes(2);

    expect(lastMessageText(1)).toContain('output token limit');
  });

  it('reports the truncation on the turn event and the log', async () => {
    create
      .mockResolvedValueOnce(truncatedToolCall())
      .mockResolvedValueOnce(reply({ content: [text('done')], stopReason: 'end_turn' }));

    const onTurn = jest.fn();
    await anthropicToolLoop({ ...params, onTurn });

    expect(onTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ truncated: 'no_output' }));
    expect(warn).toHaveBeenCalledWith(
      '[anthropic] tool loop truncated mid-tool-call, asking for a smaller step',
      expect.objectContaining({ recovery: 1 }),
    );
  });

  it('gives up with a real error rather than recovering forever', async () => {
    create.mockResolvedValue(truncatedToolCall());

    await expect(anthropicToolLoop({ ...params, label: 'movement_agent' })).rejects.toThrow(
      /truncated at max_tokens.*movement_agent/s,
    );
    // Two recoveries, then the third truncation is fatal.
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('still continues a truncated reply that did produce text', async () => {
    create
      .mockResolvedValueOnce(reply({ content: [text('half an ')], stopReason: 'max_tokens' }))
      .mockResolvedValueOnce(reply({ content: [text('answer')], stopReason: 'end_turn' }));

    await expect(anthropicToolLoop(params)).resolves.toEqual([{ type: 'text', text: 'answer' }]);
    expect(lastMessageText(1)).toBe('Continue exactly where you left off.');
  });
});

/** `maxTurns` was destructured but never enforced — the loop had no bound at all. */
describe('the maxTurns bound', () => {
  it('stops at the cap and names it, instead of looping forever', async () => {
    create.mockResolvedValue(reply({ content: [toolUse('doThing')], stopReason: 'tool_use' }));
    const doThing = jest.fn().mockResolvedValue({ ok: true });

    await expect(
      anthropicToolLoop({ ...params, maxTurns: 3, label: 'movement_agent' }, { doThing }),
    ).rejects.toThrow(/maxTurns=3/);

    expect(create).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      '[anthropic] tool loop hit maxTurns',
      expect.objectContaining({ maxTurns: 3 }),
    );
  });

  it('leaves an unbounded loop unbounded when no cap is given', async () => {
    create
      .mockResolvedValueOnce(reply({ content: [toolUse('doThing')], stopReason: 'tool_use' }))
      .mockResolvedValueOnce(reply({ content: [text('done')], stopReason: 'end_turn' }));

    await expect(anthropicToolLoop(params, { doThing: async () => ({}) })).resolves.toEqual([
      { type: 'text', text: 'done' },
    ]);
  });
});
