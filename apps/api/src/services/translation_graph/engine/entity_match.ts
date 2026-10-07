// LLM judge for translation-graph entity resolution. The engine calls
// this when an adapter returns multiple candidate matches and they
// can't be disambiguated by structural rules (single all-exact
// candidate).
//
// Modelled on `services/knowledge_pipeline/consolidate.ts`'s
// `matchPromptDef` — same conservative "decline if uncertain" posture.
// Kept separate because TG entity matching can target ANY adapter
// (Attio, Affinity, KG, …), whereas the KG path is hardcoded to
// extracted-entity → KG-node matching.

import type { LanguageVersion } from 'movement-lang';
import { z } from 'zod';

import { execute } from '../../../lib/prompts/execute';
import { promptDef } from '../../../lib/prompts/definition';
import {
  askJev,
  assertJevConfigured,
  jevEntityResolutionEnabled,
  JevConfigurationError,
  type JevAnswer,
  type JevNoulQuestion,
} from '../../../lib/jev/client';
import { isBudgetExhausted } from '../../../lib/run_cost';
import { withSpendMeter } from '../../../lib/run_spend';
import { neverAsAny } from '../../../lib/utils/types';
import { logger } from '../../logger';
import type { ExternalRecordRef } from '../adapter';
import { arbitrateWithoutJudge, type UniquenessConstraints } from '../uniqueness';
import { aiExpressionSettings, claudeModelId } from '../../movement_engine/ai_tiers';
import type { Costed, Priced } from '../../movement_engine/host';

// The judge runs on the SAME model `AI()`'s "careful" tier names — reused
// rather than hard-coded so a self-hosted deployment with only
// ANTHROPIC_API_KEY (no OpenAI key) can still resolve FUZZY writes: an
// unnamed `model` here would route through `execute()`'s OpenAI-only default
// and every ambiguous match would fail closed into a silent duplicate create.
// Exported so a test can pin it without hard-coding the id a second time.
export const JUDGE_MODEL = claudeModelId(aiExpressionSettings('careful').model);

const entityMatchPromptDef = promptDef({
  description: 'Match an asserted record against candidate records from a target system',
  arguments: ['recordType', 'asserted', 'candidates'] as const,
  messages: [
    {
      role: 'system' as const,
      content: `You are an entity resolution system for a data sync pipeline.

A translation graph wants to write a record to a target system. The target system already
contains one or more candidate records that may represent the same real-world entity as
the asserted record. Decide which (if any) of the candidates IS the same entity.

Consider property values: names, identifiers, domains, emails, dates. Names may differ
slightly between systems (e.g. "Acme Corp" vs "Acme Corporation") — but if the
distinguishing fields (domain, email, primary contact) disagree, the candidates are
different entities even when names match closely.

If multiple candidates look like the same entity as each other, that's a pre-existing
duplicate problem in the target system. Pick the candidate that best matches the
asserted record and flag it via reasoning — don't decline just because the target system
is messy.

If genuinely uncertain (none of the candidates clearly matches; multiple look equally
plausible with no tiebreaker), return null. The pipeline will create a new record
rather than risk an incorrect merge.

Respond with: {"match_index": <number or null>, "confidence": <0-1>, "reasoning": "<explanation>"}`,
    },
    {
      role: 'user' as const,
      content: `Record type: {{{recordType}}}

Asserted record:
{{{asserted}}}

Candidates:
{{{candidates}}}`,
    },
  ],
  model: JUDGE_MODEL,
  validator: z.object({
    match_index: z.number().nullable(),
    confidence: z.number(),
    reasoning: z.string(),
  }),
});

/** Drop null/empty fields — the model gains nothing from being told a field
 *  is absent, and it is one fewer thing for it to weigh as a mismatch. */
function stripEmptyFields(record: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === '') continue;
    stripped[key] = value;
  }
  return stripped;
}

function formatRecord(record: Record<string, unknown>): string {
  const lines = Object.entries(stripEmptyFields(record)).map(
    ([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
  );
  return lines.length > 0 ? lines.join('\n') : '(no fields)';
}

function formatCandidate(candidate: ExternalRecordRef, index: number): string {
  // Relationship-disambiguation context folds into `data` as ordinary
  // entries (3b §3.1), so the candidate's whole field bag — properties and
  // any folded-in connections — renders uniformly.
  return [`[Candidate ${index}]`, formatRecord(candidate.data)].join('\n');
}

/** Below this confidence the generative judge's pick is treated as a
 *  decline, same posture as the Jev judge's own threshold. */
export const GENERATIVE_MATCH_THRESHOLD = 0.5;

/**
 * The generative judge's raw call: which candidate the model picked (or
 * null) and how confident it says it is, with NO decision rule applied yet
 * — a caller wanting the production posture uses `judgeEntityMatchGenerative`
 * below; a caller wanting the raw score (the threshold eval runner) calls
 * this directly. Throws on a failed call — the "decline on throw" posture
 * belongs to the decision wrapper, not the raw score.
 */
export async function judgeEntityMatchGenerativeRaw(input: {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
}): Promise<{ match_index: number | null; confidence: number }> {
  const candidateText = input.candidates
    .map((c, i) => formatCandidate(c, i))
    .join('\n\n');

  const result = await execute('tg_entity_match', entityMatchPromptDef, {
    recordType: input.recordType,
    asserted: formatRecord(input.asserted),
    candidates: candidateText,
  });

  logger.info('[tg_entity_match] decision', {
    judge: 'generative',
    recordType: input.recordType,
    candidateCount: input.candidates.length,
    matchIndex: result.match_index,
    confidence: result.confidence,
    reasoning: result.reasoning,
  });

  return { match_index: result.match_index, confidence: result.confidence };
}

/**
 * The generative judge: decide which candidate (if any) is the same entity
 * as the asserted record. Returns the index into `candidates`, or null to
 * create a new record. Confidence below `GENERATIVE_MATCH_THRESHOLD` is
 * treated as a decline.
 *
 * A THROWN judge call also declines (never errors the write), but that is
 * a different fact than a considered decline — `onJudgeUnavailable`, when
 * given, hears the failure so the write path can say so on the record
 * instead of silently reading identically to "genuinely ambiguous".
 */
async function judgeEntityMatchGenerative(input: {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
  onJudgeUnavailable?: (message: string) => void;
}): Promise<number | null> {
  let result;
  try {
    result = await judgeEntityMatchGenerativeRaw(input);
  } catch (err) {
    // Out of money is not "no judge": declining here would create a duplicate
    // record, so the run stops instead.
    if (isBudgetExhausted(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[tg_entity_match] judge call failed; declining to merge', {
      recordType: input.recordType,
      candidateCount: input.candidates.length,
      error: message,
    });
    input.onJudgeUnavailable?.(message);
    return null;
  }

  if (result.match_index == null) return null;
  if (result.confidence < GENERATIVE_MATCH_THRESHOLD) return null;
  if (result.match_index < 0 || result.match_index >= input.candidates.length) {
    return null;
  }
  return result.match_index;
}

// Jev's real bound is its ~32k input-token ceiling (measured,
// plans/jev-evaluation-2026-09-17/0_evaluation.md); 40 keeps every
// candidate's record plus two questions well under it. A placeholder, not
// a derived number.
const JEV_MAX_CANDIDATES = 40;
const jevCandidateOption = (index: number) => `c${index}`;
const jevSameKey = (option: string) => `same_${option}`;
const jevEvidenceKey = (option: string) => `evid_${option}`;

/**
 * A wrong merge overwrites a real record; a missed merge only leaves a
 * duplicate — so both bars sit at the lowest value with ZERO wrong merges on
 * clear-evidence cases across both labelled sets (`pnpm dev:eval-entity-judge`
 * over `_fixtures/entity_match_{labelled,heldout}.jsonl`; re-derive when the
 * model version moves). The evidence bar exists because `same` alone stays
 * high on name-only evidence, where policy is "do not merge on a name alone".
 */
export const JEV_SAME_THRESHOLD = 0.7;
export const JEV_EVIDENCE_THRESHOLD = 0.5;

function expectNoulScore(answer: JevAnswer | undefined, key: string): number {
  if (!answer) {
    throw new Error(`Jev answered with no "${key}" question in its reply`);
  }
  switch (answer.type) {
    case 'noul':
      return answer.noul;
    case 'choice':
      throw new Error(`Jev answered "${key}" as a choice question; expected noul`);
    default:
      return neverAsAny(answer);
  }
}

/**
 * The Jev judge's raw call: for EACH candidate, asks two `noul` ("how true is
 * this statement") questions — `same_cI` (is this the same real-world
 * entity) and `evid_cI` (do they agree on an identifying field besides the
 * name) — in one request. Candidates ride in `state` rather than in the
 * question text, so the same field bag the generative judge sees is what Jev
 * sees. Returns each candidate's `{ same, evidence }` pair with NO decision
 * rule applied — `judgeEntityMatchViaJev` below wraps this with the
 * production thresholds; a caller wanting the raw scores (the threshold eval
 * runner) calls this directly.
 */
export async function judgeEntityMatchViaJevRaw(input: {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
}): Promise<Record<string, { same: number; evidence: number }>> {
  const candidates: Record<string, Record<string, unknown>> = {};
  const questions: Record<string, JevNoulQuestion> = {};
  input.candidates.forEach((candidate, i) => {
    const option = jevCandidateOption(i);
    candidates[option] = stripEmptyFields(candidate.data);
    questions[jevSameKey(option)] = {
      type: 'noul',
      instructions:
        `The record at candidates.${option} is the same real-world ${input.recordType} as the ` +
        'asserted record. Names may differ slightly between systems, but if identifying fields ' +
        '(website or domain, email, profile link) disagree they are different entities. A job ' +
        'title or employer can change over time, so an agreeing email or profile link outweighs ' +
        'a differing title or employer.',
    };
    questions[jevEvidenceKey(option)] = {
      type: 'noul',
      instructions:
        `The asserted record and the record at candidates.${option} agree on at least one ` +
        'specific identifying field besides the name (such as website or domain, email, ' +
        'linkedin, or employer), so the comparison does not rest on the name alone.',
    };
  });

  const answers = await askJev(
    {
      state: {
        asserted: stripEmptyFields(input.asserted),
        candidates,
      },
      questions,
    },
    { label: 'tg_entity_match' },
  );

  const scores: Record<string, { same: number; evidence: number }> = {};
  input.candidates.forEach((_, i) => {
    const option = jevCandidateOption(i);
    scores[option] = {
      same: expectNoulScore(answers[jevSameKey(option)], jevSameKey(option)),
      evidence: expectNoulScore(answers[jevEvidenceKey(option)], jevEvidenceKey(option)),
    };
  });

  logger.info('[tg_entity_match] decision', {
    judge: 'jev',
    recordType: input.recordType,
    candidateCount: input.candidates.length,
    scores,
  });

  return scores;
}

/**
 * The Jev judge: same decision as the generative judge (which candidate, if
 * any, is the asserted record) — best = the candidate with the highest
 * `same`; merge into it only when its `same` clears `JEV_SAME_THRESHOLD` AND
 * its `evidence` clears `JEV_EVIDENCE_THRESHOLD`, else decline.
 */
export async function judgeEntityMatchViaJev(input: {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
}): Promise<number | null> {
  const scores = await judgeEntityMatchViaJevRaw(input);
  let bestIndex = 0;
  for (let i = 1; i < input.candidates.length; i++) {
    if (scores[jevCandidateOption(i)].same > scores[jevCandidateOption(bestIndex)].same) {
      bestIndex = i;
    }
  }
  const best = scores[jevCandidateOption(bestIndex)];
  if (best.same < JEV_SAME_THRESHOLD || best.evidence < JEV_EVIDENCE_THRESHOLD) return null;
  return bestIndex;
}

/**
 * Decide which candidate (if any) is the same entity as the asserted
 * record — routed to Jev when `JEV_ENTITY_RESOLUTION=true`, else the
 * generative model. Returns the index into `candidates`, or null to create
 * a new record.
 *
 * The Jev route falls back to the generative judge on anything short of a
 * misconfiguration (too many candidates for one Jev question, a failed
 * call after its own retries): a slower second judge beats declining into
 * a duplicate create. A misconfiguration — the flag on with no key — is
 * the one failure that must NOT read as "the judge declined": it is
 * thrown, uncaught, before either judge runs, so it never reaches the
 * decline-on-throw catch below and never silently creates a duplicate.
 */
export async function judgeEntityMatch(input: {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
  onJudgeUnavailable?: (message: string) => void;
}): Promise<number | null> {
  if (input.candidates.length === 0) return null;

  if (jevEntityResolutionEnabled()) {
    assertJevConfigured();
    if (input.candidates.length > JEV_MAX_CANDIDATES) {
      logger.warn('[tg_entity_match] candidate count exceeds the Jev candidate bound; using the generative judge', {
        recordType: input.recordType,
        candidateCount: input.candidates.length,
      });
    } else {
      try {
        return await judgeEntityMatchViaJev(input);
      } catch (err) {
        if (err instanceof JevConfigurationError || isBudgetExhausted(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('[tg_entity_match] jev judge failed; falling back to the generative judge', {
          recordType: input.recordType,
          candidateCount: input.candidates.length,
          error: message,
        });
      }
    }
  }

  return judgeEntityMatchGenerative(input);
}

/** One write's identity question: which of its search's candidates the
 *  asserted record IS. */
export interface EntityArbitration {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
  constraints: UniquenessConstraints;
  /** The pin of the run asking: whether a blank key is a key. */
  languageVersion: LanguageVersion;
  onJudgeUnavailable?: (message: string) => void;
}

/**
 * Engine-side arbitration over an adapter's flat candidate shortlist —
 * the May-2026 entity-resolution split: the adapter searches, the engine
 * arbitrates. One decision procedure, shared by the TG engine's
 * `applyActionPlan` and the movement engine's write step:
 *
 *   0 candidates → null (create)
 *   exactly one candidate all-exact over the held constraints → match it
 *     (strong identity wins over fuzzy noise without burning an LLM call;
 *     exactness computed engine-side, 3b §3.2)
 *   exactly one candidate and NO branch of the constraints is fuzzy → match
 *     it. The adapter's search was exact; the engine just can't always
 *     re-verify it (a constraint naming a parent EDGE is folded into the
 *     search record, never into the asserted fields), and a judge that never
 *     sees the parent could decline and mint a duplicate.
 *   otherwise → LLM judge over each candidate's `data`. A lone FUZZY hit is
 *     NOT unambiguous: "oriqx.com" and "pavoai.com" each turned up exactly
 *     one fuzzy candidate and were merged unjudged (Morning Recap, 09-17).
 *     Refusing would create a new record on top of an already-violated
 *     constraint; the judge picks the best match (or declines) and logs it.
 *
 * Returns the index into `candidates`, or null to create a new record.
 */
export async function arbitrateEntityCandidates(input: EntityArbitration): Promise<number | null> {
  const decided = arbitrateWithoutJudge(input);
  if (decided !== undefined) return decided;
  return judgeEntityMatch({
    asserted: input.asserted,
    candidates: input.candidates,
    recordType: input.recordType,
    onJudgeUnavailable: input.onJudgeUnavailable,
  });
}

/** `arbitrateEntityCandidates` as a movement run's host serves it: under the
 *  run's budget, answering what the judge's model calls cost. */
export async function meteredArbitration({
  budget,
  ...arbitration
}: Priced<EntityArbitration>): Promise<Costed<{ index: number | null }>> {
  const { value, cost } = await withSpendMeter(budget, () => arbitrateEntityCandidates(arbitration));
  return { index: value, cost };
}
