import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { backOff } from 'exponential-backoff';
import { z } from 'zod';

import type {
  PageFetchResult,
  PageFetcher,
  PageReader,
  PageRequest,
  SearchRequest,
  WebSearcher,
  WebSearchResult,
  WebToolEvent,
} from './web_tools';
import type { ChatCallFor } from '../models/chat';
import type { Provider, Resolved } from '../models/map';
import type { ChatModelName } from '../models/registry';

import { buildStructuredTool, extractStructuredResult } from './structured';
import {
  defaultPageReader,
  FETCH_BUDGET_SPENT,
  hasHostedWebSearch,
  pageFetchOutcome,
  pageTextCeiling,
  readAnswerText,
  readPageRequests,
  readSearchRequests,
  readServerToolCounts,
  readWebToolEvents,
  searchOutcome,
  webChatTools,
  WEB_FETCH_MAX_CONTENT_TOKENS,
} from './web_tools';
import { Queue } from '../utils/queue';
import { neverAsAny } from '../utils/types';
import { logger } from '../../services/logger';
import { assertRunBudget } from '../run_spend';

const SECOND = 1000;

// ── What the shell hands the client ───────────────────────────────────────
//
// The client reads no environment and bills nothing itself: which provider
// (and key) answers a model name, and where a call's usage is recorded, are
// the shell's — the hosted product routes by its MODEL_MAP and bills its
// database, `lf` calls Anthropic on the key in its secrets file.

/** One live call's usage, as the shell's billing hook hears it. */
interface LlmUsage {
  resolved: Resolved;
  callType: 'chat' | 'structured' | 'tool_loop';
  label?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
}

interface ModelAccess {
  chatCallFor: ChatCallFor;
  /** Hears every live call's usage. Not awaited by the call: a failed
   *  record never fails the answer it describes. */
  recordUsage(usage: LlmUsage): Promise<void>;
  /** Fields naming who a call is for, put on its log lines. */
  logFields(): Record<string, unknown>;
}

const rateLimitQueue = new Queue<any>({ concurrency: 8 });

const RETRY_LIMIT = 4;
const INITIAL_DELAY = 1 * SECOND;
const TIME_MULTIPLE = 4;
const RATE_LIMIT_DELAY = 30 * SECOND;

async function enqueueQuery<T>(fn: () => Promise<T>, signal?: AbortSignal) {
  // Every request — each turn of a tool loop, each continuation — first asks
  // whether its run has spent its cost cap. Here, in the caller's own async
  // context: the queued job may be started from another job's.
  assertRunBudget();
  return rateLimitQueue.enqueue(async () => {
    return backOff(fn, {
      jitter: 'none',
      numOfAttempts: RETRY_LIMIT,
      startingDelay: INITIAL_DELAY,
      timeMultiple: TIME_MULTIPLE,
      retry: async (e, attempt) => {
        if (signal?.aborted) return false;
        if (e instanceof Error && e.message.includes('429')) {
          logger.info(`Hit Anthropic rate limit, waiting ${RATE_LIMIT_DELAY / SECOND}s`);
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
        } else if (e instanceof Error && e.message.includes('401')) {
          return false;
        }
        if (attempt < RETRY_LIMIT) {
          logger.info(
            `Retrying Anthropic query in ${(INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1)}s`,
            { error: e },
          );
        }
        return true;
      },
    });
  });
}

// ── The usage meter ───────────────────────────────────────────────────────
//
// The shell's `recordUsage` bills a call; this counts one. The two are different
// questions: billing rolls a run up per team, while a caller comparing two
// ways of doing the same job needs the tokens THIS piece of work spent,
// including the work its helpers did on its behalf. Scoped rather than
// returned, because the calls being counted are several layers down from the
// caller that wants the total.
//
// Only a LIVE call is counted — a replayed one spent nothing.

interface AnthropicUsageTally {
  /** Requests that reached Anthropic. A continued or resumed turn is another
   *  request and counts again. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Hosted searches Anthropic billed, when the call declared the tool. */
  searches: number;
  /** Pages read, whoever read them — Anthropic's hosted fetcher or our own.
   *  "Nothing billed" is not "nothing read". */
  fetches: number;
}

function emptyTally(): AnthropicUsageTally {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    searches: 0,
    fetches: 0,
  };
}

const usageMeter = new AsyncLocalStorage<AnthropicUsageTally>();

function tallyUsage(delta: Partial<AnthropicUsageTally>): void {
  const tally = usageMeter.getStore();
  if (!tally) return;
  tally.calls += delta.calls ?? 1;
  tally.inputTokens += delta.inputTokens ?? 0;
  tally.outputTokens += delta.outputTokens ?? 0;
  tally.cacheReadTokens += delta.cacheReadTokens ?? 0;
  tally.cacheCreationTokens += delta.cacheCreationTokens ?? 0;
  tally.searches += delta.searches ?? 0;
  tally.fetches += delta.fetches ?? 0;
}

/** Run `fn` and report what every Anthropic call underneath it cost.
 *  Nesting is fine: an inner meter and an outer one each see their own scope's
 *  calls, and the outer one does NOT see the inner one's. */
async function meterAnthropicUsage<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; usage: AnthropicUsageTally }> {
  const usage = emptyTally();
  const value = await usageMeter.run(usage, fn);
  return { value, usage };
}

interface OpenAIToolDef {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Anthropic models speak two different thinking-config dialects:
 *  - The adaptive families (Opus 4.6+, Sonnet 5, Fable / Mythos) REQUIRE
 *    `thinking: { type: 'adaptive' }` paired with `output_config: { effort }`
 *    and REJECT `{ type: 'enabled' }`.
 *  - The explicit-budget families (Haiku, legacy Sonnet 4.x) REQUIRE
 *    `thinking: { type: 'enabled', budget_tokens }`, REJECT `adaptive`, and
 *    do NOT accept `output_config`.
 *
 * Callers express intent ("think hard") via whatever shape suited the model
 * they were originally written against. This normalizes that intent to the
 * dialect the actual `model` accepts, so swapping a caller's model id is all
 * it takes to switch families — the wrapper fixes up the thinking config.
 *
 * `budget_tokens` is clamped below `max_output_tokens` (Anthropic requires
 * max_output_tokens > thinking.budget_tokens).
 *
 */
function resolveThinkingConfig(options: {
  model: string;
  thinking: AnthropicToolLoopParams['thinking'];
  outputConfig: AnthropicToolLoopParams['output_config'];
  maxOutputTokens: number;
}): {
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
  output_config?: { effort: 'low' | 'medium' | 'high' };
} {
  const { model, thinking, outputConfig, maxOutputTokens } = options;
  if (!thinking) return {};

  // Adaptive-thinking families (Opus 4.6+, Sonnet 5, Fable / Mythos). Sonnet 5
  // in particular REJECTS the `enabled` / `budget_tokens` dialect that Sonnet
  // 4.x required, so it must route here.
  const usesAdaptiveThinking =
    model.startsWith('claude-opus') ||
    model.startsWith('claude-sonnet-5') ||
    model.startsWith('claude-fable') ||
    model.startsWith('claude-mythos');

  if (usesAdaptiveThinking) {
    return {
      thinking: { type: 'adaptive' },
      output_config: outputConfig ?? { effort: 'high' },
    };
  }

  // Haiku / legacy Sonnet 4.x: explicit budget, no output_config.
  const requestedBudget = thinking.type === 'enabled' ? thinking.budget_tokens : 8000;
  const budget_tokens = Math.min(requestedBudget, Math.max(1024, maxOutputTokens - 1024));
  return { thinking: { type: 'enabled', budget_tokens } };
}

function convertToolDefinitions(openaiTools: OpenAIToolDef[]): Anthropic.Tool[] {
  return openaiTools.map((tool, i) => {
    const converted: Anthropic.Tool = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    };
    // Mark the last tool with cache_control so system + tools prefix gets cached
    if (i === openaiTools.length - 1) {
      converted.cache_control = { type: 'ephemeral' };
    }
    return converted;
  });
}

/**
 * Per-request view of `messages` with a cache breakpoint on the final
 * content block. Applied to a shallow copy, never the stored array:
 * the breakpoint must sit at the *current* end of the conversation on
 * every request, and the API allows at most 4 breakpoints per request
 * (tools carry one, system up to two, so exactly one lives here).
 *
 * Caching is a strict prefix match and only content **before** a
 * breakpoint is ever read from cache — without this marker the entire
 * conversation history is reprocessed at full price on every turn.
 * With it, each request's history is readable by the next request
 * (the API walks back up to 20 content blocks to find the previous
 * entry, so turns with very large parallel tool fan-outs may still
 * miss — acceptable, that's the rare case).
 */
function withFinalCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];

  let content: Anthropic.MessageParam['content'];
  if (typeof last.content === 'string') {
    content = [
      {
        type: 'text' as const,
        text: last.content,
        cache_control: { type: 'ephemeral' as const },
      },
    ];
  } else {
    const blocks = [...last.content];
    const lastBlock = blocks[blocks.length - 1];
    // thinking blocks can't carry cache_control. In practice the final
    // message is always a user turn (text or tool_result), but guard
    // rather than 400 the whole request on an unexpected shape.
    if (
      lastBlock.type === 'text' ||
      lastBlock.type === 'tool_use' ||
      lastBlock.type === 'tool_result'
    ) {
      blocks[blocks.length - 1] = {
        ...lastBlock,
        cache_control: { type: 'ephemeral' as const },
      };
    }
    content = blocks as Anthropic.MessageParam['content'];
  }

  return [...messages.slice(0, -1), { role: last.role, content }];
}

interface TurnEvent {
  turn: number;
  /**
   * Concatenated text-block content emitted alongside any tool calls on
   * this turn. Despite the name (kept for backwards compatibility with
   * the runner's `emitUpdate({ type: 'thinking', ... })` UI hook),
   * this is the model's visible-to-user text, not extended thinking.
   */
  thinkingText: string | null;
  /**
   * Extended-thinking content emitted by the model when the request had
   * `thinking: { type: 'enabled' }`. Null when thinking wasn't enabled
   * or the model produced no thinking block this turn.
   *
   * Captured per turn so the M2 instrumentation in the agent runner can
   * concatenate across turns and persist into `agent_message.metadata
   * .thoughts.thinking`.
   */
  extendedThinking: string | null;
  toolNames: string[];
  llmMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Set when the API stopped the turn at `max_tokens`, so a harness can see the
   * truncation instead of inferring it from a turn that did nothing.
   *  - 'text' — visible text came back; the loop asks the model to continue it.
   *  - 'no_output' — nothing usable came back: a tool call cut off mid-JSON
   *    (the common case) or thinking that consumed the whole budget. No tool
   *    ran. The loop asks for a smaller step; two of these in a row is fatal.
   */
  truncated?: 'text' | 'no_output';
}

/**
 * M4: callers that want explicit control over cache breakpoints
 * (e.g. Setup's `[static prompt][running state]` two-block layout so
 * the static prefix stays cacheable while the running state changes
 * every Kth turn) pass `system` as an array. Single-string callers
 * continue to get a single cached system block, preserving existing
 * behaviour everywhere else.
 *
 */
export interface AnthropicSystemBlock {
  text: string;
  /**
   * When set, the API treats this block as a cache breakpoint with
   * 5-minute ephemeral TTL. The default (omitted) means no breakpoint
   * on this block — caching cascades from earlier marked blocks.
   */
  cacheControl?: 'ephemeral';
}

interface AnthropicToolLoopParams {
  model?: ChatModelName;
  max_output_tokens?: number;
  maxTurns?: number;
  /**
   * Either a plain string (legacy / simple callers — gets a single
   * `cache_control: ephemeral` system block) OR an array of explicit
   * system blocks where each entry controls its own cache breakpoint.
   * The array form is used by Setup's M4 layout (static prompt as one
   * stable cached block + running state as a separate block whose
   * `cache_control` is the agreed prefix boundary).
   */
  system: string | AnthropicSystemBlock[];
  userMessage: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: OpenAIToolDef[];
  onTurn?: (event: TurnEvent) => void;
  label?: string;
  signal?: AbortSignal;
  /**
   * Opt into Anthropic extended thinking. Two shapes:
   *  - `{ type: 'enabled', budget_tokens }` — Sonnet / older Claude 4
   *    series; explicit thinking budget.
   *  - `{ type: 'adaptive' }` — Opus 4.7+; the model decides how much
   *    to think based on `output_config.effort`. Pair with that field.
   *
   * The loop forwards `thinking` (and `output_config`, when set) verbatim
   * to the Messages API and surfaces the resulting `thinking` blocks via
   * `TurnEvent.extendedThinking` regardless of the variant.
   *
   */
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
  /**
   * Effort knob for Opus 4.7's adaptive thinking. Required when
   * `thinking.type === 'adaptive'`. Ignored otherwise.
   */
  output_config?: { effort: 'low' | 'medium' | 'high' };
}

async function anthropicToolLoop(
  access: ModelAccess,
  params: AnthropicToolLoopParams,
  toolImpls: Record<string, (args: any) => Promise<any>> = {},
): Promise<Array<{ type: string; text?: string; content?: string }>> {
  const {
    model = 'claude-sonnet-5',
    max_output_tokens = 16384,
    system,
    userMessage,
    conversationHistory,
    tools: openaiTools,
    onTurn,
    label,
    maxTurns,
    signal,
    thinking,
    output_config,
  } = params;

  const anthropicTools = convertToolDefinitions(openaiTools);
  const { client, wireModel, resolved } = access.chatCallFor(model);

  const resolvedThinking = resolveThinkingConfig({
    model,
    thinking,
    outputConfig: output_config,
    maxOutputTokens: max_output_tokens,
  });

  const systemMessages: Anthropic.MessageCreateParams['system'] =
    typeof system === 'string'
      ? [
          {
            type: 'text' as const,
            text: system,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : system.map((block) => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cacheControl === 'ephemeral'
            ? { cache_control: { type: 'ephemeral' as const } }
            : {}),
        }));

  const messages: Anthropic.MessageParam[] = [
    ...(conversationHistory ?? []).map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    // Skip empty user message (e.g. handoff re-entry where referral is already in history)
    ...(userMessage ? [{ role: 'user' as const, content: userMessage }] : []),
  ];

  const MAX_MESSAGE_CHARS = 400_000; // ~100K tokens — leave headroom for system prompt + output

  // A tool call cut off mid-JSON returns nothing the loop can act on. We tell
  // the model its call was truncated and ask for a smaller one — but only so
  // many times: if it can't get under the ceiling in two consecutive tries,
  // that's a real failure and must be raised, not returned as an empty answer.
  const MAX_TRUNCATION_RECOVERIES = 2;
  let truncationRecoveries = 0;

  for (let turn = 0; ; turn++) {
    if (signal?.aborted) throw new Error('Aborted');

    if (maxTurns !== undefined && turn >= maxTurns) {
      logger.error('[anthropic] tool loop hit maxTurns', { turn, maxTurns, model, label });
      throw new Error(
        `Anthropic tool loop exhausted its turn budget (maxTurns=${maxTurns})${
          label ? ` in ${label}` : ''
        } — the agent never finished.`,
      );
    }

    const llmStart = Date.now();

    const response = await enqueueQuery(async () => {
      return client.messages.create(
        {
          model: wireModel,
          max_tokens: max_output_tokens,
          system: systemMessages,
          tools: anthropicTools,
          messages: withFinalCacheBreakpoint(messages),
          ...(resolvedThinking.thinking ? { thinking: resolvedThinking.thinking } : {}),
          ...(resolvedThinking.output_config
            ? { output_config: resolvedThinking.output_config }
            : {}),
        },
        { signal },
      );
    }, signal);

    const llmMs = Date.now() - llmStart;

    const textBlocks: string[] = [];
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
    const thinkingBlocks: string[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      } else if (block.type === 'thinking') {
        // Extended-thinking content block. Captured separately from
        // visible-to-user text so the M2 runner can persist it onto
        // `agent_message.metadata.thoughts.thinking`.
        thinkingBlocks.push((block as { thinking: string }).thinking);
      }
    }

    const thinkingText = textBlocks.length > 0 ? textBlocks.join('\n') : null;
    const extendedThinking = thinkingBlocks.length > 0 ? thinkingBlocks.join('\n') : null;
    const usage = response.usage;

    // `max_tokens` with no text is the silent-death case: a tool call that ran
    // out of budget mid-JSON is dropped from `content`, so the turn carries
    // neither an executable call nor an answer.
    const truncated: TurnEvent['truncated'] =
      response.stop_reason === 'max_tokens'
        ? textBlocks.length > 0
          ? 'text'
          : 'no_output'
        : undefined;

    const event: TurnEvent = {
      turn,
      thinkingText,
      extendedThinking,
      toolNames: toolUseBlocks.map((b) => b.name),
      llmMs,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      ...(truncated ? { truncated } : {}),
    };

    logger.info('[anthropic] turn', {
      turn,
      model,
      stop_reason: response.stop_reason,
      ...(truncated ? { truncated } : {}),
      llmMs,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      thinkingText: thinkingText ? thinkingText.slice(0, 500) : null,
      toolNames: toolUseBlocks.map((b) => b.name),
    });

    onTurn?.(event);

    tallyUsage({
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
    });

    access.recordUsage({
      resolved,
      callType: 'tool_loop',
      label,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      durationMs: event.llmMs,
    }).catch(() => {});

    if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
      truncationRecoveries = 0;
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (tc) => {
          if (signal?.aborted)
            return { type: 'tool_result' as const, tool_use_id: tc.id, content: 'Aborted' };
          const tool = toolImpls[tc.name];
          let result;
          if (tool) {
            try {
              result = await tool(tc.input as any);
            } catch (e: any) {
              // Re-throw control-flow signals (e.g. handoff/hand-back) — they must propagate
              if (e?.isHandoff || e?.isHandBack) throw e;
              result = { error: String(e) };
            }
          } else {
            result = { error: `Tool ${tc.name} not found` };
          }

          return {
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: JSON.stringify(result),
          };
        }),
      );

      if (signal?.aborted) throw new Error('Aborted');

      messages.push({ role: 'user', content: toolResults });

      // Compact old tool results once the run gets genuinely large, recovering
      // enough to drop back under a comfortable working ceiling — "compaction by
      // omission". Opus's 1M window means we can let a build accumulate real
      // context (schemas read, plan, completions) before trimming, instead of
      // forgetting after a handful of tool turns. We use the API's own token
      // count rather than re-serializing.
      //   COMPACT_TRIGGER_TOKENS — let context grow this far before trimming.
      //   COMPACT_TARGET_TOKENS  — trim back down to roughly this.
      // Cache note: rewriting old blocks changes the prompt prefix, so a
      // compaction costs one full cache re-write. Raising the trigger means it
      // fires far more rarely (most sessions never reach it → fully append-only,
      // cache-friendly); when it does fire it recovers a lot at once. ~4 chars
      // per token converts the token gap into a char-recovery goal.
      const COMPACT_TRIGGER_TOKENS = 500_000;
      const COMPACT_TARGET_TOKENS = 200_000;
      if (usage.input_tokens > COMPACT_TRIGGER_TOKENS) {
        const targetRecoverChars = (usage.input_tokens - COMPACT_TARGET_TOKENS) * 4;
        let recovered = 0;
        // Walk oldest→newest, skip the most recent tool_result (just appended)
        for (let i = 0; i < messages.length - 1; i++) {
          const msg = messages[i];
          if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (
              typeof block === 'object' &&
              'type' in block &&
              block.type === 'tool_result' &&
              typeof block.content === 'string' &&
              block.content.length > 200
            ) {
              recovered += block.content.length;
              (block as Anthropic.ToolResultBlockParam).content =
                '[Compacted — re-query if needed.]';
            }
          }
          if (recovered >= targetRecoverChars) break;
        }
        if (recovered > 0) {
          logger.info('[anthropic] compacted old tool results', {
            recoveredChars: recovered,
            inputTokens: usage.input_tokens,
          });
        }
      }
    } else if (truncated === 'text') {
      // Response was truncated — feed partial output back and ask to continue
      truncationRecoveries = 0;
      logger.info('[anthropic] tool loop response truncated, continuing', { turn });
      const partialText = textBlocks.join('\n');
      messages.push({ role: 'assistant', content: partialText });
      messages.push({ role: 'user', content: 'Continue exactly where you left off.' });
    } else if (truncated === 'no_output') {
      // The turn died mid-tool-call: nothing ran and nothing was said. Falling
      // through here returns [] and ends the run in silence, so instead we say
      // what happened and ask for a smaller step.
      truncationRecoveries += 1;
      if (truncationRecoveries > MAX_TRUNCATION_RECOVERIES) {
        logger.error('[anthropic] tool loop truncated repeatedly, giving up', {
          turn,
          model,
          label,
          recoveries: truncationRecoveries - 1,
          maxOutputTokens: max_output_tokens,
        });
        throw new Error(
          `Anthropic tool loop truncated at max_tokens (${max_output_tokens}) before emitting a usable tool call, ${
            MAX_TRUNCATION_RECOVERIES
          } recoveries in a row${label ? ` in ${label}` : ''}.`,
        );
      }

      logger.warn('[anthropic] tool loop truncated mid-tool-call, asking for a smaller step', {
        turn,
        model,
        label,
        recovery: truncationRecoveries,
        maxOutputTokens: max_output_tokens,
      });
      messages.push({
        role: 'assistant',
        content: '[Reply cut off at the output token limit before anything was emitted.]',
      });
      messages.push({
        role: 'user',
        content:
          'Your last reply hit the output token limit before it finished a tool call, so nothing ran and nothing reached me. Redo that step as a smaller tool call — less text in the arguments, and split the work across several calls if you need to.',
      });
    } else {
      return textBlocks.map((text) => ({ type: 'text', text }));
    }
  }
}

const MAX_CHAT_CONTINUATIONS = 5;

/** How long one Messages request may run before the wait itself is news. Silence
 *  for longer than this is indistinguishable from a hang to anyone watching the
 *  logs, which is exactly how a 7½-minute extraction read as a dead process. */
const SLOW_CALL_WARN_MS = 60 * SECOND;

/**
 * One block of a user turn sent as separate blocks. `cacheControl` makes the
 * END of this block a cache breakpoint — the caller says where its stable
 * prefix ends, and nothing else in the request adds one to the turn. Providers
 * without explicit breakpoints drop the marker and keep the order.
 */
export interface AnthropicUserBlock {
  text: string;
  cacheControl?: 'ephemeral';
}

interface AnthropicChatOptions {
  system: string;
  /** The user turn: one string, or separate blocks for a caller that places
   *  its own cache breakpoints (the system block always carries one). */
  userMessage: string | AnthropicUserBlock[];
  model?: ChatModelName;
  maxTokens?: number;
  label?: string;
  noContinue?: boolean;
  temperature?: number;
  /**
   * Reasoning depth for the models that reason by DEFAULT. Sonnet 5 and the
   * Opus 4.6+ family think adaptively when `thinking` is omitted, at effort
   * `high` — so a caller that never mentions thinking still buys the deepest
   * setting, and pays for it in output tokens it never asked for. Naming an
   * effort here is how a caller says how much reasoning its job is worth.
   *
   * Ignored on the budget-dialect models (Haiku, legacy Sonnet 4.x), which do
   * not accept `output_config` and do not think unless explicitly told to.
   *
   * `xhigh` sits between `high` and `max` (Opus 4.7+, Sonnet 5) — this SDK's
   * pinned version types `output_config.effort` without it, so it crosses
   * into the raw request via an assertion below rather than a plain field.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Ceiling on continue-where-you-left-off turns after a `max_tokens` stop.
   *  Defaults to {@link MAX_CHAT_CONTINUATIONS}. Lower it where a long reply is
   *  more likely to be a runaway than a real answer — each continuation buys
   *  another whole `maxTokens` of output. */
  maxContinuations?: number;
}

/**
 * Models that read `output_config: { effort }` and think adaptively when
 * `thinking` is omitted. Mirrors {@link resolveThinkingConfig}'s family split —
 * the budget-dialect models (Haiku, legacy Sonnet 4.x) reject `output_config`
 * outright and start from no thinking at all, so there is nothing to bound.
 */
function usesAdaptiveThinking(model: string): boolean {
  return (
    model.startsWith('claude-opus') ||
    model.startsWith('claude-sonnet-5') ||
    model.startsWith('claude-fable') ||
    model.startsWith('claude-mythos')
  );
}

/**
 * Announce a call that is STILL RUNNING once it passes the slow threshold, and
 * again with its duration when it lands. The in-flight line is the one that
 * matters: a completion log, however detailed, says nothing during the wait it
 * is describing. Returns the settle callback.
 */
function watchSlowCall(fields: Record<string, unknown>): (outcome: 'ok' | 'error') => void {
  const startMs = Date.now();
  const timer = setTimeout(() => {
    logger.warn('[anthropic] chat still running', { ...fields, afterMs: SLOW_CALL_WARN_MS });
  }, SLOW_CALL_WARN_MS);
  // Never let a pending warning be the reason the process stays alive.
  timer.unref?.();
  return (outcome) => {
    clearTimeout(timer);
    const durationMs = Date.now() - startMs;
    if (durationMs >= SLOW_CALL_WARN_MS) {
      logger.warn('[anthropic] chat slow', { ...fields, durationMs, outcome });
    }
  };
}

/**
 * A chat reply WITH the boundary facts a caller needs to judge it. The bare
 * string surface throws these away, which is how a truncated reply reaches a
 * lenient JSON salvage and comes out validating with half its fields nulled.
 */
interface ChatReply {
  text: string;
  stopReason: Anthropic.StopReason | null;
  /** The loop ran out of road while still truncated — continuations exhausted,
   *  `noContinue`, or the text-free bail. The text is a fragment. */
  truncated: boolean;
  /** Continuation turns actually attempted, NOT the ceiling that was allowed.
   *  A reply that died before writing a character attempted none, and a caller
   *  that reports the ceiling instead sends its reader after the wrong thing. */
  continuations: number;
  /** The last turn spent its whole ceiling thinking: `max_tokens`, no text, and
   *  nothing in the reply but reasoning. There is no fragment to salvage. */
  thinkingOnly: boolean;
  /** The depth the LAST turn ran at — the caller's, unless the step-down below
   *  lowered it. Absent when the caller named none. */
  effort?: ChatEffort;
  /** Set when a thinking-only turn was retried one effort lower. The answer in
   *  hand is the cheaper one, and a caller that meters or traces its calls has
   *  to be able to say so. */
  steppedDown?: { from: ChatEffort; to: ChatEffort };
  /** The output ceiling every turn ran under. */
  maxTokens: number;
  /** Tokens across every turn — what a caller measuring its cache reads. */
  usage: ChatUsage;
}

interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

type ChatEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * One rung down the reasoning ladder — `undefined` at the bottom, and for a
 * caller that named no depth at all (there is nothing to lower: the model is
 * already at its own default, and naming one for it would be a different
 * question than the caller asked).
 */
function effortBelow(effort: ChatEffort | undefined): ChatEffort | undefined {
  switch (effort) {
    case 'xhigh':
      return 'high';
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    case 'low':
    case undefined:
      return undefined;
  }
}

async function anthropicChatDetailed(access: ModelAccess, options: AnthropicChatOptions): Promise<ChatReply> {
  const {
    system,
    userMessage,
    model = 'claude-sonnet-5',
    maxTokens = 16384,
    label,
    noContinue = false,
    temperature,
    effort,
    maxContinuations = MAX_CHAT_CONTINUATIONS,
  } = options;
  const { client, wireModel, resolved } = access.chatCallFor(model);

  // Adaptive thinking is ON by default on these models; the only lever a chat
  // caller has over its depth is `effort`, and it only lands if `thinking` is
  // sent alongside it. `currentEffort` is what THIS turn asks for — the
  // caller's, until a turn spends the whole ceiling thinking.
  let currentEffort = effort;
  const thinkingConfigFor = (depth: ChatEffort | undefined) =>
    depth && usesAdaptiveThinking(model)
      ? { thinking: { type: 'adaptive' as const }, output_config: { effort: depth } }
      : {};

  const requestId = randomUUID().slice(0, 8);
  const callFields = { label, model, requestId, ...access.logFields() };
  const callStartMs = Date.now();

  // An empty system text block is a 400 at the API, and a caller that has only
  // a user turn to send (a bare prompt) has nothing to put there.
  const systemParam = system
    ? { system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }] }
    : {};
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        typeof userMessage === 'string'
          ? userMessage
          : userMessage.map((block) => ({
              type: 'text' as const,
              text: block.text,
              ...(block.cacheControl === 'ephemeral'
                ? { cache_control: { type: 'ephemeral' as const } }
                : {}),
            })),
    },
  ];

  let accumulated = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let stopReason: Anthropic.StopReason | null = null;
  let contentBlockTypes: string[] = [];
  let turnsTaken = 0;
  let steppedDown: { from: ChatEffort; to: ChatEffort } | undefined;
  let thinkingOnly = false;

  // `turn` counts CONTINUATIONS, not requests: a step-down asks the same
  // question again rather than continuing an answer, so it does not spend one.
  let turn = 0;
  for (;;) {
    turnsTaken += 1;
    logger.info('[anthropic] chat starting', {
      ...callFields,
      turn,
      maxTokens,
      effort: currentEffort,
    });

    const settleWatch = watchSlowCall({ ...callFields, turn });
    let response: Anthropic.Message;
    try {
      // Streamed rather than awaited whole: above ~16K `max_tokens` a
      // non-streaming request outlives the SDK's HTTP timeout. `finalMessage()`
      // reassembles the same `Message`, so nothing downstream changes.
      response = await enqueueQuery(async () => {
        const stream = client.messages.stream({
          model: wireModel,
          max_tokens: maxTokens,
          ...systemParam,
          messages,
          ...thinkingConfigFor(currentEffort),
          ...(temperature != null && { temperature }),
        });
        return stream.finalMessage();
      });
    } catch (error) {
      settleWatch('error');
      throw error;
    }
    settleWatch('ok');

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    accumulated += text;
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    totalCacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    totalCacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;
    stopReason = response.stop_reason;
    contentBlockTypes = response.content.map((b) => b.type);
    thinkingOnly =
      response.stop_reason === 'max_tokens' &&
      text === '' &&
      contentBlockTypes.length > 0 &&
      contentBlockTypes.every((type) => type === 'thinking');

    if (response.stop_reason !== 'max_tokens' || noContinue) break;

    // Truncated *before* any text — the whole budget went on THINKING, which is
    // paid for out of the same ceiling as the answer. There is nothing to
    // continue from (the continuation below would push an empty assistant turn,
    // which the API rejects), but the question can be asked again less deeply:
    // the depth is what ate the room the answer needed. Once only — a second
    // text-free turn means the ceiling itself is short, and that is the
    // caller's to report.
    if (text === '') {
      const from = thinkingOnly && !steppedDown ? currentEffort : undefined;
      const lower = from && effortBelow(from);
      if (!from || !lower) break;
      logger.warn('[anthropic] thought past the ceiling — retrying one effort lower', {
        ...callFields,
        from,
        to: lower,
        maxTokens,
      });
      steppedDown = { from, to: lower };
      currentEffort = lower;
      continue;
    }

    if (turn === maxContinuations) break;

    turn += 1;
    logger.info('[anthropic] chat truncated, continuing', { ...callFields, turn });

    // Feed partial output back as assistant turn, ask to continue
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: 'Continue exactly where you left off.' });
  }

  const durationMs = Date.now() - callStartMs;

  logger.info('[anthropic] chat', {
    ...callFields,
    stopReason,
    durationMs,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
  });

  // A text-free reply is a real outcome, not an anomaly: `refusal` returns 200
  // with no content, and an adaptive-thinking model that exhausts `maxTokens`
  // thinking returns only a (display-omitted) thinking block. Callers see `''`
  // either way, so name the cause here — downstream this surfaces as an opaque
  // parse failure with nothing pointing back at the model.
  if (accumulated === '') {
    logger.warn('[anthropic] chat returned no text', {
      ...callFields,
      stopReason,
      contentBlockTypes,
      maxTokens,
      durationMs,
    });
  }

  tallyUsage({
    calls: turnsTaken,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
  });

  access.recordUsage({
    resolved,
    callType: 'chat',
    label,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
  }).catch(() => {});

  return {
    text: accumulated,
    stopReason,
    truncated: stopReason === 'max_tokens',
    continuations: turn,
    thinkingOnly,
    ...(currentEffort ? { effort: currentEffort } : {}),
    ...(steppedDown ? { steppedDown } : {}),
    maxTokens,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
    },
  };
}

/**
 * Chat reply plus its boundary facts. Use this — not {@link anthropicChat} —
 * whenever a truncated reply would be indistinguishable from a complete one
 * downstream (a JSON body a lenient parser will happily salvage, say).
 */
/** The bare-text surface. */
async function anthropicChat(access: ModelAccess, options: AnthropicChatOptions): Promise<string> {
  return (await anthropicChatDetailed(access, options)).text;
}

interface AnthropicChatStructuredOptions<T> {
  system: string;
  userMessage: string;
  /** Object-rooted schema — Anthropic tool inputs are always objects. */
  schema: z.ZodType<T>;
  /** Tool name the model is forced to call. */
  toolName: string;
  toolDescription: string;
  model?: ChatModelName;
  maxTokens?: number;
  label?: string;
}

/**
 * Structured Anthropic output via a single forced tool call. Returns a
 * schema-validated object; raises rather than silently dropping on a missing
 * tool call or invalid input (see {@link StructuredOutputError}).
 */
async function anthropicChatStructured<T>(
  access: ModelAccess,
  options: AnthropicChatStructuredOptions<T>,
): Promise<T> {
  const {
    system,
    userMessage,
    schema,
    toolName,
    toolDescription,
    model = 'claude-sonnet-5',
    maxTokens = 4096,
    label,
  } = options;

  const { client, wireModel, resolved } = access.chatCallFor(model);
  const tool = buildStructuredTool({ name: toolName, description: toolDescription, schema });

  const startMs = Date.now();
  const response: Anthropic.Message = await enqueueQuery(async () =>
    client.messages.create({
      model: wireModel,
      max_tokens: maxTokens,
      system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user', content: userMessage }],
      tools: [tool],
      tool_choice: { type: 'tool', name: toolName },
    }),
  );
  const durationMs = Date.now() - startMs;

  tallyUsage({
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
  });

  access.recordUsage({
    resolved,
    callType: 'structured',
    label,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    durationMs,
  }).catch(() => {});

  return extractStructuredResult({ response, toolName, schema });
}

// ── Chat with Anthropic's own web tools ───────────────────────────────────

/** Anthropic's server-side sampling loop pauses after its own iteration
 *  ceiling and says so with `pause_turn`; re-sending the conversation
 *  unchanged resumes it. This bounds how often that is worth doing — a turn
 *  that keeps pausing is searching in circles, not converging. */
const MAX_WEB_CHAT_RESUMES = 3;

interface AnthropicWebChatOptions {
  system: string;
  userMessage: string;
  model?: ChatModelName;
  maxTokens?: number;
  /** Reasoning depth, on the models that read it (see {@link AnthropicChatOptions}). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  label?: string;
  /** Hard ceiling on searches for the whole request. Anthropic enforces it on
   *  its hosted search, this loop on the client-side one; past the cap either
   *  returns `max_uses_exceeded` rather than searching. */
  maxSearches?: number;
  /** The same ceiling for page reads. `web_fetch` only opens an address that
   *  is already in the conversation — a search result, or one the prompt put
   *  there — so it can never wander off on its own. */
  maxFetches?: number;
  maxResumes?: number;
  /** How much of any one fetched page reaches the model's context. Defaults to
   *  {@link WEB_FETCH_MAX_CONTENT_TOKENS}. */
  maxFetchContentTokens?: number;
  /**
   * Who reads a page: Anthropic's hosted fetcher, or ours through
   * {@link fetchPage}. Defaults to whichever the provider serves — but it is a
   * real choice on either, because our fetcher renders JavaScript-heavy pages
   * the hosted one returns empty. Asking for `hosted` where the provider has none
   * is refused rather than quietly downgraded.
   */
  pageReader?: PageReader;
  /** Reads one page for the `own` reader. Required by it: a missing handler is
   *  a wiring mistake, and throws at the call rather than turning every page
   *  read into a failure the model has to work around. */
  fetchPage?: PageFetcher;
  /** Runs one search, where the provider has no hosted search of its own
   *  (anything but `anthropic` and `vertex`). Required there, for the same
   *  reason `fetchPage` is required by the `own` reader; ignored elsewhere. */
  searchWeb?: WebSearcher;
  /** Every request this conversation may make, counting resumes and page-read
   *  answers. Defaults below; hitting it returns the partial answer. */
  maxTurns?: number;
  /** Cancels the request in flight. A caller with its own deadline needs the
   *  streaming call ABORTED rather than abandoned — an abandoned turn keeps
   *  searching, reading and billing after the caller has stopped waiting for
   *  it. An abort surfaces as a rejection from this function. */
  signal?: AbortSignal;
}

interface AnthropicWebChatReply {
  /** The prose the model wrote, across every turn of the paused loop. */
  text: string;
  /** Every search and page read it made, in order, failures included. A page
   *  read by our own fetcher is the same `fetch` / `fetch_failed` event a
   *  hosted one is, so a trace reads the same whichever reader ran. */
  events: WebToolEvent[];
  stopReason: Anthropic.StopReason | null;
  /** How many times the paused loop was resumed. At the ceiling the answer is
   *  whatever the model had written by then. */
  resumes: number;
  /** Every request made, including resumes and page-read answers. */
  turns: number;
  /** Which reader actually ran — on the record rather than re-derived from the
   *  provider, so a trace never has to guess why a fetch is not billed. */
  pageReader: PageReader;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Searches made, whoever ran them: Anthropic's billed searches where it
     *  hosts search, our own service's otherwise. */
    searches: number;
    /** Pages read, whoever read them: Anthropic's billed fetches on the hosted
     *  reader, our own fetcher's reads otherwise. "Nothing billed" is not
     *  "nothing read", and this field answers the second question. */
    fetches: number;
  };
}

/** How many pages (or searches) this loop runs at once when the model asks for
 *  several in one turn. Small on purpose: the handler behind each has its own
 *  queue and its own third party, and a turn asking for more than a handful at
 *  once is not a turn that is converging. */
const MAX_CONCURRENT_CLIENT_TOOLS = 3;

/** The page reader in force, with everything answering it needs. The handler
 *  travels WITH the mode so no later code has to re-check that it exists. */
type ResolvedPageReader = { mode: 'hosted' } | { mode: 'own'; fetchPage: PageFetcher };

function resolvePageReader(options: {
  requested: PageReader | undefined;
  provider: Provider;
  fetchPage: PageFetcher | undefined;
}): ResolvedPageReader {
  const { requested, provider, fetchPage } = options;
  const mode = requested ?? defaultPageReader(provider);
  switch (mode) {
    case 'hosted':
      return { mode };
    case 'own':
      // A wiring mistake, not a runtime condition: raised at the call rather
      // than turned into a failure the model has to work around on every page.
      if (!fetchPage) {
        throw new Error(
          'anthropicWebChat was asked to read pages with its own fetcher, but no `fetchPage` ' +
            'handler was supplied.',
        );
      }
      return { mode, fetchPage };
    default:
      return neverAsAny(mode);
  }
}

/** Who runs a search: the provider's hosted tool, or our own handler. The
 *  handler travels with the mode, as the page reader's does. */
type ResolvedSearcher = { mode: 'hosted' } | { mode: 'own'; searchWeb: WebSearcher };

function resolveSearcher(options: {
  provider: Provider;
  searchWeb: WebSearcher | undefined;
}): ResolvedSearcher {
  const { provider, searchWeb } = options;
  if (hasHostedWebSearch(provider)) return { mode: 'hosted' };
  if (!searchWeb) {
    throw new Error(
      `anthropicWebChat runs on the ${provider} provider, which has no hosted web search, but no ` +
        '`searchWeb` handler was supplied to answer the model\'s searches.',
    );
  }
  return { mode: 'own', searchWeb };
}

/** What the turn that just came back asks the loop to do next. Hosted tools
 *  never stop a turn for an answer, so a `tool_use` stop is always a client
 *  side tool's: a page read, a search, or both in one turn. */
type WebChatStep =
  | { kind: 'done' }
  | { kind: 'resume' }
  | { kind: 'client_tools'; pages: PageRequest[]; searches: SearchRequest[] };

function nextWebChatStep(options: {
  response: Anthropic.Message;
  pages: ResolvedPageReader;
  searcher: ResolvedSearcher;
}): WebChatStep {
  const { response, pages, searcher } = options;
  if (response.stop_reason === 'pause_turn') return { kind: 'resume' };
  if (response.stop_reason !== 'tool_use') return { kind: 'done' };
  const pageRequests = pages.mode === 'own' ? readPageRequests(response.content) : [];
  const searchRequests = searcher.mode === 'own' ? readSearchRequests(response.content) : [];
  return pageRequests.length > 0 || searchRequests.length > 0
    ? { kind: 'client_tools', pages: pageRequests, searches: searchRequests }
    : { kind: 'done' };
}

/** `fn` over every item, a few at a time, results in the items' order. */
async function mapFewAtATime<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_CLIENT_TOOLS, items.length) }, worker),
  );
  return results;
}

/**
 * Every page the model asked for in one turn, answered in one user turn.
 *
 * The budget is spent in the order the model asked, BEFORE anything runs, so
 * which reads are refused does not depend on which came back first. The reads
 * themselves run together, a few at a time.
 */
async function answerPageRequests(options: {
  requests: readonly PageRequest[];
  fetchPage: PageFetcher;
  /** Reads still inside the caller's ceiling. */
  remaining: number;
  maxContentChars: number;
}): Promise<{ results: Anthropic.ToolResultBlockParam[]; events: WebToolEvent[]; read: number }> {
  const { requests, fetchPage, remaining, maxContentChars } = options;

  let budget = remaining;
  const planned = requests.map((request) => {
    if (!request.url) return { request, url: null };
    if (budget <= 0) return { request, url: null, spent: true };
    budget -= 1;
    return { request, url: request.url };
  });

  const outcomes = await mapFewAtATime(planned, async (step) => {
    const result: PageFetchResult = step.url
      ? await fetchPage(step.url).catch((error: unknown) => ({ error: describeThrown(error) }))
      : { error: 'spent' in step ? FETCH_BUDGET_SPENT : 'no_url' };
    return pageFetchOutcome({
      url: step.request.url,
      result,
      maxContentChars,
      retrievedAt: new Date().toISOString(),
    });
  });

  return {
    results: outcomes.map((outcome, i) => ({
      type: 'tool_result' as const,
      tool_use_id: planned[i].request.id,
      content: outcome.told,
      ...(outcome.isError ? { is_error: true } : {}),
    })),
    events: outcomes.map((outcome) => outcome.event),
    read: planned.filter((step) => step.url != null).length,
  };
}

/**
 * Every search the model asked for in one turn, answered alongside its page
 * reads. Budgeted in the order asked, before anything runs, as page reads are.
 */
async function answerSearchRequests(options: {
  requests: readonly SearchRequest[];
  searchWeb: WebSearcher;
  /** Searches still inside the caller's ceiling. */
  remaining: number;
}): Promise<{ results: Anthropic.ToolResultBlockParam[]; events: WebToolEvent[]; ran: number }> {
  const { requests, searchWeb, remaining } = options;

  let budget = remaining;
  const planned = requests.map((request) => {
    if (!request.query) return { request, query: null };
    if (budget <= 0) return { request, query: null, spent: true };
    budget -= 1;
    return { request, query: request.query };
  });

  const outcomes = await mapFewAtATime(planned, async (step) => {
    const result: WebSearchResult = step.query
      ? await searchWeb(step.query).catch((error: unknown) => ({ error: describeThrown(error) }))
      : { error: 'spent' in step ? FETCH_BUDGET_SPENT : 'no_query' };
    return searchOutcome({ query: step.request.query, result });
  });

  return {
    results: outcomes.map((outcome, i) => ({
      type: 'tool_result' as const,
      tool_use_id: planned[i].request.id,
      content: outcome.told,
      ...(outcome.isError ? { is_error: true } : {}),
    })),
    events: outcomes.map((outcome) => outcome.event),
    ran: planned.filter((step) => step.query != null).length,
  };
}

/** A handler that rejected is a failed read, not a failed call: the model is
 *  told the page would not open and gets to try another one. */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One turn with web search and a page reader, resumed through whatever pauses
 * the server-side loop takes. Search and page reads run on the provider where
 * it hosts them and through the caller's handlers where it does not.
 * Everything the model looked at comes back alongside its answer, so a caller
 * can cite what it read and see what failed.
 */
async function anthropicWebChat(
  access: ModelAccess,
  options: AnthropicWebChatOptions,
): Promise<AnthropicWebChatReply> {
  const {
    system,
    userMessage,
    model = 'claude-sonnet-5',
    maxTokens = 8192,
    effort,
    label,
    maxSearches = 6,
    maxFetches = 3,
    maxResumes = MAX_WEB_CHAT_RESUMES,
    maxFetchContentTokens = WEB_FETCH_MAX_CONTENT_TOKENS,
    signal,
    fetchPage,
    searchWeb,
  } = options;
  const { client, wireModel, resolved } = access.chatCallFor(model);
  const { provider } = resolved;

  const thinkingConfig =
    effort && usesAdaptiveThinking(model)
      ? { thinking: { type: 'adaptive' as const }, output_config: { effort } }
      : {};

  const pages = resolvePageReader({ requested: options.pageReader, provider, fetchPage });
  const pageReader = pages.mode;
  const searcher = resolveSearcher({ provider, searchWeb });
  const tools = webChatTools({
    provider,
    pageReader,
    maxSearches,
    maxFetches,
    maxFetchContentTokens,
  });
  // Every request this conversation may make: the one that answers, one per
  // resume of a paused server-side loop, one per page read and client-side
  // search, and two spare for a model that asks again after its budget is
  // spent. Without it, a model that keeps asking for what it cannot have never
  // stops.
  const maxTurns =
    options.maxTurns ??
    1 + maxResumes + maxFetches + (searcher.mode === 'own' ? maxSearches : 0) + 2;

  const requestId = randomUUID().slice(0, 8);
  const callFields = { label, model, requestId, ...access.logFields() };
  const callStartMs = Date.now();

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
  const events: WebToolEvent[] = [];
  let text = '';
  let stopReason: Anthropic.StopReason | null = null;
  let resumes = 0;
  let turns = 0;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    searches: 0,
    fetches: 0,
  };

  for (let turn = 0; ; turn++) {
    logger.info('[anthropic] web chat starting', {
      ...callFields,
      turn,
      maxSearches,
      maxFetches,
      pageReader,
      searcher: searcher.mode,
      effort,
    });

    const settleWatch = watchSlowCall({ ...callFields, turn });
    let response: Anthropic.Message;
    try {
      response = await enqueueQuery(async () => {
        const stream = client.messages.stream(
          {
            model: wireModel,
            max_tokens: maxTokens,
            system: [
              { type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } },
            ],
            // The system block's breakpoint already caches the tools that
            // precede it. The second one is for a conversation that GROWS —
            // resumed turns, and page text coming back as tool results — so
            // each request can read the previous one's history from cache
            // instead of paying for it again. The first request has nothing
            // behind it to cache, so it is left exactly as it was.
            messages: turn === 0 ? messages : withFinalCacheBreakpoint(messages),
            tools,
            ...thinkingConfig,
          },
          { signal },
        );
        return stream.finalMessage();
      }, signal);
    } catch (error) {
      settleWatch('error');
      throw error;
    }
    settleWatch('ok');
    turns += 1;

    text += readAnswerText(response.content);
    events.push(...readWebToolEvents(response.content));
    const counts = readServerToolCounts(response.usage);
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;
    usage.searches += counts.searches;
    usage.fetches += counts.fetches;
    stopReason = response.stop_reason;

    const next = nextWebChatStep({ response, pages, searcher });
    if (next.kind === 'done') break;

    if (turns >= maxTurns) {
      logger.warn('[anthropic] web chat hit its turn ceiling', {
        ...callFields,
        turns,
        maxTurns,
        stopReason,
      });
      break;
    }

    if (next.kind === 'resume') {
      if (resumes >= maxResumes) {
        logger.warn('[anthropic] web chat still paused at the resume ceiling', {
          ...callFields,
          resumes,
        });
        break;
      }
      // The API resumes on the trailing `server_tool_use` block alone — an
      // added "continue" turn is the one thing that stops it working.
      messages.push({ role: 'assistant', content: response.content });
      resumes += 1;
      continue;
    }

    // Every client-side call in the turn is answered in one user turn: a
    // tool_use left without its result is a 400 on the next request.
    const searched =
      searcher.mode === 'own' && next.searches.length > 0
        ? await answerSearchRequests({
            requests: next.searches,
            searchWeb: searcher.searchWeb,
            remaining: Math.max(0, maxSearches - usage.searches),
          })
        : { results: [], events: [], ran: 0 };
    const read =
      pages.mode === 'own' && next.pages.length > 0
        ? await answerPageRequests({
            requests: next.pages,
            fetchPage: pages.fetchPage,
            remaining: Math.max(0, maxFetches - usage.fetches),
            maxContentChars: pageTextCeiling(maxFetchContentTokens),
          })
        : { results: [], events: [], read: 0 };
    events.push(...searched.events, ...read.events);
    usage.searches += searched.ran;
    usage.fetches += read.read;
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: [...searched.results, ...read.results] });
  }

  const durationMs = Date.now() - callStartMs;
  logger.info('[anthropic] web chat', {
    ...callFields,
    stopReason,
    durationMs,
    resumes,
    turns,
    pageReader,
    searcher: searcher.mode,
    ...usage,
    failedTools: events.filter((e) => e.kind.endsWith('_failed')).length,
  });

  tallyUsage({
    calls: turns,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    searches: usage.searches,
    fetches: usage.fetches,
  });

  access.recordUsage({
    resolved,
    callType: 'chat',
    label,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    durationMs,
  }).catch(() => {});

  return { text, events, stopReason, resumes, turns, pageReader, usage };
}

/** The client bound to one shell's access: the surface every caller uses. */
interface AnthropicClient {
  anthropicToolLoop(
    params: AnthropicToolLoopParams,
    toolImpls?: Record<string, (args: any) => Promise<any>>,
  ): ReturnType<typeof anthropicToolLoop>;
  anthropicChat(options: AnthropicChatOptions): Promise<string>;
  anthropicChatDetailed(options: AnthropicChatOptions): Promise<ChatReply>;
  anthropicChatStructured<T>(options: AnthropicChatStructuredOptions<T>): Promise<T>;
  anthropicWebChat(options: AnthropicWebChatOptions): Promise<AnthropicWebChatReply>;
}

function anthropicClient(access: ModelAccess): AnthropicClient {
  return {
    anthropicToolLoop: (params, toolImpls) => anthropicToolLoop(access, params, toolImpls),
    anthropicChat: (options) => anthropicChat(access, options),
    anthropicChatDetailed: (options) => anthropicChatDetailed(access, options),
    anthropicChatStructured: (options) => anthropicChatStructured(access, options),
    anthropicWebChat: (options) => anthropicWebChat(access, options),
  };
}

export {
  anthropicClient,
  meterAnthropicUsage,
  MAX_CHAT_CONTINUATIONS,
};
export { StructuredOutputError } from './structured';
export type {
  AnthropicClient,
  LlmUsage,
  ModelAccess,
  TurnEvent,
  AnthropicToolLoopParams,
  AnthropicChatOptions,
  AnthropicChatStructuredOptions,
  AnthropicUsageTally,
  AnthropicWebChatOptions,
  AnthropicWebChatReply,
  ChatReply,
};
export { defaultPageReader } from './web_tools';
export type {
  PageFetcher,
  PageFetchResult,
  PageReader,
  SearchHit,
  WebSearcher,
  WebSearchResult,
  WebToolEvent,
} from './web_tools';
