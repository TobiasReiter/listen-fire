// Mutation dispatch → movement firings, end to end (the listen-to-kg
// backbone). REAL: dispatchMutationEvent's KG_MUTATION matching +
// movement routing, runMovementFiring (movement/execute.ts), the movement
// engine (runMovement — parse, check, kg seed, adapter writes), and the
// emitted-event RE-DISPATCH loop. Mocked: storage (trigger rows + movement
// rows + catalog assembly), adapter resolution (fakes), the trigger_run
// recorder, and the DB.
//
// Scenario (two movements chained through the mutation-event currency):
//
//   company update event
//     → trigger t-company (listen to graph { type: "company", events:
//       ["update"], fields: [domains] } fire on_company_change)
//     → on_company_change reads the mutated company THROUGH the fake KG
//       adapter and writes kg.person — whose createRecord EMITS a person
//       mutation event (the E3 currency)
//     → the dispatcher re-dispatches that event
//     → trigger t-person (listen to graph { type: "person" } fire
//       on_person_change) fires and writes to the fake attio.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../../knowledge_pipeline/output_v3/schemas');

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
jest.mock('../../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

jest.mock('../../adapters/knowledge_graph', () => ({
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

jest.mock('../../../knowledge_pipeline/facts', () => ({
  extractFactsForResource: jest.fn(async () => []),
}));
jest.mock('../../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));
jest.mock('../../adapters/acting_user/resolve', () => ({
  resolveActingUser: jest.fn(async () => null),
}));

// trigger_run recording — the firing wiring is covered by execute.unit.
const recordMovementStep = jest.fn();
const recordStepFailure = jest.fn();
const recorderFinish = jest.fn(async () => undefined);
jest.mock('../../runs/trigger_run', () => ({
  TriggerRunRecorder: jest.fn(() => ({
    recordStep: jest.fn(),
    recordMovementStep,
    recordStepFailure,
    finish: recorderFinish,
    startOpsRun: jest.fn(async () => undefined),
    ensureStarted: jest.fn(async () => undefined),
    beginLiveTrace: jest.fn(),
    endLiveTrace: jest.fn(),
  })),
}));

// Storage: the trigger index + bindings loader.
jest.mock('../../storage/tg_table', () => ({
  findTriggersByKind: jest.fn(),
  loadTriggerBindingsByTriggerIds: jest.fn(async () => new Map()),
}));

// Movement rows + per-team catalog assembly.
jest.mock('../../movement/store', () => ({
  getMovementRow: jest.fn(),
}));
jest.mock('../../movement/catalog', () => ({
  runCatalogSnapshotForTeam: jest.fn(),
}));

// The team-Context seam a background firing runs inside — pass-through here;
// it has its own test (movement/__test__/firing_context.unit.test.ts).
jest.mock('../../movement/firing_context', () => ({
  withFiringContext: <T>(_firing: unknown, fn: () => Promise<T>) => fn(),
}));

// Adapter resolution — production-path runMovement resolves through this.
jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: jest.fn(),
}));

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type {
  Adapter,
  RuntimeCapabilities,
} from '../../adapter';
import type { MutationContext } from '../../mutation_context';
import type { RecordMutationEvent } from '../record_mutation_event';
import type { NodeId } from '../../../../generated/kysely/knowledge/Node';

import { dispatchMutationEvent } from '../mutation_dispatch';
import { containerAssociation } from '../../adapter';
import { makeStablePosition, positionRecordId } from '../../types';
import { teamOfTenant } from '../../movement/tenant';

const { findTriggersByKind } = jest.requireMock('../../storage/tg_table') as {
  findTriggersByKind: jest.Mock;
};
const { getMovementRow } = jest.requireMock('../../movement/store') as {
  getMovementRow: jest.Mock;
};
const { runCatalogSnapshotForTeam } = jest.requireMock('../../movement/catalog') as {
  runCatalogSnapshotForTeam: jest.Mock;
};
const { resolveAdapter } = jest.requireMock('../../adapters/resolve') as {
  resolveAdapter: jest.Mock;
};

const TEAM = tenantIdOf('00000000-0000-0000-0000-000000000010');
const COMPANY_NODE = '00000000-0000-0000-0000-00000000c001' as NodeId;
const PERSON_NODE = '00000000-0000-0000-0000-00000000d001' as NodeId;

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

const mutationContext: MutationContext = {
  source: { type: 'structured_input', adapterType: 'kg' },
  occurredAt: new Date().toISOString(),
};

/** The fake KG: a readable record store whose person CREATE emits a
 *  RecordMutationEvent — the re-dispatch currency. */
function makeKgFake(): {
  adapter: Adapter;
  creates: Array<{ recordType: string; fields: Record<string, unknown> }>;
} {
  const records: Record<string, Record<string, unknown>> = {
    [COMPANY_NODE]: { name: 'Acme Corp', domains: ['acme.dev'] },
    [PERSON_NODE]: { name: 'Ada Lovelace' },
  };
  const creates: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
  const adapter: Adapter = {
    adapterType: 'kg',
    supportedTriggers: ['mutation'] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    // The graph publishes its model like any other adapter: the NAME a listen
    // writes as the framework identity, the store's own id as `externalId`.
    // That pairing is what lets dispatch read an event's internal ids back in
    // the currency the listen is written in — without the host knowing how.
    async listEntryPoints() {
      return [
        { typeId: 'company', displayName: 'company', externalId: 'nt-company', readable: true, writable: true },
        { typeId: 'person', displayName: 'person', externalId: 'nt-person', readable: true, writable: true },
      ];
    },
    async describe(typeRef: string) {
      if (typeRef === 'company') {
        return {
          typeId: 'company',
          displayName: 'company',
          fields: [
            { fieldId: 'pt-name', displayName: 'name', kind: 'string' as const, writable: true, required: false },
            { fieldId: 'pt-domains', displayName: 'domains', kind: 'string' as const, cardinality: 'many' as const, writable: true, required: false },
          ],
          references: [],
        };
      }
      if (typeRef === 'person') {
        return {
          typeId: 'person',
          displayName: 'person',
          fields: [
            { fieldId: 'pt-person-name', displayName: 'name', kind: 'string' as const, writable: true, required: false },
          ],
          references: [],
        };
      }
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const id = positionRecordId(position);
      return id !== undefined ? (records[id]?.[fieldId] ?? null) : null;
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      records[PERSON_NODE] = { ...records[PERSON_NODE], ...input.fields };
      const emitted: RecordMutationEvent = {
        recordId: PERSON_NODE,
        nodeTypeId: 'nt-person',
        changeKind: 'create',
        changedFields: Object.keys(input.fields),
        context: mutationContext,
      };
      return {
        adapterType: 'kg',
        externalId: PERSON_NODE,
        data: {},
        events: [emitted],
      };
    },
    async updateRecord(input) {
      return { adapterType: 'kg', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

function makeAttioFake(): {
  adapter: Adapter;
  creates: Array<{ recordType: string; fields: Record<string, unknown> }>;
} {
  const creates: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
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
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue() {
      return null;
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType: 'attio', externalId: `attio-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const kgSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', domains: { kind: 'list', of: 'text' } },
      edges: {},
    },
    person: { properties: { name: 'text' }, edges: {} },
  },
  collections: {},
  writableRoots: {
    person: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
  },
};

const COMPANY_FILE = [
  'import { kg } from adapters',
  '',
  'graph = kg()',
  '',
  'movement on_company_change(rec: <graph-[:company]->>) {',
  '  write graph-[:person]-> {',
  '    unique by (`name`)',
  '    name: rec.`name`',
  '  }',
  '}',
  '',
  'listen to graph { type: "company", events: ["record.updated"], fields: [domains] } fire on_company_change',
].join('\n');

const PERSON_FILE = [
  'import { attio, kg } from adapters',
  'import { acme_main } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  'graph = kg()',
  '',
  'movement on_person_change(rec: <graph-[:person]->>) {',
  '  write crm-[:people]-> {',
  '    unique by (`name`)',
  '    name: rec.`name`',
  '  }',
  '}',
  '',
  'listen to graph { type: "person" } fire on_person_change',
].join('\n');

const movementRows: Record<string, { id: string; name: string; source: string }> = {
  'mov-company': { id: 'mov-company', name: 'company_file', source: COMPANY_FILE },
  'mov-person': { id: 'mov-person', name: 'person_file', source: PERSON_FILE },
};

const TRIGGERS = [
  {
    id: 't-company',
    name: 'movement/company_file/on_company_change',
    kind: 'kg',
    // Post-D40: the listen is persisted VERBATIM — names, not store ids.
    config: {
      type: 'company',
      events: ['record.updated'],
      fields: ['domains'],
    },
    credentialsId: null,
    runMode: 'live',
    movementId: 'mov-company',
  },
  {
    id: 't-person',
    name: 'movement/person_file/on_person_change',
    kind: 'kg',
    // A PRE-D40 row, kept so the transition arm stays exercised: it speaks the
    // store's own currency and keeps filtering until its movement is re-saved.
    config: { type: 'person', node_type_id: 'nt-person' },
    credentialsId: null,
    runMode: 'live',
    movementId: 'mov-person',
  },
];

function companyUpdateEvent(
  overrides: Partial<RecordMutationEvent> = {},
): RecordMutationEvent {
  return {
    recordId: COMPANY_NODE,
    nodeTypeId: 'nt-company',
    changeKind: 'update',
    changedFields: ['pt-domains'],
    context: mutationContext,
    ...overrides,
  };
}

describe('dispatchMutationEvent → movement firings (a graph listen, end to end)', () => {
  let kg: ReturnType<typeof makeKgFake>;
  let attio: ReturnType<typeof makeAttioFake>;

  beforeEach(() => {
    jest.clearAllMocks();
    kg = makeKgFake();
    attio = makeAttioFake();

    findTriggersByKind.mockResolvedValue(TRIGGERS);
    getMovementRow.mockImplementation(async ({ id }: { id: string }) => {
      const row = movementRows[id];
      if (!row) return null;
      return {
        ...row,
        teamId: TEAM,
        description: '',
        triggerId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    runCatalogSnapshotForTeam.mockResolvedValue({
      snapshot: mockCatalogSnapshot({
        adapters: {
          attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]},
          kg: { constructionArgs: [], schema: kgSchema },
        },
        credentials: { acme_main: { adapter: 'attio' } },
      }),
      credentialIds: { acme_main: 'cred-attio-1' },
      notes: [],
    });
    resolveAdapter.mockImplementation(async ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'kg') return kg.adapter;
      if (adapterType === 'attio') return attio.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    });
  });

  // NOTE: the cross-listener re-dispatch ("2-way-sync") test was removed —
  // 2-way-sync safety is being dropped (costs are passed to the customer with
  // per-customer cost limits, so runaway-loop safety is no longer the guard).
  // The single-listener dispatch + routing/filtering cases below still apply.

  it("config routing: a change kind outside the listen's `changes` is skipped", async () => {
    const result = await dispatchMutationEvent({
      event: companyUpdateEvent({ changeKind: 'create', changedFields: ['pt-domains'] }),
      teamId: teamOfTenant(TEAM),
    });
    expect(result.movementFirings).toEqual([]);
    expect(kg.creates).toEqual([]);
  });

  it("changed-fields routing: an update not touching the listen's `fields` is skipped", async () => {
    const result = await dispatchMutationEvent({
      event: companyUpdateEvent({ changedFields: ['pt-name'] }),
      teamId: teamOfTenant(TEAM),
    });
    expect(result.movementFirings).toEqual([]);
    expect(kg.creates).toEqual([]);
  });

  it('run_mode off drops the firing', async () => {
    findTriggersByKind.mockResolvedValue([{ ...TRIGGERS[0], runMode: 'off' }]);
    const result = await dispatchMutationEvent({
      event: companyUpdateEvent(),
      teamId: teamOfTenant(TEAM),
    });
    expect(result.movementFirings).toEqual([]);
    expect(kg.creates).toEqual([]);
  });

  it('an engine failure is contained: recorded, surfaced as a value, dispatch returns', async () => {
    getMovementRow.mockImplementation(async ({ id }: { id: string }) =>
      id === 'mov-company'
        ? {
            ...movementRows['mov-company'],
            source:
              'import { kg } from adapters\n\ngraph = kg()\n\nmovement broken(rec: <graph-[:company]->>) {\n  x = ghost.`name`\n}',
            teamId: TEAM,
            description: '',
            triggerId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
    );
    findTriggersByKind.mockResolvedValue([TRIGGERS[0]]);
    const result = await dispatchMutationEvent({
      event: companyUpdateEvent(),
      teamId: teamOfTenant(TEAM),
    });
    expect(result.movementFirings).toHaveLength(1);
    expect(result.movementFirings[0].ok).toBe(false);
    expect(recordStepFailure).toHaveBeenCalled();
  });
});
