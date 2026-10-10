// `unique by` clauses are OR-ed; each clause's non-equality conjuncts
// (`WITHIN`, `!=`, ranges) narrow the candidates THAT clause found. With two or
// more clauses those conjuncts used to be dropped without a word, so a stale
// record found by the second clause's key was matched anyway.
//
// Pinned here: each clause's post-filter applies to its own candidates (a
// clause without one keeps its candidates); and a candidate that lacks a field
// the post-filter reads is judged on the record as read, where an absent field
// fails an equality, a range or WITHIN and satisfies `!=`.
//
// Harness mirrors target_where.unit.test.ts.

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

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

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

// The ONE judge — mocked at the LLM seam, so the real arbitration (the
// short-circuits, the exactness rule) still runs and only the decision is
// injected.
jest.mock('../../../lib/prompts/execute', () => ({
  execute: jest.fn(),
  parseJsonReply: jest.fn(),
  flattenMessages: jest.fn(),
}));

import { execute } from '../../../lib/prompts/execute';
import { runMovement } from '../run';

import type { InstanceSchema } from 'movement-lang';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000041' as TeamId;
const mockExecute = execute as jest.MockedFunction<typeof execute>;

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

interface FakeRecord {
  ref: ExternalRecordRef;
  /** What `readRecord` returns beyond the shortlist snapshot. */
  full?: Record<string, unknown>;
}

/** A search that honours the constraints it is given: a record is a
 *  candidate when every field of SOME clause equals the searched value. */
function makeCrm(records: FakeRecord[]) {
  const creates: Array<Record<string, unknown>> = [];
  const updates: string[] = [];
  const searches: string[][] = [];
  const byId = new Map(records.map((r) => [r.ref.externalId, r]));
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
    async resolveEntity({ record, constraints }) {
      searches.push(constraints.any.map((c) => c.all.map((f) => f.field).join('+')));
      const hits = records.filter((r) =>
        constraints.any.some((clause) =>
          clause.all.every((f) => r.ref.data[f.field] !== undefined && r.ref.data[f.field] === record[f.field]),
        ),
      );
      return { candidates: hits.map((r) => r.ref) };
    },
    async readRecord({ externalId }) {
      const found = byId.get(externalId);
      return found !== undefined ? { ...found.ref.data, ...found.full } : null;
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
      return { adapterType: 'attio', externalId: `ext-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      updates.push(input.externalId);
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates, searches };
}

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', domain: 'text', updated: 'datetime', status: 'text' },
      edges: {},
    },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', domain: 'text', updated: 'datetime', status: 'text' },
      resultShape: { externalId: 'text', name: 'text', domain: 'text', updated: 'datetime', status: 'text' },
    },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: crmSchema },
});

function run(body: string[], attio: Adapter) {
  const email: Adapter = { ...makeCrm([]).adapter, adapterType: 'email' };
  const source = [
    'import { email, attio } from adapters',
    'import { acme_main } from credentials',
    'inbox = email()',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  crm = attio(credentials: acme_main)',
    ...body,
    '}',
  ].join('\n');
  const event: TriggerEvent = { pipelineInputId: 'pi-unique-by', adapterType: 'email', triggerType: 'webhook', payload: {} };
  return runMovement({
    source,
    movementName: 'intake',
    event,
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'email') return email;
      if (adapterType === 'attio') return attio;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
  });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const company = (id: string, data: Record<string, unknown>, full?: Record<string, unknown>): FakeRecord => ({
  ref: { adapterType: 'attio', externalId: id, data },
  ...(full !== undefined ? { full } : {}),
});

const TWO_CLAUSES = [
  '  write crm-[:companies]-> {',
  '    unique by (`name`)',
  '    unique by (`domain`, `updated` WITHIN 30d)',
  '    name: "Nova Labs"',
  '    domain: "nova.example"',
  '  }',
];

beforeEach(() => {
  mockExecute.mockReset();
});

describe('two or more unique by clauses — each clause keeps its own non-equality conjuncts', () => {
  it('a stale candidate found by the second clause\'s key is excluded, and the write creates', async () => {
    const crm = makeCrm([company('co-stale', { name: 'Nova Old', domain: 'nova.example', updated: daysAgo(400) })]);
    await run(TWO_CLAUSES, crm.adapter);
    expect(crm.updates).toEqual([]);
    expect(crm.creates).toEqual([{ name: 'Nova Labs', domain: 'nova.example' }]);
  });

  it('a fresh candidate found by the second clause\'s key is matched', async () => {
    const crm = makeCrm([company('co-fresh', { name: 'Nova Old', domain: 'nova.example', updated: daysAgo(3) })]);
    await run(TWO_CLAUSES, crm.adapter);
    expect(crm.updates).toEqual(['co-fresh']);
    expect(crm.creates).toEqual([]);
  });

  it('a candidate found by a clause with no such conjunct is kept however stale', async () => {
    const crm = makeCrm([company('co-named', { name: 'Nova Labs', domain: 'other.example', updated: daysAgo(400) })]);
    await run(TWO_CLAUSES, crm.adapter);
    expect(crm.updates).toEqual(['co-named']);
  });

  it('a match honours the same rule', async () => {
    const crm = makeCrm([company('co-stale', { name: 'Nova Old', domain: 'nova.example', updated: daysAgo(400) })]);
    const result = await run(
      [
        '  co = match crm-[:companies]-> {',
        '    unique by (`name`)',
        '    unique by (`domain`, `updated` WITHIN 30d)',
        '    name: "Nova Labs"',
        '    domain: "nova.example"',
        '  }',
        '  write crm-[:companies]-> { unique by (`name`), name: co.`name` }',
      ],
      crm.adapter,
    );
    expect(result.writes).toEqual([]);
  });
});

describe('a candidate missing a field the conjunct reads', () => {
  const ONE_CLAUSE = (conjunct: string) => [
    '  write crm-[:companies]-> {',
    `    unique by (\`domain\`, ${conjunct})`,
    '    name: "Nova Labs"',
    '    domain: "nova.example"',
    '  }',
  ];

  it('is judged on the record as read: a stale value only readRecord knows excludes it', async () => {
    const crm = makeCrm([company('co-sparse', { domain: 'nova.example' }, { updated: daysAgo(400) })]);
    await run(ONE_CLAUSE('`updated` WITHIN 30d'), crm.adapter);
    expect(crm.updates).toEqual([]);
    expect(crm.creates).toHaveLength(1);
  });

  it('a record that has no such field cannot satisfy WITHIN', async () => {
    const crm = makeCrm([company('co-bare', { domain: 'nova.example' })]);
    await run(ONE_CLAUSE('`updated` WITHIN 30d'), crm.adapter);
    expect(crm.updates).toEqual([]);
    expect(crm.creates).toHaveLength(1);
  });

  it('a record that has no such field satisfies !=', async () => {
    const crm = makeCrm([company('co-bare', { domain: 'nova.example' })]);
    await run(ONE_CLAUSE('`status` != "archived"'), crm.adapter);
    expect(crm.updates).toEqual(['co-bare']);
  });
});
