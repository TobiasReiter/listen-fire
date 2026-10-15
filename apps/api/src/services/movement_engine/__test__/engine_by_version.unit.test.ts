// MOVEMENT_ENGINE=by-version, production's default: a run goes to the engine
// its pinned language version runs on (5 and later the Rust engine, 1–4 the
// TypeScript engine), a version-5 run the Rust engine refuses fails loudly,
// the emergency switch (MOVEMENT_ENGINE_V5_ON_TS) sends version-5 runs to the
// TypeScript engine, and a parked run resumes on the engine that parked it
// whatever the switch says by then.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { MovementEngineError } from 'movement-engine/services/movement_engine/errors';
import { resumeMovement, runMovement, type ParkSink, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import { assertEngineChoiceConfigured, engineRoute, v5OnTypeScript } from 'movement-engine/services/movement_engine/rust_engine';
import { resetRustRunStats, rustRunStats, setRunEngineRecorder, type RunEngineRecord } from 'movement-engine/services/movement_engine/rust_stats';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

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
/** Refused by its admission: a `WITHIN` comparison. */
const REFUSED = program('  recent = msg.`subject` WITHIN "7d"', '  return msg.`subject`');
/** Parks on a timer, and returns once woken. */
const SLEEPS = program('  subject = msg.`subject`', '  await sleep(1h)', '  return UPPER(subject)');

const event: TriggerEvent = { pipelineInputId: 'pi-by-version', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'hi' } };

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
    source,
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

const NAMES = ['MOVEMENT_ENGINE', 'MOVEMENT_ENGINE_FALLBACK', 'MOVEMENT_ENGINE_V5_ON_TS', 'MOVEMENT_ENGINE_DRY_RUN_EVERY'] as const;
type Config = Partial<Record<(typeof NAMES)[number], string>>;

/** Runs `body` under exactly `config` (every other engine variable unset). */
async function under<T>(config: Config, body: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  for (const name of NAMES) {
    const value = config[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await body();
  } finally {
    for (const name of NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const BY_VERSION: Config = { MOVEMENT_ENGINE: 'by-version' };
const SWITCHED: Config = { MOVEMENT_ENGINE: 'by-version', MOVEMENT_ENGINE_V5_ON_TS: 'true' };

const recorded: RunEngineRecord[] = [];

beforeEach(() => {
  resetRustRunStats();
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});

afterEach(() => setRunEngineRecorder(undefined));

describe('the route a segment takes', () => {
  it('follows the pin under by-version, the default: 5 to Rust with no fallback, 1–4 to TypeScript', () => {
    for (const env of [{}, { MOVEMENT_ENGINE: 'by-version' }]) {
      expect(engineRoute({ languageVersion: 5 }, env)).toEqual({ engine: 'rust', fallback: 'none', dryRun: true, setting: 'by-version' });
      for (const languageVersion of [1, 2, 3, 4]) {
        expect(engineRoute({ languageVersion }, env)).toEqual({ engine: 'ts', fallback: 'ts', dryRun: false, setting: 'by-version' });
      }
    }
  });

  it('sends version 5 to TypeScript under the switch, falling back there from a Rust park', () => {
    const env = { MOVEMENT_ENGINE_V5_ON_TS: 'true' };
    expect(engineRoute({ languageVersion: 5 }, env)).toMatchObject({ engine: 'ts', fallback: 'ts', dryRun: true });
    expect(engineRoute({ languageVersion: 4 }, env)).toMatchObject({ engine: 'ts', dryRun: false });
    expect(engineRoute({ languageVersion: 5, parkedOn: 'rust' }, env)).toMatchObject({ engine: 'rust', fallback: 'ts' });
  });

  it('resumes on the engine that parked the run, whichever way the switch has flipped', () => {
    expect(engineRoute({ languageVersion: 5, parkedOn: 'ts' }, {})).toMatchObject({ engine: 'ts' });
    expect(engineRoute({ languageVersion: 5, parkedOn: 'rust' }, { MOVEMENT_ENGINE_V5_ON_TS: 'true' })).toMatchObject({ engine: 'rust' });
  });

  it('runs a version 1-4 run on TypeScript even when a forced-rust past wrote a Rust park', () => {
    for (const languageVersion of [1, 4]) {
      expect(engineRoute({ languageVersion, parkedOn: 'rust' }, {})).toMatchObject({ engine: 'ts', dryRun: false });
    }
  });

  it('forces one engine for every version, wherever the run parked, under rust or ts', () => {
    for (const languageVersion of [1, 4, 5]) {
      expect(engineRoute({ languageVersion, parkedOn: 'ts' }, { MOVEMENT_ENGINE: 'rust' })).toEqual({ engine: 'rust', fallback: 'ts', dryRun: false, setting: 'rust' });
      expect(engineRoute({ languageVersion }, { MOVEMENT_ENGINE: 'rust', MOVEMENT_ENGINE_FALLBACK: 'none' })).toMatchObject({ engine: 'rust', fallback: 'none' });
      expect(engineRoute({ languageVersion, parkedOn: 'rust' }, { MOVEMENT_ENGINE: 'ts' })).toEqual({ engine: 'ts', fallback: 'ts', dryRun: true, setting: 'ts' });
    }
  });
});

describe('the engine settings, checked at boot', () => {
  it('reads the switch as off unless it is true, and refuses anything else', () => {
    expect(v5OnTypeScript({})).toBe(false);
    expect(v5OnTypeScript({ MOVEMENT_ENGINE_V5_ON_TS: 'false' })).toBe(false);
    expect(v5OnTypeScript({ MOVEMENT_ENGINE_V5_ON_TS: 'true' })).toBe(true);
    expect(() => v5OnTypeScript({ MOVEMENT_ENGINE_V5_ON_TS: '1' })).toThrow('MOVEMENT_ENGINE_V5_ON_TS is "1"');
  });

  it('accepts by-version with or without the switch', () => {
    expect(() => assertEngineChoiceConfigured({})).not.toThrow();
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'by-version', MOVEMENT_ENGINE_V5_ON_TS: 'true' })).not.toThrow();
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'ts', MOVEMENT_ENGINE_V5_ON_TS: 'false' })).not.toThrow();
  });

  it('refuses the switch beside a forced engine, and a fallback beside anything but rust', () => {
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'rust', MOVEMENT_ENGINE_V5_ON_TS: 'true' })).toThrow('MOVEMENT_ENGINE=rust forces one engine');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'ts', MOVEMENT_ENGINE_V5_ON_TS: 'true' })).toThrow('MOVEMENT_ENGINE=ts forces one engine');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE_FALLBACK: 'ts' })).toThrow('needs MOVEMENT_ENGINE=rust (MOVEMENT_ENGINE is by-version)');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'ts', MOVEMENT_ENGINE_FALLBACK: 'ts' })).toThrow('needs MOVEMENT_ENGINE=rust');
    expect(() => assertEngineChoiceConfigured({ MOVEMENT_ENGINE: 'rust', MOVEMENT_ENGINE_FALLBACK: 'ts' })).not.toThrow();
  });
});

describe('a run under by-version', () => {
  it('runs version 4 on TypeScript, recorded so, with no dry run asked', async () => {
    const result = await under(BY_VERSION, () => runMovement(inputOf(ADMITTED, 4, 'run-v4')));
    expect(result.movementName).toBe('m');
    expect(rustRunStats.routed).toBe(0);
    expect(rustRunStats.dryRun.firings).toBe(0);
    expect(recorded).toEqual([{ runId: 'run-v4', engine: 'ts', reason: null }]);
  });

  it('runs version 5 on Rust, recorded so', async () => {
    const result = await under(BY_VERSION, () => runMovement(inputOf(ADMITTED, 5, 'run-v5')));
    expect(result.movementName).toBe('m');
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1 });
    expect(recorded).toEqual([{ runId: 'run-v5', engine: 'rust', reason: 'admitted' }]);
  });

  it('fails a version-5 run the Rust engine refuses, loudly, with the reason, running nothing on TypeScript', async () => {
    const failure = await under(BY_VERSION, () => runMovement(inputOf(REFUSED, 5, 'run-refused'))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MovementEngineError);
    expect(failure).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'within_compare' } });
    expect(String(failure)).toBe(
      'MovementEngineError: MOVENG_UNSUPPORTED: the Rust engine does not run this movement (within_compare), and under MOVEMENT_ENGINE=by-version its language version runs only on the Rust engine (MOVEMENT_ENGINE_V5_ON_TS=true runs it on the TypeScript engine)',
    );
    expect(recorded).toEqual([{ runId: 'run-refused', engine: 'rust', reason: 'within_compare' }]);
  });

  it('runs a version-4 program Rust would refuse on TypeScript, as it always ran', async () => {
    const result = await under(BY_VERSION, () => runMovement(inputOf(REFUSED, 4, 'run-v4-refused')));
    expect(result.movementName).toBe('m');
    expect(rustRunStats.routed).toBe(0);
  });

  it('runs version 5 on TypeScript under the switch, and the dry run counts it', async () => {
    const result = await under(SWITCHED, () => runMovement(inputOf(REFUSED, 5, 'run-switched')));
    expect(result.movementName).toBe('m');
    expect(rustRunStats.routed).toBe(0);
    expect(rustRunStats.dryRun).toMatchObject({ firings: 1, sampled: 1, first: { within_compare: 1 } });
    expect(recorded).toEqual([{ runId: 'run-switched', engine: 'ts', reason: 'within_compare' }]);
  });
});

describe('a parked run resumes on the engine that parked it', () => {
  it('parked on Rust, resumes on Rust after the switch is turned on', async () => {
    const parks = timerSink();
    const parked = await under(BY_VERSION, () => runMovement(inputOf(SLEEPS, 5, 'run-rust-park', parks.sink)));
    expect(parked.parked).toBe(true);
    expect(rustRunStats.routed).toBe(1);
    expect(recorded).toEqual([{ runId: 'run-rust-park', engine: 'rust', reason: 'admitted' }]);
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');

    const resumed = await under(SWITCHED, () =>
      resumeMovement({ ...inputOf(SLEEPS, 5, 'run-rust-park', parks.sink), state, parkedOnEngine: 'rust' }),
    );
    expect(resumed.parked).toBeUndefined();
    expect(rustRunStats.routed).toBe(2);
    expect(recorded.at(-1)).toEqual({ runId: 'run-rust-park', engine: 'rust', reason: 'admitted' });
  });

  it('parked on TypeScript under the switch, resumes on TypeScript after it is turned off', async () => {
    const parks = timerSink();
    const parked = await under(SWITCHED, () => runMovement(inputOf(SLEEPS, 5, 'run-ts-park', parks.sink)));
    expect(parked.parked).toBe(true);
    expect(rustRunStats.routed).toBe(0);
    expect(recorded).toEqual([{ runId: 'run-ts-park', engine: 'ts', reason: 'admitted' }]);
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');

    const resumed = await under(BY_VERSION, () =>
      resumeMovement({ ...inputOf(SLEEPS, 5, 'run-ts-park', parks.sink), state, parkedOnEngine: 'ts' }),
    );
    expect(resumed.parked).toBeUndefined();
    expect(rustRunStats.routed).toBe(0);
    expect(recorded.at(-1)).toMatchObject({ runId: 'run-ts-park', engine: 'ts' });
  });

  it('with no engine recorded, resumes by the pin, as a new run is routed', async () => {
    const parks = timerSink();
    await under(SWITCHED, () => runMovement(inputOf(SLEEPS, 5, 'run-unrecorded', parks.sink)));
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    await under(BY_VERSION, () => resumeMovement({ ...inputOf(SLEEPS, 5, 'run-unrecorded', parks.sink), state }));
    expect(rustRunStats.routed).toBe(1);
    expect(recorded.at(-1)).toEqual({ runId: 'run-unrecorded', engine: 'rust', reason: 'admitted' });
  });
});
