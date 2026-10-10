// A map literal's field holding a LIST of records reads back as that list —
// the same list the name it was built from reads as — through the REAL
// interpreter, with a fake model client.
//
// The production failure (run d73dcf5c): `{ piece: p, entries: extract(…) }`
// stored the engine's wrapper for the extraction's records under `entries`,
// so a later `MAP(x.entries, …)` read back an object and failed the run.

// ── Jest module workarounds (mirrors extraction_call.unit.test.ts) ──────────

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

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { mockCatalog, type InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import {
  type ExtractCallLlmInput,
  type ExtractCallLlmResult,
} from '../extraction_call';
import type { FileTextResolution } from '../extraction';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import {
  containerAssociation,
  type Adapter,
  type FileRef,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000053' as TeamId;

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
  positions: {
    message: {
      properties: { subject: 'text', text: 'text', deck: 'file' },
      edges: {},
    },
  },
  collections: {},
  writableRoots: {},
};
const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', stage: 'text', employees: 'number' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', employees: 'number' },
      resultShape: { externalId: 'text', name: 'text' },
    },
  },
};

const catalog = mockCatalog({
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
  'node Company: "each company named in this message" {',
  '  name: <text> "the company\'s name"',
  '  employees: <number> "its headcount"',
  '  site: <text | null> "its website"',
  '  node round: "each round it raised" {',
  '    stage: <text> "the stage"',
  '  }',
  '}',
  'node Detail: "more about the company described last" {',
  '  summary: <text> "one line on what it does"',
  '}',
].join('\n');

const DECK: FileRef = {
  __brand: 'FileRef',
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 1234,
  source: { ownerAdapterType: 'email', handle: 'attachment-1' },
};

function event(): TriggerEvent {
  return {
    pipelineInputId: 'pi-extract-call',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Deals', text: 'Acme (40 people) raised a Seed. Beta raised a Series A.', deck: DECK },
  };
}

const cite = (value: unknown, item: number, quote = 'q') => ({ value, evidence: { item, quote } });

type Reply = unknown | ((input: ExtractCallLlmInput) => unknown);

function fakeLlm(replies: Reply[]) {
  const calls: ExtractCallLlmInput[] = [];
  return {
    calls,
    client: {
      async call(input: ExtractCallLlmInput): Promise<ExtractCallLlmResult> {
        calls.push(input);
        if (calls.length > replies.length) throw new Error(`test: unexpected call #${calls.length}`);
        const reply = replies[calls.length - 1];
        const parsedJson = typeof reply === 'function' ? (reply as (i: ExtractCallLlmInput) => unknown)(input) : reply;
        return {
          parsedJson,
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: calls.length > 1 ? 80 : 0, cacheCreationTokens: 20 },
        };
      },
    },
  };
}

async function run(body: string[], replies: Reply[]) {
  const llm = fakeLlm(replies);
  const writes: CapturedWrite[] = [];
  const result = await runMovement({
    source: [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n'),
    event: event(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: ({ adapterType }) => fakeAdapter(adapterType),
    extractCallLlm: llm.client,
    resolveFileText: async (): Promise<FileTextResolution> => ({ text: 'ACME DECK: we build infra.', rawTextId: 'rt-1' }),
    dryRun: true,
    writeSink: (w) => writes.push(w),
  });
  return { calls: llm.calls, writes, result };
}


const COMPANIES = {
  records: [
    { name: cite('Acme', 0), employees: cite(40, 0), site: cite(null, 0), round: [{ stage: cite('Seed', 0) }] },
    { name: cite('Beta', 0), employees: cite(null, 0), site: cite('beta.dev', 1), round: [{ stage: cite('Series A', 0) }] },
  ],
};

const TEXT = 'Acme (40 people) raised a Seed. Beta raised a Series A.';

// The production shape (run d73dcf5c): each piece's extraction kept beside the
// piece in a map, and read back out of the map later.
const PIECES_MAP = [
  '  pieces = [msg.`subject`, msg.`text`]',
  '  results = MAP(pieces, (p) => {',
  "    return { piece: p, entries: extract([p], Company, { tier: 'careful' }) }",
  '  })',
];
const acme = { records: [COMPANIES.records[0]] };
const beta = { records: [COMPANIES.records[1]] };

async function names(body: string[], replies: Reply[] = [acme, beta]) {
  const { writes } = await run([...PIECES_MAP, ...body], replies);
  return writes.map((w) => w.fields?.name);
}

describe('a map field holding an extract(…) answer reads back as its list of records', () => {
  it('MAP over x.entries', async () => {
    expect(
      await names([
        '  MAP(results, (x) => {',
        '    write crm-[:companies]-> { name: "${x.piece}:${JOIN(MAP(x.entries, (e) => e.name), ",")}" }',
        '  })',
      ]),
    ).toEqual(['Deals:Acme', `${TEXT}:Beta`]);
  });

  it('FILTER, REDUCE, GROUPBY and KEYBY over x.entries', async () => {
    expect(
      await names([
        '  MAP(results, (x) => {',
        '    kept = FILTER(x.entries, (e) => e.name == "Beta")',
        '    total = REDUCE(x.entries, "", (acc, e) => "${acc}${e.name}")',
        '    grouped = GROUPBY(x.entries, (e) => e.name)',
        '    keyed = KEYBY(x.entries, (e) => e.name)',
        '    write crm-[:companies]-> { name: "${COUNT(kept)}|${total}|${COUNT(AT(grouped, FIRST(x.entries).name))}|${AT(keyed, FIRST(x.entries).name).name}" }',
        '  })',
      ]),
    ).toEqual(['0|Acme|1|Acme', '1|Beta|1|Beta']);
  });

  it('COUNT, FIRST and AT over x.entries', async () => {
    expect(
      await names([
        '  MAP(results, (x) => {',
        '    write crm-[:companies]-> { name: "${COUNT(x.entries)}|${FIRST(x.entries).name}|${AT(x.entries, 0).name}" }',
        '  })',
      ]),
    ).toEqual(['1|Acme|Acme', '1|Beta|Beta']);
  });

  it('a block head walks x.entries', async () => {
    expect(
      await names([
        '  MAP(results, (x) => {',
        '    x.entries-[r:round]-> {',
        '      write crm-[:companies]-> { name: r.stage }',
        '    }',
        '  })',
      ]),
    ).toEqual(['Seed', 'Series A']);
  });

  it('a block head walks a name bound to x.entries', async () => {
    expect(
      await names([
        '  MAP(results, (x) => {',
        '    es = x.entries',
        '    es-[r:round]-> {',
        '      write crm-[:companies]-> { name: r.stage }',
        '    }',
        '  })',
      ]),
    ).toEqual(['Seed', 'Series A']);
  });

  it('TEXT.PAIRS skips the list field, as it skips every non-scalar', async () => {
    expect(
      await names([
        '  MAP(results, (x) => {',
        '    write crm-[:companies]-> { name: TEXT.PAIRS(x) }',
        '  })',
      ]),
    ).toEqual(['piece=Deals', `piece=${TEXT}`]);
  });
});

describe('a map field holding records reached another way', () => {
  const ROWS = (field: string[]) => [
    '  companies = extract([msg.`text`], Company)',
    '  rows = MAP(companies, (c) => {',
    ...field,
    '  })',
    '  MAP(rows, (x) => {',
    '    write crm-[:companies]-> { name: "${x.name}:${COUNT(x.rounds)}:${JOIN(MAP(x.rounds, (r) => r.stage), ",")}" }',
    '  })',
  ];
  const EXPECTED = ['Acme:1:Seed', 'Beta:1:Series A'];

  it('a walk read written in the field', async () => {
    const { writes } = await run(ROWS(['    return { name: c.name, rounds: c-[:round]-> }']), [COMPANIES]);
    expect(writes.map((w) => w.fields?.name)).toEqual(EXPECTED);
  });

  it('a name bound to a walk read', async () => {
    const { writes } = await run(
      ROWS(['    walked = c-[:round]->', '    return { name: c.name, rounds: walked }']),
      [COMPANIES],
    );
    expect(writes.map((w) => w.fields?.name)).toEqual(EXPECTED);
  });

  it("a block's returned records", async () => {
    const { writes } = await run(
      ROWS(['    kept = c-[r:round]-> { return r }', '    return { name: c.name, rounds: kept }']),
      [COMPANIES],
    );
    expect(writes.map((w) => w.fields?.name)).toEqual(EXPECTED);
  });

  it('a list literal of an extract answer is a list holding that list', async () => {
    const { writes } = await run(
      [
        '  companies = extract([msg.`text`], Company)',
        '  nested = [companies]',
        '  write crm-[:companies]-> { name: "${COUNT(nested)}:${COUNT(AT(nested, 0))}" }',
      ],
      [COMPANIES],
    );
    expect(writes.map((w) => w.fields?.name)).toEqual(['1:2']);
  });
});

describe('the records a block returned, kept in a map at the top level', () => {
  it('read back as the list of them', async () => {
    const { writes } = await run(
      [
        '  companies = extract([msg.`text`], Company)',
        '  kept = companies-[r:round]-> { return r }',
        '  held = { rounds: kept }',
        '  write crm-[:companies]-> { name: "${COUNT(held.rounds)}:${JOIN(MAP(held.rounds, (r) => r.stage), ",")}" }',
      ],
      [COMPANIES],
    );
    expect(writes.map((w) => w.fields?.name)).toEqual(['2:Seed,Series A']);
  });
});
