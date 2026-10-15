import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { buildStructuredTool, extractStructuredResult, StructuredOutputError } from 'movement-engine/lib/anthropic/structured';

function messageWith(
  content: Anthropic.Message['content'],
  stopReason: Anthropic.Message['stop_reason'] = 'tool_use',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: stopReason,
    stop_sequence: null,
    content,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message;
}

const rowSchema = z.object({
  fields: z.array(z.object({ name: z.string(), value: z.string() })),
});

describe('extractStructuredResult', () => {
  it('returns the validated tool input when the model calls the tool', () => {
    const response = messageWith([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'extract_row',
        input: { fields: [{ name: 'ARR', value: '1.2M' }] },
        caller: { type: 'direct' },
      },
    ]);

    const result = extractStructuredResult({ response, toolName: 'extract_row', schema: rowSchema });

    expect(result).toEqual({ fields: [{ name: 'ARR', value: '1.2M' }] });
  });

  it('throws StructuredOutputError instead of silently dropping when the model returns no tool call', () => {
    const response = messageWith([{ type: 'text', text: 'no idea', citations: null }]);

    expect(() =>
      extractStructuredResult({ response, toolName: 'extract_row', schema: rowSchema }),
    ).toThrow(StructuredOutputError);
  });

  it('rejects tool input that violates the schema', () => {
    const response = messageWith([
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'extract_row',
        input: { fields: [{ name: 'ARR' }] },
        caller: { type: 'direct' },
      },
    ]);

    expect(() =>
      extractStructuredResult({ response, toolName: 'extract_row', schema: rowSchema }),
    ).toThrow(z.ZodError);
  });

  it('rejects a truncated tool call (stop_reason max_tokens) instead of trusting a cut-off argument', () => {
    // The tool block parses cleanly against the schema here, but generation hit
    // the token cap mid-stream — the argument is not something the model chose to
    // emit, it is where it was severed. Trusting it would let data loss pass as a
    // real value. Must be a loud, retryable failure, not a silent partial.
    const response = messageWith(
      [
        {
          type: 'tool_use',
          id: 'toolu_3',
          name: 'extract_row',
          input: { fields: [] },
          caller: { type: 'direct' },
        },
      ],
      'max_tokens',
    );

    expect(() =>
      extractStructuredResult({ response, toolName: 'extract_row', schema: rowSchema }),
    ).toThrow(StructuredOutputError);
  });
});

describe('buildStructuredTool', () => {
  it('produces an Anthropic tool whose input schema is derived from the zod schema', () => {
    const tool = buildStructuredTool({
      name: 'extract_row',
      description: 'Extract rows',
      schema: rowSchema,
    });

    expect(tool.name).toBe('extract_row');
    expect(tool.input_schema.type).toBe('object');
  });
});
