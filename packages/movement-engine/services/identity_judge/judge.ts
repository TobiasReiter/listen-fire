// The identity judge: when an adapter's search returns several candidate
// records and the structural rules cannot say which (if any) is the same
// real-world entity as the record being written, a model decides. A wrong
// merge overwrites a real record; a missed merge only leaves a duplicate, so
// every path here leans toward declining.
//
// Modelled on `services/knowledge_pipeline/consolidate.ts`'s match prompt —
// same decline-if-uncertain posture. Kept separate because entity matching
// can target ANY adapter (Attio, Affinity, KG, …), whereas the KG path is
// hardcoded to extracted-entity → KG-node matching.
//
// The package owns the decision rules and the prompts; the shell injects the
// two network calls (the model and, optionally, Jev), so a shell with no
// Jev account passes none.

import { z } from 'zod';

import type { ArbitrationAnswer, Costed, EntityArbitration, Priced } from '../movement_engine/host';
import type { ExternalRecordRef } from '../translation_graph/adapter';
import { arbitrateWithoutJudge } from '../translation_graph/uniqueness';
import { aiExpressionSettings, claudeModelId } from '../movement_engine/ai_tiers';
import { isBudgetExhausted } from '../../lib/run_cost';
import { withSpendMeter } from '../../lib/run_spend';
import { neverAsAny } from '../../lib/utils/types';
import { logger } from '../logger';
import { fillSlots, promptText } from './prompts';

export type { ArbitrationAnswer, EntityArbitration };

// The judge runs on the SAME model `AI()`'s "careful" tier names — reused
// rather than hard-coded so a self-hosted deployment with only
// ANTHROPIC_API_KEY (no OpenAI key) can still resolve FUZZY writes: an
// unnamed model here would route through the shell's OpenAI-only default
// and every ambiguous match would fail closed into a silent duplicate create.
// Exported so a test can pin it without hard-coding the id a second time.
export const JUDGE_MODEL = claudeModelId(aiExpressionSettings('careful').model);

const verdictSchema = z.object({
  match_index: z.number().nullable(),
  confidence: z.number(),
  reasoning: z.string(),
});
export type JudgeVerdict = z.infer<typeof verdictSchema>;

/** One model call: the filled-in prompt, and the schema its JSON reply must
 *  satisfy. The shell owns retries on an invalid reply. */
export interface JudgeModelRequest {
  label: string;
  model: typeof JUDGE_MODEL;
  system: string;
  user: string;
  validator: typeof verdictSchema;
}

export type JevNoulQuestion = { type: 'noul'; instructions: string };
export type JevAnswer = { type: 'noul'; noul: number } | { type: 'choice' };

/** The second judge. Absent, the generative judge decides alone. */
export interface JevJudgeClient {
  /** Asked on every judging, so a deployment can flip it without a restart. */
  enabled(): boolean;
  /** Throws when `enabled()` but not usable. Must not read as a decline. */
  assertConfigured(): void;
  ask(
    input: { state: unknown; questions: Record<string, JevNoulQuestion> },
    options: { label: string },
  ): Promise<Record<string, JevAnswer>>;
  /** The one failure that must never fall back to the generative judge. */
  isConfigurationError(err: unknown): boolean;
}

export interface IdentityJudgeDeps {
  askModel(request: JudgeModelRequest): Promise<JudgeVerdict>;
  jev?: JevJudgeClient;
}

type JudgeInput = {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
};

/** Below this confidence the generative judge's pick is treated as a
 *  decline, same posture as the Jev judge's own threshold. */
export const GENERATIVE_MATCH_THRESHOLD = 0.5;

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

export function createIdentityJudge({ askModel, jev }: IdentityJudgeDeps) {
  /**
   * The generative judge's raw call: which candidate the model picked (or
   * null) and how confident it says it is, with NO decision rule applied yet
   * — a caller wanting the production posture uses `judgeEntityMatchGenerative`
   * below; a caller wanting the raw score (the threshold eval runner) calls
   * this directly. Throws on a failed call — the "decline on throw" posture
   * belongs to the decision wrapper, not the raw score.
   */
  async function judgeEntityMatchGenerativeRaw(
    input: JudgeInput,
  ): Promise<{ match_index: number | null; confidence: number }> {
    const result = await askModel({
      label: 'tg_entity_match',
      model: JUDGE_MODEL,
      system: promptText('entity_match.system'),
      user: fillSlots(promptText('entity_match.user'), {
        recordType: input.recordType,
        asserted: formatRecord(input.asserted),
        candidates: input.candidates.map((c, i) => formatCandidate(c, i)).join('\n\n'),
      }),
      validator: verdictSchema,
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
  async function judgeEntityMatchGenerative(
    input: JudgeInput & { onJudgeUnavailable?: (message: string) => void },
  ): Promise<number | null> {
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
  async function judgeEntityMatchViaJevRaw(
    input: JudgeInput,
  ): Promise<Record<string, { same: number; evidence: number }>> {
    if (!jev) throw new Error('no Jev client was given to the identity judge');
    const candidates: Record<string, Record<string, unknown>> = {};
    const questions: Record<string, JevNoulQuestion> = {};
    input.candidates.forEach((candidate, i) => {
      const option = jevCandidateOption(i);
      candidates[option] = stripEmptyFields(candidate.data);
      questions[jevSameKey(option)] = {
        type: 'noul',
        instructions: fillSlots(promptText('jev_same'), { option, recordType: input.recordType }),
      };
      questions[jevEvidenceKey(option)] = {
        type: 'noul',
        instructions: fillSlots(promptText('jev_evidence'), { option }),
      };
    });

    const answers = await jev.ask(
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
  async function judgeEntityMatchViaJev(input: JudgeInput): Promise<number | null> {
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
   * record — routed to Jev when the Jev client is on, else the generative
   * model. Returns the index into `candidates`, or null to create a new
   * record.
   *
   * The Jev route falls back to the generative judge on anything short of a
   * misconfiguration (too many candidates for one Jev question, a failed
   * call after its own retries): a slower second judge beats declining into
   * a duplicate create. A misconfiguration — the flag on with no key — is
   * the one failure that must NOT read as "the judge declined": it is
   * thrown, uncaught, before either judge runs, so it never reaches the
   * decline-on-throw catch below and never silently creates a duplicate.
   */
  async function judgeEntityMatch(
    input: JudgeInput & { onJudgeUnavailable?: (message: string) => void },
  ): Promise<number | null> {
    if (input.candidates.length === 0) return null;

    if (jev?.enabled()) {
      jev.assertConfigured();
      if (input.candidates.length > JEV_MAX_CANDIDATES) {
        logger.warn('[tg_entity_match] candidate count exceeds the Jev candidate bound; using the generative judge', {
          recordType: input.recordType,
          candidateCount: input.candidates.length,
        });
      } else {
        try {
          return await judgeEntityMatchViaJev(input);
        } catch (err) {
          if (jev.isConfigurationError(err) || isBudgetExhausted(err)) throw err;
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
  async function arbitrateEntityCandidates(
    input: EntityArbitration & { onJudgeUnavailable?: (message: string) => void },
  ): Promise<number | null> {
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
  async function meteredArbitration({
    budget,
    ...arbitration
  }: Priced<EntityArbitration>): Promise<Costed<ArbitrationAnswer>> {
    let judgeUnavailable: string | undefined;
    const { value, cost } = await withSpendMeter(budget, () =>
      arbitrateEntityCandidates({
        ...arbitration,
        onJudgeUnavailable: (message) => {
          judgeUnavailable = message;
        },
      }),
    );
    return { index: value, ...(judgeUnavailable !== undefined ? { judgeUnavailable } : {}), cost };
  }

  return {
    judgeEntityMatch,
    judgeEntityMatchGenerativeRaw,
    judgeEntityMatchViaJev,
    judgeEntityMatchViaJevRaw,
    arbitrateEntityCandidates,
    meteredArbitration,
  };
}

export type IdentityJudge = ReturnType<typeof createIdentityJudge>;
