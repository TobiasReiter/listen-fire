import Anthropic from '@anthropic-ai/sdk';

// The wrapper streams every turn (a 64K-token extraction call would outlive the
// SDK's non-streaming HTTP timeout), so the double stands in for the stream
// helper: one `finalMessage()` per queued reply.
const finalMessage = jest.fn();
const stream = jest.fn(() => ({ finalMessage }));

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

const warn = jest.fn();
jest.mock('movement-engine/services/logger', () => ({
  logger: { info: jest.fn(), warn, error: jest.fn() },
}));

import { anthropicChat, anthropicChatDetailed } from '../index';

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

beforeEach(() => {
  stream.mockClear();
  finalMessage.mockReset();
  warn.mockReset();
});

/**
 * A text-free reply is a real Sonnet 5 outcome, not a malformed response:
 * `refusal` returns 200 with empty content, and adaptive thinking (on by
 * default when `thinking` is unset) can spend the whole `maxTokens` budget
 * before emitting text. Both reach callers as `''`.
 */
describe('anthropicChat with a text-free reply', () => {
  it('resolves to an empty string on a refusal rather than throwing', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [], stopReason: 'refusal' }));

    await expect(anthropicChat({ system: 's', userMessage: 'u' })).resolves.toBe('');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('names the stop reason in a warning so the cause is greppable', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [], stopReason: 'refusal' }));

    await anthropicChat({ system: 's', userMessage: 'u', label: 'affinity.findMatchingPerson' });

    expect(warn).toHaveBeenCalledWith(
      '[anthropic] chat returned no text',
      expect.objectContaining({ stopReason: 'refusal', label: 'affinity.findMatchingPerson' }),
    );
  });

  it('stops instead of continuing when max_tokens is hit before any text', async () => {
    // Thinking consumed the whole budget: one thinking block, no text. Continuing
    // would push `{ role: "assistant", content: "" }`, which the API rejects.
    // No effort was named, so there is no depth to step down from either.
    finalMessage.mockResolvedValueOnce(
      reply({
        content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
        stopReason: 'max_tokens',
      }),
    );

    await expect(anthropicChat({ system: 's', userMessage: 'u' })).resolves.toBe('');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('still continues a truncated reply that did produce text', async () => {
    finalMessage
      .mockResolvedValueOnce(reply({ content: [text('half an ')], stopReason: 'max_tokens' }))
      .mockResolvedValueOnce(reply({ content: [text('answer')], stopReason: 'end_turn' }));

    await expect(anthropicChat({ system: 's', userMessage: 'u' })).resolves.toBe('half an answer');
    expect(stream).toHaveBeenCalledTimes(2);
  });
});

/**
 * The bare-string surface cannot tell a complete reply from a fragment; the
 * detailed surface can, so callers whose output is silently salvageable
 * (JSON bodies) can refuse it.
 */
describe('anthropicChatDetailed', () => {
  it('flags a reply the continuation loop could not finish', async () => {
    for (let i = 0; i <= 5; i++) {
      finalMessage.mockResolvedValueOnce(
        reply({ content: [text('...')], stopReason: 'max_tokens' }),
      );
    }

    // The count is the turns actually SPENT, and it is what a caller reports
    // to the next reader: a fragment stitched out of five answers is a
    // different thing to explain than one that died on its first.
    await expect(anthropicChatDetailed({ system: 's', userMessage: 'u' })).resolves.toEqual(
      expect.objectContaining({ stopReason: 'max_tokens', truncated: true, continuations: 5 }),
    );
  });

  it('leaves a completed reply unflagged', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [text('done')], stopReason: 'end_turn' }));

    await expect(anthropicChatDetailed({ system: 's', userMessage: 'u' })).resolves.toEqual({
      text: 'done',
      stopReason: 'end_turn',
      truncated: false,
      continuations: 0,
      thinkingOnly: false,
      maxTokens: 16384,
      usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
  });
});

/**
 * Thinking is paid for out of the SAME ceiling as the answer, so a model asked
 * to think as hard as it can over a long document can spend the whole budget
 * before writing a character. The turn is not salvageable — there is no partial
 * answer to continue from — but the QUESTION is: asked one step less deeply, the
 * same call has room left for its reply.
 *
 * The step down happens once. A second text-free turn means the ceiling, not the
 * depth, is what the call is short of, and that is the caller's problem to name.
 */
describe('a turn that spends the whole ceiling thinking', () => {
  const thinkingOnly = () =>
    reply({
      content: [{ type: 'thinking', thinking: 'and on, and on', signature: 'sig' }],
      stopReason: 'max_tokens',
    });

  function effortOf(call: number): unknown {
    const [request] = stream.mock.calls[call] as unknown as [Record<string, unknown>];
    return (request.output_config as Record<string, unknown> | undefined)?.effort;
  }

  it('asks the same question again one effort lower', async () => {
    finalMessage
      .mockResolvedValueOnce(thinkingOnly())
      .mockResolvedValueOnce(reply({ content: [text('the answer')], stopReason: 'end_turn' }));

    const result = await anthropicChatDetailed({
      system: 's',
      userMessage: 'u',
      effort: 'xhigh',
      label: 'movement_extraction',
    });

    expect(result.text).toBe('the answer');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(effortOf(0)).toBe('xhigh');
    expect(effortOf(1)).toBe('high');

    // The retry is the SAME question — not a continuation of an answer that
    // was never written.
    const [first] = stream.mock.calls[0] as unknown as [Record<string, unknown>];
    const [second] = stream.mock.calls[1] as unknown as [Record<string, unknown>];
    expect(second.messages).toEqual(first.messages);
  });

  it('says in the log that it stepped down, and what it stepped between', async () => {
    finalMessage
      .mockResolvedValueOnce(thinkingOnly())
      .mockResolvedValueOnce(reply({ content: [text('ok')], stopReason: 'end_turn' }));

    await anthropicChatDetailed({
      system: 's',
      userMessage: 'u',
      effort: 'xhigh',
      label: 'movement_extraction',
      maxTokens: 64_000,
    });

    expect(warn).toHaveBeenCalledWith(
      '[anthropic] thought past the ceiling — retrying one effort lower',
      expect.objectContaining({
        label: 'movement_extraction',
        model: 'claude-sonnet-5',
        from: 'xhigh',
        to: 'high',
        maxTokens: 64_000,
      }),
    );
  });

  it('tells the caller the answer it got was the stepped-down one', async () => {
    finalMessage
      .mockResolvedValueOnce(thinkingOnly())
      .mockResolvedValueOnce(reply({ content: [text('ok')], stopReason: 'end_turn' }));

    const result = await anthropicChatDetailed({ system: 's', userMessage: 'u', effort: 'xhigh' });

    expect(result.steppedDown).toEqual({ from: 'xhigh', to: 'high' });
    expect(result.effort).toBe('high');
  });

  it('steps down only once, and hands back the facts the failure has to name', async () => {
    finalMessage.mockResolvedValueOnce(thinkingOnly()).mockResolvedValueOnce(thinkingOnly());

    const result = await anthropicChatDetailed({
      system: 's',
      userMessage: 'u',
      effort: 'xhigh',
      maxTokens: 64_000,
    });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        text: '',
        truncated: true,
        thinkingOnly: true,
        // The ceiling was never reached by an ANSWER, so no continuation was
        // ever attempted — the error must not claim five.
        continuations: 0,
        effort: 'high',
        maxTokens: 64_000,
      }),
    );
  });

  it('has nowhere to step from at the shallowest effort', async () => {
    finalMessage.mockResolvedValueOnce(thinkingOnly());

    const result = await anthropicChatDetailed({ system: 's', userMessage: 'u', effort: 'low' });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.thinkingOnly).toBe(true);
    expect(result.effort).toBe('low');
    expect(warn).not.toHaveBeenCalledWith(
      '[anthropic] thought past the ceiling — retrying one effort lower',
      expect.anything(),
    );
  });

  // The regression guard: a truncation WITH text is a half-written answer, and
  // continuing it is still the right move.
  it('continues a truncation that did produce text rather than stepping down', async () => {
    finalMessage
      .mockResolvedValueOnce(reply({ content: [text('half an ')], stopReason: 'max_tokens' }))
      .mockResolvedValueOnce(reply({ content: [text('answer')], stopReason: 'end_turn' }));

    const result = await anthropicChatDetailed({ system: 's', userMessage: 'u', effort: 'xhigh' });

    expect(result.text).toBe('half an answer');
    expect(result.steppedDown).toBeUndefined();
    expect(result.continuations).toBe(1);
    expect(effortOf(1)).toBe('xhigh');
  });
});

/**
 * Bounding a runaway. The wrapper sends no `thinking` config at all, and the
 * adaptive families (Sonnet 5, Opus 4.6+) read that as "think adaptively at
 * effort high" — so a caller that never mentions reasoning still buys the
 * deepest setting. Naming an effort is the only lever a chat caller has, and
 * capping continuations is what stops one budget becoming six.
 */
describe('bounding what a chat call may spend', () => {
  it('sends no thinking config when the caller names no effort', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [text('ok')], stopReason: 'end_turn' }));

    await anthropicChat({ system: 's', userMessage: 'u' });

    const [request] = stream.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
  });

  it('turns a named effort into the adaptive dialect the model accepts', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [text('ok')], stopReason: 'end_turn' }));

    await anthropicChat({ system: 's', userMessage: 'u', effort: 'low' });

    const [request] = stream.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config).toEqual({ effort: 'low' });
  });

  // Haiku rejects `output_config` outright, and starts from no thinking at all,
  // so there is nothing for an effort to bound.
  it('leaves the budget-dialect models alone', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [text('ok')], stopReason: 'end_turn' }));

    await anthropicChat({
      system: 's',
      userMessage: 'u',
      effort: 'low',
      model: 'claude-haiku-4-5-20251001',
    });

    const [request] = stream.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
  });

  // The `thorough` extraction/AI() row pins claude-opus-5 with no effort
  // named — the point being that opus-5 in that silence thinks adaptively by
  // default, unlike opus-4-7 (plans/mvt-core-calculus-2026-08-31/10_bakeoff.md
  // round 2: opus-4-7 with no effort runs with NO thinking at all, and can
  // leak its scratchpad into the visible reply). This pins that the wrapper
  // sends neither `thinking` nor `output_config` for that call, same as any
  // other adaptive-family model asked with no effort.
  it('sends no thinking config for claude-opus-5 when the caller names no effort', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [text('ok')], stopReason: 'end_turn' }));

    await anthropicChat({ system: 's', userMessage: 'u', model: 'claude-opus-5' });

    const [request] = stream.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request.model).toBe('claude-opus-5');
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
  });

  // `xhigh` is the extraction `thorough` row's effort — a value the pinned
  // SDK's own types predate (@anthropic-ai/sdk's `OutputConfig.effort` union
  // stops at `'max'`), so this also pins that it reaches the raw request
  // rather than being dropped by the crossing in `anthropicChatLive`.
  it('sends effort xhigh through to output_config', async () => {
    finalMessage.mockResolvedValueOnce(reply({ content: [text('ok')], stopReason: 'end_turn' }));

    await anthropicChat({ system: 's', userMessage: 'u', effort: 'xhigh' });

    const [request] = stream.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config).toEqual({ effort: 'xhigh' });
  });

  it('stops continuing at the caller ceiling, and says the reply is truncated', async () => {
    for (let i = 0; i < 6; i++) {
      finalMessage.mockResolvedValueOnce(
        reply({ content: [text('...')], stopReason: 'max_tokens' }),
      );
    }

    await expect(
      anthropicChatDetailed({ system: 's', userMessage: 'u', maxContinuations: 1 }),
    ).resolves.toEqual(expect.objectContaining({ truncated: true, continuations: 1 }));

    // One initial turn plus one continuation — not the generic five.
    expect(stream).toHaveBeenCalledTimes(2);
  });
});
