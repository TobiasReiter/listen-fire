// A record placed inside a write field's VALUE — `company: { a: org }` into a
// json field — is refused when the program is validated, as the direct form
// (`company: org`) always was. Before, it validated, and the engine handed the
// connector its own description of the record (kind, handle, provenance with
// source spans, the connector's whole schema and credential name), which the
// connector forwarded to the vendor. A spread of the record (`{ ...org }`)
// copies the fields it was written with, which are values.

// ── Jest module workarounds (mirrors host_data_is_data.unit.test.ts) ──────────


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
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import type { Adapter, RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000078');

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

/** A fake adapter that records the fields of every record it is asked to create. */
function spyAdapter(adapterType: string) {
  const creates: Array<{ fields: Record<string, unknown> }> = [];
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
    async getFieldValue() {
      return undefined;
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ fields: input.fields });
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
  return { adapter, creates };
}

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { title: 'text', company: 'json' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text', company: 'json' }, resultShape: { externalId: 'text' } },
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
      schema: crmSchema,
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
  'inbox = connect email using dealflow_inbox',
  'crm   = connect attio using acme_main',
  '',
].join('\n');

const event: TriggerEvent = {
  pipelineInputId: 'pi-record-in-field-value',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'hello' },
};

async function run(company: string) {
  const email = spyAdapter('email');
  const attio = spyAdapter('attio');
  const outcome = runMovement({
    source:
      PRELUDE +
      [
        'function intake(msg: <inbox-[:message]->>) {',
        '  org = write crm-[:companies]-> { name: "Acme Inc." }',
        `  write crm-[:notes]-> { title: "hello", company: ${company} }`,
        '}',
      ].join('\n'),
    movementName: 'intake',
    event,
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
  return { outcome, attio };
}

describe('a record inside a write field’s value', () => {
  it('under a map key: refused at validation, and nothing reaches the connector', async () => {
    const { outcome, attio } = await run('{ a: org }');
    await expect(outcome).rejects.toThrow(/MOV_WRITE_FIELD_TYPE[^\n]*'company\.a' is [^\n]*a record, not a value/);
    expect(attio.creates).toEqual([]);
  });

  it('as a list member: refused the same way', async () => {
    const { outcome, attio } = await run('[org]');
    await expect(outcome).rejects.toThrow(/MOV_WRITE_FIELD_TYPE[^\n]*a record, not a value/);
    expect(attio.creates).toEqual([]);
  });

  it('a spread of the record writes the fields it was written with', async () => {
    const { outcome, attio } = await run('{ ...org }');
    await outcome;
    expect(attio.creates.map((c) => c.fields)).toEqual([
      { name: 'Acme Inc.' },
      { title: 'hello', company: { name: 'Acme Inc.' } },
    ]);
  });
});
