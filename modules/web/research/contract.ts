// What both research engines are: same question in, same dossier out.
//
// Two engines answer "what does this person or company do?" — one drives the
// loop in code, the other hands the loop to a model with Anthropic's own web
// tools. They are being compared, so what they share has to be exact: the same
// input, the same properties, the same outcomes, and the same account of what
// each entry cost. An engine that reported its own shape would be measuring
// itself against its own ruler.

import { z } from 'zod';

import type { ChatModelName } from 'movement-engine/public/models';

import { neverAsAny } from 'movement-lang';
import { describeError } from '../addresses';

/** One entry to research: whatever it carries, plus what the caller wants to
 *  know. Everything but the name is optional, because the case this is built
 *  for is a name and a line of text in a message. */
export interface ResearchInput {
  name: string;
  /** What the message said about it — a description, a sector, a location,
   *  the people behind it. This is what tells the subject apart from every
   *  other use of the word. */
  context?: string;
  /** Any addresses the entry carries. Which is a homepage, which is a
   *  profile, which is an article is the engine's problem, not the caller's. */
  urls?: string[];
  /** What the caller wants the dossier to answer. The dossier is sized to
   *  these, not to everything the web says. */
  questions?: string;
}

/** How far the evidence goes. `high` needs the subject's own source, or two
 *  independent ones that agree; `medium` is plausible and unconfirmed; `low`
 *  is a reading of thin material. */
export type ResearchConfidence = 'high' | 'medium' | 'low';

/**
 * What became of one entry — carried on the plugin trace, so a run's coverage
 * is readable without re-deriving it from which fields landed.
 *
 *   no_anchor    — nothing distinctive to search on: refused before any spend.
 *   no_match     — searched, nothing consistent with the subject.
 *   fetch_failed — a page was chosen and could not be read; whatever was
 *                  resolved along the way is still returned.
 *   partial      — something answered, not all the questions.
 *   resolved     — the questions are answered.
 */
export type ResearchOutcome = 'no_anchor' | 'no_match' | 'fetch_failed' | 'partial' | 'resolved';

/** What one entry cost, so the comparison can price it. Model calls are
 *  recorded rather than capped; searches and page reads are both. */
export interface ResearchUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Cached prompt tokens, read and written. A long system prompt plus a
   *  server-tool turn's own scaffolding lands here rather than in
   *  `inputTokens`, so an engine priced without them looks an order of
   *  magnitude cheaper than it is. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  searches: number;
  fetches: number;
  wallClockMs: number;
  /** Non-fatal trouble worth surfacing on the run record — a shaping call
   *  that failed even after a retry, say, whose write-up was filed anyway
   *  rather than thrown away. Absent when nothing happened worth noting. */
  notes?: string[];
}

/**
 * The dossier. Everything but `outcome` and `usage` is absent when nothing was
 * found — an entry with no public signal returns `{}` plus its outcome, never
 * a hedged summary.
 */
export interface ResearchResult {
  outcome: ResearchOutcome;
  /** The synthesis, sized to the questions. */
  summary?: string;
  confidence?: ResearchConfidence;
  /** The addresses the synthesis rests on, in citation order. */
  sources?: string[];
  /** Resolved or confirmed along the way. */
  website?: string;
  linkedin?: string;
  /** The curated content: the excerpts and snippets that bear on the
   *  questions, each with its source. A few paragraphs, not a page dump. */
  dossier?: string;
  usage: ResearchUsage;
}

/** Which engine drives the loop. `constrained` is what production behaves
 *  like; `agentic` is the side-by-side candidate. */
export type ResearchEngineName = 'constrained' | 'agentic';

/** The knobs the comparison harness turns. An engine's own workflow is its
 *  business; these are the terms both are held to. */
export interface ResearchOptions {
  model?: ChatModelName;
  /** Reasoning depth, on the models that read it. */
  effort?: 'low' | 'medium' | 'high';
  /** At most this many searches, page reads and milliseconds per entry —
   *  the terms that make the comparison fair. */
  budget?: Partial<ResearchBudget>;
}

export interface ResearchBudget {
  maxSearches: number;
  maxFetches: number;
  wallClockMs: number;
}

/** The contract's own numbers (1_contract.md §"Budget per entry"). */
export const DEFAULT_BUDGET: ResearchBudget = {
  maxSearches: 6,
  maxFetches: 3,
  wallClockMs: 3 * 60 * 1000,
};

export const DEFAULT_RESEARCH_MODEL = 'claude-sonnet-5';

/**
 * The wall clock an entry is held to. `RESEARCH_WALL_CLOCK_MS` is how an
 * operator tightens or loosens it without a deploy — read like
 * `RESEARCH_ENGINE`, so an unset variable means the contract's own three
 * minutes rather than a missing-configuration error. Anything that is not a
 * positive number is treated as unset: a deadline of zero or NaN would refuse
 * every entry silently, which is the one failure worse than a slow run.
 */
export function configuredWallClockMs(): number {
  const parsed = Number(process.env.RESEARCH_WALL_CLOCK_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET.wallClockMs;
}

export function budgetOf(options: ResearchOptions | undefined): ResearchBudget {
  return { ...DEFAULT_BUDGET, wallClockMs: configuredWallClockMs(), ...options?.budget };
}

/** An engine: one entry in, one dossier out. Subject first, then the terms. */
export type ResearchEngine = (
  input: ResearchInput,
  options?: ResearchOptions,
) => Promise<ResearchResult>;

export function emptyUsage(): ResearchUsage {
  return {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    searches: 0,
    fetches: 0,
    wallClockMs: 0,
  };
}

/**
 * The `usage.notes` line that says this record's numbers are ABSENT rather
 * than zero.
 *
 * An aborted stream never returns its usage row, so an entry the wall clock
 * cut short reports no tokens, no searches and no cost — and a table that
 * prints that as `$0.0000` says the slowest entry of the run was the cheapest.
 * Anthropic billed for the tokens either way; only our meter missed them.
 */
export const USAGE_NOT_MEASURED = 'usage not measured (aborted)';

/** Whether a record's numbers are missing rather than zero. Readers of a cost
 *  or token figure must ask this first. */
export function usageWasNotMeasured(usage: ResearchUsage): boolean {
  return usage.notes?.includes(USAGE_NOT_MEASURED) ?? false;
}

/** The result for an entry nothing could be found for. */
export function nothingFound(outcome: ResearchOutcome, usage: ResearchUsage): ResearchResult {
  return { outcome, usage };
}

// ── The outcome, shared by both engines ─────────────────────────────────────
//
// An engine's judgment of its OWN answer — did it answer everything, some of
// it, or nothing — is one axis. Whether a server-side fetch errored along the
// way is a different one: a side fetch failing (a guessed URL, a dead link
// among several tried) describes how the research went, not what it found.
// The two used to be conflated — `fetchFailed` outranked a complete answer —
// which turned a fully-answered entry into a reported failure. A fetch error
// explains an EMPTY answer; it never overrides a real one.

/** How much of the caller's questions the engine's own judgment answered. */
export type AnsweredExtent = 'none' | 'some' | 'all';

/**
 * The one place `ResearchOutcome` is decided (1_contract.md "Outcomes").
 * A complete or partial answer stands regardless of a fetch error; a fetch
 * error only speaks when there is no answer to explain the emptiness of.
 */
export function outcomeOf(args: {
  answered: AnsweredExtent;
  fetchFailed: boolean;
}): ResearchOutcome {
  switch (args.answered) {
    case 'all':
      return 'resolved';
    case 'some':
      return 'partial';
    case 'none':
      return args.fetchFailed ? 'fetch_failed' : 'no_match';
    default:
      return neverAsAny(args.answered);
  }
}

/** Records a fetch failure that happened alongside a real answer — one
 *  `outcomeOf` refused to let change the outcome — so it is still visible on
 *  the result rather than only in the log. */
export function noteFetchFailure(usage: ResearchUsage, detail: string): void {
  usage.notes = [...(usage.notes ?? []), `a fetch failed but did not change the outcome: ${detail}`];
}

// ── The final forced-tool call, shared by both engines ─────────────────────
//
// Both engines end with one forced-tool call that files a finished piece of
// research into fixed fields, and both saw the same Sonnet 5 quirk: the call
// sometimes omits `dossier` or collapses a one-item `sources` into the bare
// string rather than an array. Neither is load-bearing — there is nothing to
// confirm about a dossier's own presence — so a filing slip on either must
// never throw away an otherwise finished result.

/** Defaults to an empty string rather than throwing when the model omits it. */
export const dossierField = z.string().default('');

/** Salvages a bare string into a one-element array — the same pattern
 *  `WireResolveEntityResult` uses for a bare array. */
export const sourcesField = z.preprocess(
  (value) => (value === undefined ? [] : typeof value === 'string' ? [value] : value),
  z.array(z.string()),
);

/**
 * Try a forced-tool call once, and — a finished result is worth a second try
 * — once more with the rejection reason appended, so the model sees exactly
 * what it needs to correct. Only a failure on BOTH attempts is reported; the
 * caller keeps whatever real material it already has rather than discard it.
 */
export async function retryFiling<T>(args: {
  call: (userMessage: string) => Promise<T>;
  firstMessage: string;
  onFailure: (attempt: 1 | 2, error: string) => void;
}): Promise<{ value: T } | { failure: string }> {
  const { call, firstMessage, onFailure } = args;
  try {
    return { value: await call(firstMessage) };
  } catch (firstError) {
    const described = describeError(firstError);
    onFailure(1, described);
    try {
      const retryMessage = `${firstMessage}\n\nThe previous filing attempt was rejected: ${described}\nFile it again, correcting only that.`;
      return { value: await call(retryMessage) };
    } catch (secondError) {
      const secondDescribed = describeError(secondError);
      onFailure(2, secondDescribed);
      return { failure: secondDescribed };
    }
  }
}

// ── The opener, shared by both engines ─────────────────────────────────────
//
// Both engines are told, at some length, that the summary answers the
// caller's question rather than narrating the research. Both still open a
// summary now and then by announcing the identification — "This matches
// strongly: UK-based…", "The subject best matching 'Wayfarer' is…" — which
// answers a question nobody asked and buries the one that was asked in the
// second sentence. A prompt that has been strengthened twice and still leaks
// is a rule the prose cannot be trusted to keep, so the opener is also
// checked here.

/** A leading sentence about the MATCHING rather than about the subject. Four
 *  terms, because these are the four the judge has actually caught. */
const VERIFICATION_OPENER = /\bmatch|\bconsistent with\b|\bchecks out\b|\bthe subject\b/i;

/** Splits off the first sentence, when there is a second one to fall back on.
 *  A summary is never improved by being emptied, so a one-sentence summary is
 *  left exactly as it is however it opens. */
const FIRST_SENTENCE = /^\s*(.+?[.!?])\s+(?=["'(\[]?[A-Z])/s;

/**
 * Drop a summary's opening sentence when it talks about the identification
 * instead of the subject, and say so — a rule that fires silently cannot be
 * shown to be wrong, and this one can misfire on a subject whose business is
 * matching people to things.
 */
export function stripVerificationOpener(summary: string): {
  summary: string;
  stripped?: string;
} {
  const match = FIRST_SENTENCE.exec(summary);
  if (!match) return { summary };
  const opener = match[1];
  if (!VERIFICATION_OPENER.test(opener)) return { summary };
  const rest = summary.slice(match[0].length).trim();
  if (!rest) return { summary };
  return { summary: rest, stripped: opener.trim() };
}
