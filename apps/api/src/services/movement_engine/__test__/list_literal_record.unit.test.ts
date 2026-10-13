// A record carried through a list literal — `[e]`, then `MAP([e], (x) => …)`
// or `FIRST([e])` — is the record `e` holds: the same value and the same type,
// so a spread `{ ...x }`, a field read and a write treat it as they treat `e`.
//
// The production failure (run 32647709): `graph<Entry> { ...x }` inside
// `FIRST(MAP([e], (x) => …))` validated, then failed every member with
// "'...x' spreads a map into a graph, and 'x' holds no value". The cause was
// the MAP sitting INSIDE an expression: the checker and the engine each read
// that call from its text, so the copy plan the checker settled on the spread
// never reached the statements the engine ran.

// ── Jest module workarounds (mirrors declared_shape_reuse.unit.test.ts) ─────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../knowledge_pipeline/output_v3/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../translation_graph/adapters/knowledge_graph', () => ({
  KG_ADAPTER_TYPE: 'kg',
  KG_MANIFEST: {
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
      'getPriorMatch', 'recordLink',
    ],
    triggerKinds: ['KG_MUTATION'],
  },
  createKnowledgeGraphAdapter: jest.fn(() => ({ adapterType: 'kg' })),
}));

jest.mock('../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import { containerAssociation, type Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000077');

function fakeAdapter(adapterType: string): Adapter {
  let n = 0;
  return {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => ({ traversal: { incoming: true, edgeProperties: true }, resources: true }),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord() {
      n += 1;
      return { adapterType, externalId: `ext-${adapterType}-${n}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
}

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm = attio(credentials: acme_main)',
  'node `Recap Entry` {',
  '  name: <text>',
  '  thesis: <text | null>',
  '  website: <text | null>',
  '  node founder {',
  '    first: <text>',
  '  }',
  '}',
  'node Enrichment: "more about the company named last" {',
  '  name: <text | null> "its proper name"',
  '  thesis: <text | null> "what it does, in a line"',
  '  website: <text | null> "its website"',
  '}',
].join('\n');

const COLLECTION = '  deduped = node { entries: <`Recap Entry`> order by arrival }';

const READ_BACK = [
  '  deduped-[x:entries]-> {',
  '    write crm-[:companies]-> { name: "${x.name}|${COALESCE(x.thesis, \'-\')}" }',
  '  }',
];

function event(): TriggerEvent {
  return {
    pipelineInputId: 'pi-list-literal-record',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Recap', text: 'Acme and Beta pitched.' },
  };
}

async function run(body: string[]) {
  const writes: CapturedWrite[] = [];
  const result = await runMovement({
    source: [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n'),
    event: event(),
    teamId: TEAM_ID,
    catalog,
    host: makeTestHost({
      writeSink: (w) => writes.push(w),
      adapters: { resolve: ({ adapterType }) => fakeAdapter(adapterType) },
    }),
    dryRun: true,
  });
  return { writes, result };
}

const names = (writes: CapturedWrite[]) => writes.map((w) => w.fields?.name);

const SEED = [
  COLLECTION,
  '  write deduped-[:entries]-> { unique by (FUZZY name)',
  '    name: "Acme"',
  '    thesis: "infra"',
  '  }',
  '  write deduped-[:entries]-> { unique by (FUZZY name)',
  '    name: "Beta"',
  '  }',
];

describe('the production shape: a graph spread of the inner MAP parameter', () => {
  it('copies the record, member by member', async () => {
    const { writes } = await run([
      ...SEED,
      '  MAP(deduped-[:entries]->, { concurrency: 6 }, (e) => {',
      '    details = FIRST(MAP([e], (x) => {',
      '      current = graph<`Recap Entry`> { ...x }',
      '      return current',
      '    }))',
      '    write crm-[:companies]-> { name: "copy ${details.name}|${COALESCE(details.thesis, \'-\')}" }',
      '  })',
    ]);
    expect(names(writes).sort()).toEqual(['copy Acme|infra', 'copy Beta|-']);
  });

  it('is the MAP inside an expression, not the list: a nested MAP over a traversal spreads too', async () => {
    const { writes } = await run([
      ...SEED,
      '  got = FIRST(MAP(deduped-[:entries]->, (x) => {',
      '    g = graph<`Recap Entry`> { ...x }',
      '    return g',
      '  }))',
      '  write crm-[:companies]-> { name: "nested ${got.name}|${COALESCE(got.thesis, \'-\')}" }',
    ]);
    expect(names(writes)).toEqual(['nested Acme|infra']);
  });
});

describe('a record through a list literal is the record', () => {
  const FORMS: Array<[string, (inner: string[]) => string[]]> = [
    [
      'the parameter of a MAP over a traversal',
      (inner) => [...SEED, '  MAP(deduped-[:entries]->, (e) => {', ...inner, '  })'],
    ],
    [
      'the alias of a block head',
      (inner) => [...SEED, '  deduped-[e:entries]-> {', ...inner, '  }'],
    ],
    [
      'a saved write result',
      (inner) => [
        COLLECTION,
        '  e = write deduped-[:entries]-> { name: "Gamma"',
        '    thesis: "robots"',
        '  }',
        ...inner,
      ],
    ],
  ];

  describe.each(FORMS)('%s', (_label, wrap) => {
    const expected = (prefix: string) =>
      _label === 'a saved write result' ? [`${prefix} Gamma|robots`] : [`${prefix} Acme|infra`, `${prefix} Beta|-`];

    it('MAP([e], (x) => x.field)', async () => {
      const { writes } = await run(
        wrap([
          '    got = FIRST(MAP([e], (x) => "${x.name}|${COALESCE(x.thesis, \'-\')}"))',
          '    write crm-[:companies]-> { name: "read ${got}" }',
        ]),
      );
      expect(names(writes)).toEqual(expected('read'));
    });

    it('MAP([e], (x) => graph<Shape> { ...x })', async () => {
      const { writes } = await run(
        wrap([
          '    got = FIRST(MAP([e], (x) => {',
          '      g = graph<`Recap Entry`> { ...x }',
          '      return g',
          '    }))',
          '    write crm-[:companies]-> { name: "graph ${got.name}|${COALESCE(got.thesis, \'-\')}" }',
        ]),
      );
      expect(names(writes)).toEqual(expected('graph'));
    });

    it('MAP([e], (x) => { ...x }) into a map literal', async () => {
      const { writes } = await run(
        wrap([
          '    got = FIRST(MAP([e], (x) => {',
          '      copied = { ...x, tag: "t" }',
          '      return copied',
          '    }))',
          '    write crm-[:companies]-> { name: "map ${got.name}|${COALESCE(got.thesis, \'-\')}" }',
        ]),
      );
      expect(names(writes)).toEqual(expected('map'));
    });

    it('FIRST([e]), then a spread', async () => {
      const { writes } = await run(
        wrap([
          '    one = FIRST([e])',
          '    got = graph { ...one }',
          '    write crm-[:companies]-> { name: "first ${got.name}|${COALESCE(got.thesis, \'-\')}" }',
        ]),
      );
      expect(names(writes)).toEqual(expected('first'));
    });

    it('MAP([e], (x) => write x { … }) updates the record in place', async () => {
      const { writes } = await run([
        ...wrap(['    MAP([e], (x) => { write x { thesis: "via x" } })']),
        ...READ_BACK,
      ]);
      expect(names(writes).every((n) => typeof n === 'string' && n.endsWith('|via x'))).toBe(true);
    });
  });
});

describe('a map holding a record under a key, spread into a graph', () => {
  // Refused by the checker on every language version (MOV_GRAPH_SPREAD_RECORD,
  // B3): the run failed at the spread on every run that reached it. The
  // engine's own refusal (`spreadIntoGraph`) stays for what no check saw.
  const RECORD_IN_FIELD = /MOV_GRAPH_SPREAD_RECORD .*'held\.owner' is .* — a record, not a value/;
  const RECORD_IN_CHILD = /MOV_GRAPH_SPREAD_RECORD .*'held\.founder\[…\]' is .* — a record, not a value/;

  it('with no shape: refused where it is written, naming the key, never the record stored as a field', async () => {
    await expect(
      run([
        ...SEED,
        '  e = FIRST(deduped-[:entries]->)',
        '  held = { name: "x", owner: e }',
        '  g = graph { ...held }',
        '  write crm-[:companies]-> { name: g.name }',
      ]),
    ).rejects.toThrow(RECORD_IN_FIELD);
  });

  it('with a shape declaring the key a child, holding records by key: the same refusal', async () => {
    await expect(
      run([
        ...SEED,
        '  byName = KEYBY(deduped-[:entries]->, (x) => x.name)',
        '  held = { name: "x", founder: byName }',
        '  g = graph<`Recap Entry`> { ...held }',
        '  write crm-[:companies]-> { name: g.name }',
      ]),
    ).rejects.toThrow(RECORD_IN_CHILD);
  });
});
