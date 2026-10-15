// A FILE placed inside a write field's VALUE — `company: { a: f }` into a json
// field — is refused when the program is validated, as a record is
// (record_in_field_value.unit.test.ts). Before, it validated, and the engine
// handed the connector the file's internal descriptor inside the value. A file
// at a field that holds files is the upload path, and still writes.

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
import { Readable } from 'node:stream';
import { services } from '../../../adapters/registry';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import type { Adapter, FileRef, RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000079');

// FILE() persists its bytes to the document store on creation (the
// stdlib_file.unit.test.ts pattern); an in-memory one keeps the run hermetic.
beforeAll(() => {
  const docs = new Map<string, Buffer>();
  services.document = {
    async upload(readable: Readable) {
      const chunks: Buffer[] = [];
      for await (const c of readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const objectUri = `mem://${docs.size}`;
      docs.set(objectUri, Buffer.concat(chunks));
      return { objectUri, checksum: 'x' };
    },
  } as unknown as typeof services.document;
});

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
    note: { properties: { title: 'text', company: 'json', upload: 'file' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text', company: 'json', upload: 'file' }, resultShape: { externalId: 'text' } },
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
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
].join('\n');

const event: TriggerEvent = {
  pipelineInputId: 'pi-file-in-field-value',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'hello' },
};

async function run(fields: string) {
  const email = spyAdapter('email');
  const attio = spyAdapter('attio');
  const outcome = runMovement({
    source:
      PRELUDE +
      [
        'movement intake(msg: <inbox-[:message]->>) {',
        '  f = FILE("the minutes", "text")',
        `  write crm-[:notes]-> { title: "hello", ${fields} }`,
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

describe('a file inside a write field’s value', () => {
  it('under a map key: refused at validation, and nothing reaches the connector', async () => {
    const { outcome, attio } = await run('company: { a: f }');
    await expect(outcome).rejects.toThrow(/MOV_WRITE_FIELD_TYPE[^\n]*'company\.a' is file — a file, not a value/);
    expect(attio.creates).toEqual([]);
  });

  it('as a list member: refused the same way', async () => {
    const { outcome, attio } = await run('company: [f]');
    await expect(outcome).rejects.toThrow(/MOV_WRITE_FIELD_TYPE[^\n]*a file, not a value/);
    expect(attio.creates).toEqual([]);
  });

  it('at a field that holds files: the upload path, which writes the file', async () => {
    const { outcome, attio } = await run('upload: f');
    await outcome;
    expect(attio.creates).toHaveLength(1);
    const upload = attio.creates[0]!.fields.upload as FileRef;
    expect(upload).toMatchObject({ __brand: 'FileRef' });
    expect(attio.creates[0]!.fields.title).toBe('hello');
  });
});
