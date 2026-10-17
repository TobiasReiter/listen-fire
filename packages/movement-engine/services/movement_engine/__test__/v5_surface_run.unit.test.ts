// Version 5's surface run on the Rust engine; the harness is engine_by_version's.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import {
  resumeMovement,
  runMovement,
  type ParkSink,
  type RunMovementInput,
} from '../run';
import {
  resetRustRunStats,
  rustRunStats,
  setRunEngineRecorder,
  type RunEngineRecord,
} from '../rust_stats';
import type { ParkedScopeState } from '../serialize';
import { credentialIdsFor, makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000e5');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const event: TriggerEvent = {
  pipelineInputId: 'pi-by-version',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'Acme', text: 'hi' },
};
function fakeEmail(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null
        ? Reflect.get(data, input.fieldId)
        : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({
      adapterType: 'email',
      externalId: input.externalId,
      data: {},
      association: containerAssociation(input),
    }),
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

function inputOf(
  source: string,
  languageVersion: LanguageVersion,
  runId: string,
  sink?: ParkSink,
): RunMovementInput {
  return {
    source,
    languageVersion,
    event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    host: makeTestHost({
      adapters: { resolve: () => fakeEmail() },
      ...(sink !== undefined ? { park: { sink } } : {}),
    }),
    runId,
    firedAt: '2026-10-14T09:00:00.000Z',
  };
}

// Language version 5's surface on the Rust engine (plans/naming-rethink-2026-10-14/
// 5_design.md): the everyday spelling is read into the tree versions 1-4 parse,
// so a v5 run runs whole, parks and resumes exactly as before.
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
const SLEEPS_V5 = V5(
  '  subject = msg.`subject`',
  '  await sleep(1h)',
  '  return Text.upper(subject)',
);

const recorded: RunEngineRecord[] = [];

beforeEach(() => {
  resetRustRunStats();
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});

afterEach(() => setRunEngineRecorder(undefined));

describe('the v5 surface on the Rust engine', () => {
  it('runs a program in the everyday spelling whole', async () => {
    const result = await runMovement(inputOf(EVERYDAY, 5, 'run-v5-surface'));
    expect(result.movementName).toBe('m');
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
    expect(recorded).toEqual([{ runId: 'run-v5-surface', engine: 'rust' }]);
  });

  it('parks and resumes a program in the everyday spelling on Rust', async () => {
    const parks = timerSink();
    const parked = await runMovement(inputOf(SLEEPS_V5, 5, 'run-v5-park', parks.sink));
    expect(parked.parked).toBe(true);
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    const resumed = await resumeMovement({
      ...inputOf(SLEEPS_V5, 5, 'run-v5-park', parks.sink),
      state,
      parkedOnEngine: 'rust',
    });
    expect(resumed.parked).toBeUndefined();
    expect(recorded.at(-1)).toEqual({ runId: 'run-v5-park', engine: 'rust' });
  });
});

// `x != null` under 5 answers what `EXISTS(x)` answered under 4, records a
// block returned included: none returned is absent.
describe('a presence test on the Rust engine from version 5', () => {
  const itemsSchema: InstanceSchema = {
    positions: {
      message: {
        properties: { subject: 'text', text: 'text' },
        edges: { items: { target: 'item', readable: true } },
      },
      item: { properties: { name: 'text' }, edges: {} },
    },
    collections: {},
    writableRoots: {},
  };
  const itemsCatalog = mockCatalogSnapshot({
    adapters: {
      email: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schema: itemsSchema,
      },
    },
    credentials: { dealflow_inbox: { adapters: ['email'] } },
  });
  const outcome = async (source: string, version: LanguageVersion): Promise<string> => {
    try {
      await runMovement({
        ...inputOf(source, version, `run-presence-${version}`),
        catalog: itemsCatalog,
      });
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
  const v5 = V5(
    '  found = msg-[i:items]-> { return i }',
    '  if (found != null) {',
    '    fail("present")',
    '  }',
    '  fail("absent")',
  );

  it('none returned is absent, as EXISTS answered', async () => {
    const old = await outcome(v4, 4);
    expect(old).toContain('absent');
    expect(await outcome(v5, 5)).toBe(old);
  });
});

// From version 5 `count(xs)` counts every item, an empty one included, as
// TypeScript's `.length` does; versions 1-4 skip empty items.
describe('count from version 5', () => {
  const outcome = async (source: string, version: LanguageVersion): Promise<string> => {
    try {
      await runMovement(inputOf(source, version, `run-count-${version}`));
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
    '  xs = [msg.`subject`, NULL, "b"]',
    '  ERROR("counted ${COUNT(xs)}")',
    '}',
  ].join('\n');
  const v5 = V5('  xs = [msg.subject, null, "b"]', '  fail("counted ${count(xs)}")');

  it('counts the empty item under 5, and skips it under 4', async () => {
    expect(await outcome(v4, 4)).toContain('counted 2');
    expect(await outcome(v5, 5)).toContain('counted 3');
    expect(recorded.at(-1)).toMatchObject({ engine: 'rust' });
  });
});

// From version 5 an empty or blank text reads as no number (JavaScript's
// `Number("")` made it 0).
describe('a number read from an empty text from version 5', () => {
  const outcome = async (source: string, version: LanguageVersion): Promise<string> => {
    try {
      await runMovement(inputOf(source, version, `run-number-${version}`));
      return 'ran';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const v5 = V5(
    '  empty = Number.parse("")',
    '  blank = Number.parse("  ")',
    '  fail("read ${empty == null} ${blank == null} ${Number.parse(" 12 ")}")',
  );

  it('reads null end to end on the Rust engine', async () => {
    expect(await outcome(v5, 5)).toContain('read true true 12');
    expect(recorded.at(-1)).toMatchObject({ engine: 'rust' });
  });
});
