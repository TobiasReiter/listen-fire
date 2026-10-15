// The production model clients a movement run's host hands the engine: the
// extraction keyword's and `AI()`'s (`LlmClient`) and the extraction call's
// (`ExtractCallLlmClient`), both on the Anthropic chat wrapper, with the output
// ceiling and the truncation rule they share.

import type { ExtractCallLlmClient } from 'movement-engine/services/movement_engine/extraction_call';
import type { CancelGate } from 'movement-engine/services/movement_engine/run';
import type { LlmCallInput, LlmClient } from '../engine/batched_extraction';

import { anthropicChatDetailed, MAX_CHAT_CONTINUATIONS, type ChatReply } from '../../../lib/anthropic';
import { parseJsonReply } from '../../../lib/prompts/execute';
import { logger } from 'movement-engine/services/logger';
import { claudeModelId } from 'movement-engine/services/movement_engine/ai_tiers';
import { RunCancelledSignal } from 'movement-engine/services/movement_engine/errors';

export interface ModelClientOptions {
  /** The run's cancel gate, checked before every call: `AI()` reaches a model
   *  without passing any other boundary inside its statement. Absent ⇒ never
   *  cancelled. */
  cancel?: CancelGate;
}

async function throwIfCancelledBy(cancel: CancelGate | undefined): Promise<void> {
  if (cancel && (await cancel.cancelled())) throw new RunCancelledSignal();
}

// ── The output ceiling ──────────────────────────────────────────────────────
//
// This is a LOOP GUARD, for a model that loops. It is off by default: Sonnet 5
// is not expected to loop, so by default an extraction gets a flat ceiling
// (streaming in the wrapper is what makes a ceiling this high safe against
// HTTP timeouts) and the chat wrapper's own continuation default — the same
// trust any other caller gets.
//
// It exists because a model CAN loop: a 2.6k-token input once generated 53.7k
// output tokens over 7½ minutes, because nothing in the request tied the size
// of the answer to the size of the question — a flat 64k ceiling paired with
// the chat wrapper's five continuations put the real ceiling at 384k output
// tokens for any extraction, however small. `EXTRACTION_OUTPUT_BUDGET=1` (or
// `true`) switches a model that DOES loop onto the tighter leash below: a
// reply is not free-form, it restates part of its OWN INPUT as records of
// fields with evidence quotes that are literal substrings of that input, so
// the budget below sizes the ceiling proportional to the input instead of a
// flat number, and caps continuations at one past it.

/** Output tokens allowed per token of input. A reply that restates its input as
 *  fields plus short quotes lands well under 1×; 4× is room for a densely
 *  nested tree, not room for a runaway. Only spent when the guard is on. */
const EXTRACTION_OUTPUT_RATIO = 4;
/** Floor — a tiny input can still ask for a real answer. Only spent when the
 *  guard is on. */
const EXTRACTION_MIN_TOKENS = 8000;
/** Hard ceiling regardless of input size — and the DEFAULT flat ceiling when
 *  the guard is off. Streaming in the wrapper is what makes a ceiling this
 *  high safe against HTTP timeouts. */
const EXTRACTION_MAX_TOKENS = 32000;
/** Rough tokens-per-character for English prose. Only ever used to size a
 *  budget or estimate one after the fact, so being off by a third costs
 *  nothing. */
const CHARS_PER_TOKEN = 4;

/**
 * How much room THIS extraction's reply gets, from the size of what it was
 * asked about. Only consulted when the guard ({@link extractionOutputBudgetEnabled})
 * is on — do not delete this on the assumption the flat ceiling replaced it.
 */
function extractionMaxTokens(input: { system: string; userMessage: string }): number {
  const inputTokens = (input.system.length + input.userMessage.length) / CHARS_PER_TOKEN;
  const proportional = Math.ceil(inputTokens * EXTRACTION_OUTPUT_RATIO);
  return Math.min(EXTRACTION_MAX_TOKENS, Math.max(EXTRACTION_MIN_TOKENS, proportional));
}

/**
 * Continuations allowed after a `max_tokens` stop, once the guard is on. The
 * wrapper's generic five exist for open-ended prose; for an extraction, a
 * reply that has already spent its whole input-proportional budget and wants
 * more is far likelier to be looping than to be mid-answer. One continuation
 * covers a genuine near-miss; past that the truncation raises and
 * `callWithRetry` gets its one clean retry.
 */
const EXTRACTION_MAX_CONTINUATIONS = 1;

/**
 * Opt-in switch for the loop guard above. Read directly off `process.env`
 * (the `LOOP_GUARD_*` idiom, not the prod-required `getEnvVar`) because this
 * is an ops calibration knob, not a required deployment setting — unset must
 * fall back to trusting the model, in every environment including production.
 */
function extractionOutputBudgetEnabled(): boolean {
  const raw = process.env.EXTRACTION_OUTPUT_BUDGET;
  return raw === '1' || raw === 'true';
}

/** How much of a truncated reply's tail is kept in the diagnostic log —
 *  enough to see what the model was mid-writing when the ceiling landed. */
const TRUNCATED_TAIL_CHARS = 400;

/** Best-effort count of what a partial reply managed to answer, for reading
 *  loop-vs-long apart after the fact: a reply near its floor with dozens of
 *  entities already written is a long document; one with none, however large,
 *  is a model that never got past the first field. Counts array entries per
 *  site key (the extraction schema's shape), or the key itself when a site
 *  answered with a single object rather than a list — never throws, since a
 *  truncated body is exactly the case a strict count would fail on. */
function countPartialEntities(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (!parsed || typeof parsed !== 'object') return 0;
  return Object.values(parsed).reduce<number>(
    (total, value) =>
      total + (Array.isArray(value) ? value.length : value && typeof value === 'object' ? 1 : 0),
    0,
  );
}

/** Diagnostics for a truncated extraction call, logged before the run fails on
 *  it — the only record of the partial reply, since a failed call never
 *  reaches `TraceSink` (this seam sits below it; `LlmClient.call` has no trace
 *  to write into, unlike the schema-rejection path in `failedCall`, which logs
 *  a slice of the reply onto the run's own trace instead). */
function logTruncatedExtraction(input: { label: string; userMessage: string }, reply: { text: string }): void {
  const partial = parseJsonReply(reply.text, { label: input.label, prompt: input.userMessage });
  logger.warn('[extraction] truncated', {
    label: input.label,
    // ChatReply carries the call's boundary facts but no usage figures, so
    // this is the same chars/4 estimate `extractionMaxTokens` sizes a budget
    // with — good enough to tell "a little over budget" from "wildly over".
    estimatedOutputTokens: Math.round(reply.text.length / CHARS_PER_TOKEN),
    entitiesParsed: countPartialEntities(partial),
    tail: reply.text.slice(-TRUNCATED_TAIL_CHARS),
  });
}

/**
 * Why the reply is a fragment, in the terms the next reader needs. Two
 * different failures end a call at the ceiling and they want opposite fixes:
 * an answer too long to finish, or an answer never started because the
 * THINKING spent the whole ceiling first (adaptive models pay for both out of
 * one budget). Both name the continuations actually attempted — the ceiling
 * the wrapper was allowed says nothing about what this call did, and quoting
 * it sent the incident's readers looking for a long answer that was never
 * written.
 */
function describeTruncation(reply: ChatReply, ceiling: number): string {
  const spent = `${reply.continuations} continuation${reply.continuations === 1 ? '' : 's'}`;
  if (reply.thinkingOnly) {
    return `the model spent the whole ${ceiling}-token output ceiling thinking${reply.effort ? ` at effort ${reply.effort}` : ''} and produced no text, after ${spent}`;
  }
  return `the model hit the ${ceiling}-token output ceiling and was still truncated after ${spent}`;
}

/** The extraction keyword's and `AI()`'s client — the same wiring as the TG
 *  production batcher's. */
export function makeAnthropicLlmClient(options: ModelClientOptions = {}): LlmClient {
  return {
    async call(input: LlmCallInput) {
      // The in-batch CANCEL gate (runs-and-cancel spec §cancel): both extraction
      // and AI() funnel through here, so a user-requested cancel stops a runaway
      // WITHIN a single statement at the next call boundary.
      await throwIfCancelledBy(options.cancel);
      const model = claudeModelId(input.model);
      // The caller's own ceiling wins where it named one (the most expensive
      // tier does). Otherwise: the guard on ⇒ one sized from what the call was
      // asked about, capped at one continuation; guard off (the default) ⇒ the
      // flat ceiling and the wrapper's own continuation default — trusting the
      // model like any other caller.
      const budgetOn = extractionOutputBudgetEnabled();
      const maxTokens = input.maxTokens ?? (budgetOn ? extractionMaxTokens(input) : EXTRACTION_MAX_TOKENS);
      const maxContinuations = budgetOn ? EXTRACTION_MAX_CONTINUATIONS : MAX_CHAT_CONTINUATIONS;
      const reply = await anthropicChatDetailed({
        system: input.system,
        userMessage: input.userMessage,
        model,
        maxTokens,
        ...(budgetOn ? { maxContinuations } : {}),
        // The caller's depth, verbatim — including its silence. Defaulting one
        // here would make every call an extraction: the output ceiling is what
        // bounds a runaway, and it applies below whatever the caller asked for.
        ...(input.effort ? { effort: input.effort } : {}),
        label: input.label,
      });
      // A truncated body still parses: `parseJsonReply` repairs and trims to the
      // last closing bracket, and the extraction schema is all-optional, so the
      // damage lands as silently-nulled fields instead of a failure. Fail loudly
      // — `callWithRetry` retries once, and a failed run beats invented nulls.
      if (reply.truncated) {
        logTruncatedExtraction(input, reply);
        throw new Error(
          `Extraction '${input.label}' produced no complete answer: ${describeTruncation(reply, maxTokens)} (EXTRACTION_OUTPUT_BUDGET ${budgetOn ? 'on' : 'off'}).`,
        );
      }
      return {
        parsedJson: parseJsonReply(reply.text, { label: input.label, prompt: input.userMessage }),
        // Kept so an anomaly can be shown as the model actually wrote it,
        // before `parseJsonReply` repaired anything. Held in memory for the
        // life of one call; only a misbehaving call ever persists a (capped)
        // slice of it.
        rawText: reply.text,
        ...(reply.steppedDown ? { effortSteppedDown: reply.steppedDown } : {}),
        ...(reply.continuations > 0 ? { continuations: reply.continuations } : {}),
      };
    },
  };
}

/** The production client: the same Anthropic seam, budget and truncation rule
 *  as the keyword's client, with the user turn sent as blocks. The system
 *  block carries the one breakpoint the seam always gives it; the content
 *  carries at most two (`ExtractCallPrefixes`), so a request never asks for
 *  more than the four the API allows. */
export function makeAnthropicExtractCallClient(options: ModelClientOptions = {}): ExtractCallLlmClient {
  return {
    async call(input) {
      await throwIfCancelledBy(options.cancel);
      const joined = input.blocks.map((block) => block.text).join('\n\n');
      const budgetOn = extractionOutputBudgetEnabled();
      const maxTokens =
        input.maxTokens ?? (budgetOn ? extractionMaxTokens({ system: input.system, userMessage: joined }) : EXTRACTION_MAX_TOKENS);
      const reply = await anthropicChatDetailed({
        system: input.system,
        userMessage: input.blocks.map((block) => ({
          text: block.text,
          ...(block.cacheBreakpoint ? { cacheControl: 'ephemeral' as const } : {}),
        })),
        model: claudeModelId(input.model),
        maxTokens,
        maxContinuations: budgetOn ? EXTRACTION_MAX_CONTINUATIONS : MAX_CHAT_CONTINUATIONS,
        ...(input.effort ? { effort: input.effort } : {}),
        label: input.label,
      });
      if (reply.truncated) {
        logTruncatedExtraction({ label: input.label, userMessage: joined }, reply);
        throw new Error(
          `Extraction '${input.label}' produced no complete answer: ${describeTruncation(reply, maxTokens)} (EXTRACTION_OUTPUT_BUDGET ${budgetOn ? 'on' : 'off'}).`,
        );
      }
      return {
        parsedJson: parseJsonReply(reply.text, { label: input.label, prompt: joined }),
        rawText: reply.text,
        ...(reply.steppedDown ? { effortSteppedDown: reply.steppedDown } : {}),
        ...(reply.continuations > 0 ? { continuations: reply.continuations } : {}),
        usage: reply.usage,
      };
    },
  };
}
