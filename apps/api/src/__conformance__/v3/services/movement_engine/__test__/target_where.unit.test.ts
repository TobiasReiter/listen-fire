// Engine coverage for a WHERE on a `match` or `write` target's final hop: it
// narrows the identity shortlist BEFORE arbitration, reading each candidate as
// the record it is. Before, it was accepted at save and never read at run.
//
// Pinned here: a candidate that fails the WHERE never reaches the arbiter (or
// the judge); a shortlist the WHERE empties is a miss — a match ends the scope,
// a write CREATES; a hop inside the WHERE (`EXISTS(c-[:deals]->)`) walks from
// the candidate through the target graph's read seam; a field the adapter's
// search never saw (here, one only `readRecord` returns) still narrows.
//
// Harness mirrors match.unit.test.ts (the judge mocked at the LLM seam, so the
// real arbitration runs).

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
import { makeStablePosition, positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000021' as TeamId;
const mockExecute = execute as jest.MockedFunction<typeof execute>;

/** The judge's reply shape ({match_index, confidence, reasoning}). */
const judged = (match_index: number | null, confidence = 0.9) =>
  ({ match_index, confidence, reasoning: 'test' }) as never;

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

interface RecordedWrite {
  recordType: string;
  fields: Record<string, unknown>;
}

interface FakeRecord {
  ref: ExternalRecordRef;
  /** What `readRecord` returns beyond the shortlist snapshot. */
  full?: Record<string, unknown>;
  /** Ids of the deals the company's `deals` edge reaches. */
  deals?: string[];
}

function makeFakeAdapter(
  adapterType: string,
  /** What `resolveEntity` finds, by the record type asked for — in order. */
  records: Record<string, FakeRecord[]> = {},
): { adapter: Adapter; creates: RecordedWrite[]; updates: string[]; searched: Record<string, unknown>[] } {
  const creates: RecordedWrite[] = [];
  const updates: string[] = [];
  const searched: Record<string, unknown>[] = [];
  const byId = new Map(
    Object.values(records)
      .flat()
      .map((r) => [r.ref.externalId, r]),
  );
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
    async resolveEntity({ recordType, record }) {
      searched.push(record);
      return { candidates: (records[recordType] ?? []).map((r) => r.ref) };
    },
    async readRecord({ externalId }) {
      const found = byId.get(externalId);
      return found !== undefined ? { ...found.ref.data, ...found.full } : null;
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated({ position, fieldId }) {
      if (fieldId !== 'deals' || position.identity.kind !== 'stable') return [];
      const deals = byId.get(position.identity.recordId)?.deals ?? [];
      return deals.map((id) => ({
        position: makeStablePosition({ adapterType, recordType: 'deal', recordId: id, data: { title: id } }),
      }));
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: `ext-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      updates.push(input.externalId);
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
  return { adapter, creates, updates, searched };
}

/** A CRM whose companies resolve by similarity, carry a region, and reach
 *  their deals; notes are what a hit goes on to write. */
const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', summary: 'text', region: 'text' },
      edges: { deals: { target: 'deal' } },
    },
    deal: { properties: { title: 'text' }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: {
      fields: { name: 'text', summary: 'text', region: 'text' },
      resultShape: { externalId: 'text', name: 'text', summary: 'text', region: 'text' },
      fuzzyResolution: true,
    },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: crmSchema },
});

const CREDENTIAL_IDS: Record<string, string> = {
  dealflow_inbox: 'cred-email-1',
  acme_main: 'cred-attio-1',
};

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = email()',
  '',
].join('\n');

function webhookEvent(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-target-where', adapterType: 'email', triggerType: 'webhook', payload };
}

function run(body: string[], adapters: { email: Adapter; attio: Adapter }) {
  const source =
    PRELUDE +
    [
      'movement intake(msg: <inbox-[:message]->>) {',
      '  crm = attio(credentials: acme_main)',
      ...body,
      '}',
    ].join('\n');
  return runMovement({
    source,
    movementName: 'intake',
    event: webhookEvent({}),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => CREDENTIAL_IDS[name],
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'email') return adapters.email;
      if (adapterType === 'attio') return adapters.attio;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
  });
}

/** Two companies the fuzzy search cannot tell apart. The FIRST in the shortlist
 *  fails every WHERE below; the second passes — so a judge answering index 0
 *  binds the passing one only if the failing one never reached it. */
const WITHOUT_DEALS: FakeRecord = {
  ref: { adapterType: 'attio', externalId: 'co-quiet', data: { name: 'Example Labs', summary: 'quiet' } },
  full: { region: 'US' },
  deals: [],
};
const WITH_DEALS: FakeRecord = {
  ref: { adapterType: 'attio', externalId: 'co-active', data: { name: 'Example Labs Ltd', summary: 'active' } },
  full: { region: 'EU' },
  deals: ['deal-1'],
};

const email = () => makeFakeAdapter('email').adapter;

beforeEach(() => {
  mockExecute.mockReset();
});

describe('a match whose target carries a WHERE', () => {
  const MATCH_WITH_DEALS = [
    '  co = match crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> { unique by (FUZZY `name`)',
    '    name: "Example Labs"',
    '  }',
    '  write crm-[:notes]-> { title: co.`summary` }',
  ];

  it('control — without the WHERE both candidates reach the judge, and index 0 is the first', async () => {
    mockExecute.mockResolvedValue(judged(0));
    const attio = makeFakeAdapter('attio', { company: [WITHOUT_DEALS, WITH_DEALS] });
    const result = await run(
      [
        '  co = match crm-[:companies]-> { unique by (FUZZY `name`), name: "Example Labs" }',
        '  write crm-[:notes]-> { title: co.`summary` }',
      ],
      { email: email(), attio: attio.adapter },
    );
    expect(result.writes[0]).toMatchObject({ kind: 'match', externalId: 'co-quiet' });
  });

  it('a hop read in the WHERE drops the candidate that fails it before the judge sees the list', async () => {
    mockExecute.mockResolvedValue(judged(0));
    const attio = makeFakeAdapter('attio', { company: [WITHOUT_DEALS, WITH_DEALS] });
    const result = await run(MATCH_WITH_DEALS, { email: email(), attio: attio.adapter });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.writes[0]).toMatchObject({ kind: 'match', externalId: 'co-active' });
    expect(attio.creates).toEqual([{ recordType: 'note', fields: { title: 'active' } }]);
  });

  it('when every candidate fails, the match is a miss: the scope ends and nothing is written', async () => {
    const attio = makeFakeAdapter('attio', { company: [WITHOUT_DEALS] });
    const result = await run(MATCH_WITH_DEALS, { email: email(), attio: attio.adapter });

    expect(mockExecute).not.toHaveBeenCalled();
    expect(attio.creates).toEqual([]);
    expect(result.writes).toEqual([]);
  });

  it('an equality the search never saw narrows — the field comes from readRecord, not the snapshot', async () => {
    mockExecute.mockResolvedValue(judged(0));
    const attio = makeFakeAdapter('attio', { company: [WITHOUT_DEALS, WITH_DEALS] });
    const result = await run(
      [
        '  co = match crm-[c:companies WHERE c.`region` == "EU"]-> { unique by (FUZZY `name`), name: "Example Labs" }',
        '  write crm-[:notes]-> { title: co.`summary` }',
      ],
      { email: email(), attio: attio.adapter },
    );
    expect(result.writes[0]).toMatchObject({ kind: 'match', externalId: 'co-active' });
    // Not pushed down: the search was asked by the name alone.
    expect(attio.searched[0]).toEqual({ name: 'Example Labs' });
  });

  it('a bare field in the WHERE reads the candidate as well', async () => {
    mockExecute.mockResolvedValue(judged(0));
    const attio = makeFakeAdapter('attio', { company: [WITHOUT_DEALS, WITH_DEALS] });
    const result = await run(
      [
        '  co = match crm-[:companies WHERE `region` == "EU"]-> { unique by (FUZZY `name`), name: "Example Labs" }',
        '  write crm-[:notes]-> { title: co.`summary` }',
      ],
      { email: email(), attio: attio.adapter },
    );
    expect(result.writes[0]).toMatchObject({ kind: 'match', externalId: 'co-active' });
  });
});

describe('a write whose target carries a WHERE', () => {
  it('updates the candidate that passes', async () => {
    mockExecute.mockResolvedValue(judged(0));
    const attio = makeFakeAdapter('attio', { company: [WITHOUT_DEALS, WITH_DEALS] });
    await run(
      [
        '  write crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> { unique by (FUZZY `name`)',
        '    name: "Example Labs"',
        '    summary: "seen again"',
        '  }',
      ],
      { email: email(), attio: attio.adapter },
    );
    expect(attio.updates).toEqual(['co-active']);
    expect(attio.creates).toEqual([]);
  });

  it('a shortlist the WHERE empties is a miss, and the write creates', async () => {
    const attio = makeFakeAdapter('attio', { company: [WITHOUT_DEALS] });
    const result = await run(
      [
        '  write crm-[c:companies WHERE EXISTS(c-[:deals]->)]-> { unique by (FUZZY `name`)',
        '    name: "Example Labs"',
        '  }',
      ],
      { email: email(), attio: attio.adapter },
    );
    expect(mockExecute).not.toHaveBeenCalled();
    expect(attio.updates).toEqual([]);
    expect(attio.creates).toEqual([{ recordType: 'company', fields: { name: 'Example Labs' } }]);
    expect(result.writes[0]).toMatchObject({ created: true });
  });
});
