// Language version 5 runs: `fail(…)` inside an expression and `sort` by a
// function key, each on the Rust engine and on the TypeScript engine (the
// v5 reference, under MOVEMENT_ENGINE_V5_ON_TS). The checkers' twins are
// crates/movement-checker/tests/v5_never_sort.rs and
// checker/__test__/v5_never_sort.unit.test.ts.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { runMovement, type ParkSink, type RunMovementInput } from 'movement-engine/services/movement_engine/run';
import { setRunEngineRecorder, type RunEngineRecord } from 'movement-engine/services/movement_engine/rust_stats';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000e5');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} }, note: { properties: { body: 'text' }, edges: {} } },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text' }, resultShape: { body: 'text' }, edges: {} } },
};

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { 'Dealflow Inbox': { adapters: ['email'] } },
});

const event: TriggerEvent = { pipelineInputId: 'pi-by-version', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'b a c' } };
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
/** Version 5 on the TypeScript engine, its reference. */
const ON_TS: Config = { MOVEMENT_ENGINE: 'by-version', MOVEMENT_ENGINE_V5_ON_TS: 'true' };

const V5 = (...body: string[]) =>
  [
    'import { `@lf/email` as email } from adapters',
    'import { `Dealflow Inbox` } from credentials',
    'inbox = connect email using `Dealflow Inbox`',
    'function m(msg: <inbox-[:message]->>) {',
    ...body,
    '}',
  ].join('\n');

const recorded: RunEngineRecord[] = [];
beforeEach(() => {
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});
afterEach(() => setRunEngineRecorder(undefined));

/** The writes without their source spans. */
const bodies = (writes: unknown[]): unknown => JSON.parse(JSON.stringify(writes, (key, value: unknown) => (key === 'span' ? undefined : value)));

/** Runs a v5 body on both engines: what each writes, or how each failed. */
async function onBoth(body: string[]): Promise<{ rust: unknown; ts: unknown }> {
  const outcome = async (config: Config, runId: string): Promise<unknown> => {
    try {
      const result = await under(config, () => runMovement(inputOf(V5(...body), 5, runId)));
      return { writes: bodies(result.writes) };
    } catch (error) {
      const { name, message } = error as Error;
      return { failed: { name, code: (error as { code?: unknown }).code, message } };
    }
  };
  const rust = await outcome(BY_VERSION, 'run-rust');
  const ts = await outcome(ON_TS, 'run-ts');
  expect(recorded.map((r) => r.engine)).toEqual(['rust', 'ts']);
  return { rust, ts };
}

describe('fail inside an expression runs on both engines', () => {
  it('a value that arrives is the other member', async () => {
    const { rust, ts } = await onBoth(['  x = coalesce(msg.subject, fail("no subject"))', '  write inbox-[:note]-> { body: x }']);
    expect(rust).toEqual({ writes: [expect.objectContaining({})] });
    expect(JSON.stringify(rust)).toContain('Acme');
    expect(ts).toEqual(rust);
  });

  it('an arm not taken never runs', async () => {
    const { rust, ts } = await onBoth(['  x = msg.subject == "Other" ? fail("stop") : "go ${msg.subject}"', '  write inbox-[:note]-> { body: x }']);
    expect(JSON.stringify(rust)).toContain('go Acme');
    expect(ts).toEqual(rust);
  });

  it('the run fails with the message exactly as the statement form does', async () => {
    const statement = await onBoth(['  if (msg.subject == "Acme") {', '    fail("stop ${msg.subject}")', '  }', '  write inbox-[:note]-> { body: "x" }']);
    recorded.length = 0;
    const inExpression = await onBoth(['  x = msg.subject == "Acme" ? fail("stop ${msg.subject}") : "go"', '  write inbox-[:note]-> { body: x }']);
    recorded.length = 0;
    const inCoalesce = await onBoth(['  x = coalesce(Text.split("", ",")[0], fail("stop ${msg.subject}"))', '  write inbox-[:note]-> { body: x }']);
    expect(statement.rust).toMatchObject({ failed: { message: expect.stringContaining('stop Acme') } });
    expect(statement.ts).toEqual(statement.rust);
    expect(inExpression).toEqual(statement);
    expect(inCoalesce).toEqual(statement);
  });
});

/** The note bodies a run wrote. */
function noteBodies(outcome: unknown): string[] {
  const writes = (outcome as { writes?: Array<{ fields?: { body?: unknown } }> }).writes ?? [];
  return writes.map((w) => JSON.stringify(w)).map((w) => /"body":"([^"]*)"/.exec(w)?.[1] ?? w);
}

describe('sort by a function key runs on both engines', () => {
  it.each([
    ['a computed key, descending', ['  words = Text.split(msg.text, " ")', '  ranked = sort(words, (w) => Text.upper(w), { order: "desc" })', '  write inbox-[:note]-> { body: Text.join(ranked, ",") }'], 'c,b,a'],
    [
      'records by a field, a missing key last whichever the order',
      ['  rows = [{ n: "b", s: 2 }, { n: "a", s: 9 }, { n: "c" }, { n: "d", s: 5 }]', '  up = sort(rows, (r) => r.s)', '  down = sort(rows, (r) => r.s, { order: "desc" })', '  write inbox-[:note]-> { body: "${Text.join(map(up, (r) => r.n), ",")}|${Text.join(map(down, (r) => r.n), ",")}" }'],
      'b,d,a,c|a,d,b,c',
    ],
    ['stable over equal keys', ['  rows = [{ n: "x", s: 1 }, { n: "y", s: 1 }, { n: "z", s: 0 }]', '  down = sort(rows, (r) => r.s, { order: "desc" })', '  write inbox-[:note]-> { body: Text.join(map(down, (r) => r.n), ",") }'], 'x,y,z'],
    ['an outer variable never hides the field', ['  s = 100', '  rows = [{ n: "b", s: 2 }, { n: "a", s: 1 }]', '  up = sort(rows, (r) => r.s)', '  write inbox-[:note]-> { body: Text.join(map(up, (r) => r.n), ",") }'], 'a,b'],
    ['inside an expression', ['  words = Text.split(msg.text, " ")', '  write inbox-[:note]-> { body: coalesce(first(sort(words, (w) => w == "a" ? 0 : 1)), fail("no words")) }'], 'a'],
  ])('%s', async (_what, body, want) => {
    const { rust, ts } = await onBoth(body);
    expect(noteBodies(rust)).toEqual([want]);
    expect(ts).toEqual(rust);
  });
});
