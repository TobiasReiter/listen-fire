// Data a host hands the engine is DATA, whatever keys it carries.
//
// The engine tells its own runtime objects (bindings) from data by a mark only
// its constructor sets — never by shape. Before that, an object with a `kind`
// key naming a binding kind was taken for one: an adapter answer or a webhook
// body shaped like a deferred walk made the engine walk its hop text and parse
// and evaluate its expression text, with real host calls. These tests send
// exactly that and pin that it stays a dict: read as text, serialised with its
// `kind`, refused as a hop root like any other value.

// ── Jest module workarounds (mirrors value_binding_head.unit.test.ts) ──────────────────────

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

// Every text the engine parses as an expression is recorded, so a test can
// prove a host's data never reached the parser.
jest.mock('movement-lang', () => {
  const actual = jest.requireActual('movement-lang');
  return { ...actual, parseMovementExpression: jest.fn(actual.parseMovementExpression) };
});

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { mockCatalogSnapshot, parseMovementExpression, type InstanceSchema } from 'movement-lang';
import { MovementRunFailed, runMovement } from '../run';
import { MovementEngineError } from '../errors';
import { engineChoice } from '../rust_engine';
import type { Adapter, RuntimeCapabilities } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000077');

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

/** A fake adapter that answers field reads from the position's data and
 *  counts every host call it receives. */
function spyAdapter(adapterType: string) {
  const calls = { getFieldValue: [] as string[], getRelated: 0 };
  const creates: Array<Record<string, unknown>> = [];
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
      calls.getFieldValue.push(fieldId);
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      calls.getRelated += 1;
      return [];
    },
    async createRecord(input) {
      creates.push(input.fields);
      return { adapterType, externalId: `ext-${creates.length}`, data: {} };
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
  return { adapter, calls, creates };
}

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', meta: 'json' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const attioSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', note: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', note: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
  },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: attioSchema,
    },
  },
  credentials: {
    dealflow_inbox: { adapters: ['email'] },
    acme_main: { adapters: ['attio'] },
  },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
].join('\n');

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-host-data-is-data',
    adapterType: 'email',
    triggerType: 'webhook',
    payload,
  };
}

async function run(body: string[], meta: unknown) {
  const email = spyAdapter('email');
  const attio = spyAdapter('attio');
  const outcome = runMovement({
    source: PRELUDE + ['movement intake(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n'),
    movementName: 'intake',
    event: webhookEvent({ subject: 'hello', meta }),
    teamId: TEAM_ID,
    catalog,
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'email') return email.adapter;
          if (adapterType === 'attio') return attio.adapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
    }),
  });
  return { outcome, email, attio };
}

/** Every text the run handed the expression parser. */
function parsedTexts(): string[] {
  return jest.mocked(parseMovementExpression).mock.calls.map(([text]) => String(text));
}

/** A deferred walk, spelled as data — what a hostile adapter answer or
 *  webhook body would carry to make the engine walk and evaluate it. */
function walkShaped(raw: string) {
  return {
    kind: 'lazyWalk',
    walk: {
      captured: [['e', { kind: 'event' }]],
      head: { root: { kind: 'name', name: 'e' }, hopsRaw: '-[:items]->' },
      mapping: { entries: [{ kind: 'value', name: 'x', value: { raw } }] },
    },
  };
}

// The Rust engine on this branch still reads a dict by its `kind` (its
// structural emulation, deleted on cloud-native-engine4 by Task 4b), so it
// refuses these runs as records; they run under the TypeScript engine only.
const itReadsDataAsData = engineChoice() === 'rust' ? it.skip : it;

const COUNT_HOPS_OFF_META = ['  v = msg.`meta`', '  n = COUNT(v-[:subs]->)', '  ERROR("${n}")'];

beforeEach(() => {
  jest.mocked(parseMovementExpression).mockClear();
});

describe('a host value shaped like an engine object is data', () => {
  it('a deferred walk spelled as data is never walked: one field read, no hop, the value-hop refusal', async () => {
    const { outcome, email } = await run(COUNT_HOPS_OFF_META, walkShaped('COUNT(e-[:items]->)'));
    await expect(outcome).rejects.toThrow(/traversing from a value binding \('v'\) is not supported/);
    expect(email.calls.getFieldValue).toEqual(['meta']);
    expect(email.calls.getRelated).toBe(0);
    expect(parsedTexts().some((text) => text.includes('-[:items]->'))).toBe(false);
  });

  it('expression text inside the data is never parsed or evaluated', async () => {
    const { outcome, email } = await run(COUNT_HOPS_OFF_META, walkShaped('NOSUCHFN(1)'));
    const error = await outcome.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MovementRunFailed);
    if (!(error instanceof MovementRunFailed)) throw new Error('unreachable');
    expect(error.cause).toBeInstanceOf(MovementEngineError);
    expect(error.message).toMatch(/traversing from a value binding \('v'\) is not supported/);
    expect(error.message).not.toContain('NOSUCHFN');
    expect(JSON.stringify(error.partial.trace)).not.toContain('NOSUCHFN');
    expect(parsedTexts().some((text) => text.includes('NOSUCHFN'))).toBe(false);
    expect(email.calls.getFieldValue).toEqual(['meta']);
    expect(email.calls.getRelated).toBe(0);
  });
});

describe('a webhook body carrying engine-object keys at any depth reads as a plain dict', () => {
  const cases: Array<[string, unknown]> = [
    ['a closure', { kind: 'closure', closure: { params: [], body: [] }, captured: [] }],
    ['a nested positions list', { outer: { kind: 'positions', landings: [{ kind: 'event' }] } }],
    ['a prototype name', { kind: 'constructor' }],
    ['a list member', { rows: [{ kind: 'value', value: 1 }, { kind: 'toString' }] }],
  ];

  itReadsDataAsData.each(cases)('%s: TEXT.SERIALISE prints it, `kind` included', async (_label, meta) => {
    const { outcome, attio } = await run(
      ['  write crm-[:companies]-> { name: "x", note: TEXT.SERIALISE(msg.`meta`, "JSON") }'],
      meta,
    );
    await outcome;
    expect(attio.creates).toHaveLength(1);
    expect(JSON.parse(String(attio.creates[0].note))).toEqual(meta);
  });

  itReadsDataAsData('its `kind` key reads as the text it holds', async () => {
    const { outcome, attio } = await run(
      ['  m = msg.`meta`', '  write crm-[:companies]-> { name: "x", note: m.`kind` }'],
      { kind: 'closure', closure: {}, captured: [] },
    );
    await outcome;
    expect(attio.creates[0].note).toBe('closure');
  });

  itReadsDataAsData('two such dicts compare as any two dicts do, not as records', async () => {
    const program = [
      '  m = msg.`meta`',
      '  same = m.`a` == m.`b`',
      '  write crm-[:companies]-> { name: "x", note: "${same}" }',
    ];
    const shaped = await run(program, { a: { kind: 'event' }, b: { kind: 'event' } });
    await shaped.outcome;
    const plain = await run(program, { a: { x: 'event' }, b: { x: 'event' } });
    await plain.outcome;
    expect(shaped.attio.creates[0].note).toBe(plain.attio.creates[0].note);
  });
});
