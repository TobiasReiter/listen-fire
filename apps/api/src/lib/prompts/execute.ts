import { z } from 'zod';

import { parseJson, parseJsonReply } from 'movement-engine/public/utils';
import { anthropicChat, anthropicChatStructured } from '../anthropic';
import { logger } from 'movement-engine/public/log';
import { DefinitionArgs, PromptDefinition } from './definition';

type DefaultToString<T> = unknown extends T ? string : T;

/**
 * Flatten a promptDef's `messages` into the (system, userMessage) shape the
 * Anthropic wrappers take. System-role blocks become the system prompt;
 * everything else folds into the single user turn — Claude 4.6+ rejects a
 * trailing assistant prefill, so we never emit an assistant turn here.
 *
 * Several turns are each wrapped in a tag naming their role: a definition
 * that sends two texts as two messages (two summaries to combine, two texts to
 * merge) means them as separate things, and a blank line alone would run them
 * together into one.
 */
function flattenMessages(messages: { role: string; content?: unknown }[]): {
  system: string;
  userMessage: string;
} {
  const text = (c: unknown) => (typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c));
  const system = messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const userMessage =
    turns.length === 1
      ? text(turns[0].content)
      : turns.map((m) => `<${m.role}_message>\n${text(m.content)}\n</${m.role}_message>`).join('\n\n');
  return { system, userMessage };
}

/** The self-correction nudge sent on a validation failure (provider-agnostic). */
function buildCorrectionMessage(err: unknown): string {
  return err instanceof z.ZodError
    ? `Your response had validation errors:\n${err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}\n\nPlease fix ONLY the invalid values and return the complete corrected JSON. Do not wrap in markdown code blocks.`
    : `Your response was not valid JSON:\n  ${err instanceof Error ? err.message : err}\n\nPlease return the complete corrected JSON. Do not wrap in markdown code blocks.`;
}

async function execute<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends PromptDefinition<any, any>,
>(
  name: string,
  definition: T,
  args: DefinitionArgs<T['arguments']>,
): Promise<
  DefaultToString<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends PromptDefinition<any, infer Z extends z.ZodType> ? z.infer<Z> : string
  >
> {
  // the generic branching here is gnarly so we're using a type assertion
  type Output = DefaultToString<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends PromptDefinition<any, infer Z extends z.ZodType> ? z.infer<Z> : string
  >;

  const messageParams = definition.messages.map((message) => {
    if (typeof message.content !== 'string') {
      return message;
    }

    return {
      ...message,
      content: message.content.replace(/{{{([^}]+)}}}/g, (_, key: string): string =>
        key in args ? (args[key as keyof typeof args & string] as string) : '',
      ),
    };
  });

  const validate = (raw: string) => {
    if (!('validator' in definition) || !definition.validator) {
      return raw as Output;
    }
    const records = parseJson(raw);
    return definition.validator.parse(records) as Output;
  };

  const model = ('model' in definition ? definition.model : undefined) ?? 'claude-sonnet-5';
  const { system, userMessage } = flattenMessages(messageParams);
  const toolDescription =
    'description' in definition && typeof definition.description === 'string'
      ? definition.description
      : `Produce the ${name} result.`;

  // Structured: the forced tool guarantees schema-valid JSON, so the
  // parseJson / repair / retry machinery below is unnecessary. Run the
  // caller's validator (for transforms) and return.
  if ('response' in definition && definition.response) {
    try {
      const result = await anthropicChatStructured({
        system,
        userMessage,
        schema: definition.response,
        toolName: name,
        toolDescription,
        model,
        label: name,
      });
      return ('validator' in definition && definition.validator
        ? definition.validator.parse(result)
        : result) as Output;
    } catch (err) {
      if ('fallback' in definition) {
        logger.error(`Structured Claude output failed for ${name}, using fallback`, { error: err });
        return definition.fallback as Output;
      }
      throw err;
    }
  }

  // Plain: string out → validate. The retry folds the correction into the
  // user turn — never an assistant prefill (Claude 4.6+ rejects that).
  const raw = await anthropicChat({
    system,
    userMessage,
    model,
    temperature: definition.temperature ?? undefined,
    label: name,
  });
  try {
    return validate(raw);
  } catch (err) {
    if ('fallback' in definition) {
      logger.error(`Claude output failed for ${name}, using fallback`, { error: err });
      return definition.fallback as Output;
    }
    logger.info(`${err instanceof Error ? err.constructor.name : 'Error'} for ${name}, retrying with correction`);
    const retryUserMessage = `${userMessage}\n\n<your_previous_response>\n${raw}\n</your_previous_response>\n\n${buildCorrectionMessage(err)}`;
    const retryRaw = await anthropicChat({ system, userMessage: retryUserMessage, model, label: `${name} (retry)` });
    return validate(retryRaw);
  }
}

export { execute, parseJsonReply, flattenMessages };
