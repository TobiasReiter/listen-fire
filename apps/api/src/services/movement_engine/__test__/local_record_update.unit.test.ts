// `write e { … }` where `e` is a record the RUN holds on one of its own edges —
// a landing on a run-local collection. The run's graph is the record's system
// and it updates by id, so the write merges into the landing in place, exactly
// as an update of a system record merges into that record: the same `?:`
// gate against current values, the same row on the firing log (marked local,
// uncommitted), and one writer at a time per record when a MAP runs its
// members concurrently.

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
import type { ExtractCallLlmInput, ExtractCallLlmResult } from '../extraction_call';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import { containerAssociation, type Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000077' as TeamId;

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

/** Every landing on `deduped`, read back through an ordinary traversal into a
 *  real write — the only honest way to see what is on the edge. */
const READ_BACK = [
  '  deduped-[x:entries]-> {',
  '    write crm-[:companies]-> { name: "${x.name}|${COALESCE(x.thesis, \'-\')}|${COALESCE(x.website, \'-\')}" }',
  '  }',
];

function event(): TriggerEvent {
  return {
    pipelineInputId: 'pi-local-record-update',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Recap', text: 'Acme and Beta pitched.' },
  };
}

const cite = (value: unknown) => ({ value, evidence: { item: 0, quote: 'q' } });

/** A model that answers per entry — keyed on the entry name the call's content
 *  carries — after a delay chosen per entry, so concurrent members finish in
 *  an order the test picks. */
function fakeLlm(answers: Record<string, { reply: unknown; delayMs?: number }>) {
  const calls: ExtractCallLlmInput[] = [];
  return {
    calls,
    client: {
      async call(input: ExtractCallLlmInput): Promise<ExtractCallLlmResult> {
        calls.push(input);
        const text = input.blocks.map((b) => b.text).join('\n');
        const key = Object.keys(answers).find((name) => text.includes(`"${name}"`));
        if (key === undefined) throw new Error(`test: no answer for a call about ${text.slice(-200)}`);
        const { reply, delayMs } = answers[key];
        if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { parsedJson: reply, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      },
    },
  };
}

async function run(body: string[], answers: Record<string, { reply: unknown; delayMs?: number }> = {}) {
  const llm = fakeLlm(answers);
  const writes: CapturedWrite[] = [];
  const result = await runMovement({
    source: [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n'),
    event: event(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: ({ adapterType }) => fakeAdapter(adapterType),
    extractCallLlm: llm.client,
    dryRun: true,
    writeSink: (w) => writes.push(w),
  });
  return { writes, result, calls: llm.calls };
}

const readBack = (writes: CapturedWrite[]) => writes.map((w) => w.fields?.name);
const localRows = (result: Awaited<ReturnType<typeof run>>['result']) =>
  result.writes.filter((w) => w.local !== undefined);

const SEED = [
  COLLECTION,
  '  write deduped-[:entries]-> { unique by (FUZZY name)',
  '    name: "Acme"',
  '  }',
  '  write deduped-[:entries]-> { unique by (FUZZY name)',
  '    name: "Beta"',
  '  }',
];

describe('the production shape: MAP enriches each entry in place', () => {
  const ENRICH = [
    ...SEED,
    '  content = [msg.`text`]',
    '  MAP(deduped-[:entries]->, { concurrency: 6, onError: "warn" }, (e) => {',
    "    details = extractOne([...content, TEXT.SERIALISE(e, 'JSON')], Enrichment, { tier: \"quick\" })",
    '    if details == null { return null }',
    '    write e {',
    '      name: COALESCE(details.name, e.name)',
    '      thesis: COALESCE(details.thesis, e.thesis)',
    '    }',
    '    new_website = details.website',
    '    if new_website != null { write e { website: new_website } }',
    '  })',
    ...READ_BACK,
  ];

  it('every entry reads back enriched, in arrival order, and the firing log shows local updates', async () => {
    const { writes, result } = await run(ENRICH, {
      // Acme answers LAST, so the members finish out of order.
      Acme: { reply: { record: { name: cite('Acme Inc'), thesis: cite('infra'), website: cite('acme.com') } }, delayMs: 30 },
      Beta: { reply: { record: { name: cite(null), thesis: cite('fintech'), website: cite(null) } }, delayMs: 0 },
    });
    expect(readBack(writes)).toEqual(['Acme Inc|infra|acme.com', 'Beta|fintech|-']);

    const rows = localRows(result);
    // Two creates, then Beta's one update (no website), then Acme's two.
    expect(rows.map((w) => [w.outcome, w.writtenValues])).toEqual([
      ['create', { name: 'Acme' }],
      ['create', { name: 'Beta' }],
      ['update', { thesis: 'fintech' }],
      ['update', { name: 'Acme Inc', thesis: 'infra' }],
      ['update', { website: 'acme.com' }],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ adapterType: 'local', recordType: 'entries', committed: false, local: { edge: 'entries' } });
      expect(row.externalId).toBeUndefined();
    }
  });

  it('an entry the model says nothing about is left as it was', async () => {
    const { writes } = await run(ENRICH, {
      Acme: { reply: { record: null } },
      Beta: { reply: { record: { name: cite(null), thesis: cite('fintech'), website: cite('beta.io') } } },
    });
    expect(readBack(writes)).toEqual(['Acme|-|-', 'Beta|fintech|beta.io']);
  });
});

describe('every name that holds the record updates it', () => {
  it('the saved write result — and the collection sees it', async () => {
    const { writes, result } = await run([
      ...SEED,
      '  h = write deduped-[:entries]-> { unique by (FUZZY name)',
      '    name: "Gamma"',
      '  }',
      '  write h { thesis: "robots" }',
      '  write crm-[:companies]-> { name: "via h: ${h.thesis}" }',
      ...READ_BACK,
    ]);
    expect(readBack(writes)).toEqual(['via h: robots', 'Acme|-|-', 'Beta|-|-', 'Gamma|robots|-']);
    expect(localRows(result).at(-1)).toMatchObject({
      outcome: 'update',
      writtenValues: { thesis: 'robots' },
      local: { edge: 'entries' },
      committed: false,
    });
  });

  it('the alias of a block head', async () => {
    const { writes } = await run([
      ...SEED,
      '  deduped-[e:entries]-> {',
      '    write e { thesis: "about ${e.name}" }',
      '  }',
      ...READ_BACK,
    ]);
    expect(readBack(writes)).toEqual(['Acme|about Acme|-', 'Beta|about Beta|-']);
  });

  it('a later identity write matches the record by its UPDATED key', async () => {
    const { writes, result } = await run([
      ...SEED,
      '  deduped-[e:entries WHERE e.name == "Acme"]-> {',
      '    write e { name: "Zeta" }',
      '  }',
      '  write deduped-[:entries]-> { unique by (name)',
      '    name: "Zeta"',
      '    thesis ?: "merged"',
      '  }',
      ...READ_BACK,
    ]);
    expect(readBack(writes)).toEqual(['Zeta|merged|-', 'Beta|-|-']);
    expect(localRows(result).map((w) => w.outcome)).toEqual(['create', 'create', 'update', 'update']);
  });
});

describe('`?:` on an update fills only what is empty', () => {
  it('a second fill finds the value the first one set, and writes nothing', async () => {
    const { writes, result } = await run([
      ...SEED,
      '  h = write deduped-[:entries]-> { name: "Gamma" }',
      '  write h { thesis ?: "first" }',
      '  write h { thesis ?: "second" }',
      ...READ_BACK,
    ]);
    expect(readBack(writes)).toContain('Gamma|first|-');
    expect(localRows(result).slice(-2).map((w) => [w.outcome, w.writtenValues])).toEqual([
      ['update', { thesis: 'first' }],
      ['noop', {}],
    ]);
  });
});

describe('concurrent members of a MAP', () => {
  it('two filling the SAME record merge one after the other: one fill lands, the other finds it there', async () => {
    const { writes, result } = await run([
      ...SEED,
      '  h = write deduped-[:entries]-> { name: "Gamma" }',
      '  MAP(["first", "second"], { concurrency: 2 }, (v) => {',
      '    write h { thesis ?: v }',
      '  })',
      ...READ_BACK,
    ]);
    expect(readBack(writes)).toContain('Gamma|first|-');
    expect(localRows(result).slice(-2).map((w) => w.outcome).sort()).toEqual(['noop', 'update']);
  });

  it('members updating DIFFERENT records each update their own', async () => {
    const { writes } = await run([
      ...SEED,
      '  MAP(deduped-[:entries]->, { concurrency: 6 }, (e) => {',
      '    write e { thesis: "t-${e.name}" }',
      '    write e { website ?: "${e.name}.com" }',
      '  })',
      ...READ_BACK,
    ]);
    expect(readBack(writes)).toEqual(['Acme|t-Acme|Acme.com', 'Beta|t-Beta|Beta.com']);
  });
});

describe('records nested under an updated one', () => {
  const FOUNDERS = [
    '  h-[f:founder]-> {',
    '    write crm-[:companies]-> { name: "founder ${f.first}" }',
    '  }',
  ];

  it('are untouched by the update of their parent', async () => {
    const { writes } = await run([
      COLLECTION,
      '  h = write deduped-[:entries]-> { name: "Acme" }',
      '  write h-[:founder]-> { first: "Jane" }',
      '  write h { thesis: "infra" }',
      ...FOUNDERS,
      ...READ_BACK,
    ]);
    expect(readBack(writes)).toEqual(['founder Jane', 'Acme|infra|-']);
  });

  it('update in place themselves, through their own handle', async () => {
    const { writes, result } = await run([
      COLLECTION,
      '  h = write deduped-[:entries]-> { name: "Acme" }',
      '  jane = write h-[:founder]-> { first: "Jane" }',
      '  write jane { first: "Janet" }',
      ...FOUNDERS,
    ]);
    expect(readBack(writes)).toEqual(['founder Janet']);
    expect(localRows(result).at(-1)).toMatchObject({ outcome: 'update', local: { edge: 'founder' } });
  });
});

describe("a graph<Shape>'s nested records", () => {
  it('written into, or built by the literal, update in place through a block alias', async () => {
    const { writes } = await run([
      '  found = graph<`Recap Entry`> { name: "root", founder: [{ first: "Ada" }] }',
      '  write found-[:founder]-> { first: "Grace" }',
      '  found-[p:founder]-> {',
      '    write p { first: "${p.first}!" }',
      '  }',
      '  found-[p2:founder]-> {',
      '    write crm-[:companies]-> { name: p2.first }',
      '  }',
    ]);
    expect(readBack(writes)).toEqual(['Ada!', 'Grace!']);
  });
});

describe('refused at validation', () => {
  it('a field the landing type does not have', async () => {
    await expect(
      run([...SEED, '  deduped-[e:entries]-> {', '    write e { nope: "x" }', '  }']),
    ).rejects.toThrow(/MOV_WRITE_UNKNOWN_FIELD/);
  });

  it('a graph<Shape> value — it is on no edge, so there is no record to update', async () => {
    await expect(
      run([
        COLLECTION,
        '  g = graph<`Recap Entry`> { name: "Acme" }',
        '  write g { thesis: "x" }',
      ]),
    ).rejects.toThrow(/MOV_WRITE_POSITION_NOT_RECORD/);
  });
});
