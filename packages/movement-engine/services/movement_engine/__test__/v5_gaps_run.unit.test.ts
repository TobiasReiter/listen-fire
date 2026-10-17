// The v5 surface's spine gaps run: each program in the v5 spelling on the Rust
// engine writes what its v4 spelling writes on the TypeScript engine. The
// harness is engine_by_version's; the checkers' twins are
// crates/movement-checker/tests/v5_gaps.rs and checker/__test__/v5_gaps.unit.test.ts.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { containerAssociation } from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import { runMovement, type ParkSink, type RunMovementInput } from '../run';
import { setRunEngineRecorder, type RunEngineRecord } from '../rust_stats';
import { credentialIdsFor, makeTestHost } from '../test_host';

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

const V5 = (...body: string[]) =>
  [
    'import { `@lf/email` as email } from adapters',
    'import { `Dealflow Inbox` } from credentials',
    'inbox = connect email using `Dealflow Inbox`',
    'function m(msg: <inbox-[:message]->>) {',
    ...body,
    '}',
  ].join('\n');
const V4 = (...body: string[]) =>
  [
    'import { email } from adapters',
    'import { `Dealflow Inbox` } from credentials',
    'inbox = email(credentials: `Dealflow Inbox`)',
    'movement m(msg: <inbox-[:message]->>) {',
    ...body,
    '}',
  ].join('\n');

/** [what, the v5 body, the v4 body]: each writes the same notes. */
const PAIRS: [string, string[], string[]][] = [
  [
    'closure-taking built-ins bound in v5 order, sort with no key, indexing',
    [
      '  words = Text.split(msg.`text`, " ")',
      '  loud = map(words, (w) => Text.upper(w), { concurrency: 2 })',
      '  total = reduce(words, (a: <number>, w: <text>) => a + Text.length(w), 0)',
      '  kept = filter(loud, (w) => w != "A")',
      '  ranked = sort(kept, { order: "desc" })',
      '  groups = List.groupBy(words, (w) => "${Text.length(w)}")',
      '  write inbox-[:note]-> { body: "${Text.join(ranked, ",")}|${sort(words)[0]}|${total}|${count(groups)}" }',
    ],
    [
      '  words = SPLIT(msg.`text`, " ")',
      '  loud = MAP(words, { concurrency: 2 }, (w) => UPPER(w))',
      '  total = REDUCE(words, 0, (a: <number>, w: <text>) => a + LENGTH(w))',
      '  kept = FILTER(loud, (w) => w != "A")',
      '  ranked = SORT(kept, DESC)',
      '  groups = GROUPBY(words, (w) => "${LENGTH(w)}")',
      '  write inbox-[:note]-> { body: "${JOIN(ranked, ",")}|${AT(SORT(words), 0)}|${total}|${COUNT(groups)}" }',
    ],
  ],
];

const recorded: RunEngineRecord[] = [];
beforeEach(() => {
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});
afterEach(() => setRunEngineRecorder(undefined));

/** The writes without their source spans, which the two spellings place differently. */
const bodies = (writes: unknown[]): unknown => JSON.parse(JSON.stringify(writes, (key, value: unknown) => (key === 'span' ? undefined : value)));

describe('the v5 spine gaps run as their v4 spelling does', () => {
  it.each(PAIRS)('%s', async (_what, v5, v4) => {
    const old = await runMovement(inputOf(V4(...v4), 4, 'run-v4'));
    const next = await runMovement(inputOf(V5(...v5), 5, 'run-v5'));
    expect(recorded.map((r) => r.engine)).toEqual(['ts', 'rust']);
    expect(old.writes.length).toBeGreaterThan(0);
    expect(bodies(next.writes)).toEqual(bodies(old.writes));
  });

  // The event names no record kind, so `is` stops both runs alike: the v5
  // condition reached the `is` test, not a parse refusal.
  it('is inside the if parentheses reaches the type test', async () => {
    const old = runMovement(inputOf(V4('  if msg IS <inbox-[:message]->> {', '    write inbox-[:note]-> { body: msg.`subject` }', '  }'), 4, 'run-v4'));
    const next = runMovement(inputOf(V5('  if (msg is <inbox-[:message]->>) {', '    write inbox-[:note]-> { body: msg.`subject` }', '  }'), 5, 'run-v5'));
    await expect(old).rejects.toThrow("can't tell what kind of record 'msg' is");
    await expect(next).rejects.toThrow("can't tell what kind of record 'msg' is");
    expect(recorded.map((r) => r.engine)).toEqual(['ts', 'rust']);
  });

  it('fail stops the run with its message, as ERROR does', async () => {
    const old = runMovement(inputOf(V4('  if msg.`subject` != NULL {', '    ERROR("no ${msg.`subject`}")', '  }'), 4, 'run-v4'));
    const next = runMovement(inputOf(V5('  if (msg.`subject` != null) {', '    fail("no ${msg.`subject`}")', '  }'), 5, 'run-v5'));
    await expect(old).rejects.toThrow('no Acme');
    await expect(next).rejects.toThrow('no Acme');
    expect(recorded.map((r) => r.engine)).toEqual(['ts', 'rust']);
  });
});
