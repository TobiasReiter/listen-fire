// A plugin called by position from language version 5, on both engines; the
// harness is plugin_call.unit.test.ts's.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('movement-engine/services/knowledge_pipeline/output_v3/schemas');

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

jest.mock('movement-engine/services/logger', () => ({
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

import { runMovement } from 'movement-engine/services/movement_engine/run';
import { setRunEngineRecorder, type RunEngineRecord } from 'movement-engine/services/movement_engine/rust_stats';
import type { MovementTransformInvoker, TransformInvocationResult } from 'movement-engine/services/movement_engine/extraction';
import type { MovementTraceEntry } from 'movement-engine/services/movement_engine/expression';

import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type RuntimeCapabilities,
} from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000a5');

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

const catalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { `@lf/email` as email } from adapters',
  'import { fetchUrl, research, vcUrlRetrieval } from plugins',
  '',
  'inbox = connect email',
  '',
].join('\n');

/** What a stubbed plugin was asked to do. */
interface Recorded {
  plugin: string;
  config: Record<string, unknown>;
}

function stubInvoker(answers: Record<string, TransformInvocationResult>): { invoker: MovementTransformInvoker; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const invoker: MovementTransformInvoker = {
    async invoke({ plugin, config }) {
      calls.push({ plugin, config });
      return answers[plugin] ?? {};
    },
  };
  return { invoker, calls };
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

const ENGINES: Array<[string, Config, RunEngineRecord['engine']]> = [
  ['the Rust engine', { MOVEMENT_ENGINE: 'by-version' }, 'rust'],
  ['the TypeScript reference engine', { MOVEMENT_ENGINE_V5_ON_TS: 'true' }, 'ts'],
];

const recorded: RunEngineRecord[] = [];
beforeEach(() => {
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});
afterEach(() => setRunEngineRecorder(undefined));

let runs = 0;

/** What a run is set up with beyond its body: the extraction's replies, and
 *  the program's imports and catalog when they are not the plain ones. */
interface RunSetup {
  replies?: unknown[];
  prelude?: string;
  catalog?: typeof catalog;
}

async function run(
  body: string[],
  config: Config,
  answers: Record<string, TransformInvocationResult>,
  setup: RunSetup = {},
): Promise<Recorded[]> {
  const replies = setup.replies ?? [];
  const { adapter: email } = makeFakeAdapter('email');
  const { invoker, calls } = stubInvoker(answers);
  await under(config, () =>
    runMovement({
      source: [setup.prelude ?? PRELUDE, 'function intake(m: <inbox-[:message]->>) {', ...body, '}'].join('\n'),
      languageVersion: 5,
      runId: `run-v5-plugin-${++runs}`,
      movementName: 'intake',
      event: { pipelineInputId: 'pi-v5-plugin-calls', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'https://acme.example' } },
      teamId: TEAM_ID,
      catalog: setup.catalog ?? catalog,
      credentialIds: {},
      host: makeTestHost({
        adapters: { resolve: () => email },
        llm: {
          transforms: invoker,
          client: { call: async () => ({ parsedJson: replies.shift() ?? {} }) },
          extractCall: { call: async () => ({ parsedJson: replies.shift() ?? {}, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }) },
        },
      }),
    }),
  );
  return calls;
}

// A plugin's arguments by position from language version 5 (design §2.7):
// its required inputs in the manifest's order, then one settings record. The
// wire to the plugin stays named — what it is handed is the config versions
// 1–4 hand it.
describe.each(ENGINES)('a plugin called by position on %s', (_name, config, engine) => {
  it('is handed its arguments by name', async () => {
    const calls = await run(
      [
        '  page = fetchUrl(m.`text`)',
        '  more = research(m.`subject`, { context: m.`text`, questions: "what it does" })',
        '  vc = vcUrlRetrieval(m.`text`, { email: "deals@acme.example" })',
      ],
      config,
      { fetch_url: { text: 'Acme raises a Series A.' }, research: { data: { summary: 'Payments.' } }, vc_url_retrieval: { text: 'https://vc.example' } },
    );
    expect(recorded.map((r) => r.engine)).toEqual([engine]);
    expect(calls).toEqual([
      { plugin: 'fetch_url', config: { url: 'https://acme.example' } },
      { plugin: 'research', config: { name: 'Acme', context: 'https://acme.example', questions: 'what it does' } },
      { plugin: 'vc_url_retrieval', config: { text: 'https://acme.example', email: 'deals@acme.example' } },
    ]);
  });

  it('binds a call nested in an expression, and one passed as another call\'s argument, the same way', async () => {
    const calls = await run(
      ['  n = coalesce(fetchUrl(m.`text`), "none")', '  more = research(fetchUrl(m.`subject`))'],
      config,
      { fetch_url: { text: 'Acme' }, research: { data: {} } },
    );
    expect(recorded.map((r) => r.engine)).toEqual([engine]);
    expect(calls).toEqual([
      { plugin: 'fetch_url', config: { url: 'https://acme.example' } },
      { plugin: 'fetch_url', config: { url: 'Acme' } },
      { plugin: 'research', config: { name: 'Acme' } },
    ]);
  });

  it('binds a through stage by position, with the stage\'s parameters', async () => {
    const calls = await run(
      [
        '  found = extract from [m.`text`] {',
        '    name: "the company"',
        '  } through [research(m.`subject`, { questions: "what it does" })] {',
        '    summary: "what it does"',
        '  }',
      ],
      config,
      { research: { data: { summary: 'Payments.' } } },
      { replies: [{ 'x:extract_result#1': [{ name: { evidence: 'q', value: 'Acme' } }] }] },
    );
    expect(recorded.map((r) => r.engine)).toEqual([engine]);
    expect(calls).toEqual([{ plugin: 'research', config: { name: 'Acme', questions: 'what it does' } }]);
  });
});

// A plugin package from language version 5 (design §2.10): a package import
// binds each member as `web.fetchUrl`, and a member call is the plugin's own
// call — invoked by its catalog key, with the named config.
const WEB = new Set(['fetch_url', 'research']);
const packaged: typeof catalog = {
  ...catalog,
  plugins: Object.fromEntries(
    Object.entries(catalog.plugins).map(([key, spec]) => [key, WEB.has(key) ? { ...spec, package: '@lf/web' } : spec]),
  ),
};
const PACKAGED = [
  'import { `@lf/email` as email } from adapters',
  'import { `@lf/web` as web } from plugins',
  '',
  'inbox = connect email',
  '',
].join('\n');

describe.each(ENGINES)("a package's member called on %s", (_name, config, engine) => {
  it('is its plugin, bound, bare, nested, as an argument and in a closure', async () => {
    const calls = await run(
      [
        '  page = web.fetchUrl(m.`text`)',
        '  web.fetchUrl(m.`subject`)',
        '  n = coalesce(web.fetchUrl(m.`text`), "none")',
        '  more = web.research(web.fetchUrl(m.`subject`), { context: m.`text` })',
        '  g = (x: <text>) => {',
        '    q = web.fetchUrl(x)',
        '    return q',
        '  }',
        '  y = g("https://g.example")',
      ],
      config,
      { fetch_url: { text: 'Acme' }, research: { data: { summary: 'Payments.' } } },
      { prelude: PACKAGED, catalog: packaged },
    );
    expect(recorded.map((r) => r.engine)).toEqual([engine]);
    expect(calls).toEqual([
      { plugin: 'fetch_url', config: { url: 'https://acme.example' } },
      { plugin: 'fetch_url', config: { url: 'Acme' } },
      { plugin: 'fetch_url', config: { url: 'https://acme.example' } },
      { plugin: 'fetch_url', config: { url: 'Acme' } },
      { plugin: 'research', config: { name: 'Acme', context: 'https://acme.example' } },
      { plugin: 'fetch_url', config: { url: 'https://g.example' } },
    ]);
  });

  it('is a through stage', async () => {
    const calls = await run(
      [
        '  found = extract from [m.`text`] {',
        '    name: "the company"',
        '  } through [web.research(m.`subject`, { questions: "what it does" })] {',
        '    summary: "what it does"',
        '  }',
      ],
      config,
      { research: { data: { summary: 'Payments.' } } },
      { replies: [{ 'x:extract_result#1': [{ name: { evidence: 'q', value: 'Acme' } }] }], prelude: PACKAGED, catalog: packaged },
    );
    expect(recorded.map((r) => r.engine)).toEqual([engine]);
    expect(calls).toEqual([{ plugin: 'research', config: { name: 'Acme', questions: 'what it does' } }]);
  });
});
