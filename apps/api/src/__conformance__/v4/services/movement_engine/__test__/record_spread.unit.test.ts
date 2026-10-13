// Spreading a record, TypeScript-style, through the REAL interpreter — the
// plan's modern shape end to end:
//
//   detailed = MAP(companies, (c) => {
//     details = ONLY(extract([...content, TEXT.SERIALISE(c, 'JSON')], Detail))
//     return { ...c, ...details }        // or graph<Shape> { ...c, ...details }
//   })
//
// A map literal copies a record's fields (its dot plane) and a map's keys in
// the order written; an absent spread copies nothing. A graph literal copies
// one record as a snapshot by the checker's plan. And from language version 3
// a graph literal is checked against its shape when it is built, so a required
// field never silently ends up empty.

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
const detail = (summary: string) => ({ records: [{ summary: cite(summary, 2) }] });

const MERGED = [
  'node Merged {',
  '  name: <text>',
  '  site: <text | null>',
  '  summary: <text | null>',
  '  node round {',
  '    stage: <text>',
  '  }',
  '}',
];

const PER_COMPANY = (ret: string) => [
  '  content = [msg.`text`]',
  "  companies = extract(content, Company, { tier: 'careful' })",
  '  detailed = MAP(companies, (c) => {',
  "    details = ONLY(extract([...content, TEXT.SERIALISE(c, 'JSON')], Detail, { tier: 'careful' }))",
  `    return ${ret}`,
  '  })',
];

describe('{ ...c, ...details } — a map of the record and its detail', () => {
  it("copies each record's fields; an absent detail copies nothing", async () => {
    const { writes } = await run(
      [
        ...PER_COMPANY('{ ...c, ...details }'),
        '  MAP(detailed, (d) => {',
        '    write crm-[:companies]-> { name: d.name, stage: COALESCE(d.summary, "none") }',
        '  })',
      ],
      [COMPANIES, detail('A does infra'), { records: [] }],
    );
    expect(writes.map((w) => w.fields)).toEqual([
      { name: 'Acme', stage: 'A does infra' },
      { name: 'Beta', stage: 'none' },
    ]);
  });

  it('a later key wins over an earlier one, in the order written', async () => {
    const { writes } = await run(
      [
        ...PER_COMPANY('{ summary: "unknown", ...details, name: UPPER(c.name) }'),
        '  MAP(detailed, (d) => {',
        '    write crm-[:companies]-> { name: d.name, stage: d.summary }',
        '  })',
      ],
      [COMPANIES, detail('A does infra'), { records: [] }],
    );
    expect(writes.map((w) => w.fields)).toEqual([
      { name: 'ACME', stage: 'A does infra' },
      { name: 'BETA', stage: 'unknown' },
    ]);
  });
});

describe('graph<Shape> { ...c, ...details } — a snapshot of the record and its detail', () => {
  it('copies the fields the shape names and follows its child node through the same-named edge', async () => {
    const { writes } = await run(
      [
        ...MERGED,
        ...PER_COMPANY('graph<Merged> { ...c, ...details }'),
        '  MAP(detailed, (d) => {',
        '    write crm-[:companies]-> { name: d.name, stage: COALESCE(d.summary, "none") }',
        '    d-[r:round]-> {',
        '      write crm-[:companies]-> { name: r.stage }',
        '    }',
        '  })',
      ],
      [COMPANIES, detail('A does infra'), { records: [] }],
    );
    expect(writes.map((w) => w.fields)).toEqual([
      { name: 'Acme', stage: 'A does infra' },
      { name: 'Seed' },
      { name: 'Beta', stage: 'none' },
      { name: 'Series A' },
    ]);
  });
});

describe('a required graph field is never silently empty (version 3)', () => {
  const NOTE = ['node Note {', '  label: <text>', '}'];

  it('a value the checker could not see was absent fails the run when the graph is built', async () => {
    // The write's handle promises the system's `stage`, and the dry run hands
    // nothing back for it: present to the checker, absent at run time.
    const built = run(
      [
        ...NOTE,
        '  h = write crm-[:companies]-> { name: "Acme" }',
        '  g = graph<Note> { label: h.stage }',
        '  write crm-[:companies]-> { name: g.label }',
      ],
      [],
    );
    await expect(built).rejects.toThrow(/the value built for 'graph<Note>' doesn't fit it: it has no `label`/);
  });
});

describe('write … { ...e } drops children; graph<Shape> { ...e } keeps them', () => {
  const ENTRY = ['node Entry {', '  name: <text>', '  node child {', '    first: <text>', '  }', '}'];

  it("a write spread carries only e's fields; a graph-literal spread carries its children too", async () => {
    const { result } = await run(
      [
        ...ENTRY,
        '  sink = node { entries: <Entry> order by arrival }',
        '  copies = node { entries: <Entry> order by arrival }',
        '  marks = node { entries: <Entry> order by arrival }',
        '  e = write sink-[:entries]-> { name: "Acme" }',
        '  write e-[:child]-> { first: "Ann" }',
        '  write e-[:child]-> { first: "Bob" }',
        '  write copies-[:entries]-> { ...e }',
        '  g = graph<Entry> { ...e }',
        '  g-[c:child]-> {',
        '    write marks-[:entries]-> { name: "FOUND-${c.first}" }',
        '  }',
      ],
      [],
    );

    const written = result.writes.map((w) => w.writtenValues);
    // e's own two children, from seeding it — not from any spread.
    expect(written.filter((w) => w.first !== undefined)).toEqual([{ first: 'Ann' }, { first: 'Bob' }]);
    // the write spread's copy: Acme's name, and nothing for its children —
    // copies holds exactly one record, with no child writes trailing it.
    expect(written.filter((w) => w.name === 'Acme')).toHaveLength(2); // the original + the copy
    // the graph-literal spread: g's children are there to walk.
    expect(written.filter((w) => typeof w.name === 'string' && w.name.startsWith('FOUND-'))).toEqual([
      { name: 'FOUND-Ann' },
      { name: 'FOUND-Bob' },
    ]);
  });
});
