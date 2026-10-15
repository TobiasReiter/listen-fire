// The production model clients (`llm_clients.ts`): the output ceiling, the
// truncation rule, and what a reply hands back.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../../lib/anthropic', () => ({
  anthropicChatDetailed: jest.fn(),
  MAX_CHAT_CONTINUATIONS: 5,
}));

import { anthropicChatDetailed } from '../../../../lib/anthropic';
import { logger } from 'movement-engine/services/logger';
import { makeAnthropicLlmClient } from '../llm_clients';

// ── Truncated LLM output must fail the call, not salvage into null fields ────

describe('the Anthropic-backed extraction client', () => {
  // Cut off mid-entity: the last field's value never arrived.
  const TRUNCATED_BODY =
    '{"x:extract_result#1":[{"name":{"evidence":"q","value":"Acme"},"summary":';

  const detailed = anthropicChatDetailed as jest.Mock;
  const callInput = {
    system: 's',
    userMessage: 'u',
    label: 'extract_companies',
    model: 'sonnet' as const,
  };

  beforeEach(() => {
    detailed.mockReset();
    (logger.warn as jest.Mock).mockClear();
    delete process.env.EXTRACTION_OUTPUT_BUDGET;
  });
  afterEach(() => {
    delete process.env.EXTRACTION_OUTPUT_BUDGET;
  });

  it('raises, naming the label, when the reply was truncated', async () => {
    detailed.mockResolvedValueOnce({
      text: TRUNCATED_BODY,
      stopReason: 'max_tokens',
      truncated: true,
      continuations: 5,
      thinkingOnly: false,
    });

    await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow(
      /truncated.*extract_companies|extract_companies.*truncated/is,
    );
  });

  it('logs the partial reply — output size, entities parsed, and tail — before raising', async () => {
    detailed.mockResolvedValueOnce({
      text: TRUNCATED_BODY,
      stopReason: 'max_tokens',
      truncated: true,
      continuations: 5,
      thinkingOnly: false,
    });

    await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      '[extraction] truncated',
      expect.objectContaining({
        label: 'extract_companies',
        estimatedOutputTokens: expect.any(Number),
        // The repaired partial still has the one entity it got through.
        entitiesParsed: 1,
        tail: expect.stringContaining('Acme'),
      }),
    );
  });

  // Sonnet 5 is not expected to loop, so by default the guard is off: every
  // extraction spends the flat ceiling and the chat wrapper's own
  // continuation default, whatever the input's size.
  describe('with EXTRACTION_OUTPUT_BUDGET unset (the default)', () => {
    it('spends the flat ceiling and leaves continuations to the wrapper default', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      const bigInput = { ...callInput, userMessage: 'x'.repeat(40_000) };
      await makeAnthropicLlmClient().call(bigInput);

      expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 32_000 }));
      expect(detailed.mock.calls[0][0]).not.toHaveProperty('maxContinuations');
    });

    it('names the flat ceiling and the continuations the wrapper actually spent, and says the guard was off', async () => {
      detailed.mockResolvedValueOnce({
        text: TRUNCATED_BODY,
        stopReason: 'max_tokens',
        truncated: true,
        continuations: 5,
        thinkingOnly: false,
        maxTokens: 32_000,
      });

      await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow(
        /32000-token output ceiling.*5 continuations \(EXTRACTION_OUTPUT_BUDGET off\)/s,
      );
    });
  });

  // The failure this names: a morning-recap run whose model spent the whole
  // 32k ceiling thinking at `xhigh` and wrote nothing. The error blamed "5
  // continuations" — the ceiling the wrapper was ALLOWED, not the zero it
  // actually attempted — and sent its readers looking for a long answer that
  // was never written.
  describe('when the model spent the whole ceiling thinking', () => {
    const thinkingOnlyReply = {
      text: '',
      stopReason: 'max_tokens' as const,
      truncated: true,
      continuations: 0,
      thinkingOnly: true,
      effort: 'high' as const,
      maxTokens: 64_000,
    };

    it('says so — the ceiling, the depth it was thinking at, and that no text came back', async () => {
      detailed.mockResolvedValueOnce(thinkingOnlyReply);

      await expect(
        makeAnthropicLlmClient().call({ ...callInput, effort: 'xhigh', maxTokens: 64_000 }),
      ).rejects.toThrow(
        /spent the whole 64000-token output ceiling thinking at effort high and produced no text/,
      );
    });

    it('counts the continuations it took, not the ones it was allowed', async () => {
      detailed.mockResolvedValueOnce(thinkingOnlyReply);

      await expect(
        makeAnthropicLlmClient().call({ ...callInput, effort: 'xhigh', maxTokens: 64_000 }),
      ).rejects.toThrow(/0 continuations/);
    });
  });

  // The runaway this bounds: a 2.6k-token input generated 53.7k output tokens
  // over 7½ minutes, because nothing in the request tied the size of the answer
  // to the size of the question. Setting the flag restores that leash.
  describe('with EXTRACTION_OUTPUT_BUDGET=1', () => {
    beforeEach(() => {
      process.env.EXTRACTION_OUTPUT_BUDGET = '1';
    });

    it('sizes the output budget from the input, not from a flat ceiling', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      // ~10k tokens of source text — big enough to clear the floor.
      const bigInput = { ...callInput, userMessage: 'x'.repeat(40_000) };
      await makeAnthropicLlmClient().call(bigInput);

      const { maxTokens, maxContinuations } = detailed.mock.calls[0][0];
      expect(maxTokens).toBeGreaterThan(8_000);
      expect(maxTokens).toBeLessThan(53_717);
      expect(maxContinuations).toBe(1);
    });

    it('still gives a tiny input a floor to answer in', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      await makeAnthropicLlmClient().call(callInput);

      expect(detailed).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 8_000, maxContinuations: 1 }),
      );
    });

    it('caps the budget however large the input gets', async () => {
      detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

      await makeAnthropicLlmClient().call({ ...callInput, userMessage: 'x'.repeat(4_000_000) });

      expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 32_000 }));
    });

    it('names the proportional ceiling and the one-continuation count in the truncation error, and says the guard was on', async () => {
      detailed.mockResolvedValueOnce({
        text: TRUNCATED_BODY,
        stopReason: 'max_tokens',
        truncated: true,
        continuations: 1,
        thinkingOnly: false,
        maxTokens: 8_000,
      });

      await expect(makeAnthropicLlmClient().call(callInput)).rejects.toThrow(
        /8000-token output ceiling.*1 continuation \(EXTRACTION_OUTPUT_BUDGET on\)/s,
      );
    });
  });

  // `true` reads the same as `1`.
  it('also switches on for EXTRACTION_OUTPUT_BUDGET=true', async () => {
    process.env.EXTRACTION_OUTPUT_BUDGET = 'true';
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call(callInput);

    expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxContinuations: 1 }));
  });

  // Extraction transcribes; it does not reason. The adaptive-thinking models
  // reason at effort `high` when nobody says otherwise, and each continuation
  // buys another whole budget — together that is where the 53.7k went. The
  // depth now travels ON the call (the tier mapping decides it), so the client
  // forwards what it is given, independent of the budget guard.
  it('forwards the caller’s reasoning depth', async () => {
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call({ ...callInput, effort: 'low' });

    expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low' }));
  });

  // Silence is a caller's answer too: no effort means the model's own depth,
  // and defaulting one here would make every call an extraction.
  it('names no depth for a caller that named none', async () => {
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call(callInput);

    expect(detailed.mock.calls[0][0]).not.toHaveProperty('effort');
  });

  // The most expensive tier spends a flat budget instead of the one sized from
  // the input — a short question may deserve a long answer. Wins over the
  // guard either way.
  it('lets the caller replace the input-proportional ceiling', async () => {
    detailed.mockResolvedValueOnce({ text: '{}', stopReason: 'end_turn', truncated: false });

    await makeAnthropicLlmClient().call({ ...callInput, maxTokens: 32_000 });

    expect(detailed).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 32_000 }));
  });

  // What the raise is protecting against: the salvage path repairs the same
  // body into a well-formed entity whose unfinished field is simply `null`.
  it('would otherwise hand back an entity with a silently nulled field', async () => {
    detailed.mockResolvedValueOnce({
      text: TRUNCATED_BODY,
      stopReason: 'max_tokens',
      truncated: false,
    });

    const { parsedJson } = await makeAnthropicLlmClient().call(callInput);
    const [entity] = (parsedJson as Record<string, Array<Record<string, { value?: unknown }>>>)[
      'x:extract_result#1'
    ];

    expect(entity.name.value).toBe('Acme');
    expect(entity.summary ?? null).toBeNull();
  });
});
