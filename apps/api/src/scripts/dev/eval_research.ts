/**
 * The side-by-side: both `research` engines over one fixture set, one judge,
 * one table.
 *
 * The plugin exists to settle which engine drives the loop, and that is a
 * question about a corpus rather than about an entry — an engine that wins on
 * Larkfield and loses on a bare name has told you nothing. So this runs every
 * entry through both engines, has a model grade what came back against what
 * the entry asked, prices both from what they actually spent, and writes the
 * table you read.
 *
 * The judge never touches the web. It grades what it is given, which is the
 * only way its verdict is about the engine rather than about its own research.
 *
 * The fixture file lives OUTSIDE the repo: you write it from your own runs.
 *
 * Usage (real API spend — every run costs money):
 *
 *   pnpm dev:eval-research --fixtures ~/scratch/research_fixtures.json \
 *     --out ~/scratch/eval [--engine constrained|agentic|both] \
 *     [--judge claude-opus-5] [--only larkfield] [--concurrency 2]
 *
 * A resource-constrained machine can't always hold a 13-entry, both-engine
 * run to the end — `--only <id>[,<id>…]` runs one entry, or a few, by their
 * exact fixture `id` (both engines finish one in under three minutes) and
 * writes its own `research_eval_*.json`/`.md` pair, same as a full run does.
 * A fixture `name` is not enough on its own to pick one out — several ids can
 * share a name (`larkfield`, `larkfield-site-only`) — so `--only` never matches on
 * it. Once every entry has run once, assemble the
 * combined report without spending anything again:
 *
 *   pnpm dev:eval-research --merge ~/scratch/eval --out ~/scratch/eval
 *
 * `--merge <dir>` reads every `research_eval_*.json` in that directory,
 * keeps the newest record per (entry, engine) — so a rerun of a cheap entry
 * supersedes an earlier attempt rather than double-counting it — and renders
 * one report from the union, exactly as a single `--engine both` run would
 * have.
 *
 * ── The fixture file ──────────────────────────────────────────────────────
 *
 * A JSON array (or `{ "entries": [ … ] }`) of:
 *
 *   {
 *     "id": "larkfield",                    // unique, names the row
 *     "name": "Larkfield",                  // the subject, as a message named it
 *     "context": "Danish school…",       // optional: what the message said
 *     "context_confidence": "sure",      // optional: "sure" | "guess" — how
 *                                        //   much the context can be trusted;
 *                                        //   a WRONG context reliably makes an
 *                                        //   entry no_match, so a guess that
 *                                        //   fails is the fixture's fault
 *     "website": "https://larkfield.example",    // optional address the entry carries
 *     "linkedin": "https://…/in/…",      // optional
 *     "url": "https://…",                // optional: an article, a listing
 *     "questions": "what it does, …",    // what the dossier must answer
 *     "expect": { "outcome": "no_anchor", "website": "https://larkfield.example" }
 *   }
 *
 * `expect` is optional and either half of it is. `outcome` is compared
 * exactly; `website` is compared with scheme, `www.` and a trailing slash
 * ignored.
 */
import './_profile_loader';

// Composition root — registers the services the fetch path reaches.
import '../../services';
import '../../services/translation_graph/engine/transforms/register-bundled';

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { anthropicChatStructured } from '../../lib/anthropic';
import { parseChatModelName } from 'movement-engine/public/models';

import type { ChatModelName } from 'movement-engine/public/models';

import { runInContext } from '../../services/context/utils';
import { research, usageWasNotMeasured } from '../../services/translation_graph/engine/transforms/research';
import { ensureDevLoopTeam } from './_lib';

import type {
  ResearchEngineName,
  ResearchOutcome,
  ResearchResult,
  ResearchUsage,
} from '../../services/translation_graph/engine/transforms/research';

// ── Prices ────────────────────────────────────────────────────────────────
//
// Dollars per million tokens, from Anthropic's own pricing page. Deliberately
// NOT read from `lib/llm_usage`'s table: that one carries $3/$15 for Sonnet 5
// (the standard rate the introductory $2/$10 reverts to) and this comparison
// has to be priced at what the runs actually cost. A cached token is charged
// at a multiple of the input rate — a write at 1.25×, a read at 0.1× — which
// is why the agentic engine's long system prompt has to be priced at all.

const RATES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
};

const CACHE_WRITE_MULTIPLE = 1.25;
const CACHE_READ_MULTIPLE = 0.1;

/** Anthropic's server-side search, $10 per thousand. The constrained engine
 *  searches Google Custom Search instead, which is counted and not priced. */
const ANTHROPIC_SEARCH_USD = 10 / 1000;

export interface RunCost {
  modelUsd: number;
  searchUsd: number;
  totalUsd: number;
}

export function priceRun(args: {
  engine: ResearchEngineName;
  model: string;
  usage: ResearchUsage;
}): RunCost {
  const rate = RATES_PER_MTOK[args.model];
  const { usage } = args;
  const modelUsd = rate
    ? (usage.inputTokens * rate.input +
        usage.outputTokens * rate.output +
        usage.cacheCreationTokens * rate.input * CACHE_WRITE_MULTIPLE +
        usage.cacheReadTokens * rate.input * CACHE_READ_MULTIPLE) /
      1_000_000
    : 0;
  // Only the agentic engine's searches reach Anthropic; the constrained
  // engine's go to Google Custom Search, whose per-query price is not in this
  // comparison.
  const searchUsd = args.engine === 'agentic' ? usage.searches * ANTHROPIC_SEARCH_USD : 0;
  return { modelUsd, searchUsd, totalUsd: modelUsd + searchUsd };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const outcomeSchema = z.enum(['no_anchor', 'no_match', 'fetch_failed', 'partial', 'resolved']);

const fixtureSchema = z.object({
  id: z.string().min(1),
  // An entry can arrive as an address and nothing else — a profile with no
  // name beside it is the case the plugin was built for — so a fixture may
  // leave the name empty. The `id` is what names its row.
  name: z.string(),
  context: z.string().optional(),
  context_confidence: z.enum(['sure', 'guess']).optional(),
  website: z.string().optional(),
  linkedin: z.string().optional(),
  url: z.string().optional(),
  questions: z.string().min(1),
  expect: z
    .object({ outcome: outcomeSchema.optional(), website: z.string().optional() })
    .optional(),
});

export type Fixture = z.infer<typeof fixtureSchema>;

const fixtureFileSchema = z.union([
  z.array(fixtureSchema),
  z.object({ entries: z.array(fixtureSchema) }),
]);

/** The fixture file, validated at the boundary. Duplicate ids are rejected —
 *  the id is what a row in the table is, and two rows with one name is a
 *  report nobody can read. */
export function parseFixtures(raw: unknown): Fixture[] {
  const parsed = fixtureFileSchema.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Duplicate fixture id: ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
}

/** `--only`'s argument: one fixture `id`, or several separated by commas.
 *  Names are not unique — `larkfield` and `larkfield-site-only` share one — so this
 *  matches the id exactly and never a fixture's `name`. */
export function selectFixtures(all: readonly Fixture[], only: string): Fixture[] {
  const ids = new Set(
    only
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return all.filter((f) => ids.has(f.id));
}

/** Two addresses for the same site. Scheme, `www.` and a trailing slash are
 *  presentation; what the engine resolved is the host and the path. */
export function sameSite(a: string | undefined, b: string | undefined): boolean {
  const strip = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  if (!a || !b) return false;
  return strip(a) === strip(b);
}

// ── The judge ─────────────────────────────────────────────────────────────

const verdictSchema = z.enum(['answered', 'partly', 'not_answered', 'wrong']);
export type Verdict = z.infer<typeof verdictSchema>;

const judgementSchema = z.object({
  questions: z.array(
    z.object({ question: z.string(), verdict: verdictSchema, reason: z.string() }),
  ),
  dossier_relevance: z.number().int().min(1).max(5),
  summary_form: z.enum(['answers', 'verifies', 'mixed']),
  summary_note: z.string(),
  expect_outcome: z.enum(['match', 'mismatch', 'not_applicable']),
  expect_website: z.enum(['match', 'mismatch', 'not_applicable']),
  expect_note: z.string(),
});

export type Judgement = z.infer<typeof judgementSchema>;

const JUDGE_SYSTEM = `You are grading one research write-up. You have no web access and you must not use anything you happen to know about the subject: grade only what is in front of you. A claim you cannot see is not answered, however true it is.

THE QUESTIONS. The caller asked one question per comma-separated clause, in the order written. Return one row per clause, in that order, quoting the clause as "question". A clause is:
- "answered" — the write-up states it plainly, and it is attributed to a source.
- "partly" — gestured at, hedged, or stated without support.
- "not_answered" — absent.
- "wrong" — the write-up states something that contradicts the context the caller gave, or attributes to the subject something that plainly belongs to a different organisation or person of the same name. Reserve this for a contradiction you can see in the material, not for a claim you merely doubt.
Give a one-line reason for every row.

THE DOSSIER. "dossier_relevance" 1-5: is the content SIZED TO THE QUESTIONS? 5 = every excerpt bears on a question asked. 3 = useful content padded with material nobody asked for. 1 = a homepage dump, a boilerplate about-us, or nothing at all.

THE SUMMARY'S FORM. This is the one that matters most and the easiest to miss. A summary must ANSWER the questions. A summary that instead reports on the research — that the subject was found, that the site checks out, that the identity is confirmed — has told the caller about the verification and not about the subject. An opener like "X checks out as the company described" is a verification statement, not an answer.
- "answers" — it answers, start to finish.
- "verifies" — it reports on the verification rather than answering.
- "mixed" — it opens on the verification and then answers, or answers and pads with it.
Give a one-line "summary_note" saying which and quoting the giveaway phrase when there is one.

WHAT WAS EXPECTED. When the caller states an expected outcome or an expected website, say whether what came back matches. "not_applicable" when nothing was expected. One line in "expect_note".`;

function judgeMessage(args: { fixture: Fixture; result: ResearchResult | null }): string {
  const { fixture, result } = args;
  const expected = [
    fixture.expect?.outcome ? `expected outcome: ${fixture.expect.outcome}` : null,
    fixture.expect?.website ? `expected website: ${fixture.expect.website}` : null,
  ].filter(Boolean);

  return [
    `SUBJECT: ${fixture.name || '(not named — the entry carried only an address)'}`,
    `WHAT THE MESSAGE SAID ABOUT IT: ${fixture.context?.trim() || '(nothing)'}`,
    `THE CALLER'S QUESTIONS: ${fixture.questions}`,
    expected.length ? `WHAT WAS EXPECTED: ${expected.join('; ')}` : 'WHAT WAS EXPECTED: (nothing)',
    '',
    `OUTCOME REPORTED: ${result?.outcome ?? '(the run failed)'}`,
    `CONFIDENCE REPORTED: ${result?.confidence ?? '(none)'}`,
    `WEBSITE RESOLVED: ${result?.website ?? '(none)'}`,
    '',
    'THE SUMMARY:',
    result?.summary?.trim() || '(none — nothing was returned)',
    '',
    'THE SOURCES:',
    result?.sources?.length ? result.sources.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(none)',
    '',
    'THE DOSSIER:',
    result?.dossier?.trim() || '(none)',
  ].join('\n');
}

async function judge(args: {
  fixture: Fixture;
  result: ResearchResult | null;
  model: ChatModelName;
}): Promise<Judgement> {
  return anthropicChatStructured({
    system: JUDGE_SYSTEM,
    userMessage: judgeMessage(args),
    schema: judgementSchema,
    toolName: 'file_verdict',
    toolDescription: 'File the verdict on this research write-up.',
    model: args.model,
    maxTokens: 8192,
    label: 'eval_research_judge',
  });
}

// ── One run ───────────────────────────────────────────────────────────────

export interface RunRecord {
  id: string;
  name: string;
  engine: ResearchEngineName;
  outcome: ResearchOutcome | null;
  confidence?: string;
  website?: string;
  linkedin?: string;
  summary?: string;
  sources?: string[];
  dossier?: string;
  usage: ResearchUsage;
  cost: RunCost;
  /** Matches computed here rather than by the judge: an outcome is a string
   *  comparison and a website is a host comparison, and neither is a matter
   *  of opinion. */
  expectOutcome: 'match' | 'mismatch' | 'not_applicable';
  expectWebsite: 'match' | 'mismatch' | 'not_applicable';
  judgement: Judgement | null;
  error?: string;
  judgeError?: string;
}

function expectMatches(fixture: Fixture, result: ResearchResult | null): {
  expectOutcome: RunRecord['expectOutcome'];
  expectWebsite: RunRecord['expectWebsite'];
} {
  const wanted = fixture.expect;
  return {
    expectOutcome: !wanted?.outcome
      ? 'not_applicable'
      : wanted.outcome === result?.outcome
        ? 'match'
        : 'mismatch',
    expectWebsite: !wanted?.website
      ? 'not_applicable'
      : sameSite(wanted.website, result?.website)
        ? 'match'
        : 'mismatch',
  };
}

async function runOne(args: {
  fixture: Fixture;
  engine: ResearchEngineName;
  model: ChatModelName;
  judgeModel: ChatModelName;
}): Promise<RunRecord> {
  const { fixture, engine, model, judgeModel } = args;
  const started = Date.now();

  let result: ResearchResult | null = null;
  let error: string | undefined;
  try {
    result = await research(
      {
        name: fixture.name,
        context: fixture.context ?? '',
        questions: fixture.questions,
        urls: [fixture.website, fixture.linkedin, fixture.url].filter(
          (u): u is string => Boolean(u && u.trim()),
        ),
      },
      // The engine is named here, so `RESEARCH_ENGINE` never decides a row.
      { engine, ...(model ? { model } : {}) },
    );
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }

  const usage: ResearchUsage = result?.usage ?? {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    searches: 0,
    fetches: 0,
    wallClockMs: Date.now() - started,
  };

  let judgement: Judgement | null = null;
  let judgeError: string | undefined;
  try {
    judgement = await judge({ fixture, result, model: judgeModel });
  } catch (caught) {
    judgeError = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }

  return {
    id: fixture.id,
    name: fixture.name,
    engine,
    outcome: result?.outcome ?? null,
    ...(result?.confidence ? { confidence: result.confidence } : {}),
    ...(result?.website ? { website: result.website } : {}),
    ...(result?.linkedin ? { linkedin: result.linkedin } : {}),
    ...(result?.summary ? { summary: result.summary } : {}),
    ...(result?.sources ? { sources: result.sources } : {}),
    ...(result?.dossier ? { dossier: result.dossier } : {}),
    usage,
    cost: priceRun({ engine, model, usage }),
    ...expectMatches(fixture, result),
    judgement,
    ...(error ? { error } : {}),
    ...(judgeError ? { judgeError } : {}),
  };
}

// ── The report ────────────────────────────────────────────────────────────

const VERDICT_LETTER: Record<Verdict, string> = {
  answered: 'A',
  partly: 'P',
  not_answered: 'N',
  wrong: 'W',
};

/** `A A P` — one letter per question, in the order asked. Compressed because
 *  the table is read across engines: what changed between two columns is the
 *  point, and full words hide it. */
export function compressVerdicts(judgement: Judgement | null): string {
  if (!judgement || judgement.questions.length === 0) return '—';
  return judgement.questions.map((q) => VERDICT_LETTER[q.verdict]).join(' ');
}

function answeredCount(judgement: Judgement | null): number {
  return (judgement?.questions ?? []).filter((q) => q.verdict === 'answered').length;
}

const MATCH_MARK: Record<RunRecord['expectOutcome'], string> = {
  match: 'yes',
  mismatch: 'NO',
  not_applicable: '—',
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** What an entry cost, or that nobody knows. An aborted stream never returns
 *  its usage row, so a timed-out entry's tokens and searches come back as
 *  zero — and `$0.0000` in the cheapest column of the slowest row is a lie
 *  the reader has no way to catch. */
function costCell(record: RunRecord): string {
  return usageWasNotMeasured(record.usage) ? 'n/a' : usd(record.cost.totalUsd);
}

function expectCell(record: RunRecord): string {
  const parts = [
    record.expectOutcome === 'not_applicable' ? null : `outcome ${MATCH_MARK[record.expectOutcome]}`,
    record.expectWebsite === 'not_applicable' ? null : `site ${MATCH_MARK[record.expectWebsite]}`,
  ].filter((p): p is string => p != null);
  return parts.length ? parts.join(', ') : '—';
}

function engineTable(records: readonly RunRecord[]): string {
  const header =
    '| entry | outcome | expect | verdicts | dossier | conf | wall | search/fetch | $ |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = records.map((r) =>
    [
      '',
      r.name || r.id,
      r.error ? `ERROR` : (r.outcome ?? '—'),
      expectCell(r),
      compressVerdicts(r.judgement),
      r.judgement ? `${r.judgement.dossier_relevance}/5` : '—',
      r.confidence ?? '—',
      seconds(r.usage.wallClockMs),
      usageWasNotMeasured(r.usage) ? 'n/a' : `${r.usage.searches}/${r.usage.fetches}`,
      costCell(r),
      '',
    ].join(' | ').trim(),
  );
  return [header, ...rows].join('\n');
}

function headToHead(byEngine: Map<ResearchEngineName, RunRecord[]>): string {
  const constrained = byEngine.get('constrained') ?? [];
  const agentic = byEngine.get('agentic') ?? [];
  if (!constrained.length || !agentic.length) return '_Only one engine ran._';

  const agenticById = new Map(agentic.map((r) => [r.id, r]));
  const header =
    '| entry | constrained | agentic | $ constrained | $ agentic | faster |\n' +
    '| --- | --- | --- | --- | --- | --- |';
  const rows = constrained.flatMap((c) => {
    const a = agenticById.get(c.id);
    if (!a) return [];
    const faster =
      c.usage.wallClockMs === a.usage.wallClockMs
        ? 'tie'
        : c.usage.wallClockMs < a.usage.wallClockMs
          ? 'constrained'
          : 'agentic';
    return [
      [
        '',
        c.name || c.id,
        `${c.outcome ?? 'ERROR'} · ${compressVerdicts(c.judgement)}`,
        `${a.outcome ?? 'ERROR'} · ${compressVerdicts(a.judgement)}`,
        costCell(c),
        costCell(a),
        faster,
        '',
      ].join(' | ').trim(),
    ];
  });
  return [header, ...rows].join('\n');
}

function judgeNotes(records: readonly RunRecord[]): string {
  const notes: string[] = [];
  for (const r of records) {
    // The shape of a summary is only a finding when there IS one; an entry
    // that returned nothing is already reported by its outcome.
    if (r.summary && r.judgement && r.judgement.summary_form !== 'answers') {
      notes.push(
        `- **${r.name} · ${r.engine}** — summary ${r.judgement.summary_form}: ${r.judgement.summary_note}`,
      );
    }
    for (const q of r.judgement?.questions ?? []) {
      if (q.verdict === 'wrong') {
        notes.push(`- **${r.name} · ${r.engine}** — WRONG on "${q.question}": ${q.reason}`);
      }
    }
    if (r.judgement && r.judgement.expect_outcome === 'mismatch') {
      notes.push(`- **${r.name} · ${r.engine}** — expectation missed: ${r.judgement.expect_note}`);
    }
    if (r.error) notes.push(`- **${r.name} · ${r.engine}** — the run failed: ${r.error}`);
    if (r.judgeError) notes.push(`- **${r.name} · ${r.engine}** — the judge failed: ${r.judgeError}`);
  }
  return notes.length ? notes.join('\n') : '_Nothing flagged._';
}

function totalsTable(byEngine: Map<ResearchEngineName, RunRecord[]>): string {
  const header =
    '| engine | entries | resolved | questions answered | mean wall | total $ |\n' +
    '| --- | --- | --- | --- | --- | --- |';
  const rows = [...byEngine.entries()].map(([engine, records]) => {
    const resolved = records.filter((r) => r.outcome === 'resolved').length;
    const answered = records.reduce((sum, r) => sum + answeredCount(r.judgement), 0);
    const asked = records.reduce((sum, r) => sum + (r.judgement?.questions.length ?? 0), 0);
    const meanWall = records.length
      ? records.reduce((sum, r) => sum + r.usage.wallClockMs, 0) / records.length
      : 0;
    // The total is what was MEASURED. An aborted entry contributes nothing
    // because nobody knows what it spent, so the cell says how many rows the
    // figure is missing rather than quietly pretending they were free.
    const unmeasured = records.filter((r) => usageWasNotMeasured(r.usage)).length;
    const total = records.reduce((sum, r) => sum + r.cost.totalUsd, 0);
    const totalCell = unmeasured ? `${usd(total)} (${unmeasured} not measured)` : usd(total);
    return ['', engine, records.length, resolved, `${answered}/${asked}`, seconds(meanWall), totalCell, '']
      .join(' | ')
      .trim();
  });
  return [header, ...rows].join('\n');
}

export function renderReport(args: {
  records: readonly RunRecord[];
  fixturesPath: string;
  judgeModel: string;
  model: string;
  startedAt: string;
}): string {
  const byEngine = new Map<ResearchEngineName, RunRecord[]>();
  for (const record of args.records) {
    const list = byEngine.get(record.engine) ?? [];
    list.push(record);
    byEngine.set(record.engine, list);
  }

  const sections = [...byEngine.entries()].map(
    ([engine, records]) => `## ${engine}\n\n${engineTable(records)}\n`,
  );

  return [
    `# research: constrained vs agentic — ${args.startedAt}`,
    '',
    `Fixtures: \`${path.basename(args.fixturesPath)}\` · research model: \`${args.model}\` · judge: \`${args.judgeModel}\` (no web access; it grades what it is given).`,
    '',
    'Verdicts read left to right, one letter per question the entry asked: **A** answered, **P** partly, **N** not answered, **W** wrong.',
    '',
    ...sections,
    '## Head to head',
    '',
    headToHead(byEngine),
    '',
    '## Judge notes',
    '',
    judgeNotes(args.records),
    '',
    '## Totals',
    '',
    totalsTable(byEngine),
    '',
  ].join('\n');
}

// ── Merging per-entry runs ──────────────────────────────────────────────────

/** Only enough of a persisted `research_eval_*.json` is validated to merge
 *  and render safely — `id` and `engine` decide dedup, the rest passes
 *  through untouched. The file was written by this same script moments
 *  earlier, so its `records` are trusted to be `RunRecord`s rather than
 *  re-validated field by field. */
const persistedFileSchema = z.object({
  startedAt: z.string(),
  fixturesPath: z.string(),
  model: z.string(),
  judgeModel: z.string(),
  records: z.array(z.object({ id: z.string(), engine: z.enum(['constrained', 'agentic']) }).passthrough()),
});

/**
 * Every `research_eval_*.json` in `dir`, unioned into one record set. A
 * `--only <id>` run writes one of these per entry; this is how their results
 * become the one table a full `--engine both` run would have written,
 * without paying for the entries again.
 */
export function mergeRecords(dir: string): {
  records: RunRecord[];
  fixturesPath: string;
  model: string;
  judgeModel: string;
  startedAt: string;
} {
  const files = readdirSync(dir).filter((f) => /^research_eval_.*\.json$/.test(f));
  if (!files.length) throw new Error(`No research_eval_*.json files in ${dir}`);

  const parsed = files.map((f) => ({
    file: f,
    ...persistedFileSchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8'))),
  }));

  // The newest file wins per (id, engine) — a rerun of a cheap entry (an
  // anchor refusal, say) supersedes an earlier attempt's record of it rather
  // than appearing twice in the table.
  const newest = new Map<string, { startedAt: string; record: RunRecord }>();
  for (const file of parsed) {
    for (const record of file.records) {
      const key = `${record.id}:${record.engine}`;
      const existing = newest.get(key);
      if (!existing || file.startedAt > existing.startedAt) {
        newest.set(key, { startedAt: file.startedAt, record: record as unknown as RunRecord });
      }
    }
  }

  const first = parsed[0];
  return {
    records: [...newest.values()].map((v) => v.record),
    fixturesPath: first.fixturesPath,
    model: first.model,
    judgeModel: first.judgeModel,
    // The earliest attempt's start, not "now" — the round began when the
    // first entry ran, whatever order the pieces were assembled in.
    startedAt: parsed.map((f) => f.startedAt).sort()[0],
  };
}

// ── Driving it ────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** Run `tasks` at most `limit` at a time. The engines carry their own budgets,
 *  so the only thing this bounds is how much of the search quota and how many
 *  concurrent model calls the harness spends at once. */
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

async function main(): Promise<void> {
  const mergeDir = flag('merge');
  if (mergeDir) {
    const merged = mergeRecords(mergeDir);
    const outDir = flag('out') ?? mergeDir;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `research_eval_merged_${stamp}.json`);
    const mdPath = path.join(outDir, `research_eval_merged_${stamp}.md`);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        { ...merged, engines: [...new Set(merged.records.map((r) => r.engine))] },
        null,
        2,
      ),
    );
    writeFileSync(mdPath, renderReport({ ...merged, records: merged.records }));
    console.log(`\n${jsonPath}\n${mdPath}`);
    return;
  }

  const fixturesPath = flag('fixtures');
  if (!fixturesPath) throw new Error('--fixtures <path to the fixture JSON> is required');
  const outDir = flag('out') ?? path.dirname(fixturesPath);
  const judgeFlag = flag('judge');
  const judgeModel = judgeFlag ? parseChatModelName(judgeFlag, '--judge') : 'claude-opus-5';
  const modelFlag = flag('model');
  const model = modelFlag ? parseChatModelName(modelFlag, '--model') : 'claude-sonnet-5';
  const concurrency = Number(flag('concurrency') ?? 2);
  const only = flag('only');

  const named = flag('engine') ?? 'both';
  const engines: ResearchEngineName[] =
    named === 'both' ? ['constrained', 'agentic'] : [named as ResearchEngineName];
  if (engines.some((e) => e !== 'constrained' && e !== 'agentic')) {
    throw new Error(`--engine must be constrained, agentic or both (got "${named}")`);
  }

  const all = parseFixtures(JSON.parse(readFileSync(fixturesPath, 'utf8')));
  const fixtures = only ? selectFixtures(all, only) : all;
  if (!fixtures.length) throw new Error(`No fixture matched --only "${only ?? ''}"`);

  // The page fetch goes through the shared plumbing, which stores what it
  // fetched and therefore needs a tenant.
  let userId: string | null = null;
  try {
    ({ userId } = await ensureDevLoopTeam());
  } catch (error) {
    console.warn(`No dev-loop team (${String(error)}) — fetches will fail.`);
  }

  const startedAt = new Date().toISOString();
  console.log(
    `${fixtures.length} entries × ${engines.join(', ')} — model ${model}, judge ${judgeModel}, ${concurrency} at a time`,
  );

  const tasks = fixtures.flatMap((fixture) =>
    engines.map((engine) => async () => {
      const record = await runOne({ fixture, engine, model, judgeModel });
      console.log(
        `  ${record.name} · ${engine}: ${record.error ? `ERROR ${record.error}` : record.outcome} ` +
          `(${compressVerdicts(record.judgement)}, ${seconds(record.usage.wallClockMs)}, ${costCell(record)})`,
      );
      return record;
    }),
  );

  const call = () => pool(tasks, concurrency);
  const records = userId ? await runInContext(call, { id: userId }) : await call();

  const stamp = startedAt.replace(/[:.]/g, '-');
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `research_eval_${stamp}.json`);
  const mdPath = path.join(outDir, `research_eval_${stamp}.md`);
  writeFileSync(
    jsonPath,
    JSON.stringify({ startedAt, fixturesPath, model, judgeModel, engines, records }, null, 2),
  );
  writeFileSync(mdPath, renderReport({ records, fixturesPath, judgeModel, model, startedAt }));
  console.log(`\n${jsonPath}\n${mdPath}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
