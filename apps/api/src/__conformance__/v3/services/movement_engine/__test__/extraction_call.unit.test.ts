// `extract(content, Shape, config)` through the REAL interpreter, with a fake
// model client that records every call.
//
// What is held here is the cache-sensitive layout and what the run does with
// the answer: one system prompt for every call, each content item its own
// block in order, the shape last; breakpoints at the end of the prefix an
// earlier call already sent and at the end of the content; evidence that
// names the item it came from; one retry and then a raise, which `MAP`'s
// `onError` decides about.

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
  EXTRACT_CALL_SYSTEM_PROMPT,
  ExtractCallPrefixes,
  type ExtractCallLlmInput,
  type ExtractCallLlmResult,
} from '../extraction_call';
import type { FileTextResolution } from '../extraction';
import type { MovementTraceEntry } from '../expression';
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

const extractions = (trace: MovementTraceEntry[]) =>
  trace.filter((e): e is Extract<MovementTraceEntry, { kind: 'extraction' }> => e.kind === 'extraction');

const COMPANIES = {
  records: [
    { name: cite('Acme', 0), employees: cite(40, 0), site: cite(null, 0), round: [{ stage: cite('Seed', 0) }] },
    { name: cite('Beta', 0), employees: cite(null, 0), site: cite('beta.dev', 1), round: [{ stage: cite('Series A', 0) }] },
  ],
};
const detail = (summary: string) => ({ records: [{ summary: cite(summary, 2) }] });

const FAN_OUT = [
  '  content = [msg.`text`, msg.`deck`]',
  "  companies = extract(content, Company, { tier: 'careful' })",
  '  details = MAP(companies, (c) => {',
  "    found = extract([...content, TEXT.SERIALISE(c, 'JSON')], Detail, { tier: 'careful' })",
  '    return ONLY(found)',
  '  })',
];

describe('the prompt is laid out for the cache', () => {
  it('one system prompt for every call, the content in order, the shape last', async () => {
    const { calls } = await run(FAN_OUT, [COMPANIES, detail('Acme builds infra'), detail('Beta does fintech')]);
    expect(calls).toHaveLength(3);
    // The system prompt names no shape, and is the same for both shapes.
    for (const call of calls) expect(call.system).toBe(EXTRACT_CALL_SYSTEM_PROMPT);
    expect(calls[0].system).not.toContain('employees');
    // Each content item is its own block, in the author's order.
    expect(calls[0].blocks.map((b) => b.text.split('\n')[0])).toEqual([
      '## Content item 0 (text)',
      '## Content item 1 (file "deck.pdf")',
      '## What to extract',
    ]);
    expect(calls[0].blocks[1].text).toContain('ACME DECK: we build infra.');
    // The shape — nested node included, in the one call — is the last block.
    const shape = calls[0].blocks[2].text;
    expect(shape).toContain("`name` (text): the company's name");
    expect(shape).toContain('`employees` (number): its headcount');
    expect(shape).toContain('**round** (an array under the key `round` inside each **Company**)');
    expect(calls[1].blocks[3].text).toContain('`summary` (text): one line on what it does');
    // A per-entity call starts with the root call's content, byte for byte.
    expect(calls[1].blocks.slice(0, 2).map((b) => b.text)).toEqual(calls[0].blocks.slice(0, 2).map((b) => b.text));
    expect(calls[1].blocks[2].text).toMatch(/^## Content item 2 \(text\)\n\{/);
    expect(calls[1].blocks[2].text).toContain('"name": "Acme"');
  });

  it('the model and effort are the tier\'s, and an override wins', async () => {
    const { calls } = await run(
      ["  found = extract([msg.`text`], Detail, { tier: 'careful', effort: 'medium', model: 'claude-opus-5' })"],
      [detail('x')],
    );
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5', effort: 'medium' });
    const tiered = await run(["  found = extract([msg.`text`], Detail, { tier: 'careful' })"], [detail('x')]);
    expect(tiered.calls[0]).toMatchObject({ model: 'sonnet', effort: 'high', maxTokens: 64000 });
  });
});

describe('cache breakpoints', () => {
  const marks = (call: ExtractCallLlmInput) =>
    call.blocks.flatMap((b, i) => (b.cacheBreakpoint ? [i] : []));

  it('the first call marks the end of its content; a later call marks the shared prefix too', async () => {
    const { calls, result } = await run(FAN_OUT, [COMPANIES, detail('a'), detail('b')]);
    // First call: nothing sent before — one breakpoint, after the last content item.
    expect(marks(calls[0])).toEqual([1]);
    // Per-entity calls share the first two items: a breakpoint where the shared
    // prefix ends and one at the end of their own content. Never the shape block.
    expect(marks(calls[1])).toEqual([1, 2]);
    expect(marks(calls[2])).toEqual([1, 2]);
    const entries = extractions(result.trace);
    expect(entries.map((e) => e.cache)).toEqual([
      { breakpoints: [1], sharedItems: 0, inputTokens: 100, readTokens: 0, writeTokens: 20 },
      { breakpoints: [1, 2], sharedItems: 2, inputTokens: 100, readTokens: 80, writeTokens: 20 },
      { breakpoints: [1, 2], sharedItems: 2, inputTokens: 100, readTokens: 80, writeTokens: 20 },
    ]);
    expect(entries.every((e) => e.form === 'call')).toBe(true);
  });

  it('the same content again needs only the one breakpoint', () => {
    const prefixes = new ExtractCallPrefixes();
    expect(prefixes.plan('m', ['a', 'b'])).toEqual({ breakpoints: [1], sharedItems: 0 });
    expect(prefixes.plan('m', ['a', 'b'])).toEqual({ breakpoints: [1], sharedItems: 2 });
    expect(prefixes.plan('m', ['a', 'c'])).toEqual({ breakpoints: [0, 1], sharedItems: 1 });
    // A different model reads a different cache.
    expect(prefixes.plan('other', ['a', 'b'])).toEqual({ breakpoints: [1], sharedItems: 0 });
    // An item is identified with its place: the same text later is not a prefix.
    expect(prefixes.plan('m', ['b', 'a'])).toEqual({ breakpoints: [1], sharedItems: 0 });
  });
});

describe('the call nests inside an expression (language version 3)', () => {
  it('ONLY(extract(…)) is the one record it found', async () => {
    const { calls, writes } = await run(
      [
        '  first = ONLY(extract([msg.`text`], Detail))',
        // ONLY may find nothing, so a field read off it may be absent.
        '  write crm-[:companies]-> { name: COALESCE(first.summary, "") }',
      ],
      [detail('Acme builds infra')],
    );
    expect(calls).toHaveLength(1);
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Acme builds infra' }]);
  });

  it('a field reads off any call: ONLY(extract(…)).summary', async () => {
    const { calls, writes } = await run(
      ['  write crm-[:companies]-> { name: COALESCE(ONLY(extract([msg.`text`], Detail)).summary, "none") }'],
      [detail('read off the call')],
    );
    expect(calls).toHaveLength(1);
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'read off the call' }]);
  });

  it('a field reads off a call that runs nothing: FIRST(found).name', async () => {
    const { writes } = await run(
      ['  found = extract([msg.`text`], Company)', '  write crm-[:companies]-> { name: COALESCE(FIRST(found).name, "none") }'],
      [COMPANIES],
    );
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Acme' }]);
  });

  it('EXTRACT(…) in any letter case is the extraction call', async () => {
    const { calls, writes } = await run(
      ['  found = EXTRACT([msg.`text`], Company)', '  write crm-[:companies]-> { name: JOIN(MAP(found, (c) => c.name), ", ") }'],
      [COMPANIES],
    );
    expect(calls).toHaveLength(1);
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Acme, Beta' }]);
  });

  it('as a collection op reads it, inside a write field', async () => {
    const { writes } = await run(
      ['  write crm-[:companies]-> { name: JOIN(MAP(extract([msg.`text`], Company), (c) => c.name), ", ") }'],
      [COMPANIES],
    );
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Acme, Beta' }]);
  });

  it("a declaration's name bound to another name is the same shape", async () => {
    const aliased = await run(
      [
        '  D = Detail',
        '  found = extract([msg.`text`], D)',
        '  MAP(found, (d) => { write crm-[:companies]-> { name: d.summary } })',
      ],
      [detail('hello')],
    );
    const direct = await run(
      [
        '  found = extract([msg.`text`], Detail)',
        '  MAP(found, (d) => { write crm-[:companies]-> { name: d.summary } })',
      ],
      [detail('hello')],
    );
    expect(aliased.writes.map((w) => w.fields)).toEqual([{ name: 'hello' }]);
    expect(aliased.calls[0].blocks.at(-1)!.text).toBe(direct.calls[0].blocks.at(-1)!.text);
  });
});

describe('the records', () => {
  it('read by field and path; evidence names the content item it came from', async () => {
    const { writes, result } = await run(
      [
        '  content = [msg.`text`, msg.`deck`]',
        '  companies = extract(content, Company)',
        '  MAP(companies, (c) => {',
        '    c-[r:round WHERE r.stage = "Seed"]-> {',
        '      write crm-[:companies]-> { name: c.name, stage: r.stage }',
        '    }',
        '  })',
      ],
      [COMPANIES],
    );
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Acme', stage: 'Seed' }]);
    const origin = result.writes[0].provenance.name[0];
    expect(origin).toMatchObject({ kind: 'extraction', field: 'name', quote: 'q', item: 0 });
  });

  it('text nobody found reads as "", a typed field as absent', async () => {
    const { writes } = await run(
      [
        '  companies = extract([msg.`text`], Company)',
        '  MAP(companies, (c) => {',
        '    write crm-[:companies]-> { name: "${c.name}|${COALESCE(c.employees, -1)}|${COALESCE(c.site, \'none\')}" }',
        '  })',
      ],
      [{ records: [{ name: cite(null, 0), employees: cite(null, 0), site: cite(null, 0), round: [{ stage: cite('Seed', 0) }] }] }],
    );
    expect(writes.map((w) => w.fields)).toEqual([{ name: '|-1|none' }]);
  });

  it('a record answered with nothing in it is dropped, and the trace keeps what the model said', async () => {
    const blank = { name: cite(null, 0), employees: cite(null, 0), site: cite(null, 0), round: [] };
    const { result } = await run(
      ['  companies = extract([msg.`text`], Company)'],
      [{ records: [blank, COMPANIES.records[0]] }],
    );
    const [entry] = extractions(result.trace);
    expect(entry.emissions).toEqual({ Company: 2 });
    expect(entry.empty).toEqual({ Company: 1 });
    expect(entry.dropped).toEqual({ Company: 1 });
    expect(entry.reply?.why).toEqual(['dropped_records']);
    expect(entry.reply?.keys).toEqual(['records']);
    expect(entry.reply?.sample).toContain('Acme');
  });

  it('a reply with no records says so, with the reply beside it', async () => {
    const { result } = await run(['  companies = extract([msg.`text`], Company)'], [{ records: [] }]);
    const [entry] = extractions(result.trace);
    expect(entry.emissions).toEqual({ Company: 0 });
    expect(entry.reply?.why).toEqual(['no_entities']);
  });

  it('a healthy reply keeps no digest', async () => {
    const { result } = await run(['  companies = extract([msg.`text`], Company)'], [COMPANIES]);
    expect(extractions(result.trace)[0].reply).toBeUndefined();
  });

  it('a citation of an item that was never shown is no citation', async () => {
    const { result } = await run(
      [
        '  found = extract([msg.`text`], Detail)',
        '  MAP(found, (d) => { write crm-[:companies]-> { name: d.summary } })',
      ],
      [{ records: [{ summary: cite('x', 7) }] }],
    );
    expect(result.writes[0].provenance.name[0]).not.toHaveProperty('item');
  });

  it('a shape written in place, and one declared in the body, extract the same way', async () => {
    const inline = await run(
      [
        '  found = extract([msg.`text`], node Note: "each note" {',
        '    summary: <text> "the note"',
        '  })',
        '  MAP(found, (n) => { write crm-[:companies]-> { name: n.summary } })',
      ],
      [{ records: [{ summary: cite('hello', 0) }] }],
    );
    const local = await run(
      [
        '  node Note: "each note" {',
        '    summary: <text> "the note"',
        '  }',
        '  found = extract([msg.`text`], Note)',
        '  MAP(found, (n) => { write crm-[:companies]-> { name: n.summary } })',
      ],
      [{ records: [{ summary: cite('hello', 0) }] }],
    );
    expect(inline.writes.map((w) => w.fields)).toEqual([{ name: 'hello' }]);
    expect(local.writes.map((w) => w.fields)).toEqual([{ name: 'hello' }]);
    expect(inline.calls[0].blocks.at(-1)!.text).toBe(local.calls[0].blocks.at(-1)!.text);
  });
});

describe('a reply the shape does not describe', () => {
  it('is asked once more, with the same content blocks', async () => {
    const { calls, writes, result } = await run(
      [
        '  found = extract([msg.`text`], Detail)',
        '  MAP(found, (d) => { write crm-[:companies]-> { name: d.summary } })',
      ],
      [{ answer: [] }, detail('fixed')],
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].blocks.slice(0, -1)).toEqual(calls[0].blocks.slice(0, -1));
    expect(calls[1].blocks.at(-1)!.text).toContain('Your previous response had validation errors');
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'fixed' }]);
    expect(extractions(result.trace)[0].retried).toBeDefined();
  });

  it('twice, fails the run', async () => {
    await expect(run(['  found = extract([msg.`text`], Detail)'], [{ answer: [] }, { answer: [] }])).rejects.toThrow(
      /extraction of `Detail` was answered with something its shape does not describe, twice/,
    );
  });

  it('twice, leaves the reply it got on the trace', async () => {
    const { result } = await run(
      [
        '  content = [msg.`text`]',
        '  companies = extract(content, Company)',
        "  details = MAP(companies, { onError: 'warn' }, (c) => {",
        "    found = extract([...content, TEXT.SERIALISE(c, 'JSON')], Detail)",
        '    return ONLY(found)',
        '  })',
      ],
      [COMPANIES, { answer: [] }, { answer: [] }, { answer: [] }, { answer: [] }],
    );
    const failed = extractions(result.trace).find((e) => e.failed === 'invalid_reply');
    expect(failed?.reply?.why).toEqual(['failed', 'retried']);
    expect(failed?.reply?.keys).toEqual(['answer']);
  });

  it('twice inside a MAP with onError, leaves that member out and carries on', async () => {
    const { calls, writes, result } = await run(
      [
        '  content = [msg.`text`]',
        '  companies = extract(content, Company)',
        "  details = MAP(companies, { onError: 'warn' }, (c) => {",
        "    found = extract([...content, TEXT.SERIALISE(c, 'JSON')], Detail)",
        '    return ONLY(found)',
        '  })',
        '  MAP(details, (d) => { write crm-[:companies]-> { name: COALESCE(d.summary, "") } })',
      ],
      [COMPANIES, { answer: [] }, { answer: [] }, detail('Beta does fintech')],
    );
    expect(calls).toHaveLength(4);
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Beta does fintech' }]);
    expect(result.trace.some((e) => e.kind === 'warning')).toBe(true);
  });
});

describe('extractOne(content, Shape) — the single record, or absent', () => {
  const one = (summary: string) => ({ record: { summary: cite(summary, 0) } });
  const WRITE_SUMMARY = '  write crm-[:companies]-> { name: COALESCE(d.summary, "none") }';
  const single = (replies: Reply[]) =>
    run(['  d = extractOne([msg.`text`], Detail)', WRITE_SUMMARY], replies);

  it('asks for the single one the sources describe, in the shape\'s own words, and answers one record or null', async () => {
    const { calls } = await single([one('Acme builds infra')]);
    const ask = calls[0].blocks.at(-1)!.text;
    expect(ask).toContain(
      "Extract more about the company described last — the single one these sources describe, or nothing if they don't.",
    );
    expect(ask).toContain('**Detail**: more about the company described last — the one record, as the object under `record`');
    expect(ask).toContain('whose value is the one record as a bare JSON object — or null when these sources describe none');
    expect(ask).not.toContain('emit each one');
    expect(ask).not.toContain('`records`');
    // `extract` still asks for each one, as a list.
    const each = await run(['  found = extract([msg.`text`], Detail)'], [detail('x')]);
    const eachAsk = each.calls[0].blocks.at(-1)!.text;
    expect(eachAsk).toContain('emit each one as an element of the `records` array');
    expect(eachAsk).not.toContain('the single one');
    // Only the last block differs: the system prompt and the content are the same.
    expect(calls[0].system).toBe(each.calls[0].system);
    expect(calls[0].blocks.slice(0, -1)).toEqual(each.calls[0].blocks.slice(0, -1));
  });

  it('a shape with no description is asked for by its name', async () => {
    const { calls } = await run(
      ['  d = extractOne([msg.`text`], node Note: "" {', '    summary: <text> "the note"', '  })'],
      [{ record: null }],
    );
    expect(calls[0].blocks.at(-1)!.text).toContain(
      "Extract the single **Note** these sources describe, or nothing if they don't.",
    );
  });

  it('one record is the record', async () => {
    const { writes, result } = await single([one('Acme builds infra')]);
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Acme builds infra' }]);
    expect(result.writes[0].provenance.name[0]).toMatchObject({ kind: 'extraction', field: 'summary', item: 0 });
    expect(extractions(result.trace)[0]).toMatchObject({ emissions: { Detail: 1 } });
  });

  it('null — or an empty list — is absent', async () => {
    const none = await single([{ record: null }]);
    expect(none.writes.map((w) => w.fields)).toEqual([{ name: 'none' }]);
    const [entry] = extractions(none.result.trace);
    expect(entry.emissions).toEqual({ Detail: 0 });
    expect(entry.reply?.why).toEqual(['no_entities']);
    const empty = await single([{ record: [] }]);
    expect(empty.writes.map((w) => w.fields)).toEqual([{ name: 'none' }]);
  });

  it('a list holding the one record is that record', async () => {
    const { writes, calls } = await single([{ record: [{ summary: cite('listed', 0) }] }]);
    expect(calls).toHaveLength(1);
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'listed' }]);
  });

  it('a record with nothing in it is absent, and the trace keeps what the model said', async () => {
    const { writes, result } = await single([{ record: { summary: cite(null, 0) } }]);
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'none' }]);
    const [entry] = extractions(result.trace);
    expect(entry.emissions).toEqual({ Detail: 1 });
    expect(entry.dropped).toEqual({ Detail: 1 });
    expect(entry.reply?.why).toEqual(['dropped_records']);
    expect(entry.reply?.keys).toEqual(['record']);
  });

  it('several records is a malformed reply: asked once more, saying so', async () => {
    const two = { record: [{ summary: cite('a', 0) }, { summary: cite('b', 0) }] };
    const { calls, writes, result } = await single([two, one('the one')]);
    expect(calls).toHaveLength(2);
    expect(calls[1].blocks.slice(0, -1)).toEqual(calls[0].blocks.slice(0, -1));
    const retry = calls[1].blocks.at(-1)!.text;
    expect(retry).toContain('2 records were answered, and this asks for the single one');
    expect(retry).toContain('with the one record (or null) under `record`');
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'the one' }]);
    expect(extractions(result.trace)[0].retried).toBeDefined();
  });

  it('several records twice fails the run, and leaves the reply on the trace', async () => {
    const two = { record: [{ summary: cite('a', 0) }, { summary: cite('b', 0) }] };
    await expect(single([two, two])).rejects.toThrow(
      /extraction of `Detail` was answered with something its shape does not describe, twice: record — 2 records were answered/,
    );
    const { result } = await run(
      [
        '  content = [msg.`text`]',
        '  companies = extract(content, Company)',
        "  details = MAP(companies, { onError: 'warn' }, (c) => {",
        "    return extractOne([...content, TEXT.SERIALISE(c, 'JSON')], Detail)",
        '  })',
      ],
      [COMPANIES, two, two, one('Beta does fintech')],
    );
    const failed = extractions(result.trace).find((e) => e.failed === 'invalid_reply');
    expect(failed?.reply?.why).toEqual(['failed', 'retried']);
    expect(failed?.reply?.keys).toEqual(['record']);
  });

  it('a reply without the record is malformed too', async () => {
    await expect(single([{ records: [] }, { answer: null }])).rejects.toThrow(/answered with something its shape does not describe, twice/);
  });

  it('shares the cached content with the root extract, breakpoints as for extract', async () => {
    const marks = (call: ExtractCallLlmInput) => call.blocks.flatMap((b, i) => (b.cacheBreakpoint ? [i] : []));
    const FAN_OUT_ONE = [
      '  content = [msg.`text`, msg.`deck`]',
      "  companies = extract(content, Company, { tier: 'careful' })",
      '  detailed = MAP(companies, (c) => {',
      "    details = extractOne([...content, TEXT.SERIALISE(c, 'JSON')], Detail, { tier: 'careful' })",
      '    return { ...c, ...details }',
      '  })',
    ];
    const enriched = await run(FAN_OUT_ONE, [COMPANIES, one('a'), one('b')]);
    const listed = await run(FAN_OUT, [COMPANIES, detail('a'), detail('b')]);
    expect(enriched.calls.map(marks)).toEqual([[1], [1, 2], [1, 2]]);
    expect(enriched.calls.map(marks)).toEqual(listed.calls.map(marks));
    // A per-entity call starts with the root call's content, byte for byte.
    expect(enriched.calls[1].blocks.slice(0, 2)).toEqual(enriched.calls[0].blocks.slice(0, 2));
    expect(enriched.calls.map((c) => c.blocks.slice(0, -1))).toEqual(listed.calls.map((c) => c.blocks.slice(0, -1)));
    expect(extractions(enriched.result.trace).map((e) => e.cache)).toEqual(
      extractions(listed.result.trace).map((e) => e.cache),
    );
  });

  it('spreads into the record it enriches', async () => {
    const { writes } = await run(
      [
        '  companies = extract([msg.`text`], Company)',
        '  detailed = MAP(companies, (c) => {',
        "    details = extractOne([msg.`text`, TEXT.SERIALISE(c, 'JSON')], Detail)",
        '    return { ...c, ...details }',
        '  })',
        '  MAP(detailed, (d) => { write crm-[:companies]-> { name: "${d.name}: ${COALESCE(d.summary, \'?\')}" } })',
      ],
      [COMPANIES, one('infra'), { record: null }],
    );
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'Acme: infra' }, { name: 'Beta: ?' }]);
  });

  it('nests inside an expression, and reads a field off the call', async () => {
    const { writes } = await run(
      ['  write crm-[:companies]-> { name: COALESCE(extractOne([msg.`text`], Detail).summary, "none") }'],
      [one('nested')],
    );
    expect(writes.map((w) => w.fields)).toEqual([{ name: 'nested' }]);
  });
});

describe('what a call extracted is on its trace entry', () => {
  const find = (finds: 'extract' | 'extractOne', shape: string, reply: unknown) =>
    run([`  found = ${finds}([msg.\`text\`], ${shape}, { tier: 'careful' })`], [reply]);

  it('a list: every record by node name, nested records under their own name', async () => {
    const { result } = await find('extract', 'Company', COMPANIES);
    const [entry] = extractions(result.trace);
    expect(entry.entities).toEqual({
      Company: [
        { fields: { name: 'Acme', employees: '40', site: null } },
        { fields: { name: 'Beta', employees: null, site: 'beta.dev' } },
      ],
      round: [{ fields: { stage: 'Seed' } }, { fields: { stage: 'Series A' } }],
    });
    expect(entry.truncatedCount).toBeUndefined();
  });

  it('a single record', async () => {
    const { result } = await find('extractOne', 'Detail', { record: { summary: cite('Acme builds infra', 0) } });
    expect(extractions(result.trace)[0].entities).toEqual({ Detail: [{ fields: { summary: 'Acme builds infra' } }] });
  });

  it('absent: no entities on the entry', async () => {
    const { result } = await find('extractOne', 'Detail', { record: null });
    expect(extractions(result.trace)[0].entities).toBeUndefined();
  });

  it('the cap counts what it leaves out', async () => {
    const many = { records: Array.from({ length: 22 }, (_, i) => ({ summary: cite(`s${i}`, 0) })) };
    const { result } = await find('extract', 'Detail', many);
    const [entry] = extractions(result.trace);
    expect(entry.entities?.Detail).toHaveLength(20);
    expect(entry.truncatedCount).toEqual({ Detail: 2 });
  });
});
