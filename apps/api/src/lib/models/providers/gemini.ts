// Gemini on Google Cloud, behind the chat seam: an Anthropic request in, a
// `generateContent` request out, and the streamed reply assembled back into one
// Anthropic message. Every row of the design's translation table is honoured
// here or raises naming the feature and this provider — a request that would
// silently lose something on the way to Gemini never leaves.
//
// Reaching the fake Gemini in apps/fake-channels (mounted at /gemini), from
// apps/api, with the dev loop's fake channels running on FAKE_CHANNELS_PORT:
//
//   MODEL_MAP='{"claude-sonnet-5":"gemini/gemini-3-pro"}' \
//   GEMINI_BASE_URL="http://localhost:${FAKE_CHANNELS_PORT}/gemini" \
//   GOOGLE_PRIVATE_KEY=unused GOOGLE_CLIENT_EMAIL=fake@example.com GOOGLE_PROJECT_ID=fake-project \
//   GOOGLE_MODEL_REGION=global \
//   pnpm tsx src/scripts/verify_model_map.ts
//
// The fake picks its canned reply from an `X-Fake-Scenario` header (`text` by
// default); see apps/fake-channels/src/routes/gemini.ts for the scenarios.

import { randomUUID } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';
import { FinishReason, FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel } from '@google/genai';
import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
  ThinkingConfig,
  ToolConfig,
} from '@google/genai';
import { z } from 'zod';

import { googleModelRegion, googleServiceAccount } from '../../google_cloud';
import { neverAsAny } from '../../utils/types';
import type { ChatProvider } from '../chat';

const PROVIDER = 'gemini';

function unsupported(feature: string): never {
  throw new Error(
    `${feature} cannot be sent to ${PROVIDER}: MODEL_MAP sends this call to Gemini, which has no ` +
      'equivalent. Remove it from the request, or map the model to anthropic or vertex.',
  );
}

/** A key the translation does not know is a feature it would silently drop. */
function refuseUnknownKeys(value: object, known: readonly string[], where: string): void {
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined && v !== null && !known.includes(key)) unsupported(`${where}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// Client

let provider: ChatProvider | undefined;

export function geminiChatProvider(env: NodeJS.ProcessEnv = process.env): ChatProvider {
  return (provider ??= buildProvider(geminiClient(env)));
}

const clients = new Map<string, GoogleGenAI>();

/**
 * The `@google/genai` client every Gemini capability shares, one per location.
 *
 * Models are addressed where Claude on Vertex is (`GOOGLE_MODEL_REGION`,
 * default the global endpoint): new Gemini models often launch there first,
 * and it carries no regional premium. A capability that needs a real region
 * (image generation, which has always run in the project location) names it.
 */
export function geminiClient(
  env: NodeJS.ProcessEnv = process.env,
  options: { location?: string } = {},
): GoogleGenAI {
  const location = options.location ?? googleModelRegion(env);
  let client = clients.get(location);
  if (!client) {
    client = buildClient(env, location);
    clients.set(location, client);
  }
  return client;
}

function buildClient(env: NodeJS.ProcessEnv, location: string): GoogleGenAI {
  const { projectId, privateKey, clientEmail } = googleServiceAccount(env);
  const baseUrl = env.GEMINI_BASE_URL;
  return new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location,
    // Pinned rather than the SDK's `v1beta1` default: the GA surface is the one
    // the fake mirrors, and a beta default can move under a package upgrade.
    apiVersion: 'v1',
    ...(baseUrl
      ? {
          // A redirected client is talking to a fake, and minting a real token
          // would mean signing with a service account key the fake never
          // checks (and a dev loop does not have). The Gmail client makes the
          // same choice for the same reason. With project and location given,
          // the SDK still builds the full Vertex path under the base URL.
          apiKey: 'dev-loop-gemini-key',
          httpOptions: { baseUrl },
        }
      : {
          googleAuthOptions: {
            credentials: { client_email: clientEmail, private_key: privateKey },
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
        }),
  });
}

function buildProvider(client: GoogleGenAI): ChatProvider {
  const run = async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Message> => {
    const request = toGeminiRequest(params);
    const signal = options?.signal ?? undefined;
    const stream = await client.models.generateContentStream(
      signal ? { ...request, config: { ...request.config, abortSignal: signal } } : request,
    );
    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return toAnthropicMessage(chunks, params.model);
  };
  return {
    messages: {
      // Streamed underneath either way: a long reply outlives a single HTTP
      // request's timeout, and one assembly keeps the two entry points equal.
      create: run,
      stream(params, options) {
        let pending: Promise<Anthropic.Message> | undefined;
        return { finalMessage: () => (pending ??= run(params, options)) };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Request: Anthropic in, Gemini out

const KNOWN_PARAMS = [
  'model',
  'messages',
  'max_tokens',
  'system',
  'tools',
  'tool_choice',
  'thinking',
  'output_config',
  'temperature',
  'stop_sequences',
  // Gemini caches implicitly; a breakpoint has nothing to mark there.
  'cache_control',
  'stream',
] as const;

export function toGeminiRequest(params: Anthropic.MessageCreateParamsNonStreaming): GenerateContentParameters {
  refuseUnknownKeys(params, KNOWN_PARAMS, 'request');
  if (params.stream) unsupported('request.stream');

  const config: GenerateContentConfig = { maxOutputTokens: params.max_tokens };
  const systemInstruction = systemFor(params.system);
  if (systemInstruction) config.systemInstruction = systemInstruction;
  if (params.tools && params.tools.length > 0) {
    config.tools = [{ functionDeclarations: params.tools.map(functionDeclarationFor) }];
  }
  if (params.tool_choice) config.toolConfig = toolConfigFor(params.tool_choice);
  const thinkingConfig = thinkingConfigFor(params.model, params.thinking, params.output_config);
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;
  if (params.temperature !== undefined) config.temperature = params.temperature;
  if (params.stop_sequences && params.stop_sequences.length > 0) {
    config.stopSequences = params.stop_sequences;
  }

  return { model: params.model, contents: contentsFor(params.messages), config };
}

function systemFor(system: Anthropic.MessageCreateParamsNonStreaming['system']): Content | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system === '' ? undefined : { parts: [{ text: system }] };
  if (system.length === 0) return undefined;
  return { parts: system.map((block) => textPartFor(block, 'system')) };
}

function textPartFor(block: Anthropic.TextBlockParam, where: string): Part {
  refuseUnknownKeys(block, ['type', 'text', 'cache_control'], `${where} text block`);
  return { text: block.text };
}

function functionDeclarationFor(tool: Anthropic.ToolUnion): FunctionDeclaration {
  if (!('input_schema' in tool)) {
    // Every server tool (web search, web fetch, code execution, …) is a tool
    // Anthropic runs on its side; Gemini has nothing to run it with.
    unsupported(`The server tool "${tool.type}"`);
  }
  refuseUnknownKeys(tool, ['type', 'name', 'description', 'input_schema', 'cache_control'], `tools["${tool.name}"]`);
  assertSchemaIsNotRecursive(tool.input_schema, tool.name);
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parametersJsonSchema: tool.input_schema,
  };
}

function toolConfigFor(choice: Anthropic.ToolChoice): ToolConfig {
  if (choice.type !== 'none' && choice.disable_parallel_tool_use) {
    unsupported('tool_choice.disable_parallel_tool_use');
  }
  switch (choice.type) {
    case 'auto':
      return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
    case 'any':
      return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
    case 'tool':
      return {
        functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [choice.name] },
      };
    case 'none':
      return unsupported('tool_choice "none"');
    default:
      return neverAsAny(choice);
  }
}

/**
 * Anthropic's two thinking dialects onto Gemini's two knobs, chosen by the
 * REQUEST's dialect: the wrapper already picks adaptive or budgeted thinking
 * per model family, and a map line is what decides that family's Gemini
 * counterpart. Only "no thinking" also depends on the wire model, because only
 * there do the Gemini families differ in what they accept.
 *
 * - adaptive + effort → `thinkingLevel`. Gemini's levels are LOW, MEDIUM, HIGH
 *   (MINIMAL has no Anthropic counterpart); `xhigh` and `max` have nowhere
 *   higher to go and become HIGH. No effort means Anthropic's default, high.
 * - enabled + budget_tokens → `thinkingBudget`, the same number: both count
 *   tokens and both count them inside the output ceiling.
 * - effort without any thinking config → `thinkingLevel` too, since on
 *   Anthropic effort governs spend whether or not thinking is on.
 * - disabled or absent, no effort → no thinking, as far as the model allows:
 *   - Flash: `thinkingBudget: 0`, the SDK's documented off switch. Left unset,
 *     Flash thinks at its own default, which turned a 500-token planning call
 *     into minutes. A Flash generation that refuses 0 fails the call loudly.
 *   - Pro, thinking `disabled`: `thinkingLevel: LOW`. Pro cannot be told not to
 *     think (a budget of 0 is refused), so the closest honest answer to an
 *     explicit "no thinking" is the least it will do.
 *   - Pro, thinking absent: nothing, so Pro thinks at its own default; the
 *     request stated no preference.
 *
 * `includeThoughts` follows whether thinking was asked for and not hidden, so
 * a thought summary comes back as a thinking block exactly when a Claude reply
 * would have carried one.
 */
function thinkingConfigFor(
  wireModel: string,
  thinking: Anthropic.ThinkingConfigParam | undefined,
  outputConfig: Anthropic.OutputConfig | undefined,
): ThinkingConfig | undefined {
  if (outputConfig) {
    refuseUnknownKeys(outputConfig, ['effort'], 'output_config');
  }
  const effort = outputConfig?.effort ?? undefined;
  if (thinking === undefined || thinking.type === 'disabled') {
    if (effort) return { thinkingLevel: thinkingLevelFor(effort) };
    if (canDisableThinking(wireModel)) return { thinkingBudget: 0 };
    return thinking?.type === 'disabled' ? { thinkingLevel: ThinkingLevel.LOW } : undefined;
  }
  const includeThoughts = thinking.display !== 'omitted';
  switch (thinking.type) {
    case 'adaptive':
      return { thinkingLevel: thinkingLevelFor(effort ?? 'high'), includeThoughts };
    case 'enabled':
      if (effort) unsupported('output_config.effort together with thinking.budget_tokens');
      return { thinkingBudget: thinking.budget_tokens, includeThoughts };
    default:
      return neverAsAny(thinking);
  }
}

/** The Flash models accept a thinking budget of 0; the Pro models do not.
 *  Gemini models are not in the registry (a map line names them as free text),
 *  so the wire name is the only thing that says which family answers. */
function canDisableThinking(wireModel: string): boolean {
  return /flash/i.test(wireModel);
}

function thinkingLevelFor(effort: NonNullable<Anthropic.OutputConfig['effort']>): ThinkingLevel {
  switch (effort) {
    case 'low':
      return ThinkingLevel.LOW;
    case 'medium':
      return ThinkingLevel.MEDIUM;
    case 'high':
    case 'xhigh':
    case 'max':
      return ThinkingLevel.HIGH;
    default:
      return neverAsAny(effort);
  }
}

/**
 * Gemini answers a function call BY NAME; Anthropic by the call's id. So each
 * `tool_result` takes the name of the `tool_use` with its id that came most
 * recently before it in this request. Most recently, because the ids this file
 * synthesises restart at `toolu_1` in every reply, and a long tool loop reuses
 * them turn after turn.
 */
function contentsFor(messages: readonly Anthropic.MessageParam[]): Content[] {
  const toolNames = new Map<string, string>();
  return messages.map((message) => {
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    switch (message.role) {
      case 'user':
        return { role: 'user', parts: blocks.map((block) => userPartFor(block, toolNames)) };
      case 'assistant':
        return { role: 'model', parts: modelPartsFor(blocks, toolNames) };
      case 'system':
        return unsupported('A message with role "system" (put it in the system prompt)');
      default:
        return neverAsAny(message.role);
    }
  });
}

function userPartFor(block: Anthropic.ContentBlockParam, toolNames: ReadonlyMap<string, string>): Part {
  switch (block.type) {
    case 'text':
      return textPartFor(block, 'user');
    case 'image':
      refuseUnknownKeys(block, ['type', 'source', 'cache_control'], 'image block');
      if (block.source.type !== 'base64') unsupported(`An image from a ${block.source.type} source`);
      return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
    case 'document':
      refuseUnknownKeys(block, ['type', 'source', 'cache_control'], 'document block');
      if (block.source.type !== 'base64') unsupported(`A document from a ${block.source.type} source`);
      return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
    case 'tool_result': {
      refuseUnknownKeys(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], 'tool_result block');
      const name = toolNames.get(block.tool_use_id);
      if (name === undefined) {
        throw new Error(
          `A tool_result answers "${block.tool_use_id}", but no tool_use with that id comes before it in ` +
            `this request. ${PROVIDER} matches a function response to its call by name, so it cannot be sent.`,
        );
      }
      const text = toolResultText(block.content);
      // Gemini reads a failed call from an `error` key in the response, beside
      // `output` for a successful one. An empty error would read as a failure
      // with no reason, which the model tends to retry blindly, so it says so.
      return {
        functionResponse: {
          name,
          response: block.is_error ? { error: text === '' ? '(no output)' : text } : { output: text },
        },
      };
    }
    default:
      return unsupported(`A "${block.type}" block in a user message`);
  }
}

function toolResultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : unsupported(`A "${part.type}" block inside a tool_result`)))
    .join('\n');
}

/**
 * A reply's assistant turn, back in Gemini's parts.
 *
 * Gemini signs its reasoning with a `thoughtSignature` on the part that follows
 * it and requires it back on that same part. The reply side of this file puts
 * each signature in a thinking block placed immediately BEFORE the block made
 * from its part — so here a thinking block's signature goes onto the next part
 * produced, and a signature with nothing after it is sent the way Gemini sent
 * it: on an empty text part. Nothing else in a thinking block is sent back; its
 * text is a summary for people, and Gemini does not read its own summaries.
 */
function modelPartsFor(blocks: readonly Anthropic.ContentBlockParam[], toolNames: Map<string, string>): Part[] {
  const parts: Part[] = [];
  let signature: string | undefined;
  const signed = (part: Part): Part => {
    const withSignature = signature ? { ...part, thoughtSignature: signature } : part;
    signature = undefined;
    return withSignature;
  };
  for (const block of blocks) {
    switch (block.type) {
      case 'thinking':
        if (signature) parts.push(signed({ text: '' }));
        signature = block.signature === '' ? undefined : block.signature;
        break;
      case 'text':
        parts.push(signed(textPartFor(block, 'assistant')));
        break;
      case 'tool_use': {
        // `caller` is on every tool_use a reply carried, and the wrapper keeps
        // reply blocks verbatim; only a direct call means an ordinary function.
        refuseUnknownKeys(block, ['type', 'id', 'name', 'input', 'cache_control', 'caller'], 'tool_use block');
        if (block.caller && block.caller.type !== 'direct') unsupported(`A tool_use called by ${block.caller.type}`);
        toolNames.set(block.id, block.name);
        parts.push(signed({ functionCall: { name: block.name, args: toolArgs(block.input, block.name) } }));
        break;
      }
      default:
        unsupported(`A "${block.type}" block in an assistant message`);
    }
  }
  if (signature) parts.push(signed({ text: '' }));
  return parts;
}

const ToolArgs = z.record(z.string(), z.unknown());

function toolArgs(input: unknown, name: string): Record<string, unknown> {
  const parsed = ToolArgs.safeParse(input);
  if (!parsed.success) {
    throw new Error(`The tool_use input for "${name}" is not a JSON object, which ${PROVIDER} requires.`);
  }
  return parsed.data;
}

/**
 * Refuse a JSON schema Gemini cannot honour: fully recursive schemas are not
 * supported in function declarations, and an unsupported schema is ignored
 * rather than rejected — so the alternative to raising here is a call whose
 * arguments are shaped by nothing at all.
 *
 * Detection is a cycle walk over the `$defs` graph the schema generator emits. A
 * plain `$ref` is not enough on its own: zod names a merely REUSED subschema the
 * same way, and refusing those would refuse schemas Google is happy with.
 */
export function assertSchemaIsNotRecursive(schema: unknown, name: string): void {
  const withDefs = z.object({ $defs: z.record(z.string(), z.unknown()) }).safeParse(schema);
  if (!withDefs.success) return;

  /** Every `#/$defs/X` this subtree points at, at any depth. */
  const refsWithin = (node: unknown, found: Set<string>): Set<string> => {
    if (Array.isArray(node)) {
      for (const item of node) refsWithin(item, found);
      return found;
    }
    if (typeof node !== 'object' || node === null) return found;
    for (const [key, value] of Object.entries(node)) {
      const target = key === '$ref' && typeof value === 'string' ? /^#\/\$defs\/(.+)$/.exec(value) : null;
      if (target) found.add(target[1]);
      else refsWithin(value, found);
    }
    return found;
  };

  const edges = new Map<string, Set<string>>();
  for (const [defName, defSchema] of Object.entries(withDefs.data.$defs)) {
    edges.set(defName, refsWithin(defSchema, new Set()));
  }

  const visiting = new Set<string>();
  const settled = new Set<string>();
  const reachesItself = (from: string): boolean => {
    if (visiting.has(from)) return true;
    if (settled.has(from)) return false;
    visiting.add(from);
    for (const next of edges.get(from) ?? []) {
      if (reachesItself(next)) return true;
    }
    visiting.delete(from);
    settled.add(from);
    return false;
  };

  // Only the definitions can take part in a cycle — the root is not a `$defs`
  // entry, so nothing can point back at it.
  for (const root of edges.keys()) {
    if (reachesItself(root)) {
      throw new Error(
        `The JSON schema for "${name}" is recursive, and MODEL_MAP sends this call to ${PROVIDER} — ` +
          'Gemini does not support fully recursive schemas and would ignore it rather than refuse ' +
          'it. Flatten the schema, or map the model to anthropic or vertex.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reply: Gemini's streamed chunks in, one Anthropic message out

type OpenText = { text: string; signature?: string };
type PendingThought = { text: string; signature?: string };

/**
 * Chunks arrive as fragments: text split mid-sentence, thought summaries
 * likewise, each function call whole in one part. Adjacent text fragments join
 * into one text block; a signature marks where Gemini's reasoning sat, and is
 * kept as a thinking block right before the block its part became (see
 * {@link modelPartsFor} for the way back).
 */
export function toAnthropicMessage(chunks: readonly GenerateContentResponse[], model: string): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  let thought: PendingThought | undefined;
  let open: OpenText | undefined;
  let toolCalls = 0;

  const emitThinking = (signature: string | undefined): void => {
    const summary = thought?.text ?? '';
    const sig = signature ?? thought?.signature;
    thought = undefined;
    if (sig === undefined && summary === '') return;
    content.push({ type: 'thinking', thinking: summary, signature: sig ?? '' });
  };
  const closeText = (): void => {
    if (!open) return;
    const { text, signature } = open;
    open = undefined;
    emitThinking(signature);
    // A signature can arrive alone on an empty part; it is kept as the thinking
    // block above, and an empty text block would say nothing.
    if (text !== '') content.push({ type: 'text', text, citations: null });
  };

  let finishReason: FinishReason | undefined;
  let finishMessage: string | undefined;
  let usage: GenerateContentResponseUsageMetadata | undefined;
  let responseId: string | undefined;
  let blockReason: string | undefined;

  for (const chunk of chunks) {
    responseId ??= chunk.responseId;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    if (candidate.finishMessage) finishMessage = candidate.finishMessage;

    for (const part of candidate.content?.parts ?? []) {
      if (part.thought) {
        closeText();
        thought = {
          text: (thought?.text ?? '') + (part.text ?? ''),
          signature: part.thoughtSignature ?? thought?.signature,
        };
      } else if (part.functionCall) {
        closeText();
        emitThinking(part.thoughtSignature);
        toolCalls += 1;
        const { name, args } = part.functionCall;
        if (!name) throw new Error(`${PROVIDER} replied with a function call that has no name.`);
        content.push({
          type: 'tool_use',
          id: `toolu_${toolCalls}`,
          name,
          input: args ?? {},
          caller: { type: 'direct' },
        });
      } else if (part.text !== undefined) {
        if (open && !(open.signature && part.thoughtSignature)) {
          open.text += part.text;
          open.signature ??= part.thoughtSignature;
        } else {
          closeText();
          open = { text: part.text, signature: part.thoughtSignature };
        }
      } else {
        throw new Error(
          `${PROVIDER} replied with a part this translation does not carry (fields: ${Object.keys(part).join(', ')}).`,
        );
      }
    }
  }
  closeText();
  emitThinking(undefined);

  if (blockReason) {
    throw new Error(`${PROVIDER} refused the prompt (${blockReason}).`);
  }

  return {
    id: `msg_gemini_${responseId ?? randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toolCalls > 0 ? 'tool_use' : stopReasonFor(finishReason, finishMessage),
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: usageFor(usage),
  };
}

/**
 * Only the endings the table names. A stop sequence ends a Gemini reply as
 * STOP with no way to tell which sequence, so it reads as `end_turn`. Every
 * other reason — a safety block, recitation, a malformed call — is a reply we
 * cannot stand behind, and raises with Gemini's own words rather than passing
 * as an ordinary answer.
 */
function stopReasonFor(finishReason: FinishReason | undefined, finishMessage: string | undefined): Anthropic.StopReason {
  switch (finishReason) {
    case FinishReason.STOP:
      return 'end_turn';
    case FinishReason.MAX_TOKENS:
      return 'max_tokens';
    case undefined:
      throw new Error(`${PROVIDER}'s reply stream ended without a finish reason.`);
    default:
      throw new Error(
        `${PROVIDER} stopped with ${finishReason}${finishMessage ? ` (${finishMessage})` : ''}, ` +
          'which is not an answer this call can use.',
      );
  }
}

/**
 * Anthropic counts cache reads OUTSIDE `input_tokens`; Gemini counts cached
 * content INSIDE `promptTokenCount`. The wrapper adds the two, so input is the
 * prompt less what was read from cache. Output includes the thoughts count:
 * Gemini bills thoughts as output, and Anthropic's `output_tokens` already
 * includes thinking. Gemini's implicit cache has no write step, so creation is
 * zero.
 */
function usageFor(usage: GenerateContentResponseUsageMetadata | undefined): Anthropic.Usage {
  const cached = usage?.cachedContentTokenCount ?? 0;
  return {
    input_tokens: (usage?.promptTokenCount ?? 0) - cached,
    output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}
