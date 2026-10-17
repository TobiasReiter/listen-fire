// Replay of recorded identity-judge cases. The fixture was recorded from the
// judge as it stood in apps/api before it moved into the movement-engine
// package: each case holds the inputs, what the model and Jev answered, and
// everything the judge did in return (decision, prompts sent, Jev requests,
// failures reported). Replaying gives identical decisions AND identical
// prompts, so a prompt edit or a changed decision rule shows up as a diff
// here. Re-record with RECORD_IDENTITY_JUDGE=1 only when a change is meant.

import fs from 'node:fs';
import path from 'node:path';

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import { BudgetExhausted } from 'movement-engine/lib/run_cost';
import type { ExternalRecordRef } from 'movement-engine/services/translation_graph/adapter';
import type { UniquenessConstraints } from 'movement-engine/services/translation_graph/uniqueness';

import { execute } from '../../../../lib/prompts/execute';
import { askJev, JevConfigurationError, JevRequestError } from '../../../../lib/jev/client';
import { arbitrateEntityCandidates, judgeEntityMatch, meteredArbitration } from '../entity_match';

jest.mock('../../../../lib/prompts/execute', () => ({ execute: jest.fn() }));
jest.mock('../../../../lib/jev/client', () => {
  const actual = jest.requireActual('../../../../lib/jev/client');
  return { ...actual, askJev: jest.fn() };
});

const mockExecute = execute as jest.MockedFunction<typeof execute>;
const mockAskJev = askJev as jest.MockedFunction<typeof askJev>;

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../../../../packages/movement-engine/services/identity_judge/__fixtures__/replay.json',
);

type Scripted =
  | { returns: unknown }
  | { throws: string }
  | { throwsBudgetExhausted: true }
  | { throwsJevConfiguration: string }
  | { throwsJevRequest: string };

interface ReplayCase {
  name: string;
  env: Record<string, string>;
  operation: 'judge' | 'arbitrate' | 'metered';
  input: {
    asserted: Record<string, unknown>;
    candidates: ExternalRecordRef[];
    recordType: string;
    constraints?: UniquenessConstraints;
  };
  model: Scripted[];
  jev: Scripted[];
  expected?: Observed;
}

interface Observed {
  outcome: { result: unknown } | { threw: string };
  modelCalls: { name: string; model: unknown; system: string; user: string }[];
  jevCalls: { state: unknown; questions: unknown; label: unknown }[];
  unavailable: string[];
}

function ref(data: Record<string, unknown>, externalId = 'rec'): ExternalRecordRef {
  return { adapterType: 'attio', externalId, recordType: 'attio:companies', data };
}

function play(script: Scripted[]): (...args: never[]) => Promise<unknown> {
  let next = 0;
  return async () => {
    const step = script[next++];
    if (step === undefined) throw new Error('replay script exhausted');
    if ('returns' in step) return step.returns;
    if ('throws' in step) throw new Error(step.throws);
    if ('throwsBudgetExhausted' in step) throw new BudgetExhausted([]);
    if ('throwsJevConfiguration' in step) throw new JevConfigurationError(step.throwsJevConfiguration);
    throw new JevRequestError(step.throwsJevRequest);
  };
}

const render = (content: unknown, args: Record<string, string>) =>
  typeof content === 'string'
    ? content.replace(/{{{([^}]+)}}}/g, (_, key: string) => (key in args ? args[key] : ''))
    : '';

async function observe(replayCase: ReplayCase): Promise<Observed> {
  const saved = { ...process.env };
  for (const key of ['JEV_ENTITY_RESOLUTION', 'JEV_KEY']) delete process.env[key];
  Object.assign(process.env, replayCase.env);

  const modelCalls: Observed['modelCalls'] = [];
  const jevCalls: Observed['jevCalls'] = [];
  const unavailable: string[] = [];
  const scriptedModel = play(replayCase.model);
  const scriptedJev = play(replayCase.jev);
  mockExecute.mockReset();
  mockAskJev.mockReset();
  mockExecute.mockImplementation((async (name: string, def: { model?: unknown; messages: { role: string; content?: unknown }[] }, args: Record<string, string>) => {
    modelCalls.push({
      name,
      model: def.model,
      system: render(def.messages.find((m) => m.role === 'system')?.content, args),
      user: render(def.messages.find((m) => m.role === 'user')?.content, args),
    });
    return scriptedModel();
  }) as never);
  mockAskJev.mockImplementation((async (input: { state: unknown; questions: unknown }, options: { label?: unknown }) => {
    jevCalls.push({ state: input.state, questions: input.questions, label: options.label });
    return scriptedJev();
  }) as never);

  try {
    const { asserted, candidates, recordType, constraints = { any: [] } } = replayCase.input;
    const onJudgeUnavailable = (message: string) => unavailable.push(message);
    let result: unknown;
    switch (replayCase.operation) {
      case 'judge':
        result = await judgeEntityMatch({ asserted, candidates, recordType, onJudgeUnavailable });
        break;
      case 'arbitrate':
        result = await arbitrateEntityCandidates({
          asserted,
          candidates,
          recordType,
          constraints,
          languageVersion: CURRENT_LANGUAGE_VERSION,
          onJudgeUnavailable,
        });
        break;
      case 'metered':
        result = await meteredArbitration({
          asserted,
          candidates,
          recordType,
          constraints,
          languageVersion: CURRENT_LANGUAGE_VERSION,
          budget: { remainingMicrodollars: null },
        });
        break;
    }
    return { outcome: { result }, modelCalls, jevCalls, unavailable };
  } catch (err) {
    const threw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { outcome: { threw }, modelCalls, jevCalls, unavailable };
  } finally {
    process.env = saved;
  }
}

// ── Case generation (only used to record) ──────────────────────────────────

function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['Acme', 'Acme Corp', 'Acme Corporation', 'Pavo AI', 'OriqX', 'Globex', 'Initech', 'Umbrella Ltd'];
const DOMAINS = ['acme.com', 'pavoai.com', 'oriqx.com', 'globex.io', 'initech.net'];
const EXTRAS: Record<string, unknown>[] = [
  {},
  { employer: 'Acme', title: 'CTO' },
  { linkedin: 'https://linkedin.com/in/x', email: 'a@acme.com' },
  { tags: ['a', 'b'], owner: { id: 7 } },
  { note: 'multi\nline {{{recordType}}} braces', blank: '', missing: null },
  { count: 0, flag: false },
  { name: 'Ünïcode 名前 ☃' },
];

function generatedCases(): ReplayCase[] {
  const rnd = prng(20261017);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const cases: ReplayCase[] = [];
  const confidences = [0, 0.1, 0.49, 0.5, 0.51, 0.9, 1];
  const scores = [0, 0.2, 0.49, 0.5, 0.69, 0.7, 0.71, 0.95, 1];
  for (let i = 0; i < 60; i++) {
    const candidateCount = 1 + Math.floor(rnd() * 5);
    const candidates = Array.from({ length: candidateCount }, (_, c) =>
      ref({ name: pick(NAMES), domain: pick(DOMAINS), ...pick(EXTRAS) }, `c${c}`),
    );
    const input = {
      asserted: { name: pick(NAMES), domain: pick(DOMAINS), ...pick(EXTRAS) },
      candidates,
      recordType: pick(['company', 'person', 'attio:people', 'Deal {x}']),
    };
    if (i % 2 === 0) {
      const matchIndex = rnd() < 0.2 ? null : Math.floor(rnd() * (candidateCount + 2)) - 1;
      cases.push({
        name: `generated generative ${i}`,
        env: {},
        operation: 'judge',
        input,
        model: [{ returns: { match_index: matchIndex, confidence: pick(confidences), reasoning: `r${i}` } }],
        jev: [],
      });
    } else {
      const answers: Record<string, unknown> = {};
      candidates.forEach((_, c) => {
        answers[`same_c${c}`] = { type: 'noul', noul: pick(scores) };
        answers[`evid_c${c}`] = { type: 'noul', noul: pick(scores) };
      });
      cases.push({
        name: `generated jev ${i}`,
        env: { JEV_ENTITY_RESOLUTION: 'true', JEV_KEY: 'k' },
        operation: 'judge',
        input,
        model: [],
        jev: [{ returns: answers }],
      });
    }
  }
  return cases;
}

function handCases(): ReplayCase[] {
  const two = [ref({ name: 'Acme', domain: 'acme.com' }, 'a'), ref({ name: 'Acme Corp', domain: 'acme.io' }, 'b')];
  const asserted = { name: 'Acme', domain: 'acme.com' };
  const verdict = (match_index: number | null, confidence: number) => ({
    returns: { match_index, confidence, reasoning: 'hand' },
  });
  const jev = { JEV_ENTITY_RESOLUTION: 'true', JEV_KEY: 'k' };
  const jevAnswers = (rows: [number, number][]) =>
    Object.fromEntries(
      rows.flatMap(([same, evid], c) => [
        [`same_c${c}`, { type: 'noul', noul: same }],
        [`evid_c${c}`, { type: 'noul', noul: evid }],
      ]),
    );
  const forty1 = Array.from({ length: 41 }, (_, c) => ref({ name: `N${c}` }, `r${c}`));
  const forty = forty1.slice(0, 40);
  const base = { asserted, candidates: two, recordType: 'company' };
  return [
    { name: 'no candidates', env: {}, operation: 'judge', input: { ...base, candidates: [] }, model: [], jev: [] },
    { name: 'lone candidate is judged', env: {}, operation: 'judge', input: { ...base, candidates: [two[0]] }, model: [verdict(0, 0.9)], jev: [] },
    { name: 'model throws: declines and reports', env: {}, operation: 'judge', input: base, model: [{ throws: 'anthropic 529' }], jev: [] },
    { name: 'model budget exhausted rethrows', env: {}, operation: 'judge', input: base, model: [{ throwsBudgetExhausted: true }], jev: [] },
    { name: 'jev budget exhausted rethrows', env: jev, operation: 'judge', input: base, model: [], jev: [{ throwsBudgetExhausted: true }] },
    { name: 'jev request failure falls back to the model', env: jev, operation: 'judge', input: base, model: [verdict(1, 0.8)], jev: [{ throwsJevRequest: 'Jev 400' }] },
    { name: 'jev plain error falls back to the model', env: jev, operation: 'judge', input: base, model: [verdict(null, 0.8)], jev: [{ throws: 'socket hang up' }] },
    { name: 'jev fallback and model also throws', env: jev, operation: 'judge', input: base, model: [{ throws: 'down' }], jev: [{ throwsJevRequest: 'x' }] },
    { name: 'jev configuration error rethrows', env: jev, operation: 'judge', input: base, model: [], jev: [{ throwsJevConfiguration: 'no key' }] },
    { name: 'jev flag on, key missing: loud', env: { JEV_ENTITY_RESOLUTION: 'true' }, operation: 'judge', input: base, model: [], jev: [] },
    { name: 'jev flag on, empty candidates still null', env: { JEV_ENTITY_RESOLUTION: 'true' }, operation: 'judge', input: { ...base, candidates: [] }, model: [], jev: [] },
    { name: 'jev flag false string is off', env: { JEV_ENTITY_RESOLUTION: 'false', JEV_KEY: 'k' }, operation: 'judge', input: base, model: [verdict(0, 0.6)], jev: [] },
    { name: 'jev 41 candidates uses the model', env: jev, operation: 'judge', input: { ...base, candidates: forty1 }, model: [verdict(3, 0.9)], jev: [] },
    { name: 'jev 40 candidates uses jev', env: jev, operation: 'judge', input: { ...base, candidates: forty }, model: [], jev: [{ returns: jevAnswers(forty.map((_, c) => [c === 7 ? 0.9 : 0.1, 0.9] as [number, number])) }] },
    { name: 'jev tie keeps the first best', env: jev, operation: 'judge', input: base, model: [], jev: [{ returns: jevAnswers([[0.8, 0.9], [0.8, 0.9]]) }] },
    { name: 'jev best same but weak evidence declines', env: jev, operation: 'judge', input: base, model: [], jev: [{ returns: jevAnswers([[0.95, 0.4], [0.5, 0.9]]) }] },
    { name: 'jev same exactly at threshold merges', env: jev, operation: 'judge', input: base, model: [], jev: [{ returns: jevAnswers([[0.7, 0.5], [0.1, 0.1]]) }] },
    { name: 'jev missing answer is an error and falls back', env: jev, operation: 'judge', input: base, model: [verdict(0, 0.7)], jev: [{ returns: { same_c0: { type: 'noul', noul: 0.9 } } }] },
    { name: 'jev choice answer where noul expected falls back', env: jev, operation: 'judge', input: base, model: [verdict(1, 0.7)], jev: [{ returns: { same_c0: { type: 'choice', choice: 'c0' }, evid_c0: { type: 'noul', noul: 1 }, same_c1: { type: 'noul', noul: 1 }, evid_c1: { type: 'noul', noul: 1 } } }] },
    { name: 'empty asserted record renders (no fields)', env: {}, operation: 'judge', input: { ...base, asserted: { a: null, b: '' } }, model: [verdict(0, 0.9)], jev: [] },
    { name: 'arbitrate: one exact candidate needs no model', env: {}, operation: 'arbitrate', input: { ...base, constraints: { any: [{ all: [{ field: 'domain' }] }] } }, model: [], jev: [] },
    { name: 'arbitrate: lone fuzzy goes to the judge', env: {}, operation: 'arbitrate', input: { ...base, candidates: [two[1]], constraints: { any: [{ all: [{ field: 'domain', fuzzy: true }] }] } }, model: [verdict(null, 0.99)], jev: [] },
    { name: 'arbitrate: judge unavailable is reported', env: {}, operation: 'arbitrate', input: { ...base, asserted: { name: 'Acme Inc', domain: 'x.com' }, constraints: { any: [{ all: [{ field: 'name', fuzzy: true }] }] } }, model: [{ throws: 'overloaded' }], jev: [] },
    { name: 'arbitrate: lone candidate under exact-only constraints', env: {}, operation: 'arbitrate', input: { ...base, candidates: [two[1]], constraints: { any: [{ all: [{ field: 'company' }] }] } }, model: [], jev: [] },
    { name: 'metered: judge answer is wrapped', env: {}, operation: 'metered', input: { ...base, asserted: { name: 'Acme Inc', domain: 'x.com' }, constraints: { any: [{ all: [{ field: 'name', fuzzy: true }] }] } }, model: [verdict(0, 0.9)], jev: [] },
    { name: 'metered: unavailable judge is carried', env: {}, operation: 'metered', input: { ...base, asserted: { name: 'Acme Inc', domain: 'x.com' }, constraints: { any: [{ all: [{ field: 'name', fuzzy: true }] }] } }, model: [{ throws: 'boom' }], jev: [] },
  ];
}

if (process.env.RECORD_IDENTITY_JUDGE === '1') {
  it('records the replay fixture', async () => {
    const recorded: ReplayCase[] = [];
    for (const replayCase of [...handCases(), ...generatedCases()]) {
      recorded.push({ ...replayCase, expected: await observe(replayCase) });
    }
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
  });
} else {
  const recorded: ReplayCase[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  describe('identity judge replay', () => {
    it('has the recorded cases', () => {
      expect(recorded.length).toBeGreaterThanOrEqual(80);
    });
    it.each(recorded.map((c) => [c.name, c] as const))('%s', async (_name, replayCase) => {
      expect(await observe(replayCase)).toEqual(replayCase.expected);
    });
  });
}
