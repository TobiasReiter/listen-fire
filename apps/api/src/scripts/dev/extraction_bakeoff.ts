/**
 * Extraction model bake-off — which model should each tier buy?
 *
 * The tier mapping (`ai_tiers.ts`) decides what `quick` / `careful` /
 * `thorough` cost the platform, and it shipped on judgement. This settles it
 * with numbers: the SAME extraction, the SAME production prompts, over fixed
 * inputs whose right answer was written down first, run on each candidate
 * model, twice.
 *
 * What it drives, and what it does not:
 *
 * - It drives `materializeExtract` directly — the real materializer, the real
 *   prompt builder, the real response schema, the real validate-then-retry
 *   loop. Nothing about the call is reimplemented here, because a
 *   reimplementation would measure the harness.
 * - It needs no stack: no server, no database, no dev-loop slot. The runtime's
 *   three dependencies (an LLM client, a plugin invoker, an expression
 *   evaluator) are all supplied here, and the two that are not the LLM are
 *   fixed by hand so the only thing varying is the model.
 * - The plugin invoker returns FIXED text (`_fixtures/extraction_bakeoff.ts`).
 *   A bake-off that reached the network would be measuring the network.
 *
 * How the model is chosen. Production's client already maps a tier key to a
 * model id (`'opus' | 'sonnet' | 'haiku'` → the three candidates), so the
 * harness wraps that client and rewrites the key rather than pinning a model
 * id of its own. That keeps every other setting — the streamed request, the
 * input-proportional output ceiling, the one-continuation cap, the tier's
 * reasoning effort — exactly production's, which is the only way the numbers
 * transfer.
 *
 * How the tokens are read. They exist for about a millisecond: the Anthropic
 * wrapper logs them, records them to `llm_usage` under the ambient team, and
 * drops them. With no team there is no row, so the harness reads the log line
 * the wrapper already writes, through a pass-through wrapper on the logger.
 * Deliberately a read-only tap — the alternative was a callback seam through
 * two shared production files, which is not worth carrying for a measurement
 * script.
 *
 * Usage (real API spend — every run costs money):
 *
 *   pnpm dev:extraction-bakeoff --dry-run              # prompts + plan, no calls
 *   pnpm dev:extraction-bakeoff --fixtures slack_small --reps 1
 *   pnpm dev:extraction-bakeoff --out /tmp/bakeoff     # round 1's full matrix
 *
 * Round 2 (`--conditions`) asks a different question — see {@link CONDITIONS}.
 * It compares whole TIER SETTINGS rather than models, on the two fixtures hard
 * enough to separate them:
 *
 *   pnpm dev:extraction-bakeoff --conditions A,B,C \
 *     --fixtures reconcile_long,nested_synthesis --reps 3 --out /tmp/round2
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ExtractExpression } from 'movement-lang';
import type { ChatModelName } from 'movement-engine/lib/models/registry';
import type { MovementTraceEntry } from 'movement-engine/services/movement_engine/expression';
import type {
  LlmCallInput,
  LlmClient,
} from '../../services/translation_graph/engine/batched_extraction';

import { BARE_HOST } from 'movement-engine/services/movement_engine/host_kit';
import { anthropicChatDetailed } from '../../lib/anthropic';
import { parseJsonReply } from '../../lib/prompts/execute';
import { logger } from 'movement-engine/services/logger';
import { makeAnthropicLlmClient } from '../../services/translation_graph/movement/llm_clients';
import {
  buildExtractSpec,
  materializeExtract,
  type ExtractEmission,
  type ExtractNodeSpec,
  type ExtractSpecOptions,
  type MovementTransformInvoker,
} from 'movement-engine/services/movement_engine/extraction';
import { NO_PROVENANCE } from 'movement-engine/services/movement_engine/provenance';
import {
  claudeModelId,
  extractionSettings,
  type TierCallSettings,
} from 'movement-engine/services/movement_engine/ai_tiers';
import {
  FIXTURES,
  resolveDeclaredType,
  type ExpectedNode,
  type Fixture,
} from './_fixtures/extraction_bakeoff';
import { bundledPluginSpecs } from 'movement-engine/public/plugins';

// ── The candidates ─────────────────────────────────────────────────────────

/**
 * The three models the tier mapping can currently reach, named by the key
 * production's client already understands. Prices are dollars per million
 * tokens, copied from movement-engine's `lib/models/prices.json` — the table this
 * repo actually bills against — so the bake-off's cost column and the app's
 * own cost column cannot drift apart.
 */
const CANDIDATES = {
  haiku: { id: 'claude-haiku-4-5-20251001', input: 0.8, output: 4.0 },
  sonnet: { id: 'claude-sonnet-5', input: 3.0, output: 15.0 },
  opus: { id: 'claude-opus-4-7', input: 5.0, output: 25.0 },
} as const;

type Candidate = keyof typeof CANDIDATES;

const ALL_CANDIDATES: Candidate[] = ['haiku', 'sonnet', 'opus'];

/** Hard stop, overridable with `--budget`. Real spend on a measurement is worth
 *  it only while it stays small; past this the run aborts with whatever it has
 *  already collected. */
const DEFAULT_BUDGET_DOLLARS = 12;

// ── Round 2: the conditions ────────────────────────────────────────────────
//
// Round 1 compared three models at one fixed reasoning effort. It could not
// price the `thorough` tier, because `thorough` is not a model — it is a model
// PLUS a thinking configuration plus an output ceiling, and round 1 varied only
// the first of those. Round 2 varies all three together, as one setting each,
// and asks the only question left: what does the expensive tier buy?
//
// Two things about these settings are worth stating rather than inferring.
//
// 1. WHICH MODEL IS ASKED TO THINK. The chat wrapper sends `thinking` and
//    `output_config` only when the caller names an effort. So an arm with no
//    effort sends neither field — and what that MEANS is a property of the
//    model, not of us: on `claude-opus-4-7` an absent `thinking` runs the model
//    with NO thinking at all, while on `claude-sonnet-5` and `claude-opus-5` it
//    runs adaptive thinking at the model's own default depth. The `thorough`
//    tier as mapped today therefore buys the LEAST reasoning of the three arms
//    below, at the highest price per token.
// 2. WHERE THE OUTPUT TOKENS COME FROM. Thinking tokens are billed as output
//    and are counted in `usage.output_tokens`, which is what the tap reads. The
//    `out tok` column is therefore total BILLED output — visible answer plus
//    reasoning — which is the number the cost comparison needs.
const CONDITIONS = {
  /** A — `careful` at the mapping round 1 recommended: sonnet-5, effort `high`
   *  (adaptive thinking, capped), input-proportional output ceiling. */
  A: {
    label: 'A careful (sonnet-5 / high / proportional)',
    modelId: 'claude-sonnet-5',
    effort: 'high' as const,
    maxTokens: undefined,
    input: 2.0,
    output: 10.0,
  },
  /** B — `thorough` exactly as mapped today: opus-4-7, no effort named, flat
   *  32k. On this model an absent `thinking` is no thinking. */
  B: {
    label: 'B thorough as mapped (opus-4-7 / no thinking / 32k)',
    modelId: 'claude-opus-4-7',
    effort: undefined,
    maxTokens: 32000,
    input: 5.0,
    output: 25.0,
  },
  /** C — `thorough` as proposed: opus-5, no effort named, flat 32k. Same
   *  request shape as B; on THIS model an absent `thinking` is adaptive
   *  thinking at the model's own default effort. */
  C: {
    label: 'C thorough proposed (opus-5 / adaptive default / 32k)',
    modelId: 'claude-opus-5',
    effort: undefined,
    maxTokens: 32000,
    input: 5.0,
    output: 25.0,
  },
} as const;

type Condition = keyof typeof CONDITIONS;

const ALL_CONDITIONS: Condition[] = ['A', 'B', 'C'];

// ── Round 3: the tiers, as the product actually computes them ──────────────
//
// Round 2 hand-wrote its settings, and hand-written settings go stale: the
// output ceiling and the continuation cap both moved under it when the
// proportional budget guard became opt-in. Round 3 therefore does not spell
// any setting out. Each arm ASKS `extractionSettings` — the one function the
// live extraction asks — for a row, and hands the answer to production's own
// client, so an arm is by construction whatever that call site sends today.
//
// The question of this round: what does the no-tier heavy-schema path buy by
// landing on Opus 4.7? That path is the only one in the product that still
// reaches an Opus 4 model, and it is reached by a density check on the SHAPE
// of the schema (30 or more nested extraction sites), never by a word an
// author wrote.
const TIERS = {
  /** The baseline: no tier named, density check chose Opus. This is byte for
   *  byte what a heavy-schema extraction sends today. */
  base: {
    label: 'baseline — no tier, dense schema (opus-4-7 / low)',
    settings: (): TierCallSettings => extractionSettings(undefined, 'opus'),
  },
  /** The same row with the model swapped, which is the whole proposal for this
   *  site: nothing about the request changes but which Opus answers. */
  opus5: {
    label: 'opus-5, baseline settings (opus-5 / low)',
    settings: (): TierCallSettings => ({ ...extractionSettings(undefined, 'opus'), model: 'opus5' }),
  },
  /** What every extraction below the density threshold already gets. If this
   *  matches the baseline, the density check is buying nothing. */
  sonnetLow: {
    label: 'below-threshold default (sonnet-5 / low)',
    settings: (): TierCallSettings => extractionSettings(undefined, 'sonnet'),
  },
  /** What an author who writes `careful` gets — the same model asked to think,
   *  with the room that asking costs. The ceiling arrives from the product, so
   *  this arm cannot drift from the tier it is named after. */
  sonnetHigh: {
    label: 'careful tier (sonnet-5 / high / 64k)',
    settings: (): TierCallSettings => extractionSettings('careful', 'sonnet'),
  },
} as const;

type Tier = keyof typeof TIERS;

const ALL_TIERS: Tier[] = ['base', 'opus5', 'sonnetLow', 'sonnetHigh'];

/** Dollars per million tokens for the models the tier map can name, from
 *  movement-engine's `lib/models/prices.json` — the same table round 1 copied. Every
 *  Opus is priced alike, so the baseline and its replacement differ only in
 *  how many tokens they spend. */
const TIER_PRICING: Record<TierCallSettings['model'], { input: number; output: number }> = {
  opus: { input: 5.0, output: 25.0 },
  opus5: { input: 5.0, output: 25.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 0.8, output: 4.0 },
};

// ── Arms ───────────────────────────────────────────────────────────────────

/**
 * One column of the matrix: a name, an LLM client, and what its tokens cost.
 *
 * Round 1's arms wrap PRODUCTION's client and rewrite the tier key, which is
 * why its numbers transfer — every other setting was production's. Round 2
 * cannot do that for one arm: the production model map has no key for
 * `claude-opus-5`, and teaching it one is a shipping decision, not a
 * measurement. So round 2's arms name a model id directly and go through
 * {@link makeDirectLlmClient}, which is `makeAnthropicLlmClient` with the tier
 * lookup removed and nothing else changed.
 */
interface Arm {
  id: string;
  label: string;
  client: LlmClient;
  price: { input: number; output: number };
}

function candidateArm(model: Candidate): Arm {
  const production = makeAnthropicLlmClient();
  return {
    id: model,
    label: `${model} (${CANDIDATES[model].id})`,
    // The one substitution: which model answers. Everything else about the
    // call is production's.
    client: { call: (input) => production.call({ ...input, model }) },
    price: { input: CANDIDATES[model].input, output: CANDIDATES[model].output },
  };
}

function conditionArm(condition: Condition): Arm {
  const settings = CONDITIONS[condition];
  const direct = makeDirectLlmClient(settings.modelId);
  return {
    id: condition,
    label: settings.label,
    client: {
      call: (input) => {
        // The tier's OWN settings, replacing whatever the fixture's extract
        // asked for. The replacement has to DELETE as well as set: a fixture
        // that names no tier still arrives here carrying extraction's default
        // effort of `low`, and the two `thorough` arms are defined by naming no
        // effort at all — leaving `low` in place would measure a different tier.
        const { effort: _tierEffort, maxTokens: _tierMaxTokens, ...rest } = input;
        return direct.call({
          ...rest,
          ...(settings.effort ? { effort: settings.effort } : {}),
          ...(settings.maxTokens ? { maxTokens: settings.maxTokens } : {}),
        });
      },
    },
    price: { input: settings.input, output: settings.output },
  };
}

/**
 * A round-3 arm: production's client, asked for one tier row.
 *
 * Nothing is mirrored here. `makeAnthropicLlmClient` resolves the model alias,
 * the output ceiling, the continuation cap and the thinking config exactly as
 * the live extraction does, so the only thing this arm decides is WHICH row of
 * the tier table the call carries.
 *
 * The overwrite has to delete as well as set: a fixture arrives carrying the
 * settings its own extract asked for, and an arm defined by naming no effort
 * would silently measure a different depth if the fixture's effort were left
 * standing.
 */
function tierArm(tier: Tier): Arm {
  const production = makeAnthropicLlmClient();
  const settings = TIERS[tier].settings();
  return {
    id: tier,
    label: `${TIERS[tier].label} → ${claudeModelId(settings.model)}`,
    client: {
      call: (input) => {
        const { effort: _fixtureEffort, maxTokens: _fixtureMaxTokens, ...rest } = input;
        return production.call({
          ...rest,
          model: settings.model,
          ...(settings.effort ? { effort: settings.effort } : {}),
          ...(settings.maxTokens ? { maxTokens: settings.maxTokens } : {}),
        });
      },
    },
    price: TIER_PRICING[settings.model],
  };
}

// ── The direct-model client ────────────────────────────────────────────────
//
// A copy of `makeAnthropicLlmClient` with the tier→id lookup replaced by a
// literal id. Everything the measurement depends on is still production's: the
// same `anthropicChatDetailed` (so the same thinking-config resolution, the
// same streaming, the same continuation loop), the same one-continuation cap,
// the same raise-on-truncation, the same `parseJsonReply`. The three constants
// below are production's, mirrored here because they are module-private there.

const EXTRACTION_OUTPUT_RATIO = 4;
const EXTRACTION_MIN_TOKENS = 8000;
const EXTRACTION_MAX_TOKENS = 32000;
const CHARS_PER_TOKEN = 4;
const EXTRACTION_MAX_CONTINUATIONS = 1;

function proportionalMaxTokens(input: { system: string; userMessage: string }): number {
  const inputTokens = (input.system.length + input.userMessage.length) / CHARS_PER_TOKEN;
  const proportional = Math.ceil(inputTokens * EXTRACTION_OUTPUT_RATIO);
  return Math.min(EXTRACTION_MAX_TOKENS, Math.max(EXTRACTION_MIN_TOKENS, proportional));
}

function makeDirectLlmClient(modelId: ChatModelName): LlmClient {
  return {
    async call(input: LlmCallInput) {
      const reply = await anthropicChatDetailed({
        system: input.system,
        userMessage: input.userMessage,
        model: modelId,
        maxTokens: input.maxTokens ?? proportionalMaxTokens(input),
        maxContinuations: EXTRACTION_MAX_CONTINUATIONS,
        ...(input.effort ? { effort: input.effort } : {}),
        label: input.label,
      });
      if (reply.truncated) {
        throw new Error(
          `Extraction '${input.label}' produced no complete answer: the model hit its output ceiling and was still truncated after ${EXTRACTION_MAX_CONTINUATIONS} continuation.`,
        );
      }
      return {
        parsedJson: parseJsonReply(reply.text, { label: input.label, prompt: input.userMessage }),
        rawText: reply.text,
      };
    },
  };
}

// ── Usage tap ──────────────────────────────────────────────────────────────

interface CallUsage {
  model: string;
  label: string;
  /** UNCACHED input only — `usage.input_tokens` excludes anything served from
   *  or written to the prompt cache, so the two cache columns are not a detail
   *  to fold in later. Leaving them out understates an arm that caches and
   *  makes its input column look smaller than an arm that does not. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  stopReason: string | null;
  durationMs: number;
}

/**
 * Reads the `[anthropic] chat` completion line — the one place a settled
 * call's token counts and stop reason are both still in hand. It wraps
 * `logger.info` rather than adding a winston transport because the transport
 * base class is not resolvable from this package; the wrapper still calls
 * through, so nothing about the logging changes.
 */
class UsageTap {
  readonly calls: CallUsage[] = [];
  private restore: (() => void) | undefined;

  attach(): void {
    const original = logger.info.bind(logger);
    const capture = (message: unknown, meta: unknown): void => {
      if (typeof message !== 'string' || !message.includes('[anthropic] chat')) return;
      if (meta === null || typeof meta !== 'object') return;
      const fields = meta as Record<string, unknown>;
      if (typeof fields.inputTokens !== 'number') return;
      this.calls.push({
        model: String(fields.model ?? ''),
        label: String(fields.label ?? ''),
        inputTokens: Number(fields.inputTokens),
        cacheReadTokens: Number(fields.cacheReadTokens ?? 0),
        cacheCreationTokens: Number(fields.cacheCreationTokens ?? 0),
        outputTokens: Number(fields.outputTokens ?? 0),
        stopReason: fields.stopReason == null ? null : String(fields.stopReason),
        durationMs: Number(fields.durationMs ?? 0),
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logger as any).info = (message: unknown, meta: unknown, ...rest: unknown[]): unknown => {
      capture(message, meta);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any)(message, meta, ...rest);
    };
    this.restore = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any).info = original;
    };
  }

  detach(): void {
    this.restore?.();
  }

  /** Everything seen since the marker, so one fixture run can be isolated. */
  since(marker: number): CallUsage[] {
    return this.calls.slice(marker);
  }
}

// ── Shape observation ──────────────────────────────────────────────────────

/**
 * The two misbehaviours production has actually seen, counted at the seam
 * where the reply is still the model's own object: the `{ evidence, value }`
 * field wrapping applied to a whole entity LIST, and an answer filed under a
 * key the guide never named. Both are salvaged or retried downstream, so
 * neither shows up in the result — which is exactly why they need counting.
 */
interface ShapeObservation {
  envelopeWrapped: number;
  offGuideKeys: number;
}

/** Every key the guide can ask an answer under is an interned site id. A
 *  top-level key that is not one is the model answering under a name of its
 *  own — the failure that reads downstream as "extracted nothing". */
const SITE_KEY = /^x:.+#\d+$/;

function isEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.includes('value') && keys.every((k) => k === 'value' || k === 'evidence');
}

// ── The run ────────────────────────────────────────────────────────────────

interface FixtureRun {
  fixture: string;
  /** Which column of the matrix — a round-1 model key or a round-2 condition. */
  arm: string;
  rep: number;
  ok: boolean;
  error?: string;
  /** null where the fixture expects no entities — recall is not a question. */
  recall: number | null;
  precision: number | null;
  fieldExact: number | null;
  fieldsCompared: number;
  /** Entities emitted that no expected entity claims. */
  spurious: number;
  /** Closed-set fields whose value was not a member. */
  closedBroken: number;
  retries: number;
  dropped: number;
  coerced: number;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  durations: number[];
  stopReasons: string[];
  shape: ShapeObservation;
}

/**
 * How many nested extraction sites the ROOT call carries — the same tally the
 * engine's density check takes, computed from the spec the engine plans from
 * so it can be read without spending a call.
 *
 * It matters because the density check is the only route in the product to an
 * Opus 4 model: 30 or more sites in one call and the model changes. Counting
 * follows the engine's two rules — a site is a NODE, not a field, and a child
 * whose first stage is fenced behind a plugin leaves the call rather than
 * joining it.
 *
 * Counted off the SPEC, not the written tree: a node that takes a declaration
 * as its shape (`node entry: <Entry>`) writes no first stage of its own — the
 * declaration is it — and only the spec has it spelled out.
 */
function declaredSites(nodes: readonly ExtractNodeSpec[]): number {
  return nodes
    .filter((child) => (child.stages[0]?.through ?? []).length === 0)
    .reduce((total, child) => total + 1 + declaredSites(child.stages[0]?.children ?? []), 0);
}

export function rootSites(spec: ExtractNodeSpec): number {
  return 1 + declaredSites(spec.stages[0]?.children ?? []);
}

/** The spec a fixture's tree plans from, built as the engine builds it. */
export function fixtureSpec(
  extract: ExtractExpression,
  options: Pick<ExtractSpecOptions, 'resolveDeclaredNode'> = {},
): Promise<ExtractNodeSpec> {
  return buildExtractSpec(extract, { resolveDeclaredType, ...options });
}

function stubInvoker(fixture: Fixture): MovementTransformInvoker {
  return {
    async invoke({ plugin, extractedContext }) {
      const byEntity = fixture.enrichment?.[plugin];
      if (!byEntity) return {};
      const name = String(extractedContext.name ?? '');
      return byEntity[name] ?? {};
    },
  };
}

async function runOne(
  fixture: Fixture,
  arm: Arm,
  rep: number,
  tap: UsageTap,
): Promise<FixtureRun> {
  const marker = tap.calls.length;
  const trace: MovementTraceEntry[] = [];
  const shape: ShapeObservation = { envelopeWrapped: 0, offGuideKeys: 0 };

  const llm: LlmClient = {
    async call(input: LlmCallInput) {
      const reply = await arm.client.call(input);
      const body = reply.parsedJson;
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        for (const [key, value] of Object.entries(body)) {
          if (isEnvelope(value)) shape.envelopeWrapped++;
          if (!SITE_KEY.test(key)) shape.offGuideKeys++;
        }
      }
      return reply;
    },
  };

  let emission: ExtractEmission | undefined;
  let error: string | undefined;
  try {
    emission = await materializeExtract({
      extract: fixture.extract,
      spec: await fixtureSpec(fixture.extract),
      runtime: {
        // Outside a run: a bare host's wall clock and random ids.
        world: BARE_HOST,
        llm,
        transformInvoker: stubInvoker(fixture),
        plugins: bundledPluginSpecs(),
        evalSlot: async () => ({ value: fixture.source, provenance: NO_PROVENANCE }),
        trace,
      },
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (emission && process.argv.includes('--dump')) {
    console.log(`\n--- ${fixture.id} / ${arm.id} / rep ${rep} — what came back`);
    console.log(JSON.stringify(dumpTree(emission), null, 2));
  }

  const usage = tap.since(marker);
  // A run that RAISED found nothing, and must score as nothing. Falling back
  // to an empty tally would make it read as "no question asked", which
  // averages a crash into a model's recall as if it never happened.
  const score = emission ? scoreTree(emission, fixture.expected) : emptyScore(fixture.expected);

  const extractions = trace.filter(
    (e): e is Extract<MovementTraceEntry, { kind: 'extraction' }> => e.kind === 'extraction',
  );

  return {
    fixture: fixture.id,
    arm: arm.id,
    rep,
    ok: error === undefined,
    ...(error !== undefined ? { error } : {}),
    recall: score.expected === 0 ? null : score.matched / score.expected,
    precision: score.extracted === 0 ? null : score.matched / score.extracted,
    fieldExact: score.compared === 0 ? null : score.correct / score.compared,
    fieldsCompared: score.compared,
    spurious: score.extracted - score.matched,
    closedBroken: score.closedBroken,
    retries: extractions.filter((e) => e.retried).length,
    dropped: extractions.reduce(
      (n, e) => n + Object.values(e.dropped ?? {}).reduce((a, b) => a + b, 0),
      0,
    ),
    coerced: extractions.reduce(
      (n, e) => n + Object.values(e.coerced ?? {}).reduce((a, v) => a + v.length, 0),
      0,
    ),
    calls: usage.length,
    inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0),
    cacheReadTokens: usage.reduce((n, u) => n + u.cacheReadTokens, 0),
    cacheCreationTokens: usage.reduce((n, u) => n + u.cacheCreationTokens, 0),
    outputTokens: usage.reduce((n, u) => n + u.outputTokens, 0),
    durations: usage.map((u) => u.durationMs),
    stopReasons: [...new Set(usage.map((u) => u.stopReason ?? 'none'))],
    shape,
  };
}

/** The emission tree as plain JSON — `--dump`. A cell that scores below 100%
 *  is only actionable once you can see whether the model was wrong or the
 *  fixture's written answer was. */
function dumpTree(emission: ExtractEmission): unknown {
  const children: Record<string, unknown[]> = {};
  for (const [name, kids] of emission.children) children[name] = kids.map(dumpTree);
  return {
    node: emission.nodeName,
    fields: emission.fields,
    ...(Object.keys(children).length > 0 ? { children } : {}),
  };
}

// ── Scoring ────────────────────────────────────────────────────────────────

interface Score {
  matched: number;
  expected: number;
  extracted: number;
  correct: number;
  compared: number;
  closedBroken: number;
}

/** Comparison normal form: case, accents-as-written, whitespace and trailing
 *  punctuation are noise; anything else is a different answer. */
function norm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .replace(/\/+$/, '')
    .trim();
}

function sameValue(got: unknown, want: string | number | null): boolean {
  if (want === null) return got === null || got === undefined;
  if (typeof want === 'number') return Number(got) === want;
  return norm(got) === norm(want);
}

/** The tally a run that answered nothing at all earns: every expected entity
 *  missed, every expected field wrong, nothing spurious. */
function emptyScore(expected: Record<string, ExpectedNode>): Score {
  const score: Score = {
    matched: 0,
    expected: 0,
    extracted: 0,
    correct: 0,
    compared: 0,
    closedBroken: 0,
  };
  const walk = (want: ExpectedNode): void => {
    score.expected += want.entities.length;
    for (const entity of want.entities) {
      score.compared += Object.keys(entity.fields).length;
      for (const child of Object.values(entity.children ?? {})) walk(child);
    }
  };
  for (const want of Object.values(expected)) walk(want);
  return score;
}

function scoreTree(root: ExtractEmission, expected: Record<string, ExpectedNode>): Score {
  const total: Score = {
    matched: 0,
    expected: 0,
    extracted: 0,
    correct: 0,
    compared: 0,
    closedBroken: 0,
  };
  for (const [nodeName, want] of Object.entries(expected)) {
    scoreNode(root.children.get(nodeName) ?? [], want, total);
  }
  return total;
}

function scoreNode(got: ExtractEmission[], want: ExpectedNode, into: Score): void {
  into.expected += want.entities.length;
  into.extracted += got.length;
  const claimed = new Set<number>();

  for (const expectedEntity of want.entities) {
    const index = got.findIndex(
      (candidate, i) =>
        !claimed.has(i) && norm(candidate.fields[want.identity]) === norm(expectedEntity.key),
    );
    if (index === -1) continue;
    claimed.add(index);
    into.matched++;
    const actual = got[index];

    for (const [fieldName, wantValue] of Object.entries(expectedEntity.fields)) {
      into.compared++;
      if (sameValue(actual.fields[fieldName], wantValue)) into.correct++;
    }
    for (const [fieldName, options] of Object.entries(want.closed ?? {})) {
      const value = actual.fields[fieldName];
      if (value == null) continue;
      if (!options.some((option) => norm(option) === norm(value))) into.closedBroken++;
    }
    for (const [childName, childWant] of Object.entries(expectedEntity.children ?? {})) {
      scoreNode(actual.children.get(childName) ?? [], childWant, into);
    }
  }
}

// ── Reporting ──────────────────────────────────────────────────────────────

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

/** Cache-read and cache-write tokens are priced off the input rate by fixed
 *  multipliers, the same ones `lib/llm_usage.ts` bills against. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * What one arm's tokens cost. Cache tokens are counted rather than ignored:
 * `usage.input_tokens` is the UNCACHED remainder, so an arm whose system block
 * happens to clear the model's minimum cacheable length shows a smaller input
 * column and — if the cache columns are dropped — a falsely cheaper bill. Only
 * one of the three round-2 arms caches, which is exactly the situation where
 * ignoring this would decide the comparison.
 */
function costDollars(
  arm: Arm,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  },
): number {
  const { input, output } = arm.price;
  return (
    (tokens.inputTokens * input +
      tokens.cacheReadTokens * input * CACHE_READ_MULTIPLIER +
      tokens.cacheCreationTokens * input * CACHE_WRITE_MULTIPLIER +
      tokens.outputTokens * output) /
    1_000_000
  );
}

/** Two repetitions of the same cell, averaged where averaging means something
 *  and summed where it does not. */
function fold(runs: FixtureRun[]): {
  recall: number | null;
  precision: number | null;
  fieldExact: number | null;
  retries: number;
  dropped: number;
  spurious: number;
  closedBroken: number;
  failures: number;
  envelope: number;
  offGuide: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  durations: number[];
} {
  const mean = (pick: (r: FixtureRun) => number | null): number | null => {
    const values = runs.map(pick).filter((v): v is number => v !== null);
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  };
  const sum = (pick: (r: FixtureRun) => number): number => runs.reduce((n, r) => n + pick(r), 0);
  return {
    recall: mean((r) => r.recall),
    precision: mean((r) => r.precision),
    fieldExact: mean((r) => r.fieldExact),
    retries: sum((r) => r.retries),
    dropped: sum((r) => r.dropped),
    spurious: sum((r) => r.spurious),
    closedBroken: sum((r) => r.closedBroken),
    failures: runs.filter((r) => !r.ok).length,
    envelope: sum((r) => r.shape.envelopeWrapped),
    offGuide: sum((r) => r.shape.offGuideKeys),
    inputTokens: sum((r) => r.inputTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens),
    cacheCreationTokens: sum((r) => r.cacheCreationTokens),
    outputTokens: sum((r) => r.outputTokens),
    durations: runs.flatMap((r) => r.durations),
  };
}

function renderReport(runs: FixtureRun[], fixtures: Fixture[], arms: Arm[]): string {
  const lines: string[] = [];

  lines.push('### Arm × fixture');
  lines.push('');
  lines.push(
    '| fixture | arm | recall | entity precision | field-exact | retries | drops | spurious | closed-set breaks | in tok | out tok | p50 ms | max ms |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const fixture of fixtures) {
    for (const arm of arms) {
      const cell = fold(runs.filter((r) => r.fixture === fixture.id && r.arm === arm.id));
      lines.push(
        `| ${fixture.id} | ${arm.id} | ${pct(cell.recall)} | ${pct(cell.precision)} | ${pct(
          cell.fieldExact,
        )} | ${cell.retries} | ${cell.dropped} | ${cell.spurious} | ${cell.closedBroken} | ${
          cell.inputTokens
        } | ${cell.outputTokens} | ${percentile(cell.durations, 0.5)} | ${percentile(
          cell.durations,
          1,
        )} |`,
      );
    }
  }

  // Per-rep, not just folded. Thinking models are not deterministic, and a mean
  // over three reps hides whether the arm is reliably good or occasionally
  // brilliant — which is the difference between a tier you can ship and one you
  // cannot.
  lines.push('');
  lines.push('### Per rep — field-exact, and what the rep cost');
  lines.push('');
  lines.push(
    '| fixture | arm | rep | recall | field-exact | retries | in tok | cached tok | out tok | ms | cost |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const fixture of fixtures) {
    for (const arm of arms) {
      for (const run of runs
        .filter((r) => r.fixture === fixture.id && r.arm === arm.id)
        .sort((a, b) => a.rep - b.rep)) {
        const cost = costDollars(arm, run);
        lines.push(
          `| ${fixture.id} | ${arm.id} | ${run.rep} | ${pct(run.recall)} | ${pct(run.fieldExact)} | ${
            run.retries
          } | ${run.inputTokens} | ${run.cacheReadTokens + run.cacheCreationTokens} | ${
            run.outputTokens
          } | ${run.durations.reduce((a, b) => a + b, 0)} | $${cost.toFixed(4)} |${
            run.ok ? '' : ` FAILED: ${run.error}`
          }`,
        );
      }
    }
  }

  lines.push('');
  lines.push('### Per arm');
  lines.push('');
  lines.push(
    '| arm | settings | recall | field-exact | retries | drops | spurious | closed-set breaks | failures | envelope-wrapped | off-guide keys | in tok | cached tok | out tok | p50 ms | max ms | cost | $/call |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of arms) {
    const armRuns = runs.filter((r) => r.arm === arm.id);
    const cell = fold(armRuns);
    const cost = costDollars(arm, cell);
    const calls = armRuns.reduce((n, r) => n + r.calls, 0);
    lines.push(
      `| ${arm.id} | ${arm.label} | ${pct(cell.recall)} | ${pct(
        cell.fieldExact,
      )} | ${cell.retries} | ${cell.dropped} | ${cell.spurious} | ${cell.closedBroken} | ${
        cell.failures
      } | ${cell.envelope} | ${cell.offGuide} | ${cell.inputTokens} | ${
        cell.cacheReadTokens + cell.cacheCreationTokens
      } | ${cell.outputTokens} | ${percentile(cell.durations, 0.5)} | ${percentile(
        cell.durations,
        1,
      )} | $${cost.toFixed(4)} | $${(calls === 0 ? 0 : cost / calls).toFixed(4)} |`,
    );
  }

  // The two numbers the round was run to produce. Quality is the relative
  // change in field-exact score; cost is the relative change in mean spend per
  // API CALL — per call rather than per run, because the fixtures differ in how
  // many calls they make and a per-run figure would price the fixture mix
  // rather than the arm.
  if (arms.length > 1) {
    lines.push('');
    lines.push('### Δ against each earlier arm');
    lines.push('');
    lines.push('| comparison | field-exact | Δ quality | $/call | Δ cost |');
    lines.push('|---|---|---|---|---|');
    const stats = new Map<string, { exact: number | null; perCall: number }>();
    for (const arm of arms) {
      const armRuns = runs.filter((r) => r.arm === arm.id);
      const cell = fold(armRuns);
      const calls = armRuns.reduce((n, r) => n + r.calls, 0);
      stats.set(arm.id, {
        exact: cell.fieldExact,
        perCall: calls === 0 ? 0 : costDollars(arm, cell) / calls,
      });
    }
    const rel = (from: number, to: number): string =>
      from === 0 ? '—' : `${to >= from ? '+' : ''}${(((to - from) / from) * 100).toFixed(1)}%`;
    for (let i = 1; i < arms.length; i++) {
      for (let j = 0; j < i; j++) {
        const base = stats.get(arms[j].id);
        const arm = stats.get(arms[i].id);
        if (!base || !arm) continue;
        lines.push(
          `| ${arms[i].id} vs ${arms[j].id} | ${pct(base.exact)} → ${pct(arm.exact)} | ${
            base.exact === null || arm.exact === null ? '—' : rel(base.exact, arm.exact)
          } | $${base.perCall.toFixed(4)} → $${arm.perCall.toFixed(4)} | ${rel(
            base.perCall,
            arm.perCall,
          )} |`,
        );
      }
    }
  }

  const failures = runs.filter((r) => !r.ok);
  if (failures.length > 0) {
    lines.push('');
    lines.push('### Failures');
    lines.push('');
    for (const failure of failures) {
      lines.push(`- \`${failure.fixture}\` / ${failure.arm} / rep ${failure.rep}: ${failure.error}`);
    }
  }

  return lines.join('\n');
}

// ── Entry ──────────────────────────────────────────────────────────────────

/** A named value, where several of the names double as bare mode switches
 *  (`--tiers` alone means the whole round, `--tiers base,opus5` a slice of it).
 *  So a following token that is itself a switch is not this one's value. */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function main(): Promise<void> {
  // Two modes, deliberately not merged. `--models` is round 1 — three models at
  // one effort, through production's own client — and it still reproduces round
  // 1's table. `--conditions` is round 2: whole tier SETTINGS, one of which
  // names a model production cannot reach.
  const roundTwo = process.argv.includes('--conditions');
  const roundThree = process.argv.includes('--tiers');
  const arms: Arm[] = roundThree
    ? (flag('tiers')?.split(',') ?? ALL_TIERS).map((id) => {
        if (!(id in TIERS)) throw new Error(`unknown tier arm '${id}'`);
        return tierArm(id as Tier);
      })
    : roundTwo
      ? (flag('conditions')?.split(',') ?? ALL_CONDITIONS).map((id) => {
          if (!(id in CONDITIONS)) throw new Error(`unknown condition '${id}'`);
          return conditionArm(id as Condition);
        })
      : ((flag('models')?.split(',') as Candidate[] | undefined) ?? ALL_CANDIDATES).map((model) => {
          if (!(model in CANDIDATES)) throw new Error(`unknown model '${model}'`);
          return candidateArm(model);
        });
  const reps = Number(flag('reps') ?? 2);
  const only = flag('fixtures')?.split(',');
  const fixtures = only ? FIXTURES.filter((f) => only.includes(f.id)) : FIXTURES;
  const outDir = flag('out') ?? path.join(process.cwd(), '.bakeoff');
  const budget = Number(flag('budget') ?? DEFAULT_BUDGET_DOLLARS);
  const dryRun = process.argv.includes('--dry-run');

  if (fixtures.length === 0) throw new Error('no fixtures selected');

  console.log(
    `bake-off: ${fixtures.length} fixtures × ${arms.length} arms × ${reps} reps` +
      `\nfixtures: ${fixtures.map((f) => `${f.id} (${f.source.length} chars)`).join(', ')}` +
      `\narms:     ${arms.map((a) => a.label).join(' | ')}\n`,
  );

  if (dryRun) {
    for (const fixture of fixtures) {
      console.log(`── ${fixture.id} — ${fixture.title}\n   ${fixture.asks}`);
      const sites = rootSites(await fixtureSpec(fixture.extract));
      console.log(`   source ${fixture.source.length} chars, expects `
        + Object.entries(fixture.expected)
            .map(([n, e]) => `${e.entities.length} ${n}`)
            .join(', '));
      console.log(
        `   root call carries ${sites} extraction site${sites === 1 ? '' : 's'} — the density check would send it to ${sites >= 30 ? 'OPUS' : 'sonnet'}`,
      );
    }
    return;
  }

  const tap = new UsageTap();
  tap.attach();

  const runs: FixtureRun[] = [];
  let spent = 0;
  outer: for (let rep = 1; rep <= reps; rep++) {
    for (const arm of arms) {
      for (const fixture of fixtures) {
        if (spent > budget) {
          console.error(`\nABORT: spend passed the $${budget} budget at $${spent.toFixed(2)}`);
          break outer;
        }
        const run = await runOne(fixture, arm, rep, tap);
        runs.push(run);
        spent += costDollars(arm, run);
        console.log(
          `${fixture.id.padEnd(24)} ${arm.id.padEnd(7)} rep${rep}  ` +
            `recall ${pct(run.recall).padStart(4)}  exact ${pct(run.fieldExact).padStart(4)}  ` +
            `${run.calls} calls  ${run.inputTokens}/${run.outputTokens} tok  ` +
            `retries ${run.retries}  spent $${spent.toFixed(3)}  ${run.ok ? '' : `FAILED: ${run.error}`}`,
        );
      }
    }
  }

  tap.detach();

  const report = renderReport(runs, fixtures, arms);
  console.log(`\n${report}\n\nTOTAL SPEND: $${spent.toFixed(4)}`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify({ runs, spent }, null, 2));
  writeFileSync(path.join(outDir, 'report.md'), `${report}\n\nTotal spend: $${spent.toFixed(4)}\n`);
  console.log(`\nwrote ${outDir}/runs.json and ${outDir}/report.md`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
