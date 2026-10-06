// Two RUNS writing one identity at once — the cross-run locks beneath each
// run's own effect locks. Each run finds nothing in the slow CRM's window and
// would create; with the locks, the second run's search waits until the first
// run's segment has ended, finds the record, and updates it. Proved against
// both lock tables: the in-process one and Postgres advisory locks.

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

import { randomUUID } from 'node:crypto';

import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { InstanceSchema } from 'movement-lang';

import { runMovement } from '../run';
import { getDatabaseUrl } from '../../../prisma';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import { positionData } from '../../translation_graph/types';
import { InMemoryWriteLocks, type WriteLocks } from '../../write_locks/write_locks';
import { PostgresWriteLocks } from '../../write_locks/postgres';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

/** A CRM shared by both runs: its identity search is slow and answers from
 *  what it had itself created when the search began. */
function makeCrm() {
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<{ externalId: string; fields: Record<string, unknown> }> = [];
  const store: ExternalRecordRef[] = [];
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity({ record }) {
      // The answer is what was there when the search began; the wait after it
      // is the window in which another run can search too.
      const candidates = store.filter((held) => held.data.name === record.name);
      await sleep(150);
      return { candidates };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push(input.fields);
      const created = { adapterType: 'attio', externalId: `ext-${creates.length}`, data: { ...input.fields } };
      store.push(created);
      return created;
    },
    async updateRecord(input) {
      updates.push({ externalId: input.externalId, fields: input.fields });
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates };
}

function inertAdapter(adapterType: string): Adapter {
  return {
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
      return { adapterType, externalId: 'x', data: { ...input.fields } };
    },
    async updateRecord(input) {
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
}

const ATTIO_SCHEMA: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
  },
  supportsInPlaceUpdate: true,
};

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: ATTIO_SCHEMA },
});

const SOURCE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
  'movement intake(m: <inbox-[:message]->>) {',
  '  write crm-[:companies]-> { unique by (`name`), name: "Acme" }',
  '}',
].join('\n');

function webhookEvent(subject: string): TriggerEvent {
  return {
    pipelineInputId: `pi-cross-run-${subject}`,
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject },
  };
}

async function twoRunsAtOnce(writeLocks: WriteLocks) {
  const crm = makeCrm();
  const email = inertAdapter('email');
  const teamId = randomUUID() as TeamId;
  const runOnce = (subject: string) =>
    runMovement({
      source: SOURCE,
      movementName: 'intake',
      event: webhookEvent(subject),
      teamId,
      writeLocks,
      catalog,
      resolveCredentialId: (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
      resolveAdapter: ({ adapterType }: { adapterType: string }) =>
        adapterType === 'email' ? email : crm.adapter,
    });
  await Promise.all([runOnce('first'), runOnce('second')]);
  return crm;
}

/** No lock at all across runs: the control that shows the race is real. */
const NO_CROSS_RUN_LOCKS: WriteLocks = {
  holder: () => ({ acquire: async () => undefined, release: async () => undefined }),
};

function requireUrl(url: string | undefined): string {
  if (!url) throw new Error('no database url for the integration test');
  return url;
}

describe('two runs writing one identity at once', () => {
  it('without cross-run locks, both create (the race this guards)', async () => {
    const crm = await twoRunsAtOnce(NO_CROSS_RUN_LOCKS);
    expect(crm.creates).toHaveLength(2);
  });

  it.each([
    ['the in-process lock table', () => new InMemoryWriteLocks()],
    [
      'Postgres advisory locks',
      () => new PostgresWriteLocks({ connectionString: requireUrl(getDatabaseUrl(false).url) }),
    ],
  ])('under %s: one create, one update', async (_label, locks) => {
    const crm = await twoRunsAtOnce(locks());
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(1);
    expect(crm.updates[0]!.externalId).toBe('ext-1');
  });
});
