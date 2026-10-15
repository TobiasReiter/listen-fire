import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Thrown when the model's response carries no `tool_use` block for the forced
 * structured-output tool. The old prompt-and-parse output path (see
 * `services/knowledge_pipeline/output.ts`) swallowed this case in a `catch` and
 * silently dropped the row; forcing a single tool call and raising here turns a
 * silent data-loss into a loud, retryable failure.
 */
export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/**
 * A single Anthropic tool whose input schema *is* the structured output shape.
 * Forcing this tool (`tool_choice: { type: 'tool', name }`) makes the model
 * return schema-valid JSON as the tool input rather than free text we have to
 * parse. Anthropic tool inputs are always object-rooted, so `schema` must be a
 * `z.object(...)` — array outputs wrap their array in a field.
 */
export function buildStructuredTool(options: {
  name: string;
  description: string;
  schema: z.ZodType;
}): Anthropic.Tool {
  return {
    name: options.name,
    description: options.description,
    // JSON-schema → SDK InputSchema at the boundary; same cast as
    // `convertToolDefinitions` in ./index.ts.
    input_schema: z.toJSONSchema(options.schema) as Anthropic.Tool.InputSchema,
  };
}

/**
 * Pull the forced tool call out of a response and validate it against `schema`.
 * Raises {@link StructuredOutputError} when the tool wasn't called and a
 * `ZodError` when the input doesn't satisfy the schema — never returns
 * unvalidated or partial data.
 */
export function extractStructuredResult<T>(options: {
  response: Anthropic.Message;
  toolName: string;
  schema: z.ZodType<T>;
}): T {
  // A forced tool call that stopped at the token cap was severed mid-stream: the
  // JSON is whatever the model had emitted when the budget ran out, not a value
  // it chose to finish on. Even when the partial happens to satisfy the schema
  // (e.g. an optional field simply never reached), it is data loss wearing a
  // valid shape. Fail loud and retryable rather than let it through — this is the
  // guard that lets callers safely relax a required field to optional.
  if (options.response.stop_reason === 'max_tokens') {
    throw new StructuredOutputError(
      `Model's "${options.toolName}" tool call was truncated at max_tokens — ` +
        `the arguments are incomplete and cannot be trusted (retryable).`,
    );
  }

  const block = options.response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === options.toolName,
  );

  if (!block) {
    const seen = options.response.content.map((b) => b.type).join(', ') || 'none';
    // stop_reason separates the causes that look identical from the content
    // alone: `refusal` (safety classifiers declined — no content at all) vs
    // `max_tokens` (budget exhausted, typically by thinking) vs a model that
    // simply answered in prose despite the forced tool.
    throw new StructuredOutputError(
      `Model did not call the "${options.toolName}" tool ` +
        `(stop_reason: ${options.response.stop_reason ?? 'null'}, content blocks: ${seen})`,
    );
  }

  return options.schema.parse(block.input);
}
