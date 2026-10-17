// A run goes to the engine its pinned language version runs on (5 and later
// the Rust engine, 1–4 the TypeScript engine), with no fallback between them:
// a version-5 run the Rust engine refuses fails loudly. A version-5 run the
// TypeScript engine parked (under the retired MOVEMENT_ENGINE_V5_ON_TS) fails
// its resume; a version-4 run a forced-Rust past parked resumes on the
// TypeScript engine. The engine settings that once chose otherwise are
// refused at boot.

import { fromCatalogSnapshot, mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';

import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import { MovementEngineError } from '../errors';
import { resumeMovement, runMovement, type ParkSink, type RunMovementInput } from '../run';
import { assertEngineConfigured, engineFor } from '../rust_engine';
import { resetRustRunStats, rustRunStats, setRunEngineRecorder, type RunEngineRecord } from '../rust_stats';
import type { ParkedScopeState } from '../serialize';
import { credentialIdsFor, makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000e5');

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
/** Parks on a timer, and returns once woken. */
const SLEEPS = program('  subject = msg.`subject`', '  await sleep(1h)', '  return UPPER(subject)');

const event: TriggerEvent = { pipelineInputId: 'pi-by-version', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'hi' } };
/** Declined at the wire whatever the program says (a `Map` does not cross as
 *  itself), so the Rust engine gives the same reason under every language version. */
const UNWIREABLE_EVENT: TriggerEvent = { ...event, payload: { subject: 'Acme', text: 'hi', seen: new Map() } };
const declined = (...args: Parameters<typeof inputOf>): RunMovementInput => ({ ...inputOf(...args), event: UNWIREABLE_EVENT });

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

/** An in-memory park sink keeping each timer park's state to wake. */
function timerSink() {
  const timers: ParkedScopeState[] = [];
  const sink: ParkSink = {
    async recordJoin() {},
    async commitTimerPark(input) {
      timers.push(JSON.parse(JSON.stringify(input.state)) as ParkedScopeState);
    },
    async commitAwaitPark() {
      throw new Error('test: no await parks expected');
    },
    async decrementJoin() {
      return { closed: true };
    },
    async persistBranchExport() {},
    async collectBranchExports() {
      return [];
    },
    async cancelSubtrees() {},
  };
  return { sink, timers };
}

function inputOf(source: string, languageVersion: LanguageVersion, runId: string, sink?: ParkSink): RunMovementInput {
  return {
    source: spelledFor(languageVersion, source, fromCatalogSnapshot(catalog)),
    languageVersion,
    event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    host: makeTestHost({ adapters: { resolve: () => fakeEmail() }, ...(sink !== undefined ? { park: { sink } } : {}) }),
    runId,
    firedAt: '2026-10-14T09:00:00.000Z',
  };
}

const recorded: RunEngineRecord[] = [];

beforeEach(() => {
  resetRustRunStats();
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});

afterEach(() => setRunEngineRecorder(undefined));

describe('the engine a segment runs on', () => {
  it('follows the pin: 5 and later Rust, 1–4 TypeScript', () => {
    for (const languageVersion of [1, 2, 3, 4]) expect(engineFor({ languageVersion })).toBe('ts');
    expect(engineFor({ languageVersion: 5 })).toBe('rust');
    expect(engineFor({ languageVersion: 5, parkedOn: 'rust' })).toBe('rust');
  });

  it('resumes a version 1–4 run on TypeScript even when a forced-Rust past wrote a Rust park', () => {
    expect(engineFor({ languageVersion: 4, parkedOn: 'rust' })).toBe('ts');
  });

  it('refuses a version-5 run the TypeScript engine parked: no engine may resume it', () => {
    expect(() => engineFor({ languageVersion: 5, parkedOn: 'ts' })).toThrow(
      'MOVENG_UNSUPPORTED: this run is pinned to language version 5, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume',
    );
  });
});

describe('the engine settings, checked at boot', () => {
  it('accepts an environment that names none', () => {
    expect(() => assertEngineConfigured({})).not.toThrow();
    expect(() => assertEngineConfigured({ MOVEMENT_ENGINE: '' })).not.toThrow();
  });

  it('refuses each retired setting, whatever its value, naming every one set', () => {
    for (const name of ['MOVEMENT_ENGINE', 'MOVEMENT_ENGINE_FALLBACK', 'MOVEMENT_ENGINE_DRY_RUN_EVERY', 'MOVEMENT_ENGINE_V5_ON_TS']) {
      expect(() => assertEngineConfigured({ [name]: 'by-version' })).toThrow(`${name} is retired: a run's engine follows its pinned language version`);
    }
    expect(() => assertEngineConfigured({ MOVEMENT_ENGINE: 'rust', MOVEMENT_ENGINE_V5_ON_TS: 'true' })).toThrow(
      'MOVEMENT_ENGINE, MOVEMENT_ENGINE_V5_ON_TS are retired',
    );
  });
});

describe('a run', () => {
  it('runs version 4 on TypeScript, recorded so', async () => {
    const result = await runMovement(inputOf(ADMITTED, 4, 'run-v4'));
    expect(result.movementName).toBe('m');
    expect(rustRunStats.segments).toBe(0);
    expect(recorded).toEqual([{ runId: 'run-v4', engine: 'ts' }]);
  });

  it('runs version 5 on Rust, recorded so', async () => {
    const result = await runMovement(inputOf(ADMITTED, 5, 'run-v5'));
    expect(result.movementName).toBe('m');
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {} });
    expect(recorded).toEqual([{ runId: 'run-v5', engine: 'rust' }]);
  });

  it('fails a version-5 run the Rust engine refuses, loudly, with the reason, running nothing on TypeScript', async () => {
    const failure = await runMovement(declined(ADMITTED, 5, 'run-refused')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MovementEngineError);
    expect(failure).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'event_does_not_cross' } });
    expect(String(failure)).toBe('MovementEngineError: MOVENG_UNSUPPORTED: the Rust engine does not run this movement (event_does_not_cross)');
    expect(rustRunStats.unsupported).toEqual({ event_does_not_cross: 1 });
    expect(recorded).toEqual([{ runId: 'run-refused', engine: 'rust' }]);
  });

  it('runs a version-4 program Rust would refuse on TypeScript, as it always ran', async () => {
    const result = await runMovement(declined(ADMITTED, 4, 'run-v4-refused'));
    expect(result.movementName).toBe('m');
    expect(rustRunStats.segments).toBe(0);
  });
});

describe('a parked run', () => {
  it('parked on Rust, resumes on Rust', async () => {
    const parks = timerSink();
    const parked = await runMovement(inputOf(SLEEPS, 5, 'run-rust-park', parks.sink));
    expect(parked.parked).toBe(true);
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    const resumed = await resumeMovement({ ...inputOf(SLEEPS, 5, 'run-rust-park', parks.sink), state, parkedOnEngine: 'rust' });
    expect(resumed.parked).toBeUndefined();
    expect(rustRunStats.segments).toBe(2);
    expect(recorded.at(-1)).toEqual({ runId: 'run-rust-park', engine: 'rust' });
  });

  it('pinned to 5 and recorded as parked by TypeScript, fails its resume before any segment opens', async () => {
    const parks = timerSink();
    await runMovement(inputOf(SLEEPS, 5, 'run-ts-park', parks.sink));
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    resetRustRunStats();
    recorded.length = 0;
    const failure = await resumeMovement({ ...inputOf(SLEEPS, 5, 'run-ts-park', parks.sink), state, parkedOnEngine: 'ts' }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'parked_on_typescript' } });
    expect(rustRunStats.segments).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('pinned to 4 and recorded as parked by Rust, resumes on TypeScript', async () => {
    const parks = timerSink();
    await runMovement(inputOf(SLEEPS, 4, 'run-v4-park', parks.sink));
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    const resumed = await resumeMovement({ ...inputOf(SLEEPS, 4, 'run-v4-park', parks.sink), state, parkedOnEngine: 'rust' });
    expect(resumed.parked).toBeUndefined();
    expect(rustRunStats.segments).toBe(0);
    expect(recorded.at(-1)).toEqual({ runId: 'run-v4-park', engine: 'ts' });
  });

  it('with no engine recorded, resumes by the pin', async () => {
    const parks = timerSink();
    await runMovement(inputOf(SLEEPS, 5, 'run-unrecorded', parks.sink));
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    await resumeMovement({ ...inputOf(SLEEPS, 5, 'run-unrecorded', parks.sink), state });
    expect(rustRunStats.segments).toBe(2);
    expect(recorded.at(-1)).toEqual({ runId: 'run-unrecorded', engine: 'rust' });
  });
});
