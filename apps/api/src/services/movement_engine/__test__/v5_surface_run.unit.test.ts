// Version 5's surface run on the Rust engine; the harness is engine_by_version's.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { resumeMovement, runMovement, type ParkSink, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
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


// Language version 5's surface on the Rust engine (plans/naming-rethink-2026-10-14/
// 5_design.md): the everyday spelling is read into the tree versions 1-4 parse,
// so a v5 run is admitted, runs whole, parks and resumes exactly as before.
// Every slot is re-read under the run's version on each poll, a resumed one
// included (crates/movement-parser/src/surface).

const V5 = (...body: string[]) =>
  [
    'import { `@lf/email` as email } from adapters',
    'import { dealflow_inbox } from credentials',
    'inbox = connect email using dealflow_inbox',
    'function m(msg: <inbox-[:message]->>) {',
    ...body,
    '}',
  ].join('\n');

const EVERYDAY = V5(
  '  subject = msg.`subject`',
  '  loud = Text.upper(Text.trim(subject))',
  '  label = Text.length(loud) > 2 && loud != null ? "long" : "short"',
  '  if (label == "long" || !(loud == "")) {',
  '    words = Text.split(loud, " ")',
  '  }',
  '  return coalesce(first(map([loud], (w) => Text.lower(w))), label)',
);
const SLEEPS_V5 = V5('  subject = msg.`subject`', '  await sleep(1h)', '  return Text.upper(subject)');

const recorded: RunEngineRecord[] = [];

beforeEach(() => {
  resetRustRunStats();
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});

afterEach(() => setRunEngineRecorder(undefined));

describe('the v5 surface on the Rust engine', () => {
  it('admits and runs a program in the everyday spelling whole', async () => {
    const result = await under(BY_VERSION, () => runMovement(inputOf(EVERYDAY, 5, 'run-v5-surface')));
    expect(result.movementName).toBe('m');
    expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1 });
    expect(recorded).toEqual([{ runId: 'run-v5-surface', engine: 'rust', reason: 'admitted' }]);
  });

  it('parks and resumes a program in the everyday spelling on Rust', async () => {
    const parks = timerSink();
    const parked = await under(BY_VERSION, () => runMovement(inputOf(SLEEPS_V5, 5, 'run-v5-park', parks.sink)));
    expect(parked.parked).toBe(true);
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    const resumed = await under(BY_VERSION, () =>
      resumeMovement({ ...inputOf(SLEEPS_V5, 5, 'run-v5-park', parks.sink), state, parkedOnEngine: 'rust' }),
    );
    expect(resumed.parked).toBeUndefined();
    expect(recorded.at(-1)).toEqual({ runId: 'run-v5-park', engine: 'rust', reason: 'admitted' });
  });
});

// `x != null` under 5 answers what `EXISTS(x)` answered under 4, records a
// block returned included: none returned is absent (on Rust, and on the
// TypeScript reference engine).
describe('a presence test on the Rust engine from version 5', () => {
  const itemsSchema: InstanceSchema = {
    positions: {
      message: { properties: { subject: 'text', text: 'text' }, edges: { items: { target: 'item', readable: true } } },
      item: { properties: { name: 'text' }, edges: {} },
    },
    collections: {},
    writableRoots: {},
  };
  const itemsCatalog = mockCatalogSnapshot({
    adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: itemsSchema } },
    credentials: { dealflow_inbox: { adapters: ['email'] } },
  });
  const outcome = async (source: string, version: LanguageVersion, config: Config): Promise<string> => {
    try {
      await under(config, () => runMovement({ ...inputOf(source, version, `run-presence-${version}`), catalog: itemsCatalog }));
      return 'ran';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const v4 = [
    'import { email } from adapters',
    'import { dealflow_inbox } from credentials',
    'inbox = email(credentials: dealflow_inbox)',
    'movement m(msg: <inbox-[:message]->>) {',
    '  found = msg-[i:items]-> { return i }',
    '  if EXISTS(found) {',
    '    ERROR("present")',
    '  }',
    '  ERROR("absent")',
    '}',
  ].join('\n');
  const v5 = V5('  found = msg-[i:items]-> { return i }', '  if (found != null) {', '    fail("present")', '  }', '  fail("absent")');

  it('none returned is absent, as EXISTS answered', async () => {
    const old = await outcome(v4, 4, BY_VERSION);
    expect(old).toContain('absent');
    expect(await outcome(v5, 5, BY_VERSION)).toBe(old);
    expect(await outcome(v5, 5, { MOVEMENT_ENGINE_V5_ON_TS: 'true' })).toBe(old);
  });
});
