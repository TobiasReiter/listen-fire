// The admission dry run (rust_engine.ts `dryAdmitRun`): a run the TypeScript
// engine runs is also put to the Rust engine's admission, through the real
// artifact's start entry, and what it would have refused the run for is
// counted — with no host call, and no change to the run.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { EngineHost } from '../host';

import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import { runMovement, type RunMovementInput } from '../run';
import { openRunContext } from '../run_context';
import {
  admissionDryRunEvery,
  assertEngineChoiceConfigured,
  dryAdmitFire,
  dryAdmitResume,
  dryAdmitRun,
  dryAdmitSettle,
  type EngineProtocol,
  type EngineStep,
} from '../rust_engine';
import { admissionVerdicts, dryRunDurationSummary, resetRustRunStats, rustRunStats, setDryRunClock } from '../rust_stats';
import { credentialIdsFor, makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000d1');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const program = (...body: string[]) =>
  [
    'import { email } from adapters',
    'import { dealflow_inbox } from credentials',
    'inbox = email(credentials: dealflow_inbox)',
    'movement m(msg: <inbox-[:message]->>) {',
    ...body,
    '}',
  ].join('\n');

/** Admitted by the Rust engine. */
const ADMITTED = program('  subject = msg.`subject`', '  return UPPER(subject)');
/** Refused by its admission: a `WITHIN` comparison (which may stay refused
 *  by name: no corpus run reaches it). */
const WITHIN = ['  recent = msg.`subject` WITHIN "7d"'];
const REFUSED = program(...WITHIN, '  return msg.`subject`');
/** Refused for two reasons: the `WITHIN`, and a bound write. */
const REFUSED_TWICE = program(...WITHIN, '  write inbox-[:message]-> bind msg { subject: "a" }', '  return msg.`subject`');

const event: TriggerEvent = { pipelineInputId: 'pi-dry-run', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'hi' } };

function fakeEmail(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

function inputOf(source: string, host: EngineHost, runId?: string): RunMovementInput {
  return {
    source,
    event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    host,
    ...(runId !== undefined ? { runId } : {}),
  };
}

/** A copy of `host` (the test host shares its defaults between hosts, so
 *  the copy is made fresh at every level) in which every method records its
 *  path and fails: any request made of it is seen, and fails. */
function failingEveryRequest(host: EngineHost): { host: EngineHost; asked: string[] } {
  const asked: string[] = [];
  const copy = <T extends object>(from: T, prefix: string): T => {
    const into = { ...from };
    for (const key of Object.keys(into)) {
      const value: unknown = Reflect.get(into, key);
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof value === 'function') {
        Reflect.set(into, key, () => {
          asked.push(path);
          throw new Error(`test: the dry run asked the host for ${path}`);
        });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Reflect.set(into, key, copy(value, path));
      }
    }
    return into;
  };
  const failing = copy(host, '');
  return { host: failing, asked };
}

/** A segment of `source` against a host that fails every request once the
 *  segment is open. Pinned to version 3: the dry run's counters are the
 *  point, kept by version, and these programs' reasons are the same under 4. */
async function failingSegment(source: string, runId?: string) {
  const working = makeTestHost({ adapters: { resolve: () => fakeEmail() } });
  const context = await openRunContext({ host: working, teamId: TEAM_ID, languageVersion: 3, spend: {} });
  const { host, asked } = failingEveryRequest(working);
  return { segment: { input: inputOf(source, host, runId), context }, asked };
}

async function underEngine<T>(engine: 'ts' | 'rust' | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.MOVEMENT_ENGINE;
  if (engine === undefined) delete process.env.MOVEMENT_ENGINE;
  else process.env.MOVEMENT_ENGINE = engine;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** An engine double whose start answers `step`, recording what it was asked. */
function startingWith(step: EngineStep | (() => EngineStep)) {
  const log = { started: 0, answered: 0, finished: 0 };
  const engine: EngineProtocol = {
    start: () => {
      log.started += 1;
      return typeof step === 'function' ? step() : step;
    },
    answer: () => {
      log.answered += 1;
      throw new Error('test: a dry run answered the engine');
    },
    finish: () => {
      log.finished += 1;
    },
  };
  return { engine, log };
}

beforeEach(() => {
  resetRustRunStats();
  delete process.env.MOVEMENT_ENGINE_DRY_RUN_EVERY;
});

afterAll(() => {
  delete process.env.MOVEMENT_ENGINE_DRY_RUN_EVERY;
});

describe('the admission dry run, through the real artifact', () => {
  it('counts what the Rust engine would refuse, by reason and version, and asks a host that fails every request for nothing', async () => {
    const refused = await failingSegment(REFUSED, 'run-refused');
    dryAdmitRun(refused.segment);
    const admitted = await failingSegment(ADMITTED, 'run-admitted');
    dryAdmitRun(admitted.segment);

    expect(refused.asked).toEqual([]);
    expect(admitted.asked).toEqual([]);
    const tally = { sampled: 2, admitted: 1, first: { within_compare: 1 }, all: { within_compare: 1 } };
    expect(rustRunStats.dryRun).toEqual({ firings: 2, faults: 0, ...tally, byVersion: { '3': tally }, byRoute: { run: tally, resume: { sampled: 0, admitted: 0, first: {}, all: {} }, settle: { sampled: 0, admitted: 0, first: {}, all: {} }, fire: { sampled: 0, admitted: 0, first: {}, all: {} } } });
    expect(admissionVerdicts).toEqual([
      { runId: 'run-refused', languageVersion: 3, reasons: ['within_compare'] },
      { runId: 'run-admitted', languageVersion: 3, reasons: [] },
    ]);
    // Only the dry run's own counters move: no segment was routed, nothing ran in Rust.
    expect(rustRunStats).toMatchObject({ routed: 0, admitted: 0, ranWhole: 0, notAdmitted: {}, declined: {}, hostCalls: {} });
  });

  it('counts every reason the walk meets, not only the first', async () => {
    const { segment, asked } = await failingSegment(REFUSED_TWICE, 'run-twice');
    dryAdmitRun(segment);
    expect(asked).toEqual([]);
    expect(rustRunStats.dryRun).toMatchObject({ first: { within_compare: 1 }, all: { within_compare: 1, write_bind: 1 } });
    expect(admissionVerdicts).toEqual([{ runId: 'run-twice', languageVersion: 3, reasons: ['within_compare', 'write_bind'] }]);
  });

  // A real run leaves a slot this engine's lowering misses to its check
  // (declined after a passing one); the dry run, never answered, names it.
  it('names a slot the lowering misses, which a real run leaves to its check', async () => {
    // A namespaced member the language does not have (the checker refuses it).
    const missed = program('  x = TEXT.CHUNKS(msg.`subject`)');
    const { segment, asked } = await failingSegment(missed.replace('inbox = email(credentials: dealflow_inbox)', 'inbox = email(credentials: dealflow_inbox)\ncrm = email(credentials: dealflow_inbox)'), 'run-missed');
    dryAdmitRun(segment);
    expect(asked).toEqual([]);
    expect(rustRunStats.dryRun.first).toEqual({ expression_does_not_lower: 1 });
  });

  it("puts a resume to the engine's start as a real resume, its answer included", async () => {
    const { segment, asked } = await failingSegment(ADMITTED);
    const starts: unknown[] = [];
    const engine: EngineProtocol = {
      start: (input) => {
        starts.push(input);
        return { done: { refused: 'park_state', reasons: ['park_state'] } };
      },
      answer: () => {
        throw new Error('test: a dry run answered the engine');
      },
      finish: () => undefined,
    };
    const state = { version: 1 } as never;
    dryAdmitResume({ input: { ...segment.input, state, answer: 'yes' }, context: segment.context }, engine);
    expect(asked).toEqual([]);
    expect(starts).toHaveLength(1);
    // The state crosses on the eval wire, as a real resume's does.
    expect(starts[0]).toMatchObject({ resume: { state: ['o', 0, [['version', 1]]], answer: 'yes' } });
    expect(rustRunStats.dryRun.first).toEqual({ park_state: 1 });
  });

  // The two routes a parked run continues by besides a resume: each is put
  // to the start entry as the real segment would be, so the refusal
  // inventory covers every run the TypeScript engine runs.
  it("puts a race's settlement and a callback's firing to the engine's start as the real ones", async () => {
    const { segment, asked } = await failingSegment(ADMITTED, 'run-parked');
    const starts: unknown[] = [];
    const engine: EngineProtocol = {
      start: (input) => {
        starts.push(input);
        return { done: { refused: 'resume_state_version', reasons: ['resume_state_version'] } };
      },
      answer: () => {
        throw new Error('test: a dry run answered the engine');
      },
      finish: () => undefined,
    };
    const state = { version: 1 } as never;
    dryAdmitSettle({ input: { ...segment.input, state, frameAddress: 's0' }, context: segment.context }, engine);
    dryAdmitFire({ input: { ...segment.input, state, values: { ok: true }, callIndex: 2 }, context: segment.context }, engine);
    expect(asked).toEqual([]);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ resume: { state: ['o', 0, [['version', 1]]] }, settle: { frameAddress: 's0' } });
    expect(starts[1]).toMatchObject({ resume: { state: ['o', 0, [['version', 1]]] }, fire: { values: ['o', expect.any(Number), [['ok', true]]], callIndex: 2 } });
    expect(rustRunStats.dryRun).toMatchObject({ sampled: 2, first: { resume_state_version: 2 } });
    expect(admissionVerdicts).toEqual([
      { runId: 'run-parked', languageVersion: 3, reasons: ['resume_state_version'] },
      { runId: 'run-parked', languageVersion: 3, reasons: ['resume_state_version'] },
    ]);
  });
});

describe('a run the TypeScript engine runs', () => {
  it('runs as it would without the dry run, and the dry run counts it', async () => {
    const run = (source: string) =>
      underEngine(undefined, () => runMovement(inputOf(source, makeTestHost({ adapters: { resolve: () => fakeEmail() } }))));
    process.env.MOVEMENT_ENGINE_DRY_RUN_EVERY = '0';
    const withoutDryRun = await run(REFUSED);
    expect(rustRunStats.dryRun.sampled).toBe(0);
    delete process.env.MOVEMENT_ENGINE_DRY_RUN_EVERY;
    const withDryRun = await run(REFUSED);
    expect(withDryRun).toEqual(withoutDryRun);
    expect(rustRunStats.dryRun).toMatchObject({ firings: 2, sampled: 1, admitted: 0, faults: 0, first: { within_compare: 1 } });
  });

  it('is never asked about under MOVEMENT_ENGINE=rust: an admitted run moves no dry run counter', async () => {
    await underEngine('rust', () => runMovement(inputOf(ADMITTED, makeTestHost({ adapters: { resolve: () => fakeEmail() } }))));
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1 });
    expect(rustRunStats.dryRun).toEqual({ firings: 0, sampled: 0, admitted: 0, faults: 0, first: {}, all: {}, byVersion: {}, byRoute: { run: { sampled: 0, admitted: 0, first: {}, all: {} }, resume: { sampled: 0, admitted: 0, first: {}, all: {} }, settle: { sampled: 0, admitted: 0, first: {}, all: {} }, fire: { sampled: 0, admitted: 0, first: {}, all: {} } } });
    expect(admissionVerdicts).toEqual([]);
  });

  it('survives a dry run that faults: counted as a fault, nothing else', async () => {
    const { segment } = await failingSegment(ADMITTED, 'run-1');
    const { engine } = startingWith(() => {
      throw new Error('test: the artifact failed');
    });
    expect(() => dryAdmitRun(segment, engine)).not.toThrow();
    expect(rustRunStats.dryRun).toMatchObject({ firings: 1, sampled: 0, faults: 1 });
    expect(admissionVerdicts).toEqual([]);
  });
});

describe('the dry run against an engine double', () => {
  it('skips a rehearsal: no engine started, no counter moved', async () => {
    const { segment } = await failingSegment(ADMITTED, 'run-rehearsal');
    const { engine, log } = startingWith({ pending: [] });
    dryAdmitRun({ input: { ...segment.input, dryRun: true }, context: segment.context }, engine);
    expect(log.started).toBe(0);
    expect(rustRunStats.dryRun).toMatchObject({ firings: 0, sampled: 0 });
    expect(admissionVerdicts).toEqual([]);
  });

  it("times each dry run by the host's clock, once one is installed", async () => {
    const { segment } = await failingSegment(ADMITTED);
    const { engine } = startingWith({ pending: [] });
    dryAdmitRun(segment, engine);
    expect(dryRunDurationSummary().timed).toBe(0);
    let now = 0;
    setDryRunClock(() => (now += 2.5));
    try {
      dryAdmitRun(segment, engine);
      dryAdmitRun(segment, engine);
    } finally {
      setDryRunClock(undefined);
    }
    expect(dryRunDurationSummary()).toEqual({ timed: 2, p50: 2.5, p95: 2.5, p99: 2.5, max: 2.5 });
  });

  it("never answers an admitted run's first request, and finishes the segment there", async () => {
    const { segment } = await failingSegment(ADMITTED);
    const { engine, log } = startingWith({ pending: [{ id: 0, family: 'check', method: 'program', args: {} }] });
    dryAdmitRun(segment, engine);
    expect(log).toEqual({ started: 1, answered: 0, finished: 1 });
    expect(rustRunStats.dryRun).toMatchObject({ sampled: 1, admitted: 1 });
  });

  it('counts every reason the engine names, once each, and the first as first', async () => {
    const { segment } = await failingSegment(ADMITTED, 'run-2');
    const { engine } = startingWith({ done: { refused: 'expression:llm', reasons: ['expression:llm', 'statement:call', 'plugin_call', 'statement:call'] } });
    dryAdmitRun(segment, engine);
    expect(rustRunStats.dryRun).toMatchObject({
      first: { 'expression:llm': 1 },
      all: { 'expression:llm': 1, 'statement:call': 1, plugin_call: 1 },
    });
    expect(admissionVerdicts[0]?.reasons).toEqual(['expression:llm', 'statement:call', 'plugin_call', 'statement:call']);
  });

  it('asks about one firing in MOVEMENT_ENGINE_DRY_RUN_EVERY', async () => {
    const { segment } = await failingSegment(ADMITTED);
    const { engine, log } = startingWith({ pending: [] });
    process.env.MOVEMENT_ENGINE_DRY_RUN_EVERY = '3';
    for (let i = 0; i < 7; i++) dryAdmitRun(segment, engine);
    expect(log.started).toBe(3);
    expect(rustRunStats.dryRun).toMatchObject({ firings: 7, sampled: 3 });
  });

  it('reads the sampling rate as a whole number, and refuses anything else at boot', () => {
    expect(admissionDryRunEvery({})).toBe(1);
    expect(admissionDryRunEvery({ MOVEMENT_ENGINE_DRY_RUN_EVERY: '0' })).toBe(0);
    expect(admissionDryRunEvery({ MOVEMENT_ENGINE_DRY_RUN_EVERY: '10' })).toBe(10);
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE_DRY_RUN_EVERY: '0.5' })).toThrow('MOVEMENT_ENGINE_DRY_RUN_EVERY is "0.5"');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE_DRY_RUN_EVERY: '-1' })).toThrow('MOVEMENT_ENGINE_DRY_RUN_EVERY is "-1"');
  });
});
