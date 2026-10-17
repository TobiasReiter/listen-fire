// Two RUNS writing one identity at once — the cross-run locks beneath each
// run's own effect locks. Each run finds nothing in the slow CRM's window and
// would create; with the locks, the second run's search waits until the first
// run's write is done, finds the record, and updates it. Proved against
// both lock tables: the in-process one and Postgres advisory locks.

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

import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';
import type { InstanceSchema } from 'movement-lang';
import type { MovementTransformInvoker } from 'movement-engine/services/movement_engine/extraction';

import { runMovement } from 'movement-engine/services/movement_engine/run';
import { getDatabaseUrl } from '../../../prisma';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { InMemoryWriteLocks, type WriteLocks } from 'movement-engine/services/write_locks/write_locks';
import { PostgresWriteLocks, type PostgresWriteLockHolder } from '../../write_locks/postgres';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

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
  let searched: () => void = () => {};
  const firstSearch = new Promise<void>((resolve) => (searched = resolve));
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
      searched();
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
  return { adapter, creates, updates, firstSearch };
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

const catalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: ATTIO_SCHEMA },
});

const SOURCE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = connect email',
  'crm = connect attio using acme_main',
  '',
  'import { fetchUrl } from plugins',
  '',
  'function intake(m: <inbox-[:message]->>) {',
  '  write crm-[:companies]-> { unique by (`name`), name: "Acme" }',
  '}',
  '',
  'function intake_then_wait(m: <inbox-[:message]->>) {',
  '  write crm-[:companies]-> { unique by (`name`), name: "Acme" }',
  '  page = fetchUrl("400")',
  '}',
].join('\n');

/** A `fetch_url` that takes as long as its url says, after `whileWaiting`. */
function slowFetch(whileWaiting: () => Promise<void>): MovementTransformInvoker {
  return {
    async invoke({ config }) {
      await whileWaiting();
      await sleep(Number(config.url));
      return { text: 'page' };
    },
  };
}

function webhookEvent(subject: string): TriggerEvent {
  return {
    pipelineInputId: `pi-cross-run-${subject}`,
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject },
  };
}

function runsAgainst(writeLocks: WriteLocks, whileWaiting: () => Promise<void> = async () => {}) {
  const crm = makeCrm();
  const email = inertAdapter('email');
  const teamId = tenantIdOf(randomUUID());
  const runOnce = (subject: string, movementName = 'intake') =>
    runMovement({
      source: SOURCE,
      movementName,
      event: webhookEvent(subject),
      teamId,
      credentialIds: credentialIdsFor(catalog, (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined)),
      host: makeTestHost({
        adapters: {
          resolve: ({ adapterType }: { adapterType: string }) =>
            adapterType === 'email' ? email : crm.adapter,
        },
        llm: { transforms: slowFetch(whileWaiting) },
        locks: writeLocks,
      }),
      catalog,
    });
  return { crm, runOnce };
}

async function twoRunsAtOnce(writeLocks: WriteLocks) {
  const { crm, runOnce } = runsAgainst(writeLocks);
  await Promise.all([runOnce('first'), runOnce('second')]);
  return crm;
}

/** No lock at all across runs: the control that shows the race is real. */
const NO_CROSS_RUN_LOCKS: WriteLocks = {
  holder: () => ({ acquire: async () => undefined, release: async () => undefined }),
};

const connectionString = () => requireUrl(getDatabaseUrl(false).url);

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
      () => new PostgresWriteLocks({ connectionString: connectionString() }),
    ],
  ])('under %s: one create, one update', async (_label, locks) => {
    const crm = await twoRunsAtOnce(locks());
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(1);
    expect(crm.updates[0]!.externalId).toBe('ext-1');
  });
});

describe("a run's lock is let go when its write is done, not when the run ends", () => {
  it.each([
    ['the in-process lock table', () => new InMemoryWriteLocks()],
    ['Postgres advisory locks', () => new PostgresWriteLocks({ connectionString: connectionString() })],
  ])('under %s: a second run writes while the first is still running', async (_label, locks) => {
    const { crm, runOnce } = runsAgainst(locks());
    let firstRunning = true;
    const first = runOnce('first', 'intake_then_wait').finally(() => (firstRunning = false));
    // The first run holds the lock from its search on.
    await crm.firstSearch;
    await runOnce('second');
    expect(firstRunning).toBe(true);
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(1);
    await first;
  });

  it("under Postgres, the run's session is open and holds no lock once its write is done", async () => {
    const holders: PostgresWriteLockHolder[] = [];
    const postgres = new PostgresWriteLocks({ connectionString: connectionString() });
    const recording: WriteLocks = {
      holder: (scope) => {
        const holder = postgres.holder(scope);
        holders.push(holder);
        return holder;
      },
    };
    const observer = new Client({ connectionString: connectionString() });
    await observer.connect();
    const seen: Array<{ pid: number | undefined; locks: number }> = [];
    try {
      const { runOnce } = runsAgainst(recording, async () => {
        const pid = await holders[0]!.debugBackendPid();
        const result = await observer.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory' AND pid = $1 AND granted`,
          [pid],
        );
        seen.push({ pid, locks: Number(result.rows[0]!.count) });
      });
      await runOnce('first', 'intake_then_wait');
    } finally {
      await observer.end();
    }
    expect(seen).toEqual([{ pid: expect.any(Number), locks: 0 }]);
  });
});

/** An inbox whose message has two attachments, listed in `order`; each update
 *  takes 100 ms, so the two runs' members overlap. */
function inboxListing(order: readonly string[], updates: string[]): Adapter {
  return {
    ...inertAdapter('email'),
    async getRelated({ fieldId }) {
      if (fieldId !== 'files') return [];
      return order.map((recordId) => ({
        position: makeStablePosition({ adapterType: 'email', recordType: 'attachment', recordId }),
      }));
    },
    async updateRecord(input) {
      await sleep(100);
      updates.push(input.externalId);
      return { adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
  };
}

const INBOX_CATALOG = staticCatalogSnapshot({
  credentials: {},
  instanceSchemas: {
    email: {
      positions: {
        message: { properties: { subject: 'text' }, edges: { files: { target: 'attachment', readable: true } } },
        attachment: { properties: { filename: 'text' }, edges: {} },
      },
      collections: { message: { target: 'message' } },
      supportsInPlaceUpdate: true,
      writableRoots: {
        attachment: { fields: { filename: 'text' }, resultShape: { externalId: 'text', filename: 'text' } },
      },
    },
  },
});

const TOUCH_BOTH = [
  'import { email } from adapters',
  '',
  'inbox = connect email',
  '',
  'function intake(m: <inbox-[:message]->>) {',
  '  map(m-[:files]->, (f) => {',
  '    write f { filename: "seen" }',
  '  }, { concurrency: 2 })',
  '}',
].join('\n');

describe('two runs whose parallel members update the same two records in opposite orders', () => {
  it('under Postgres, both succeed: a member waiting for a lock does not stall its siblings', async () => {
    const postgres = new PostgresWriteLocks({ connectionString: connectionString(), timeoutMs: 10_000 });
    const lockedNames: string[] = [];
    const recording: WriteLocks = {
      holder: (scope) => {
        const holder = postgres.holder(scope);
        return {
          acquire: (names) => {
            lockedNames.push(...names);
            return holder.acquire(names);
          },
          release: (names) => holder.release(names),
        };
      },
    };
    const teamId = tenantIdOf(randomUUID());
    const updates: string[] = [];
    const runWith = (order: readonly string[]) =>
      runMovement({
        source: TOUCH_BOTH,
        movementName: 'intake',
        event: webhookEvent(order.join('-')),
        teamId,
        host: makeTestHost({
          adapters: { resolve: () => inboxListing(order, updates) },
          locks: recording,
        }),
        catalog: INBOX_CATALOG,
      });

    const results = await Promise.all([runWith(['r1', 'r2']), runWith(['r2', 'r1'])]);

    expect(results.map((result) => result.writes.length)).toEqual([2, 2]);
    expect([...updates].sort()).toEqual(['r1', 'r1', 'r2', 'r2']);
    expect(new Set(lockedNames)).toEqual(new Set(['record "email" "r1"', 'record "email" "r2"']));
  });
});
