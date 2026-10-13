// kg-seeded movements (the mutation-listen increment) — engine side.
//
//   1. A movement fired by `listen to graph { type: "company" }` seeds the
//      mutated record's stable KG position from the mutation event and
//      reads its properties THROUGH the adapter read seam (a fake KG
//      adapter's getFieldValue), writing the values to a fake external
//      target.
//   2. Edge hops off the kg seed stream through getRelated, the same
//      seam every source walks.
//   3. A mutation event with no recordId fails loud (MOVENG_RUNTIME).
//   4. surfaceReadAdapter — the natural-name→internal-id read translation,
//      driven by the adapter's OWN introspection-derived resolver (uniform
//      across adapters; the KG is not special): getFieldValue translates
//      property names per type, getRelated translates edge names to
//      EdgeTypeIds and stamps landed positions with the hop target's natural
//      type.

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
    methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated'],
    triggerKinds: ['KG_MUTATION'],
    subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
    listenConfig: [
      { key: 'type', required: true, narrows: { collection: 'Node Type', matchField: 'Id' } },
      { key: 'fields', format: 'fields' },
    ],
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
jest.mock('../../translation_graph/adapters/acting_user/resolve', () => ({
  resolveActingUser: jest.fn(async () => null),
}));
jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(() => {
    throw new Error('test: resolveAdapter must not be called — tests inject a resolver');
  }),
}));

import type { InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { MovementEngineError } from '../expression';
import { surfaceReadAdapter } from '../kg';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type {
  Adapter,
  RuntimeCapabilities,
} from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { RecordMutationEvent } from '../../translation_graph/mutation_context';
import {
  makeStablePosition,
  positionData,
  positionRecordId,
} from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;
const COMPANY_NODE_ID = '00000000-0000-0000-0000-00000000c001' as NodeId;

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

interface RecordedWrite {
  recordType: string;
  externalId?: string;
  fields: Record<string, unknown>;
}

function makeTargetFake(adapterType: string): { adapter: Adapter; creates: RecordedWrite[] } {
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
      return { adapterType, externalId: `ext-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

/** A fake KG SOURCE: per-node property bags + per-(node, edge) neighbours. */
function makeKgFake(input: {
  records: Record<string, Record<string, unknown>>;
  edges?: Record<string, Record<string, Array<{ id: string; data?: Record<string, unknown> }>>>;
}): Adapter {
  return {
    adapterType: 'kg',
    supportedTriggers: ['mutation'] as never[],
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
      const id = positionRecordId(position);
      return id !== undefined ? (input.records[id]?.[fieldId] ?? null) : null;
    },
    async getRelated({ position, fieldId }) {
      const id = positionRecordId(position);
      const neighbours = id !== undefined ? (input.edges?.[id]?.[fieldId] ?? []) : [];
      return neighbours.map((n) => ({
        position: makeStablePosition({
          adapterType: 'kg',
          recordType: null,
          recordId: n.id,
          ...(n.data !== undefined ? { data: n.data } : {}),
        }),
      }));
    },
    async createRecord() {
      throw new Error('test: the kg fake is a source — nothing writes to it here');
    },
    async updateRecord() {
      throw new Error('test: the kg fake is a source — nothing writes to it here');
    },
    async deleteRecord() {
      return {};
    },
  };
}

const kgSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', domains: { kind: 'list', of: 'text' } },
      edges: { rounds: { target: 'funding_round' } },
    },
    funding_round: { properties: { stage: 'text' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { kg: kgSchema },
});

function mutationEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  const payload: RecordMutationEvent = {
    recordId: COMPANY_NODE_ID,
    nodeTypeId: 'nt-company',
    changeKind: 'update',
    changedFields: ['pt-domains'],
    context: {
      source: { type: 'structured_input', adapterType: 'kg' },
      occurredAt: new Date().toISOString(),
    },
  };
  return {
    pipelineInputId: 'trigger:t-kg-1',
    adapterType: 'kg',
    triggerType: 'mutation',
    payload,
    recordId: COMPANY_NODE_ID,
    changedFields: ['pt-domains'],
    occurredAt: payload.context.occurredAt,
    ...overrides,
  };
}

const ON_COMPANY_CHANGE = [
  'import { attio, kg } from adapters',
  'import { acme_main } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'graph = kg()',
  '',
  'movement on_company_change(rec: <graph-[:company]->>) {',
  '  write crm-[:companies]-> {',
  '    unique by (`name`)',
  '    name:    rec.`name`',
  '    domains: rec.`domains`',
  '  }',
  '}',
  '',
  'listen to graph { type: "company", events: ["record.created", "record.updated"], fields: [domains] } fire on_company_change',
].join('\n');

describe('kg-seeded movements (mutation listen) — runMovement', () => {
  it('seeds the mutated record and reads its properties through the KG adapter', async () => {
    const target = makeTargetFake('attio');
    const kg = makeKgFake({
      records: {
        [COMPANY_NODE_ID]: { name: 'Acme Corp', domains: ['acme.dev'] },
      },
    });

    const result = await runMovement({
      source: ON_COMPANY_CHANGE,
      movementName: 'on_company_change',
      event: mutationEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: () => 'cred-attio-1',
      resolveAdapter: ({ adapterType }) => {
        if (adapterType === 'kg') return kg;
        if (adapterType === 'attio') return target.adapter;
        throw new Error(`test: no fake for '${adapterType}'`);
      },
    });

    expect(result.movementName).toBe('on_company_change');
    // The fake target declares no descriptor, so the engine's cardinality
    // coercion folds the list to CSV — frozen-engine parity, not a kg fact.
    expect(target.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'Acme Corp', domains: 'acme.dev' },
      },
    ]);
    // Source-property provenance carries the graph INSTANCE's own name + the
    // record — the instance the movement constructed, like any other system.
    expect(result.writes[0].provenance['name']?.[0]).toMatchObject({
      kind: 'source_field',
      instance: 'graph',
      adapterType: 'kg',
      field: 'name',
    });
  });

  it('edge hops off the kg seed stream through getRelated', async () => {
    const target = makeTargetFake('attio');
    const kg = makeKgFake({
      records: {
        [COMPANY_NODE_ID]: { name: 'Acme Corp' },
        'round-1': { stage: 'Series A' },
      },
      edges: {
        [COMPANY_NODE_ID]: { rounds: [{ id: 'round-1' }] },
      },
    });

    const source = [
      'import { attio, kg } from adapters',
      'import { acme_main } from credentials',
      '',
      'crm = attio(credentials: acme_main)',
      'graph = kg()',
      '',
      'movement on_company_change(rec: <graph-[:company]->>) {',
      '  rec-[r:rounds]-> {',
      '    write crm-[:companies]-> {',
      '      unique by (`name`)',
      '      name: r.`stage`',
      '    }',
      '  }',
      '}',
      '',
      'listen to graph { type: "company" } fire on_company_change',
    ].join('\n');

    const result = await runMovement({
      source,
      movementName: 'on_company_change',
      event: mutationEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: () => 'cred-attio-1',
      resolveAdapter: ({ adapterType }) => {
        if (adapterType === 'kg') return kg;
        if (adapterType === 'attio') return target.adapter;
        throw new Error(`test: no fake for '${adapterType}'`);
      },
    });

    expect(result.writes).toHaveLength(1);
    expect(target.creates[0].fields).toEqual({ name: 'Series A' });
  });

  it('a mutation event with no recordId fails loud', async () => {
    const target = makeTargetFake('attio');
    const kg = makeKgFake({ records: {} });
    await expect(
      runMovement({
        source: ON_COMPANY_CHANGE,
        movementName: 'on_company_change',
        event: mutationEvent({ recordId: undefined }),
        teamId: TEAM_ID,
        catalog,
        resolveCredentialId: () => 'cred-attio-1',
        resolveAdapter: ({ adapterType }) =>
          adapterType === 'kg' ? kg : target.adapter,
      }),
    ).rejects.toThrow(MovementEngineError);
  });
});

describe('surfaceReadAdapter — natural-name read seam (KG)', () => {
  // The wrapper carries NO name↔id translation (Decision #3 — the adapter
  // does that internally). Its job is to STAMP each position's `recordType`
  // with the hop target's NATURAL type (from the instance schema) and PRESERVE
  // inline `data`, so the adapter's own `getFieldValue` can resolve the
  // (verbatim) natural field name against the right type. It passes field /
  // edge names through unchanged.

  function recordingInner(): {
    adapter: Adapter;
    fieldReads: Array<{ fieldId: string; recordType: string | null; recordId?: string }>;
    relatedReads: Array<{ fieldId: string; recordType: string | null }>;
  } {
    const fieldReads: Array<{ fieldId: string; recordType: string | null; recordId?: string }> = [];
    const relatedReads: Array<{ fieldId: string; recordType: string | null }> = [];
    const adapter: Adapter = {
      adapterType: 'kg',
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
        fieldReads.push({
          fieldId,
          recordType: position.recordType,
          ...(positionRecordId(position) !== undefined
            ? { recordId: positionRecordId(position) }
            : {}),
        });
        return 'value';
      },
      async getRelated({ position, fieldId }) {
        relatedReads.push({ fieldId, recordType: position.recordType });
        return [
          {
            position: makeStablePosition({
              adapterType: 'kg',
              recordType: null,
              recordId: 'round-1',
            }),
          },
        ];
      },
      async createRecord() {
        throw new Error('unused');
      },
      async updateRecord() {
        throw new Error('unused');
      },
      async deleteRecord() {
        return {};
      },
    };
    return { adapter, fieldReads, relatedReads };
  }

  const kgSchemaForWrapper: InstanceSchema = {
    positions: {
      company: { properties: { name: 'text' }, edges: { rounds: { target: 'funding_round' } } },
      funding_round: { properties: { stage: 'text' }, edges: {} },
    },
    collections: {},
    writableRoots: {},
  };

  const companyPosition = makeStablePosition({
    adapterType: 'kg',
    recordType: 'company',
    recordId: COMPANY_NODE_ID,
  });

  it('passes the natural field name through verbatim, with the position natural type', async () => {
    const inner = recordingInner();
    const wrapped = surfaceReadAdapter({
      inner: inner.adapter,
      schema: kgSchemaForWrapper,
    });
    await wrapped.getFieldValue({ position: companyPosition, fieldId: 'name' });
    // The wrapper does NOT translate — the adapter receives the natural field
    // name and the natural type on the position (it resolves them itself).
    expect(inner.fieldReads).toEqual([
      { fieldId: 'name', recordType: 'company', recordId: COMPANY_NODE_ID },
    ]);
  });

  it('passes the natural edge name through and stamps the landed natural type', async () => {
    const inner = recordingInner();
    const wrapped = surfaceReadAdapter({
      inner: inner.adapter,
      schema: kgSchemaForWrapper,
    });
    const related = await wrapped.getRelated({
      position: companyPosition,
      fieldId: 'rounds',
      direction: 'outgoing',
    });
    // Edge name crosses verbatim; the FROM position carries its natural type.
    expect(inner.relatedReads).toEqual([{ fieldId: 'rounds', recordType: 'company' }]);
    expect(related).toHaveLength(1);
    // The landed record is stamped with the schema edge's target natural type.
    expect(related[0].position).toMatchObject({ recordType: 'funding_round' });

    // A deeper read off the landed position carries the stamped natural type,
    // so the adapter resolves ITS field against the right type.
    await wrapped.getFieldValue({ position: related[0].position, fieldId: 'stage' });
    expect(inner.fieldReads).toEqual([
      { fieldId: 'stage', recordType: 'funding_round', recordId: 'round-1' },
    ]);
  });

  it('roots a typeless event position at the parameter natural type (startSurfaceType)', async () => {
    const inner = recordingInner();
    const wrapped = surfaceReadAdapter({
      inner: inner.adapter,
      schema: kgSchemaForWrapper,
      startSurfaceType: 'company',
    });
    const typeless = makeStablePosition({
      adapterType: 'kg',
      recordType: null,
      recordId: COMPANY_NODE_ID,
    });
    await wrapped.getFieldValue({ position: typeless, fieldId: 'name' });
    // The typeless root is stamped with the parameter's declared natural type
    // so the adapter knows which type to resolve `name` against.
    expect(inner.fieldReads).toEqual([
      { fieldId: 'name', recordType: 'company', recordId: COMPANY_NODE_ID },
    ]);
  });
});
