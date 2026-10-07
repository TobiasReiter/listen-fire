// Entity-resolution arbiter coverage. `arbitrateEntityCandidates` /
// `judgeEntityMatch` (engine/entity_match.ts) decide, on EVERY write that
// returns >1 candidate, whether to merge into an existing record or create a
// new one. A regression here = silent duplicate or wrong-merged records — yet
// the only test reaching this code (movement_engine/run.unit) mocks the LLM
// AND injects fakes that always agree, so the decision logic itself was never
// exercised. This drives every branch by mocking only the LLM `execute` call
// and using the REAL exactness arbitration (`candidateIsAllExact`).

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import { execute } from '../../../../lib/prompts/execute';
import { askJev } from '../../../../lib/jev/client';
import type { ExternalRecordRef } from '../../adapter';
import type { UniquenessConstraints } from '../../uniqueness';
import { arbitrateEntityCandidates, judgeEntityMatch, JUDGE_MODEL } from '../entity_match';

// Mock ONLY the LLM call. entity_match imports just `execute` from this module.
jest.mock('../../../../lib/prompts/execute', () => ({
  execute: jest.fn(),
}));

// Mock ONLY the network call — `assertJevConfigured`/`jevEntityResolutionEnabled`
// stay real so the loud-misconfiguration path is exercised, not stubbed away.
jest.mock('../../../../lib/jev/client', () => {
  const actual = jest.requireActual('../../../../lib/jev/client');
  return { ...actual, askJev: jest.fn() };
});

const mockExecute = execute as jest.MockedFunction<typeof execute>;
const mockAskJev = askJev as jest.MockedFunction<typeof askJev>;

/** Build a candidate with a flat field bag. */
function ref(data: Record<string, unknown>, externalId = 'rec'): ExternalRecordRef {
  return { adapterType: 'attio', externalId, recordType: 'attio:companies', data };
}

/** Shape the judge returns (validator: {match_index, confidence, reasoning}). */
function judged(match_index: number | null, confidence: number) {
  return { match_index, confidence, reasoning: 'test' } as never;
}

/** Shape `askJev` returns for the per-candidate `same_cI`/`evid_cI` noul
 *  questions the Jev judge asks — one entry per candidate option (e.g. `c0`). */
function jevScores(scores: Record<string, { same: number; evidence: number }>) {
  const answers: Record<string, { type: 'noul'; noul: number }> = {};
  for (const [option, { same, evidence }] of Object.entries(scores)) {
    answers[`same_${option}`] = { type: 'noul', noul: same };
    answers[`evid_${option}`] = { type: 'noul', noul: evidence };
  }
  return answers;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockExecute.mockReset();
  mockAskJev.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('the judge runs on a Claude model', () => {
  it('names a claude- model, so a deployment with only ANTHROPIC_API_KEY can still judge', () => {
    // Self-hosted deployments document ANTHROPIC_API_KEY only (no OpenAI key).
    // `execute()` only routes to Anthropic when the prompt definition's
    // `model` starts with 'claude-' — anything else silently needs
    // OPENAI_API_KEY and every ambiguous FUZZY write fails closed into a
    // duplicate create.
    expect(JUDGE_MODEL.startsWith('claude-')).toBe(true);
  });
});

describe('judgeEntityMatch — structural short-circuits (no LLM)', () => {
  it('returns null for 0 candidates without calling the LLM', async () => {
    const out = await judgeEntityMatch({ asserted: { name: 'A' }, candidates: [], recordType: 'co' });
    expect(out).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('calls the LLM for exactly 1 candidate — a lone candidate is not unambiguous by definition', async () => {
    // The 2026-09 incident this guards: two different companies ("OriqX" and
    // "Pavo AI") each surfaced exactly one FUZZY candidate and were merged
    // without ever reaching a judge.
    mockExecute.mockResolvedValue(judged(0, 0.9));
    const out = await judgeEntityMatch({
      asserted: { name: 'A' },
      candidates: [ref({ name: 'A' })],
      recordType: 'co',
    });
    expect(out).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

describe('judgeEntityMatch — LLM decision gating', () => {
  const twoCandidates = [ref({ name: 'Acme' }, 'a'), ref({ name: 'Acme Corp' }, 'b')];

  it('returns the matched index when confidence ≥ 0.5', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.9));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBe(1);
  });

  it('declines (null) when confidence is below 0.5 — the conservative cutoff', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.49));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('returns null when the judge picks no match (match_index null)', async () => {
    mockExecute.mockResolvedValue(judged(null, 0.99));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('returns null when the judge returns an out-of-range index (guards a bad LLM reply)', async () => {
    mockExecute.mockResolvedValue(judged(5, 0.99));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('returns null for a negative index', async () => {
    mockExecute.mockResolvedValue(judged(-1, 0.99));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('declines to merge (null) when the LLM call throws — never errors the write', async () => {
    mockExecute.mockRejectedValue(new Error('anthropic 529'));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('reports a THROWN judge via onJudgeUnavailable, distinct from a considered decline', async () => {
    mockExecute.mockRejectedValue(new Error('anthropic 529'));
    const onJudgeUnavailable = jest.fn();
    const out = await judgeEntityMatch({
      asserted: { name: 'Acme' },
      candidates: twoCandidates,
      recordType: 'co',
      onJudgeUnavailable,
    });
    expect(out).toBeNull();
    expect(onJudgeUnavailable).toHaveBeenCalledTimes(1);
    expect(onJudgeUnavailable).toHaveBeenCalledWith('anthropic 529');
  });

  it('does NOT call onJudgeUnavailable when the judge answers but declines (low confidence)', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.1));
    const onJudgeUnavailable = jest.fn();
    const out = await judgeEntityMatch({
      asserted: { name: 'Acme' },
      candidates: twoCandidates,
      recordType: 'co',
      onJudgeUnavailable,
    });
    expect(out).toBeNull();
    expect(onJudgeUnavailable).not.toHaveBeenCalled();
  });
});

describe('judgeEntityMatch — prompt construction', () => {
  it('formats the asserted record (skips null/undefined/empty, JSON-encodes objects) and indexes candidates', async () => {
    mockExecute.mockResolvedValue(judged(0, 0.9));
    await judgeEntityMatch({
      asserted: { name: 'Acme', domains: ['acme.com'], blank: '', missing: null, owner: { id: 7 } },
      candidates: [ref({ name: 'Acme' }, 'a'), ref({ name: 'Acme Corp' }, 'b')],
      recordType: 'company',
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const args = mockExecute.mock.calls[0][2] as { recordType: string; asserted: string; candidates: string };
    expect(args.recordType).toBe('company');
    expect(args.asserted).toContain('- name: Acme');
    expect(args.asserted).toContain('- domains: ["acme.com"]');
    expect(args.asserted).toContain('- owner: {"id":7}');
    expect(args.asserted).not.toContain('blank');
    expect(args.asserted).not.toContain('missing');
    expect(args.candidates).toContain('[Candidate 0]');
    expect(args.candidates).toContain('[Candidate 1]');
  });
});

describe('arbitrateEntityCandidates — exactness before the LLM', () => {
  const constraintsOn = (field: string, fuzzy = false): UniquenessConstraints => ({
    any: [{ all: [{ field, ...(fuzzy ? { fuzzy: true } : {}) }] }],
  });

  it('returns null for 0 candidates (create) without the LLM', async () => {
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(out).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 0 for a single ALL-EXACT candidate without the LLM', async () => {
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'acme.com' })],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(out).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('sends a single FUZZY candidate to the judge — a lone fuzzy candidate is not unambiguous', async () => {
    // The prod incident this guards: "OriqX"/oriqx.com and "Pavo AI"/pavoai.com
    // each turned up exactly one FUZZY candidate and got merged, because the
    // old shortcut treated "1 candidate" as "unambiguous" regardless of
    // exactness. A decline here is the safe outcome — a create, not a merge.
    mockExecute.mockResolvedValue(judged(null, 0.99));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'other.com' }, 'a')],
      recordType: 'co',
      constraints: constraintsOn('domain', true),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBeNull();
  });

  it('matches a single candidate without the judge when there are NO uniqueness constraints at all', async () => {
    // `candidateIsAllExact` over `{ any: [] }` is `[].some(...)` — vacuously
    // false — but `{ any: [] }` also has no branch to carry a fuzzy entry,
    // so an unconstrained write with exactly one candidate matches it
    // directly (the pre-existing unconstrained-write behaviour), same as
    // before the May-2026 split ever added a judge call here.
    mockExecute.mockRejectedValue(new Error('LLM must not be called'));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'acme.com' }, 'a')],
      recordType: 'co',
      constraints: { any: [] },
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(out).toBe(0);
  });

  it('matches a lone candidate under an EXACT-only constraint the engine cannot verify — an edge-named identity', async () => {
    // The 2026-09-17 regression this guards: a constraint naming a parent
    // EDGE (e.g. Affinity's list-entry identity, `unique by (company)`) is
    // folded into the adapter's SEARCH record but never into the write's
    // own asserted fields, so `candidateIsAllExact` can never confirm it —
    // yet the constraint has no fuzzy entry, so the adapter's search was
    // exact. Routing this to the judge on every such write would burn an
    // LLM call the judge can't even answer correctly (it never sees the
    // parent) and risks a declined judge minting a duplicate.
    mockExecute.mockRejectedValue(new Error('LLM must not be called'));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { name: 'U123' },
      candidates: [ref({ company: { id: 'ext-attio-1' } }, 'a')],
      recordType: 'co',
      constraints: constraintsOn('company'),
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(out).toBe(0);
  });

  it('sends a lone candidate under a FUZZY constraint to the judge even though nothing is exact', async () => {
    // Same case as "sends a single FUZZY candidate to the judge" above,
    // named to match the brief's new-behaviour checklist: a fuzzy branch
    // never counts as "no fuzzy entry", so the exact-only bypass never
    // applies and the lone candidate still reaches the judge.
    mockExecute.mockResolvedValue(judged(null, 0.99));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'other.com' }, 'a')],
      recordType: 'co',
      constraints: constraintsOn('domain', true),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBeNull();
  });

  it('auto-matches the single all-exact candidate WITHOUT calling the LLM', async () => {
    mockExecute.mockRejectedValue(new Error('LLM must not be called'));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'other.com' }, 'a'), ref({ domain: 'acme.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(out).toBe(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('falls through to the LLM judge when MORE THAN ONE candidate is all-exact (ambiguous)', async () => {
    mockExecute.mockResolvedValue(judged(0, 0.8));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'acme.com' }, 'a'), ref({ domain: 'acme.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBe(0);
  });

  it('falls through to the LLM judge when NO candidate is all-exact', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.7));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'x.com' }, 'a'), ref({ domain: 'y.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBe(1);
  });

  it('a FUZZY field whose values are equal outright is exact — the one exact candidate wins without the judge', async () => {
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { name: 'Pavo AI' },
      candidates: [ref({ name: 'pavo ai' }, 'a'), ref({ name: 'Pavo AI Labs' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('name', true),
    });
    expect(out).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('a lone FUZZY candidate with the identical name matches without the judge', async () => {
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { name: 'Pavo AI' },
      candidates: [ref({ name: 'Pavo AI' }, 'a')],
      recordType: 'co',
      constraints: constraintsOn('name', true),
    });
    expect(out).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('two FUZZY candidates both equal outright are ambiguous — the judge decides', async () => {
    mockExecute.mockResolvedValue(judged(null, 0.9));
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { name: 'Pavo AI' },
      candidates: [ref({ name: 'Pavo AI' }, 'a'), ref({ name: 'PAVO AI' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('name', true),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBeNull();
  });

  it('forwards onJudgeUnavailable through to the LLM judge on a throw', async () => {
    mockExecute.mockRejectedValue(new Error('anthropic 529'));
    const onJudgeUnavailable = jest.fn();
    const out = await arbitrateEntityCandidates({
      languageVersion: CURRENT_LANGUAGE_VERSION,
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'x.com' }, 'a'), ref({ domain: 'y.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
      onJudgeUnavailable,
    });
    expect(out).toBeNull();
    expect(onJudgeUnavailable).toHaveBeenCalledWith('anthropic 529');
  });
});

describe('judgeEntityMatch — routed through Jev when JEV_ENTITY_RESOLUTION=true', () => {
  const oneCandidate = [ref({ name: 'Acme Inc' }, 'a')];
  const twoCandidates = [ref({ name: 'Acme Inc' }, 'a'), ref({ name: 'Acme Corp' }, 'b')];

  it('picks the candidate when both `same` and `evidence` clear their thresholds', async () => {
    process.env.JEV_ENTITY_RESOLUTION = 'true';
    process.env.JEV_KEY = 'jev-test-key';
    mockAskJev.mockResolvedValue(jevScores({ c0: { same: 0.9, evidence: 0.8 } }));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: oneCandidate, recordType: 'co' });
    expect(out).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('declines when `same` is below the bar even with strong evidence', async () => {
    process.env.JEV_ENTITY_RESOLUTION = 'true';
    process.env.JEV_KEY = 'jev-test-key';
    mockAskJev.mockResolvedValue(jevScores({ c0: { same: 0.6, evidence: 0.9 } }));
    const out = await judgeEntityMatch({
      asserted: { name: 'Pavo AI' },
      candidates: [ref({ name: 'OriqX' }, 'a')],
      recordType: 'co',
    });
    expect(out).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('declines when `same` clears the bar but `evidence` is below 0.5 — a name-only match', async () => {
    process.env.JEV_ENTITY_RESOLUTION = 'true';
    process.env.JEV_KEY = 'jev-test-key';
    mockAskJev.mockResolvedValue(jevScores({ c0: { same: 0.9, evidence: 0.3 } }));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: oneCandidate, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('picks the candidate with the higher `same` among two', async () => {
    process.env.JEV_ENTITY_RESOLUTION = 'true';
    process.env.JEV_KEY = 'jev-test-key';
    mockAskJev.mockResolvedValue(
      jevScores({ c0: { same: 0.7, evidence: 0.9 }, c1: { same: 0.85, evidence: 0.9 } }),
    );
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBe(1);
  });

  it('falls back to the generative judge when Jev fails', async () => {
    process.env.JEV_ENTITY_RESOLUTION = 'true';
    process.env.JEV_KEY = 'jev-test-key';
    mockAskJev.mockRejectedValue(new Error('jev 529'));
    mockExecute.mockResolvedValue(judged(0, 0.9));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: oneCandidate, recordType: 'co' });
    expect(out).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('is loud when the flag is on with no key — never reads as a decline', async () => {
    process.env.JEV_ENTITY_RESOLUTION = 'true';
    delete process.env.JEV_KEY;
    const onJudgeUnavailable = jest.fn();
    await expect(
      judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: oneCandidate, recordType: 'co', onJudgeUnavailable }),
    ).rejects.toThrow(/JEV_KEY/);
    expect(onJudgeUnavailable).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockAskJev).not.toHaveBeenCalled();
  });
});
