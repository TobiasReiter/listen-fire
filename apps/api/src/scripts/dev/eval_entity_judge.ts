/**
 * Threshold evaluation runner for the two entity-match judges
 * (`services/translation_graph/engine/entity_match.ts`, Part A's judge
 * split). For each hand-labelled synthetic case this calls the RAW Jev judge
 * (per-candidate `{ same, evidence }` scores) and the RAW generative judge —
 * the pre-threshold score, not the production decision — so the production
 * thresholds can be swept AFTER the call instead of re-running the model
 * once per threshold.
 *
 * Synthetic data only: `_fixtures/entity_match_labelled.jsonl` is 180
 * fabricated company/person records with no connection to any real team's
 * data. Never point this at a real record.
 *
 * `multi-preexisting-duplicate` cases are excluded from every wrong/missed
 * tally: both candidates in that category ARE the same real-world entity as
 * each other (a pre-existing duplicate problem), so merging into either one
 * is harmless — the "expected" index only names the more-complete record.
 * They get their own "merged into some candidate" line instead.
 *
 * Usage (real API spend against Jev and, unless `--jev-only`, Anthropic):
 *
 *   pnpm dev:eval-entity-judge -- --out ~/scratch/results.jsonl [--jev-only] [--limit N] [--fixture path]
 *
 * `--out <path>` (required) is where the per-case `results.jsonl` lands.
 * `--jev-only` skips the generative judge entirely (no ANTHROPIC_API_KEY
 * spend). `--limit N` runs only the first N cases, for a cheap smoke pass.
 * `--fixture <path>` evaluates a different labelled JSONL file instead of
 * the repo fixture (same shape as `caseSchema` below).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { ExternalRecordRef } from '../../services/translation_graph/adapter';

import {
  GENERATIVE_MATCH_THRESHOLD,
  JEV_SAME_THRESHOLD,
  JEV_EVIDENCE_THRESHOLD,
  judgeEntityMatchGenerativeRaw,
  judgeEntityMatchViaJevRaw,
} from '../../services/translation_graph/engine/entity_match';

const FIXTURES_PATH = path.join(__dirname, '_fixtures/entity_match_labelled.jsonl');

/** Merging into EITHER candidate is harmless for this category — see header. */
const DUPLICATE_GROUP_CATEGORY = 'multi-preexisting-duplicate';

// ── Fixtures ──────────────────────────────────────────────────────────────

const caseSchema = z.object({
  id: z.string().min(1),
  category: z.string(),
  recordType: z.string(),
  asserted: z.record(z.string(), z.unknown()),
  candidates: z.array(z.record(z.string(), z.unknown())),
  expected: z.number().int().nullable(),
  evidence: z.enum(['strong', 'weak']),
  note: z.string().optional(),
});

export type LabelledCase = z.infer<typeof caseSchema>;

export function loadCases(filePath: string): LabelledCase[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => caseSchema.parse(JSON.parse(line)));
}

function toRefs(candidates: Record<string, unknown>[], recordType: string): ExternalRecordRef[] {
  return candidates.map((data, i) => ({
    adapterType: 'synthetic',
    externalId: String(i),
    recordType,
    data,
  }));
}

// ── Calling the judges ──────────────────────────────────────────────────

interface JevOutcome {
  scores: Record<string, { same: number; evidence: number }>;
  latencyMs: number;
}

interface GenerativeOutcome {
  match_index: number | null;
  confidence: number;
  latencyMs: number;
}

export interface CaseResult {
  id: string;
  category: string;
  recordType: string;
  expected: number | null;
  evidence: 'strong' | 'weak';
  candidateCount: number;
  jev?: JevOutcome;
  jevError?: string;
  generative?: GenerativeOutcome;
  generativeError?: string;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, latencyMs: Date.now() - started };
}

async function runCase(c: LabelledCase, jevOnly: boolean): Promise<CaseResult> {
  const candidates = toRefs(c.candidates, c.recordType);
  const result: CaseResult = {
    id: c.id,
    category: c.category,
    recordType: c.recordType,
    expected: c.expected,
    evidence: c.evidence,
    candidateCount: candidates.length,
  };

  try {
    const { value, latencyMs } = await timed(() =>
      judgeEntityMatchViaJevRaw({ asserted: c.asserted, candidates, recordType: c.recordType }),
    );
    result.jev = { scores: value, latencyMs };
  } catch (err) {
    result.jevError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  if (!jevOnly) {
    try {
      const { value, latencyMs } = await timed(() =>
        judgeEntityMatchGenerativeRaw({ asserted: c.asserted, candidates, recordType: c.recordType }),
      );
      result.generative = { ...value, latencyMs };
    } catch (err) {
      result.generativeError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  return result;
}

/** Run `tasks` at most `limit` at a time — bounds how many concurrent judge
 *  calls (Jev + Anthropic) the run spends at once. */
async function pool<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (let i = next++; i < tasks.length; i = next++) {
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Decision rules (applied AFTER the call, over the raw scores) ────────

/** The production Jev decision at given thresholds: best = the candidate
 *  with the highest `same`; merge into it only when its `same` clears
 *  `sameThreshold` AND its `evidence` clears `evidenceThreshold` — exactly
 *  `judgeEntityMatchViaJev`'s rule, parameterised. */
function jevDecision(outcome: JevOutcome, candidateCount: number, sameThreshold: number, evidenceThreshold: number): number | null {
  let bestIndex: number | null = null;
  let bestSame = -Infinity;
  for (let i = 0; i < candidateCount; i++) {
    const score = outcome.scores[`c${i}`];
    if (score && score.same > bestSame) {
      bestSame = score.same;
      bestIndex = i;
    }
  }
  if (bestIndex === null) return null;
  const best = outcome.scores[`c${bestIndex}`];
  if (best.same < sameThreshold || best.evidence < evidenceThreshold) return null;
  return bestIndex;
}

/** The generative judge's current, non-swept rule (`judgeEntityMatchGenerative`). */
function generativeDecision(outcome: GenerativeOutcome, candidateCount: number): number | null {
  if (outcome.match_index == null) return null;
  if (outcome.confidence < GENERATIVE_MATCH_THRESHOLD) return null;
  if (outcome.match_index < 0 || outcome.match_index >= candidateCount) return null;
  return outcome.match_index;
}

type Verdict = 'correct' | 'wrong_merge' | 'missed_merge';

function scoreDecision(expected: number | null, decision: number | null): Verdict {
  if (expected === null) return decision === null ? 'correct' : 'wrong_merge';
  if (decision === null) return 'missed_merge';
  return decision === expected ? 'correct' : 'wrong_merge';
}

// ── Summary ──────────────────────────────────────────────────────────────

interface Tally {
  correct: number;
  wrongMerges: number;
  missedMerges: number;
}

function tallyOf(
  results: readonly CaseResult[],
  decisionFor: (r: CaseResult) => number | null | undefined,
  evidence: 'strong' | 'weak',
): Tally {
  const tally: Tally = { correct: 0, wrongMerges: 0, missedMerges: 0 };
  for (const r of results) {
    if (r.category === DUPLICATE_GROUP_CATEGORY) continue; // reported separately — see header
    if (r.evidence !== evidence) continue;
    const decision = decisionFor(r);
    if (decision === undefined) continue; // a failed call — excluded here, listed under failures
    const verdict = scoreDecision(r.expected, decision);
    if (verdict === 'correct') tally.correct++;
    else if (verdict === 'wrong_merge') tally.wrongMerges++;
    else tally.missedMerges++;
  }
  return tally;
}

function fmtTally(t: Tally): string {
  return `wrong=${t.wrongMerges} missed=${t.missedMerges} correct=${t.correct}`;
}

interface DuplicateGroupTally {
  merged: number;
  total: number;
  failed: number;
}

/** `multi-preexisting-duplicate` cases: both candidates are the same
 *  real-world entity as each other, so merging into EITHER is harmless —
 *  count "merged into some candidate" rather than requiring the exact
 *  labelled index. */
function duplicateGroupTally(
  results: readonly CaseResult[],
  decisionFor: (r: CaseResult) => number | null | undefined,
): DuplicateGroupTally {
  const tally: DuplicateGroupTally = { merged: 0, total: 0, failed: 0 };
  for (const r of results) {
    if (r.category !== DUPLICATE_GROUP_CATEGORY) continue;
    tally.total++;
    const decision = decisionFor(r);
    if (decision === undefined) {
      tally.failed++;
      continue;
    }
    if (decision !== null) tally.merged++;
  }
  return tally;
}

function fmtDuplicateGroupTally(t: DuplicateGroupTally): string {
  return `merged into some candidate ${t.merged}/${t.total}${t.failed ? ` (${t.failed} call failures)` : ''}`;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function printSummary(results: readonly CaseResult[], jevOnly: boolean): void {
  const jevAnswered = results.filter((r): r is CaseResult & { jev: JevOutcome } => r.jev !== undefined);
  const jevFailed = results.filter((r) => r.jevError !== undefined);
  const genAnswered = results.filter(
    (r): r is CaseResult & { generative: GenerativeOutcome } => r.generative !== undefined,
  );
  const genFailed = results.filter((r) => r.generativeError !== undefined);

  console.log(
    `\n${results.length} cases · Jev answered ${jevAnswered.length} (${jevFailed.length} failed)` +
      (jevOnly ? '' : ` · generative answered ${genAnswered.length} (${genFailed.length} failed)`),
  );

  // 1. Jev threshold sweep: `same` 0.40–0.90 step 0.05, at evidence 0.5 and 0.7.
  // `multi-preexisting-duplicate` cases are excluded from every cell here — see header.
  console.log(
    '\n== 1. Jev — threshold sweep (production rule: highest `same`, thresholded on same AND evidence) ==',
  );
  for (const evidenceThreshold of [0.5, 0.7] as const) {
    console.log(`\n-- evidence >= ${evidenceThreshold} --`);
    console.log('same >= | strong: wrong/missed/correct | weak: wrong/missed/correct');
    for (let step = 40; step <= 90; step += 5) {
      const sameThreshold = step / 100;
      const decisionFor = (r: CaseResult) =>
        r.jev ? jevDecision(r.jev, r.candidateCount, sameThreshold, evidenceThreshold) : undefined;
      const strong = tallyOf(results, decisionFor, 'strong');
      const weak = tallyOf(results, decisionFor, 'weak');
      console.log(`${sameThreshold.toFixed(2)}    | ${fmtTally(strong)}          | ${fmtTally(weak)}`);
    }
  }

  // 2. Generative judge at its current rule.
  if (!jevOnly) {
    console.log(`\n== 2. Generative judge — current rule (confidence >= ${GENERATIVE_MATCH_THRESHOLD}) ==`);
    const decisionFor = (r: CaseResult) =>
      r.generative ? generativeDecision(r.generative, r.candidateCount) : undefined;
    console.log(`strong: ${fmtTally(tallyOf(results, decisionFor, 'strong'))}`);
    console.log(`weak:   ${fmtTally(tallyOf(results, decisionFor, 'weak'))}`);
  } else {
    console.log('\n== 2. Generative judge — skipped (--jev-only) ==');
  }

  // 3. Jev at the production thresholds.
  console.log(`\n== 3. Jev — production rule (same >= ${JEV_SAME_THRESHOLD}, evidence >= ${JEV_EVIDENCE_THRESHOLD}) ==`);
  const jevProdDecisionFor = (r: CaseResult) =>
    r.jev ? jevDecision(r.jev, r.candidateCount, JEV_SAME_THRESHOLD, JEV_EVIDENCE_THRESHOLD) : undefined;
  console.log(`strong: ${fmtTally(tallyOf(results, jevProdDecisionFor, 'strong'))}`);
  console.log(`weak:   ${fmtTally(tallyOf(results, jevProdDecisionFor, 'weak'))}`);

  // 4. multi-preexisting-duplicate — reported separately, both judges.
  console.log(`\n== 4. ${DUPLICATE_GROUP_CATEGORY} — merging into EITHER duplicate is harmless ==`);
  console.log(`Jev (production rule): ${fmtDuplicateGroupTally(duplicateGroupTally(results, jevProdDecisionFor))}`);
  if (!jevOnly) {
    const genDecisionFor = (r: CaseResult) =>
      r.generative ? generativeDecision(r.generative, r.candidateCount) : undefined;
    console.log(`Generative:             ${fmtDuplicateGroupTally(duplicateGroupTally(results, genDecisionFor))}`);
  }

  // 5. Every case either judge gets wrong at the production thresholds
  // (excludes the duplicate-group category, reported separately above).
  console.log('\n== 5. Cases either judge gets wrong at the production thresholds ==');
  let anyWrong = false;
  for (const r of results) {
    if (r.category === DUPLICATE_GROUP_CATEGORY) continue;
    const jevDec = jevProdDecisionFor(r);
    const genDec = r.generative ? generativeDecision(r.generative, r.candidateCount) : undefined;
    const jevWrong = jevDec !== undefined && scoreDecision(r.expected, jevDec) !== 'correct';
    const genWrong = genDec !== undefined && scoreDecision(r.expected, genDec) !== 'correct';
    if (!jevWrong && !genWrong) continue;
    anyWrong = true;
    const jevSay = r.jev
      ? Object.entries(r.jev.scores)
          .map(([opt, s]) => `${opt}:same=${s.same.toFixed(2)}/evid=${s.evidence.toFixed(2)}`)
          .join(' ')
      : r.jevError
        ? 'ERROR'
        : 'n/a';
    const genSay = jevOnly
      ? 'n/a (--jev-only)'
      : r.generative
        ? `idx=${r.generative.match_index}, conf=${r.generative.confidence.toFixed(2)}`
        : r.generativeError
          ? 'ERROR'
          : 'n/a';
    console.log(
      `${r.id} [${r.category}] expected=${r.expected} — jev:${jevWrong ? 'WRONG' : 'ok'} (${jevSay}) generative:${genWrong ? 'WRONG' : 'ok'} (${genSay})`,
    );
  }
  if (!anyWrong) console.log('(none)');

  // 6. Latency.
  console.log('\n== 6. Latency ==');
  const jevLatencies = jevAnswered.map((r) => r.jev.latencyMs);
  console.log(`Jev — median ${percentile(jevLatencies, 50) ?? 'n/a'}ms, p95 ${percentile(jevLatencies, 95) ?? 'n/a'}ms`);
  if (!jevOnly) {
    const genLatencies = genAnswered.map((r) => r.generative.latencyMs);
    console.log(
      `Generative — median ${percentile(genLatencies, 50) ?? 'n/a'}ms, p95 ${percentile(genLatencies, 95) ?? 'n/a'}ms`,
    );
  }

  if (jevFailed.length) {
    console.log(`\nJev call failures: ${jevFailed.map((r) => `${r.id} (${r.jevError})`).join('; ')}`);
  }
  if (genFailed.length) {
    console.log(`Generative call failures: ${genFailed.map((r) => `${r.id} (${r.generativeError})`).join('; ')}`);
  }
}

// ── Driving it ────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const CONCURRENCY = 5;

async function main(): Promise<void> {
  const outPath = flag('out');
  if (!outPath) throw new Error('--out <path for results.jsonl> is required');
  const jevOnly = hasFlag('jev-only');
  const limitFlag = flag('limit');
  const limit = limitFlag ? Number(limitFlag) : undefined;
  const fixturePath = flag('fixture') ?? FIXTURES_PATH;

  const all = loadCases(fixturePath);
  const cases = limit ? all.slice(0, limit) : all;

  console.log(
    `${cases.length} cases${jevOnly ? ' (Jev only)' : ' (Jev + generative)'} — ${CONCURRENCY} at a time`,
  );

  const tasks = cases.map((c) => () => runCase(c, jevOnly));
  const results = await pool(tasks, CONCURRENCY);

  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`wrote ${results.length} results to ${outPath}`);

  printSummary(results, jevOnly);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
