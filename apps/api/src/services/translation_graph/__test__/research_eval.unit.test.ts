// The comparison harness's own arithmetic and rendering.
//
// The harness is a measuring instrument, so the parts that could quietly lie
// about the result are the ones worth testing: what it reads out of a fixture
// file, what it charges a run, and what the table says happened. The engines
// and the judge are mocked away entirely — they are what is being measured,
// not what is under test here.
//
// Contract: plans/research-plugin-2026-09-10/1_contract.md

// The harness's composition root and its tenant lookup reach the database and
// every registered service; the pure functions below need none of it.
jest.mock('../../../services', () => ({}));
jest.mock('../../../scripts/dev/_profile_loader', () => ({}));
jest.mock('../engine/transforms/register-bundled', () => ({}));
jest.mock('../../../scripts/dev/_lib', () => ({ ensureDevLoopTeam: jest.fn() }));
jest.mock('../../context/utils', () => ({ runInContext: jest.fn() }));

// The two things being compared, stood down — but NOT the note reader. Which
// records carry usable numbers is the contract between an engine and this
// table, and a stubbed contract makes the table test prove nothing, so the
// real one is required from the module that defines it. That module reaches
// the scraper for an error formatter it never calls here, which is the only
// reason the fetch plumbing is stood down too.
jest.mock('../engine/transforms/fetch_resource', () => ({ describeError: String }));
jest.mock('../engine/transforms/research', () => ({
  research: jest.fn(),
  usageWasNotMeasured: jest.requireActual('@lf/web/research/contract')
    .usageWasNotMeasured,
}));
jest.mock('../../../lib/anthropic', () => ({ anthropicChatStructured: jest.fn() }));

import { mkdtempSync, rmSync, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Judgement, RunRecord } from '../../../scripts/dev/eval_research';
import type { ResearchUsage } from '../engine/transforms/research';

import {
  compressVerdicts,
  mergeRecords,
  parseFixtures,
  priceRun,
  renderReport,
  sameSite,
  selectFixtures,
} from '../../../scripts/dev/eval_research';

const usage = (over: Partial<ResearchUsage> = {}): ResearchUsage => ({
  modelCalls: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  searches: 0,
  fetches: 0,
  wallClockMs: 1000,
  ...over,
});

const judgement = (over: Partial<Judgement> = {}): Judgement => ({
  questions: [
    { question: 'what it does', verdict: 'answered', reason: 'stated and cited' },
    { question: 'which sector', verdict: 'partly', reason: 'implied only' },
  ],
  dossier_relevance: 4,
  summary_form: 'answers',
  summary_note: 'answers throughout',
  expect_outcome: 'not_applicable',
  expect_website: 'not_applicable',
  expect_note: 'nothing expected',
  ...over,
});

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'larkfield',
  name: 'Larkfield',
  engine: 'constrained',
  outcome: 'resolved',
  confidence: 'high',
  summary: 'Larkfield builds canteen ordering software.',
  usage: usage(),
  cost: { modelUsd: 0.01, searchUsd: 0, totalUsd: 0.01 },
  expectOutcome: 'not_applicable',
  expectWebsite: 'not_applicable',
  judgement: judgement(),
  ...over,
});

describe('reading the fixture file', () => {
  it('takes a bare array or an entries object', () => {
    const entry = { id: 'a', name: 'A', questions: 'what it does' };
    expect(parseFixtures([entry])).toHaveLength(1);
    expect(parseFixtures({ entries: [entry] })).toHaveLength(1);
  });

  it('refuses two entries with the same id, because a row is its id', () => {
    const entry = { id: 'a', name: 'A', questions: 'what it does' };
    expect(() => parseFixtures([entry, { ...entry, name: 'B' }])).toThrow(/Duplicate fixture id/);
  });

  it('takes an entry that carries an address and no name', () => {
    const [entry] = parseFixtures([
      { id: 'a-profile', name: '', linkedin: 'https://www.linkedin.com/in/someone', questions: 'q' },
    ]);
    expect(entry.name).toBe('');
  });

  it('refuses an expectation that is not an outcome the contract has', () => {
    expect(() =>
      parseFixtures([{ id: 'a', name: 'A', questions: 'q', expect: { outcome: 'refused' } }]),
    ).toThrow();
  });
});

describe('picking fixtures for --only', () => {
  const larkfield = { id: 'larkfield', name: 'Larkfield', questions: 'what it does' };
  const larkfieldSiteOnly = { id: 'larkfield-site-only', name: 'Larkfield', questions: 'what it does' };
  const marlow = { id: 'marlow', name: 'Marlow', questions: 'what it does' };
  const all = parseFixtures([larkfield, larkfieldSiteOnly, marlow]);

  it('matches the fixture id exactly, never a shared name', () => {
    expect(selectFixtures(all, 'larkfield').map((f) => f.id)).toEqual(['larkfield']);
  });

  it('takes a comma-separated list of ids', () => {
    expect(selectFixtures(all, 'larkfield,marlow').map((f) => f.id)).toEqual(['larkfield', 'marlow']);
  });

  it('matches nothing when the id is not one a fixture has', () => {
    expect(selectFixtures(all, 'nope')).toEqual([]);
  });
});

describe('what a run cost', () => {
  it('charges cached tokens at their own multiple of the input rate', () => {
    // 1M in, 1M out, 1M cache-written, 1M cache-read on Sonnet 5:
    // 2 + 10 + 2*1.25 + 2*0.1 = $14.70
    const { totalUsd } = priceRun({
      engine: 'constrained',
      model: 'claude-sonnet-5',
      usage: usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    });
    expect(totalUsd).toBeCloseTo(14.7, 6);
  });

  it('bills searches only on the engine whose searches Anthropic runs', () => {
    const six = usage({ searches: 6 });
    expect(priceRun({ engine: 'agentic', model: 'claude-sonnet-5', usage: six }).searchUsd).toBeCloseTo(
      0.06,
      6,
    );
    // The constrained engine searches Google Custom Search, which this
    // comparison counts and does not price.
    expect(
      priceRun({ engine: 'constrained', model: 'claude-sonnet-5', usage: six }).searchUsd,
    ).toBe(0);
  });

  it('charges nothing rather than guessing when the model is not in the table', () => {
    expect(
      priceRun({ engine: 'constrained', model: 'some-new-model', usage: usage({ inputTokens: 1e6 }) })
        .modelUsd,
    ).toBe(0);
  });
});

describe('comparing an address to the one that was expected', () => {
  it('ignores scheme, www and a trailing slash', () => {
    expect(sameSite('https://www.larkfield.example/', 'http://larkfield.example')).toBe(true);
  });

  it('does not call a different host a match', () => {
    expect(sameSite('https://larkfield.example', 'https://larkfield.dk')).toBe(false);
    expect(sameSite(undefined, 'https://larkfield.example')).toBe(false);
  });
});

describe('compressing the verdicts', () => {
  it('is one letter per question, in the order asked', () => {
    expect(
      compressVerdicts(
        judgement({
          questions: [
            { question: 'a', verdict: 'answered', reason: '' },
            { question: 'b', verdict: 'partly', reason: '' },
            { question: 'c', verdict: 'not_answered', reason: '' },
            { question: 'd', verdict: 'wrong', reason: '' },
          ],
        }),
      ),
    ).toBe('A P N W');
  });

  it('says so rather than reading as a pass when there is no verdict', () => {
    expect(compressVerdicts(null)).toBe('—');
  });
});

describe('the report', () => {
  const report = renderReport({
    fixturesPath: '/elsewhere/research_fixtures.json',
    judgeModel: 'claude-opus-5',
    model: 'claude-sonnet-5',
    startedAt: '2026-09-10T10:00:00.000Z',
    records: [
      record({ engine: 'constrained', usage: usage({ wallClockMs: 20_000, searches: 3, fetches: 2 }) }),
      record({
        engine: 'agentic',
        usage: usage({ wallClockMs: 40_000, searches: 5, fetches: 3 }),
        cost: { modelUsd: 0.08, searchUsd: 0.05, totalUsd: 0.13 },
        judgement: judgement({
          summary_form: 'verifies',
          summary_note: 'opens "Larkfield checks out as the subject described"',
          questions: [
            { question: 'what it does', verdict: 'wrong', reason: 'describes a US namesake' },
            { question: 'which sector', verdict: 'answered', reason: 'stated' },
          ],
        }),
      }),
      record({
        id: 'marlow',
        name: 'Marlow',
        engine: 'constrained',
        outcome: 'no_anchor',
        summary: undefined,
        expectOutcome: 'match',
        // The judge runs on a refusal too, and with nothing in front of it it
        // reads the absence as a summary that reports rather than answers.
        judgement: judgement({
          summary_form: 'verifies',
          summary_note: 'nothing was returned at all',
          questions: [
            { question: 'what it does', verdict: 'not_answered', reason: 'nothing returned' },
            { question: 'which sector', verdict: 'not_answered', reason: 'nothing returned' },
            { question: 'where based', verdict: 'not_answered', reason: 'nothing returned' },
            { question: 'stage', verdict: 'not_answered', reason: 'nothing returned' },
          ],
        }),
      }),
    ],
  });

  it('gives each engine its own table and both a head-to-head row', () => {
    expect(report).toContain('## constrained');
    expect(report).toContain('## agentic');
    expect(report).toContain('| Larkfield | resolved · A P | resolved · W A |');
  });

  it('names the faster engine per entry', () => {
    expect(report).toMatch(/\| Larkfield \|.*\| \$0\.0100 \| \$0\.1300 \| constrained \|/);
  });

  it('carries the verification-versus-answer call and every wrong verdict into the notes', () => {
    expect(report).toContain('summary verifies: opens "Larkfield checks out as the subject described"');
    expect(report).toContain('WRONG on "what it does": describes a US namesake');
  });

  it('does not call an entry that returned nothing a badly shaped summary', () => {
    expect(report).not.toContain('Marlow · constrained** — summary');
  });

  it('totals each engine over its own rows', () => {
    // constrained: two entries, one resolved, 1 of the 6 questions the two
    // entries asked between them, (20s + 1s) / 2 mean wall clock, $0.02.
    expect(report).toContain('| constrained | 2 | 1 | 1/6 | 10.5s | $0.0200 |');
    expect(report).toContain('| agentic | 1 | 1 | 1/2 | 40.0s | $0.1300 |');
  });

  it('shows an expectation that was met', () => {
    expect(report).toMatch(/\| Marlow \| no_anchor \| outcome yes \|/);
  });
});

// An entry the wall clock aborted comes back with zeroes for everything the
// usage row would have carried. Printed as figures, the slowest row of the
// run is also its cheapest, and there is nothing in the table to catch it.
describe('an entry whose usage was never measured', () => {
  const report = renderReport({
    fixturesPath: '/elsewhere/research_fixtures.json',
    judgeModel: 'claude-opus-5',
    model: 'claude-sonnet-5',
    startedAt: '2026-09-10T10:00:00.000Z',
    records: [
      record({
        id: 'wayfarer',
        name: 'Wayfarer',
        engine: 'agentic',
        outcome: 'no_match',
        summary: undefined,
        usage: usage({
          wallClockMs: 180_000,
          modelCalls: 0,
          notes: ['timed out after 180s', 'usage not measured (aborted)'],
        }),
        cost: { modelUsd: 0, searchUsd: 0, totalUsd: 0 },
      }),
    ],
  });

  it('says n/a rather than $0.0000, and says the same of its tool counts', () => {
    expect(report).toContain('| Wayfarer | no_match | — | ');
    expect(report).toContain('| 180.0s | n/a | n/a |');
    // The entry's own row carries no figure at all — only the engine total
    // below it, which says outright how many rows it is missing.
    expect(report).not.toMatch(/\| Wayfarer \|.*\$/);
  });

  it('says how many rows the engine total is missing', () => {
    expect(report).toContain('$0.0000 (1 not measured)');
  });
});

describe('merging per-entry runs', () => {
  // `--only <id>` writes one `research_eval_*.json` per entry (the same
  // shape `main()` writes for a full run); merging is what turns a stack of
  // those back into one comparison without spending anything again.
  function persistedFile(dir: string, name: string, over: {
    startedAt: string;
    records: RunRecord[];
  }) {
    writeFile(
      path.join(dir, name),
      JSON.stringify({
        fixturesPath: '/elsewhere/research_fixtures.json',
        model: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5',
        engines: [...new Set(over.records.map((r) => r.engine))],
        ...over,
      }),
    );
  }

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'research-eval-merge-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('unions the records of every file in the directory', () => {
    persistedFile(dir, 'research_eval_larkfield.json', {
      startedAt: '2026-09-10T10:00:00.000Z',
      records: [record({ id: 'larkfield', engine: 'constrained' })],
    });
    persistedFile(dir, 'research_eval_donna.json', {
      startedAt: '2026-09-10T10:05:00.000Z',
      records: [record({ id: 'marlow', name: 'Marlow', engine: 'agentic', outcome: 'no_anchor' })],
    });

    const merged = mergeRecords(dir);

    expect(merged.records.map((r) => r.id).sort()).toEqual(['larkfield', 'marlow']);
    // The round began when the first entry ran, not when the merge happened.
    expect(merged.startedAt).toBe('2026-09-10T10:00:00.000Z');
  });

  it('keeps the newer record when the same entry and engine was run twice', () => {
    persistedFile(dir, 'research_eval_larkfield_a.json', {
      startedAt: '2026-09-10T10:00:00.000Z',
      records: [record({ id: 'larkfield', engine: 'constrained', outcome: 'fetch_failed' })],
    });
    persistedFile(dir, 'research_eval_larkfield_b.json', {
      startedAt: '2026-09-10T10:10:00.000Z',
      records: [record({ id: 'larkfield', engine: 'constrained', outcome: 'resolved' })],
    });

    const merged = mergeRecords(dir);

    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].outcome).toBe('resolved');
  });

  it('ignores files that are not a research_eval JSON dump', () => {
    writeFile(path.join(dir, 'notes.txt'), 'not json');
    persistedFile(dir, 'research_eval_larkfield.json', {
      startedAt: '2026-09-10T10:00:00.000Z',
      records: [record({ id: 'larkfield', engine: 'constrained' })],
    });

    expect(mergeRecords(dir).records).toHaveLength(1);
  });

  it('refuses an empty directory rather than rendering an empty report', () => {
    expect(() => mergeRecords(dir)).toThrow(/No research_eval_\*\.json files/);
  });
});
