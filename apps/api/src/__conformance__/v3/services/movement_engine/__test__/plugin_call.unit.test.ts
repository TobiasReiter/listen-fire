// A PLUGIN CALLED PLAINLY — `page = fetch_url(url: …)` rather than a stage of
// an extraction.
//
// What these tests pin is the SEAM, not the plugins: that the import binds a
// name a call can be made on, that the arguments reach the plugin as its
// config, that what comes back is bound as the DECLARED output (a value, or a
// node whose reads are the declared fields), that a plugin which found nothing
// binds absence rather than nothing at all — and that the run's trace says a
// plugin ran outside an extraction, which is the only place a reader can
// find out.

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

import { runMovement } from '../run';
import type { MovementTransformInvoker, TransformInvocationResult } from '../extraction';
import type { MovementTraceEntry } from '../expression';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData, type TransformOutputShape } from '../../translation_graph/types';
import { getTransform } from '../../translation_graph/engine/transforms/registry';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000031' as TeamId;

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
}

function makeFakeAdapter(adapterType: string): { adapter: Adapter; creates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
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
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: `ext-${adapterType}-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return {
        adapterType,
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
});

const CREDENTIAL_IDS: Record<string, string> = { acme_main: 'cred-attio-1' };

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetch_url, research, vc_url_retrieval, linkedin_enrichment } from plugins',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
].join('\n');

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-plugin-calls', adapterType: 'email', triggerType: 'webhook', payload };
}

/** What a stubbed plugin was asked to do, and what it answered. */
interface Recorded {
  plugin: string;
  config: Record<string, unknown>;
}

function stubInvoker(
  answers: Record<string, TransformInvocationResult>,
): { invoker: MovementTransformInvoker; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const invoker: MovementTransformInvoker = {
    declaredOutput: (plugin) => realOutput(plugin),
    async invoke({ plugin, config }) {
      calls.push({ plugin, config });
      return answers[plugin] ?? {};
    },
  };
  return { invoker, calls };
}

/** The plugin's REAL declared output, off the registry the catalog itself
 *  reads. Stubbing it would let this test agree with itself about a shape the
 *  checker never typed. */
function realOutput(plugin: string): TransformOutputShape | undefined {
  const impl = getTransform(plugin) ?? getTransform(plugin.replace(/_/g, '-'));
  return impl?.signature.output;
}

function run(source: string, invoker: MovementTransformInvoker, adapters: {
  email: Adapter;
  attio: Adapter;
}): Promise<Awaited<ReturnType<typeof runMovement>>> {
  return runMovement({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent({ subject: 'Acme', text: 'https://acme.example' }),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      const found = adapterType === 'email' ? adapters.email : adapters.attio;
      if (!found) throw new Error(`test: no fake adapter for '${adapterType}'`);
      return found;
    },
    transformInvoker: invoker,
  });
}

const pluginEntries = (trace: MovementTraceEntry[]) =>
  trace.filter((e): e is Extract<MovementTraceEntry, { kind: 'plugin' }> => e.kind === 'plugin');

// ── A value output ───────────────────────────────────────────────────────────

const FETCH_MOVEMENT = [
  'movement intake(m: <inbox-[:message]->>) {',
  '  page = fetch_url(url: m.`text`)',
  '  co = write crm-[:companies]-> { name: m.`subject`, summary: COALESCE(page, "nothing") }',
  '}',
].join('\n');

describe('a plugin called plainly hands back its declared VALUE', () => {
  it('passes the written arguments through and binds the text that came back', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker, calls } = stubInvoker({ fetch_url: { text: 'Acme raises a Series A.' } });

    await run(FETCH_MOVEMENT, invoker, { email: email.adapter, attio: attio.adapter });

    expect(calls).toEqual([{ plugin: 'fetch_url', config: { url: 'https://acme.example' } }]);
    expect(attio.creates[0]?.fields.summary).toBe('Acme raises a Series A.');
  });

  it('binds ABSENCE when the plugin found nothing — not a missing name', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({ fetch_url: { outcome: 'fetch_failed' } });

    await run(FETCH_MOVEMENT, invoker, { email: email.adapter, attio: attio.adapter });

    // The COALESCE discharges it, which is the whole point of declaring the
    // output `text | absent` rather than `text`.
    expect(attio.creates[0]?.fields.summary).toBe('nothing');
  });

  it('says on the trace that a plugin ran, and what it handed back', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({ fetch_url: { text: 'Acme raises a Series A.' } });

    const result = await run(FETCH_MOVEMENT, invoker, {
      email: email.adapter,
      attio: attio.adapter,
    });
    const entries = pluginEntries(result.trace);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'plugin',
      plugin: 'fetch_url',
      url: 'https://acme.example',
      chars: 'Acme raises a Series A.'.length,
      returned: 'value',
    });
    // No extraction ran, so there is no node — which is what tells a reader
    // this was a call and not a stage.
    expect(entries[0]?.node).toBeUndefined();
  });

  it('a run that found nothing is still on the trace, saying so', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({ fetch_url: { outcome: 'fetch_failed' } });

    const result = await run(FETCH_MOVEMENT, invoker, {
      email: email.adapter,
      attio: attio.adapter,
    });
    expect(pluginEntries(result.trace)[0]).toMatchObject({
      plugin: 'fetch_url',
      outcome: 'fetch_failed',
      returned: 'absent',
    });
  });
});

// ── A record output ──────────────────────────────────────────────────────────

const RESEARCH_MOVEMENT = [
  'movement intake(m: <inbox-[:message]->>) {',
  '  more = research(name: m.`subject`, questions: "what it does")',
  '  co = write crm-[:companies]-> {',
  '    name: COALESCE(more.website, "no-site")',
  '    summary: COALESCE(more.summary, "nothing")',
  '  }',
  '}',
].join('\n');

describe('a plugin called plainly hands back its declared RECORD', () => {
  it('reads each declared field by name', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker, calls } = stubInvoker({
      research: {
        data: { summary: 'A payments company.', website: 'https://acme.example', confidence: 'high' },
      },
    });

    await run(RESEARCH_MOVEMENT, invoker, { email: email.adapter, attio: attio.adapter });

    expect(calls[0]?.config).toEqual({ name: 'Acme', questions: 'what it does' });
    expect(attio.creates[0]?.fields).toMatchObject({
      summary: 'A payments company.',
      name: 'https://acme.example',
    });
  });

  it('a field the plugin did not fill reads absent, and the COALESCE discharges it', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({ research: { data: { confidence: 'low' } } });

    await run(RESEARCH_MOVEMENT, invoker, { email: email.adapter, attio: attio.adapter });

    expect(attio.creates[0]?.fields).toMatchObject({ summary: 'nothing', name: 'no-site' });
  });

  it('a plugin that attached nothing at all still binds a readable record', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({ research: { outcome: 'no_match' } });

    const result = await run(RESEARCH_MOVEMENT, invoker, {
      email: email.adapter,
      attio: attio.adapter,
    });

    expect(attio.creates[0]?.fields).toMatchObject({ summary: 'nothing', name: 'no-site' });
    expect(pluginEntries(result.trace)[0]).toMatchObject({
      plugin: 'research',
      outcome: 'no_match',
      returned: 'absent',
    });
  });
});

// ── A list of records ────────────────────────────────────────────────────────

describe('a plugin called plainly hands back its declared list of RECORDS', () => {
  const deckFile = {
    __brand: 'FileRef' as const,
    name: 'deck.pdf',
    contentType: 'application/pdf',
    source: { ownerAdapterType: 'document-store', handle: 's3://bucket/abc/deck.pdf' },
    retrieve: async () => ({ stream: {} as never, contentType: 'application/pdf' }),
  };

  // The first record read field by field: its link, its text, and whether it
  // carries a file — each through the same dot read any record gets.
  const SCAN = [
    'movement intake(m: <inbox-[:message]->>) {',
    '  pages = vc_url_retrieval(text: m.`text`)',
    '  deck = FIRST(pages)',
    '  if deck != null {',
    '    write crm-[:companies]-> { name: deck.url, summary ?: deck.text }',
    '    if deck.file != null {',
    '      write crm-[:companies]-> { name: deck.name, summary: "carries a file" }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('passes the fed argument through, and binds one record per fetched link', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker, calls } = stubInvoker({
      vc_url_retrieval: {
        text: 'Acme deck text.',
        records: [
          { name: 'deck.pdf', url: 'https://docsend.example/acme', file: deckFile, text: 'Acme deck text.' },
        ],
      },
    });

    const result = await run(SCAN, invoker, { email: email.adapter, attio: attio.adapter });

    expect(calls).toEqual([
      { plugin: 'vc_url_retrieval', config: { text: 'https://acme.example' } },
    ]);
    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'https://docsend.example/acme', summary: 'Acme deck text.' },
      { name: 'deck.pdf', summary: 'carries a file' },
    ]);
    expect(pluginEntries(result.trace)[0]).toMatchObject({
      plugin: 'vc_url_retrieval',
      returned: 'value',
    });
  });

  it('a link that stored no file reads its file as absent', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({
      vc_url_retrieval: {
        text: 'A company homepage.',
        records: [{ name: 'https://acme.example', url: 'https://acme.example', text: 'A company homepage.' }],
      },
    });

    await run(SCAN, invoker, { email: email.adapter, attio: attio.adapter });

    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'https://acme.example', summary: 'A company homepage.' },
    ]);
  });

  it('several links read across as a list, in the order they were fetched', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({
      vc_url_retrieval: {
        records: [
          { name: 'one', url: 'https://one.example', text: 'first' },
          { name: 'two', url: 'https://two.example', file: deckFile },
        ],
      },
    });
    const source = [
      'movement intake(m: <inbox-[:message]->>) {',
      '  pages = vc_url_retrieval(text: m.`text`)',
      '  write crm-[:companies]-> { name: JOIN(pages.url, ", "), summary: CONCAT("", COUNT(pages)) }',
      '}',
    ].join('\n');

    await run(source, invoker, { email: email.adapter, attio: attio.adapter });

    expect(attio.creates[0]?.fields).toEqual({
      name: 'https://one.example, https://two.example',
      summary: '2',
    });
  });

  it('no link worth following binds the empty list, and the trace says nothing came back', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker } = stubInvoker({ vc_url_retrieval: {} });

    const result = await run(SCAN, invoker, { email: email.adapter, attio: attio.adapter });

    expect(attio.creates).toEqual([]);
    expect(pluginEntries(result.trace)[0]).toMatchObject({
      plugin: 'vc_url_retrieval',
      returned: 'absent',
    });
  });
});

// ── What the checker refuses never reaches the engine ────────────────────────

describe('a call the checker refuses fails the run before anything is invoked', () => {
  it('a required argument left out is a check error, not a silent no-op', async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker, calls } = stubInvoker({});
    const source = [
      'movement intake(m: <inbox-[:message]->>) {',
      '  page = fetch_url()',
      '  co = write crm-[:companies]-> { name: m.`subject`, summary: COALESCE(page, "x") }',
      '}',
    ].join('\n');

    await expect(
      run(source, invoker, { email: email.adapter, attio: attio.adapter }),
    ).rejects.toThrow(/MOV_THROUGH_ARG_MISSING/);
    expect(calls).toEqual([]);
  });

  it("a plugin the extraction alone feeds still can't be called", async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker, calls } = stubInvoker({});
    const source = [
      'movement intake(m: <inbox-[:message]->>) {',
      '  found = linkedin_enrichment()',
      '  co = write crm-[:companies]-> { name: m.`subject` }',
      '}',
    ].join('\n');

    await expect(
      run(source, invoker, { email: email.adapter, attio: attio.adapter }),
    ).rejects.toThrow(/MOV_PLUGIN_FED_BY_EXTRACTION/);
    expect(calls).toEqual([]);
  });
});

// ── A call written in place as an argument ───────────────────────────────────

describe("a call written in place as a plugin's argument is the value it computes", () => {
  it("a built-in's call is evaluated and its value passed, as a bound name's would be", async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const { invoker, calls } = stubInvoker({ fetch_url: { text: 'page' } });

    await run(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  page = fetch_url(url: LOWER(m.`text`))',
        '  shouted = fetch_url(url: UPPER(m.`text`))',
        '}',
      ].join('\n'),
      invoker,
      { email: email.adapter, attio: attio.adapter },
    );

    expect(calls).toEqual([
      { plugin: 'fetch_url', config: { url: 'https://acme.example' } },
      { plugin: 'fetch_url', config: { url: 'HTTPS://ACME.EXAMPLE' } },
    ]);
  });

  it("a plugin's call runs first, and what it handed back is the outer call's argument", async () => {
    const email = makeFakeAdapter('email');
    const attio = makeFakeAdapter('attio');
    const calls: Recorded[] = [];
    const invoker: MovementTransformInvoker = {
      declaredOutput: (plugin) => realOutput(plugin),
      async invoke({ plugin, config }) {
        calls.push({ plugin, config });
        return { text: calls.length === 1 ? 'https://acme.example/about' : 'About Acme.' };
      },
    };

    await run(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  page = fetch_url(url: fetch_url(url: m.`text`))',
        '  co = write crm-[:companies]-> { name: m.`subject`, summary: COALESCE(page, "nothing") }',
        '}',
      ].join('\n'),
      invoker,
      { email: email.adapter, attio: attio.adapter },
    );

    expect(calls).toEqual([
      { plugin: 'fetch_url', config: { url: 'https://acme.example' } },
      { plugin: 'fetch_url', config: { url: 'https://acme.example/about' } },
    ]);
    expect(attio.creates[0]?.fields.summary).toBe('About Acme.');
  });
});
