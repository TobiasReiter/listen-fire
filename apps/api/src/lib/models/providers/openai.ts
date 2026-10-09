// OpenAI chat completions behind the seam: an Anthropic request goes in, an
// OpenAI request goes out, and the streamed reply is assembled back into one
// Anthropic `Message`.
//
// Every row of the translation table in the model map design (§3) is a
// guarantee; anything outside it raises with the feature and the provider
// named, because a request that quietly loses a field looks exactly like one
// that worked.
//
// Always streamed underneath, whichever of `create` and `stream` the wrapper
// called: a long reply outlives a non streaming HTTP timeout on OpenAI just as
// it does on Anthropic, and one assembly path means the two cannot drift.

import OpenAI from 'openai';

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../chat';

import { getEnvVar } from '../../utils/environment';
import { neverAsAny } from '../../utils/types';

type OpenAiRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type OpenAiMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAiUserPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type OpenAiChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type FinishReason = OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'];
type ReasoningEffort = NonNullable<OpenAiRequest['reasoning_effort']>;

function unsupported(feature: string): Error {
  return new Error(
    `${feature} cannot be sent to the openai provider: it has no OpenAI chat completions ` +
      'equivalent. Map this model to anthropic or vertex, or stop sending it.',
  );
}

/** Refuse every field the caller set that the table has no row for. Collected
 *  from a rest spread so a field the SDK adds later is refused too, rather
 *  than being dropped because nobody thought to list it. */
function refuseRest(where: string, rest: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null) throw unsupported(`${where} \`${key}\``);
  }
}

// ── request ──────────────────────────────────────────────────────────────

function systemText(system: Anthropic.MessageCreateParamsNonStreaming['system']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system.map((block) => textOf(block, 'system')).join('\n\n');
}

function textOf(block: Anthropic.TextBlockParam, where: string): string {
  const { text, type: _type, cache_control: _cacheControl, ...rest } = block;
  refuseRest(`A ${where} text block's`, rest);
  return text;
}

function userPart(block: Anthropic.ContentBlockParam): OpenAiUserPart {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: textOf(block, 'user') };
    case 'image': {
      const { source, type: _type, cache_control: _cacheControl, ...rest } = block;
      refuseRest('An image block’s', rest);
      if (source.type !== 'base64') throw unsupported(`An image with a ${source.type} source`);
      return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
    }
    case 'document': {
      const { source, title, type: _type, cache_control: _cacheControl, ...rest } = block;
      refuseRest('A document block’s', rest);
      if (source.type !== 'base64') throw unsupported(`A document with a ${source.type} source`);
      // OpenAI reads `file_data` as a data URL, not bare base64, and wants a
      // filename beside it; the title is the only name an Anthropic document has.
      return {
        type: 'file',
        file: {
          file_data: `data:${source.media_type};base64,${source.data}`,
          filename: title ?? 'document.pdf',
        },
      };
    }
    default:
      throw unsupported(`A \`${block.type}\` block in a user message`);
  }
}

function toolMessage(block: Anthropic.ToolResultBlockParam): OpenAiMessage {
  const { tool_use_id, content, is_error, type: _type, cache_control: _cacheControl, ...rest } = block;
  refuseRest('A tool_result block’s', rest);
  const text =
    content === undefined
      ? ''
      : typeof content === 'string'
        ? content
        : content
            .map((part) => {
              if (part.type !== 'text') throw unsupported(`A \`${part.type}\` block inside a tool_result`);
              return textOf(part, 'tool_result');
            })
            .join('\n');
  // The model must learn the call failed, and with no error flag on OpenAI's
  // tool message the content is the only channel that can tell it.
  const told = is_error ? `Tool error: ${text || '(no output)'}` : text;
  return { role: 'tool', tool_call_id: tool_use_id, content: told };
}

function userMessages(content: Anthropic.MessageParam['content']): OpenAiMessage[] {
  if (typeof content === 'string') return [{ role: 'user', content }];
  // OpenAI wants each tool message directly after the assistant turn that
  // called it, so tool results go first and whatever else the user turn
  // carried follows as its own user message.
  const results: OpenAiMessage[] = [];
  const parts: OpenAiUserPart[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') results.push(toolMessage(block));
    else parts.push(userPart(block));
  }
  return parts.length > 0 ? [...results, { role: 'user', content: parts }] : results;
}

function assistantMessage(content: Anthropic.MessageParam['content']): OpenAiMessage {
  if (typeof content === 'string') return { role: 'assistant', content };
  const texts: string[] = [];
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        texts.push(textOf(block, 'assistant'));
        break;
      case 'tool_use': {
        const { id, name, input, type: _type, cache_control: _cacheControl, caller, ...rest } = block;
        refuseRest('A tool_use block’s', rest);
        if (caller && caller.type !== 'direct') throw unsupported(`A tool_use called by ${caller.type}`);
        toolCalls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
        break;
      }
      // OpenAI cannot take reasoning back, and a signature is only meaningful
      // to the Anthropic model that wrote it.
      case 'thinking':
      case 'redacted_thinking':
        break;
      default:
        throw unsupported(`A \`${block.type}\` block in an assistant message`);
    }
  }
  return {
    role: 'assistant',
    ...(texts.length > 0 ? { content: texts.join('') } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function functionTool(tool: Anthropic.ToolUnion): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  // Every typed tool is a server tool Anthropic runs itself (web search, web
  // fetch, code execution, …); OpenAI chat completions runs none of them.
  if (tool.type !== undefined && tool.type !== null && tool.type !== 'custom') {
    throw unsupported(`The \`${tool.type}\` server tool`);
  }
  const { name, description, input_schema, type: _type, cache_control: _cacheControl, ...rest } = tool;
  refuseRest(`Tool "${name}"’s`, rest);
  return {
    type: 'function',
    function: { name, ...(description !== undefined ? { description } : {}), parameters: input_schema },
  };
}

function toolChoice(
  choice: Anthropic.ToolChoice,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  if ('disable_parallel_tool_use' in choice && choice.disable_parallel_tool_use) throw unsupported('`tool_choice.disable_parallel_tool_use`');
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    case 'none':
      throw unsupported('`tool_choice: none`');
    default:
      return neverAsAny(choice);
  }
}

/**
 * OpenAI has four named depths where Anthropic has a token budget. The edges
 * sit where this codebase's own budgets fall: Anthropic's floor is 1024, the
 * wrapper's default budget is 8000 and means "think normally", so it lands on
 * `medium`, OpenAI's own default. Below 4096 a caller is asking for a glance
 * (`low`); from 16384 up it is paying for deep reasoning (`high`).
 */
function effortForBudget(budgetTokens: number): ReasoningEffort {
  if (budgetTokens < 4096) return 'low';
  if (budgetTokens < 16384) return 'medium';
  return 'high';
}

function effortForLevel(effort: NonNullable<Anthropic.OutputConfig['effort']>): ReasoningEffort {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
      return effort;
    // OpenAI's ladder stops at `high`.
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return neverAsAny(effort);
  }
}

function reasoningEffort(
  thinking: Anthropic.ThinkingConfigParam | undefined,
  effort: Anthropic.OutputConfig['effort'],
): ReasoningEffort | undefined {
  if (thinking?.type === 'enabled') return effortForBudget(thinking.budget_tokens);
  if (effort) return effortForLevel(effort);
  // Adaptive thinking with no effort named runs at `high` on Anthropic.
  if (thinking?.type === 'adaptive') return 'high';
  return undefined;
}

export function toOpenAiRequest(params: Anthropic.MessageCreateParamsNonStreaming): OpenAiRequest {
  const {
    model,
    max_tokens,
    messages,
    system,
    tools,
    tool_choice,
    thinking,
    output_config,
    temperature,
    stop_sequences,
    stream: _stream,
    // OpenAI caches prompts on its own; there is nothing to mark.
    cache_control: _cacheControl,
    ...rest
  } = params;
  refuseRest('The request field', rest);
  // OpenAI chat completions returns no reasoning at all, which is what
  // `omitted` asks for; a summary it cannot give is refused.
  if (thinking && thinking.type !== 'disabled' && thinking.display === 'summarized') {
    throw unsupported('`thinking.display: summarized`');
  }
  const { effort, ...outputRest } = output_config ?? {};
  refuseRest('The request field output_config', outputRest);

  const instructions = systemText(system);
  const translated = messages.flatMap((message): OpenAiMessage[] =>
    message.role === 'user' ? userMessages(message.content) : [assistantMessage(message.content)],
  );
  const effortLevel = reasoningEffort(thinking, effort);

  return {
    model,
    messages: instructions === undefined ? translated : [{ role: 'system', content: instructions }, ...translated],
    max_completion_tokens: max_tokens,
    stream: true,
    // Without this the stream carries no usage at all, and the ledger would
    // record a free call.
    stream_options: { include_usage: true },
    // OpenAI rejects an empty tools array outright.
    ...(tools && tools.length > 0 ? { tools: tools.map(functionTool) } : {}),
    ...(tool_choice ? { tool_choice: toolChoice(tool_choice) } : {}),
    ...(effortLevel ? { reasoning_effort: effortLevel } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(stop_sequences && stop_sequences.length > 0 ? { stop: stop_sequences } : {}),
  };
}

// ── reply ────────────────────────────────────────────────────────────────

interface PartialToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

function toolUse(call: PartialToolCall): Anthropic.ToolUseBlock {
  if (!call.id || !call.name) {
    throw new Error('The openai provider streamed a tool call with no id or no name.');
  }
  let input: unknown;
  try {
    input = call.arguments === '' ? {} : JSON.parse(call.arguments);
  } catch {
    throw new Error(
      `The openai provider finished a "${call.name}" tool call whose arguments are not JSON: ` +
        `${call.arguments.slice(0, 200)}`,
    );
  }
  return { type: 'tool_use', id: call.id, name: call.name, input, caller: { type: 'direct' } };
}

function stopReason(
  finish: FinishReason,
  hasToolCalls: boolean,
): Anthropic.StopReason {
  switch (finish) {
    // OpenAI answers a tool call it was FORCED into (`tool_choice` naming a
    // function) with `stop`, not `tool_calls`; the calls are what say a tool
    // is waiting.
    case 'stop':
      return hasToolCalls ? 'tool_use' : 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
    case 'function_call':
      throw new Error(
        `The openai provider finished with "${finish}", which has no Anthropic stop reason.`,
      );
    case null:
      throw new Error('The openai provider’s stream ended without a finish reason.');
    default:
      return neverAsAny(finish);
  }
}

/** One Anthropic message from OpenAI's streamed chunks. */
export async function assembleOpenAiMessage(chunks: AsyncIterable<OpenAiChunk>): Promise<Anthropic.Message> {
  let id: string | undefined;
  let model: string | undefined;
  let text = '';
  let refusal = '';
  let finish: FinishReason = null;
  let usage: OpenAiChunk['usage'];
  const calls = new Map<number, PartialToolCall>();

  for await (const chunk of chunks) {
    id ??= chunk.id;
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices) {
      const { delta } = choice;
      if (delta.content) text += delta.content;
      if (delta.refusal) refusal += delta.refusal;
      for (const call of delta.tool_calls ?? []) {
        const partial = calls.get(call.index) ?? { arguments: '' };
        if (call.id) partial.id = call.id;
        if (call.function?.name) partial.name = call.function.name;
        if (call.function?.arguments) partial.arguments += call.function.arguments;
        calls.set(call.index, partial);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }

  if (refusal) throw new Error(`The openai provider refused: ${refusal}`);
  if (!id || !model) throw new Error('The openai provider’s stream carried no chunks.');
  // Silence here would bill the call as free.
  if (!usage) throw new Error('The openai provider’s stream carried no usage.');

  const stop_reason = stopReason(finish, calls.size > 0);
  // A `length` finish severs whatever tool call was being written; handing on
  // the fragment would turn the wrapper's truncation recovery into a JSON
  // parse error, so the reply reads as truncated text with no call at all.
  const toolUses =
    stop_reason === 'max_tokens'
      ? []
      : [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => toolUse(call));

  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [...(text ? [{ type: 'text' as const, text, citations: null }] : []), ...toolUses],
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      // Anthropic's input count excludes cache reads and OpenAI's prompt count
      // includes them; subtracting keeps the ledger from pricing them twice.
      input_tokens: usage.prompt_tokens - cached,
      output_tokens: usage.completion_tokens,
      cache_read_input_tokens: cached,
      // OpenAI caches without a write charge.
      cache_creation_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

// ── provider ─────────────────────────────────────────────────────────────

/** The seam over a given OpenAI client; exported so tests can hand it one
 *  whose `fetch` never leaves the process. */
export function openAiChatProviderOver(client: OpenAI): ChatProvider {
  const complete = async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Message> => {
    const request = toOpenAiRequest(params);
    const signal = options?.signal ?? undefined;
    const stream = await client.chat.completions.create(request, signal ? { signal } : undefined);
    return assembleOpenAiMessage(stream);
  };
  return {
    messages: {
      create: complete,
      stream(params, options) {
        // Started on first ask and remembered, so asking twice is one request.
        let reply: Promise<Anthropic.Message> | undefined;
        return { finalMessage: () => (reply ??= complete(params, options)) };
      },
    },
  };
}

// Built at first use, not at import: `getEnvVar` throws in production on an
// unset key, and merely importing this must not stop a deployment that never
// maps a model to openai from booting.
let client: OpenAI | undefined;
let provider: ChatProvider | undefined;

/** The one OpenAI client every capability shares: chat here, and the
 *  transcription, embedding and image providers beside their capabilities. */
export function openAiClient(env: NodeJS.ProcessEnv = process.env): OpenAI {
  return (client ??= new OpenAI({
    apiKey:
      env.OPENAI_API_KEY ??
      env.OPENAI_API_KEY_FALLBACK_OR_DEV ??
      getEnvVar('OPENAI_API_KEY', {
        devDefault: 'test',
        because: 'it is the key for every model name that resolves to the openai provider',
      }),
    // Read from the passed environment rather than left to the SDK's own
    // `process.env` read, so a caller that threads one is not overruled.
    // Unset means OpenAI itself; the fake OpenAI in the dev loop sets it.
    ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
    ...(env.OPENAI_ORGANIZATION ? { organization: env.OPENAI_ORGANIZATION } : {}),
  }));
}

export function openAiChatProvider(env: NodeJS.ProcessEnv = process.env): ChatProvider {
  return (provider ??= openAiChatProviderOver(openAiClient(env)));
}
