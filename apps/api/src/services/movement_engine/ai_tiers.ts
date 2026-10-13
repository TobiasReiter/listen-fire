/**
 * Tiers → calls. The language lets an author say how much thinking a job is
 * worth — `"quick"`, `"careful"`, `"thorough"` — and nothing else. What that
 * BUYS is decided here, on the platform's side of the line: which model
 * answers, how hard it is asked to think, how long its answer may run.
 *
 * That split is the whole point. Provider names, reasoning-effort dialects and
 * token budgets are all things that change under us — and none of them are
 * things an author can be asked to reason about. Retuning any of them, or
 * moving to a different family entirely, is an edit to this file and to
 * nothing else; no saved program changes, and no author has to be told.
 *
 * The AI() and extraction contexts map INDEPENDENTLY. They are different jobs:
 * `AI()` is a judgement call on a small prompt, extraction is a transcription
 * job over a whole document, and its defaults are tuned from production
 * runaways. The same word means "cheap for this job" in both, which is not the
 * same settings in both.
 */

import { z } from 'zod';

import { AI_EFFORTS, AI_TIERS, aiTier } from '#shared/expression/types';
import type { AiTier } from '#shared/expression/types';

import { availableChatModels, chatModelAvailability } from '../../lib/models/map';
import { hasCapability, isModelName, parseChatModelName } from '../../lib/models/registry';
import type { ChatModelName } from '../../lib/models/registry';

/**
 * Reasoning depth for extraction, on its OWN calls rather than on the client
 * it shares with `AI()`. Extraction is a transcription job, not a reasoning
 * one: the fields are named in the prompt and the evidence is quoted from the
 * source. The adaptive-thinking models reason at effort `high` when nobody
 * says otherwise, which is where a production runaway's output tokens went.
 */
export const EXTRACTION_EFFORT = 'low' as const;

/**
 * The room a call that REASONS gets — flat rather than sized from the input,
 * and twice what a shallow call may spend.
 *
 * The doubling is not generosity: on these models the thinking is paid for out
 * of the same ceiling as the answer, and from `high` up it is a large fraction
 * of everything the model writes. One stage of a morning recap answered in 22.5k
 * tokens with the thinking switched down to `low`; the same stage at `high` and
 * at `xhigh` each spent a whole 32k ceiling thinking and returned no answer at
 * all. The request is streamed, so a ceiling this high is safe against the HTTP
 * timeout.
 */
const REASONING_OUTPUT_TOKENS = 64000;

/**
 * The ceiling a depth needs, which is what actually decides it — not the tier's
 * name. `high` and `xhigh` are both deep enough to exhaust a shallow call's
 * ceiling before writing a character, so both carry this one.
 *
 * Silence below that is deliberate and is NOT the same number written out: it
 * leaves the client's own ceiling standing, which is the flat 32k by default
 * and the budget guard's input-sized one where that is switched on. A shallow
 * call's ceiling only ever has to fit its answer.
 */
function roomToThink(effort: TierCallSettings['effort']): { maxTokens?: number } {
  switch (effort) {
    case 'high':
    case 'xhigh':
      return { maxTokens: REASONING_OUTPUT_TOKENS };
    case 'low':
    case 'medium':
    case undefined:
      return {};
  }
}

/** What one call asks the platform for. An absent field is the client's own
 *  default: no `effort` means the model's own reasoning depth, no `maxTokens`
 *  means the ceiling sized from the input.
 *
 *  `'opus'` is opus-4-7 — reachable only through extraction's omitted-tier
 *  path (the density heuristic can still choose it independently of the tier
 *  ladder below). `'opus5'` is claude-opus-5, on `AI()`'s `thorough` row
 *  only: see plans/mvt-core-calculus-2026-08-31/10_bakeoff.md round 2 for why
 *  the two are not interchangeable — opus-4-7 with no effort named runs with
 *  NO thinking at all and can leak its scratchpad into the visible reply;
 *  opus-5 in the same silence thinks adaptively by default. */
export interface TierCallSettings {
  model: 'opus' | 'opus5' | 'sonnet' | 'haiku';
  effort?: Effort;
  maxTokens?: number;
}

export const EFFORTS = AI_EFFORTS;
export type Effort = (typeof EFFORTS)[number];

/** What an extraction call names as its model: one of the built-in aliases
 *  above, or a logical model that a deployment's tier assignment or an
 *  author's override chose. The built-in table keeps its aliases so a
 *  deployment that configures nothing calls — and traces — exactly as before. */
export type TierModel = TierCallSettings['model'] | ChatModelName;

/** One extraction call's settings, after the deployment's tier assignments
 *  and the author's overrides. */
export interface ExtractionCallSettings {
  model: TierModel;
  effort: Effort;
  maxTokens?: number;
}

/**
 * The provider's own id for one of the four aliases above — the ONLY place
 * that spells out `claude-sonnet-5` and friends for a call routed through a
 * tier. `LlmClient`'s Anthropic wiring uses this; any other caller that wants
 * "whatever model a tier means today" (rather than the frozen chat/extraction
 * seam) should call it too, instead of copying the string.
 */
export function claudeModelId(model: TierModel): ChatModelName {
  if (isModelName(model)) return model;
  switch (model) {
    case 'opus':
      return 'claude-opus-4-7';
    case 'opus5':
      return 'claude-opus-5';
    case 'haiku':
      return 'claude-haiku-4-5-20251001';
    case 'sonnet':
      return 'claude-sonnet-5';
  }
}

/**
 * An `AI(prompt[, tier])` call's settings.
 *
 * An omitted tier is the platform default, and it is deliberately the same as
 * `quick`: the fast model under the input-proportional ceiling, which is what
 * every deployed `AI()` without a tier already gets. `careful` and `thorough`
 * name no effort, so those models reason at their own default depth — an
 * author who asked for real thinking should not have it capped from here.
 *
 * A word that is not a tier cannot reach a saved program (the checker refuses
 * it), so it lands on the default rather than raising: an evaluator is the
 * wrong place to discover a spelling mistake.
 *
 * Ruled from two bake-off rounds:
 * plans/mvt-core-calculus-2026-08-31/10_bakeoff.md.
 */
export function aiExpressionSettings(tier: string | undefined): TierCallSettings {
  switch (aiTier(tier)) {
    case 'careful':
      return { model: 'sonnet' };
    // No effort named, and opus-5 in that silence thinks adaptively and deeply
    // — a reasoning call by any other route, so it gets a reasoning call's room.
    case 'thorough':
      return { model: 'opus5', maxTokens: REASONING_OUTPUT_TOKENS };
    case 'quick':
    case undefined:
      return { model: 'haiku', effort: EXTRACTION_EFFORT };
  }
}

/**
 * An `extract ["tier"] from […]` call's settings — every call the extraction
 * makes, at every stage.
 *
 * An omitted tier is exactly today's extraction: the density heuristic's model
 * (`defaultModel`), shallow effort, and the input-proportional ceiling. So a
 * deployed extraction that names no tier calls the models identically to
 * before this existed. Naming one takes the model choice AWAY from the density
 * heuristic — an author who says how much the job is worth has said something
 * the heuristic was guessing at.
 *
 * `quick`/`careful`/`thorough` are one model (sonnet-5) at rising effort, not
 * three models: two bake-off rounds found no fixture — including two built
 * specifically to break the cheap arm — where a bigger model scored higher
 * than sonnet-5, at any effort. Ruled from
 * plans/mvt-core-calculus-2026-08-31/10_bakeoff.md.
 *
 * The room each row gets follows its DEPTH ({@link roomToThink}), not its name:
 * the thinking comes out of the same ceiling as the answer, so the two rows
 * that reason carry a ceiling that fits both. It also means the flat ceiling
 * arrives for the same reason the tier does, rather than as a second thing to
 * remember about the expensive one.
 */
export function extractionSettings(
  tier: string | undefined,
  defaultModel: 'opus' | 'sonnet',
): TierCallSettings {
  const named = aiTier(tier);
  if (named === undefined) return { model: defaultModel, effort: EXTRACTION_EFFORT };
  const { model, effort } = BUILT_IN_EXTRACTION_TIERS[named];
  return { model, effort, ...roomToThink(effort) };
}

/** Each extraction tier as shipped: sonnet-5 asked to think this hard. What a
 *  deployment that sets no `EXTRACTION_TIERS` buys. */
const BUILT_IN_EXTRACTION_TIERS: Record<AiTier, { model: TierCallSettings['model']; effort: Effort }> = {
  quick: { model: 'sonnet', effort: EXTRACTION_EFFORT },
  careful: { model: 'sonnet', effort: 'high' },
  thorough: { model: 'sonnet', effort: 'xhigh' },
};

/**
 * One extraction call's settings on THIS deployment: the tier's assignment
 * (built in, or `EXTRACTION_TIERS`), then the author's own `model` and
 * `effort`, each of which wins over the tier on its own. The ceiling follows
 * whatever effort that leaves ({@link roomToThink}), so an author who asks for
 * `xhigh` gets the room `xhigh` needs whichever tier they named.
 *
 * With no tier the density heuristic picks the model and the effort stays at
 * EXTRACTION_EFFORT — exactly {@link extractionSettings} with no tier — and a
 * deployment cannot reassign that row.
 *
 * `model` is a name the checker has already found reachable here
 * ({@link chatModelAvailability}); it is not re-validated per call, since the
 * model layer refuses an unreachable one at the call anyway.
 */
export function extractionCallSettings(
  request: {
    tier: string | undefined;
    densityModel: 'opus' | 'sonnet';
    model?: ChatModelName;
    effort?: Effort;
  },
  env: NodeJS.ProcessEnv = process.env,
): ExtractionCallSettings {
  const named = aiTier(request.tier);
  const row =
    named === undefined
      ? { model: request.densityModel, effort: EXTRACTION_EFFORT }
      : { ...BUILT_IN_EXTRACTION_TIERS[named], ...extractionTiers(env).get(named) };
  const effort = request.effort ?? row.effort;
  return { model: request.model ?? row.model, effort, ...roomToThink(effort) };
}

/**
 * The chat models an extraction call's written `model` is held to on a run:
 * the run's catalog snapshot's `models`, the list the checker held it to,
 * which the snapshot builders fill from {@link availableChatModels}; a
 * snapshot written without one gets that function's answer here. One list for
 * the checker and both engines: the Rust engine is handed it as the
 * snapshot's `models` (rust_engine.ts), so a checked program's model is always
 * in it. A name the model registry holds as no chat model is dropped, so the
 * list is names a call can be made with.
 */
export function runChatModels(catalog: { models?: readonly string[] }): ChatModelName[] {
  return (catalog.models ?? availableChatModels()).filter(
    (name): name is ChatModelName => isModelName(name) && hasCapability(name, 'chat'),
  );
}

/** Why a run refuses an extraction call's written `model`, both engines'
 *  words (crates/movement-engine/src/extract/call.rs mirrors them): it is not
 *  in {@link runChatModels}, which it prints. Only a program the checker did
 *  not hold to the same list reaches it. */
export function unreachedModelMessage(model: string, models: readonly string[]): string {
  const reached = models.length === 0 ? 'none' : models.map((m) => `'${m}'`).join(', ');
  return `'extract''s model '${model}' is not a model this deployment reaches — it reaches ${reached}`;
}

// ── The deployment's tier assignments ──────────────────────────────────────
//
// `EXTRACTION_TIERS` is a JSON object from a tier to the model and effort this
// deployment buys for it, for example
// `{"careful": {"model": "claude-opus-5", "effort": "medium"}}`. A tier it is
// silent about, and a field a tier's entry leaves out, keep the built-in
// value, so an unset variable is exactly the built-in table. The model is a
// logical name; MODEL_MAP still decides which vendor answers it.

export interface ExtractionTierAssignment {
  model?: ChatModelName;
  effort?: Effort;
}
export type ExtractionTiers = ReadonlyMap<AiTier, ExtractionTierAssignment>;

const TIERS_EXAMPLE = '{"careful": {"model": "claude-opus-5", "effort": "medium"}}';

const tierAssignment = z.strictObject({
  model: z.string().optional(),
  effort: z.enum(EFFORTS).optional(),
});

function isAiTier(s: string): s is AiTier {
  return AI_TIERS.some((tier) => tier === s);
}

/** Shape only, refusing a misspelt tier or field with its key named rather
 *  than leaving the built-in silently in place. Whether a named model can be
 *  reached here is {@link assertExtractionTiersConfigured}'s question. */
export function parseExtractionTiers(raw: string | undefined): ExtractionTiers {
  if (raw === undefined || raw.trim() === '') return new Map();

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `EXTRACTION_TIERS is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `It must be an object like ${TIERS_EXAMPLE}.`,
    );
  }
  const shape = z.record(z.string(), z.unknown()).safeParse(json);
  if (!shape.success) {
    throw new Error(`EXTRACTION_TIERS must be a JSON object from tier to settings, like ${TIERS_EXAMPLE}.`);
  }

  const tiers = new Map<AiTier, ExtractionTierAssignment>();
  for (const [key, value] of Object.entries(shape.data)) {
    if (!isAiTier(key)) {
      throw new Error(`EXTRACTION_TIERS key "${key}" is not a tier. Tiers: ${AI_TIERS.join(', ')}.`);
    }
    const entry = tierAssignment.safeParse(value);
    if (!entry.success) {
      throw new Error(
        `EXTRACTION_TIERS["${key}"] must be an object with an optional "model" (a model name) and an ` +
          `optional "effort" (one of ${EFFORTS.join(', ')}), and nothing else.`,
      );
    }
    const { model, effort } = entry.data;
    tiers.set(key, {
      ...(model !== undefined ? { model: parseChatModelName(model, `EXTRACTION_TIERS["${key}"].model`) } : {}),
      ...(effort !== undefined ? { effort } : {}),
    });
  }
  return tiers;
}

// Parsed once per distinct value, as MODEL_MAP is: fixed in production, and a
// test that sets its own does not read the previous test's.
let memo: { raw: string | undefined; tiers: ExtractionTiers } | undefined;

function extractionTiers(env: NodeJS.ProcessEnv): ExtractionTiers {
  const raw = env.EXTRACTION_TIERS;
  if (memo === undefined || memo.raw !== raw) memo = { raw, tiers: parseExtractionTiers(raw) };
  return memo.tiers;
}

/** This deployment's tier assignments as data, for an engine that takes
 *  them as a run input rather than reading the environment (the Rust
 *  engine's `extractionTiers`): a tier's model and effort, each only when
 *  `EXTRACTION_TIERS` names it. */
export function extractionTierAssignments(env: NodeJS.ProcessEnv = process.env): Record<string, ExtractionTierAssignment> {
  return Object.fromEntries(extractionTiers(env));
}

/** Boot: refuse a tier assignment this deployment cannot serve — a malformed
 *  entry, or a model MODEL_MAP sends nowhere callable — rather than letting
 *  the first extraction at that tier find out. */
export function assertExtractionTiersConfigured(env: NodeJS.ProcessEnv = process.env): void {
  for (const [tier, { model }] of extractionTiers(env)) {
    if (model === undefined) continue;
    const availability = chatModelAvailability(model, env);
    if (!availability.available) {
      throw new Error(`EXTRACTION_TIERS["${tier}"].model: ${availability.reason}`);
    }
  }
}
