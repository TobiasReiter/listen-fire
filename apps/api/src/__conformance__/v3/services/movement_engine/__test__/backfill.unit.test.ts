// E6 — meta-rooted movements on the interpreter (backfills).
//
//   1. PARITY — `movement backfill(root: <crm>)` + collection block + kg
//      writes under a `snapshot` event, run through BOTH `runMovement`
//      AND the frozen compile + TG-engine path with the same fake
//      adapters: the engine seeds the source instance's meta position
//      (manual_run.ts semantics), the collection block streams positions
//      through the SAME `getRelated(meta, collection)` seam the TG
//      engine's snapshot fan-out walks, and the captured writes are
//      identical.
//   2. Live run — per-position isolation (each iteration's write carries
//      its own record's values), per-iteration `bridgeToExternal` (each
//      KG create bridges to the collection record it stands on — the TG
//      engine's stable-external-position rule), the `ensureKgBridge`
//      recordLink arm on identity-matched updates, and the snapshot
//      mutation context speaking the source instance's adapter (the
//      envelope's adapterType is a placeholder).
//   3. Streaming — the engine prefers `iterateRelated` when the adapter
//      publishes it (snapshot fan-outs may be large).
//   4. The run_now envelope shape (`adapterType: 'unknown'`) executes —
//      the seed's adapter identity comes from the program's source
//      instance, not the envelope.

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

import type { Catalog, InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  RuntimeCapabilities,
  GetRelatedInput,
  RelatedResult,
  UpdateInput,
  WriteInput,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { MutationContext } from '../../translation_graph/mutation_context';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
} from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;
const KG = 'kg';

// The manual channel's REAL adapter — credential-free and stateless, so
// the fixture uses it directly (the event payload is its whole surface).
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

// ── Fakes ───────────────────────────────────────────────────────────────────

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

interface CompanyRow {
  id: string;
  fields: Record<string, unknown>;
}

/**
 * The fake CRM source: its meta position's `companies` collection yields
 * one stable external record per row — the SAME getRelated seam the TG
 * engine's snapshot fan-out walks. `getFieldValue` reads the position's
 * data bag, so both engines see identical records.
 */
function makeCollectionSource(
  companies: CompanyRow[],
  options: { streaming?: boolean } = {},
): {
  adapter: Adapter;
  relatedCalls: Array<{ recordType: string | null; fieldId: string }>;
  iterateCalls: number;
} {
  const relatedCalls: Array<{ recordType: string | null; fieldId: string }> = [];
  const state = { iterateCalls: 0 };
  const yieldCompanies = (input: GetRelatedInput): RelatedResult[] => {
    relatedCalls.push({ recordType: input.position.recordType, fieldId: input.fieldId });
    if (input.position.recordType !== META_RECORD_TYPE || input.fieldId !== 'companies') {
      return [];
    }
    return companies.map((c) => ({
      position: makeStablePosition({
        adapterType: 'attio',
        recordType: 'company',
        recordId: c.id,
        data: c.fields,
      }),
    }));
  };
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
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated(input) {
      return yieldCompanies(input);
    },
    ...(options.streaming
      ? {
          async *iterateRelated(input: GetRelatedInput) {
            state.iterateCalls += 1;
            for (const r of yieldCompanies(input)) yield r;
          },
        }
      : {}),
    async createRecord() {
      throw new Error('test: source adapter must not receive writes');
    },
    async updateRecord() {
      throw new Error('test: source adapter must not receive writes');
    },
    async deleteRecord() {
      return {};
    },
  };
  return {
    adapter,
    relatedCalls,
    get iterateCalls() {
      return state.iterateCalls;
    },
  };
}

interface RecordedKgCreate {
  recordType: string;
  fields: Record<string, unknown>;
  bridgeToExternal: WriteInput['bridgeToExternal'] | null;
  mutationContext: MutationContext;
}

interface RecordedKgUpdate {
  recordType: string;
  externalId: string;
  fields: Record<string, unknown>;
}

/** A recording fake KG adapter; `resolveEntity` answers from an
 *  injectable candidate function (identity-search seam). */
function makeFakeKg(
  options: {
    resolveCandidates?: (record: Record<string, unknown>) => Array<{ externalId: string; data: Record<string, unknown> }>;
  } = {},
): {
  adapter: Adapter;
  creates: RecordedKgCreate[];
  updates: RecordedKgUpdate[];
} {
  const creates: RecordedKgCreate[] = [];
  const updates: RecordedKgUpdate[] = [];
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity({ record }) {
      return {
        candidates: (options.resolveCandidates?.(record) ?? []).map((c) => ({
          adapterType: KG,
          externalId: c.externalId,
          data: c.data,
        })),
      };
    },
    async getFieldValue() {
      return undefined;
    },
    async getRelated() {
      return [];
    },
    async createRecord(input: WriteInput) {
      creates.push({
        recordType: input.recordType,
        fields: input.fields,
        bridgeToExternal: input.bridgeToExternal ?? null,
        mutationContext: input.mutationContext,
      });
      return { adapterType: KG, externalId: `node-${creates.length}`, data: {} };
    },
    async updateRecord(input: UpdateInput) {
      updates.push({
        recordType: input.recordType,
        externalId: input.externalId,
        fields: input.fields,
      });
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

// ── Fixture ─────────────────────────────────────────────────────────────────

const kgSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', summary: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', summary: 'text' },
      resultShape: { externalId: 'text', name: 'text', summary: 'text' },
    },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { kg: kgSchema },
});

// The real attio company schema (captured reality, `staticCatalogFromManifests`'s
// thin instance schema) has no date field, and the fix for the UnsnoozeActions
// WHERE-typing case (below) needs a genuinely date-typed field to compare
// against `@current_date` — never edit the captured schema to manufacture one.
// This derives a TEST-LOCAL extension instead: the real schema, plus one
// honestly-dated `founded` field on `company`.
const datedCompanyCatalog: Catalog = {
  ...catalog,
  instantiate: (adapter, args) => {
    const schema = catalog.instantiate(adapter, args);
    if (adapter !== 'attio' || schema === undefined) return schema;
    return {
      ...schema,
      positions: {
        ...schema.positions,
        company: {
          ...schema.positions.company,
          properties: { ...schema.positions.company.properties, founded: 'date' },
        },
      },
    };
  },
};

const CREDENTIAL_IDS: Record<string, string> = { acme_main: 'cred-attio-1' };

// The backfill shape: a manual-channel listener fires the movement
// ("Run now" injects the invocation event — run_now.ts), and the body
// roots its traversal at the constructed instance — `crm-[c:companies]->`
// streams the collection through the crm instance's own adapter.
const BACKFILL = [
  'import { manual, attio, kg } from adapters',
  'import { acme_main } from credentials',
  '',
  'runs = manual()',
  'graph = kg()',
  'crm = attio(credentials: acme_main)',
  '',
  'movement backfill(go: <runs-[:Invocation]->>) {',
  '  crm-[c:companies]-> {',
  '    write graph-[:company]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`summary`',
  '    }',
  '  }',
  '}',
  '',
  'listen to runs {} fire backfill',
].join('\n');

const COMPANIES: CompanyRow[] = [
  { id: 'co-1', fields: { name: 'Acme', summary: 'roadrunner traps', founded: '2015-06-01' } },
  { id: 'co-2', fields: { name: 'Globex', summary: 'world domination', founded: '2020-01-01' } },
];

function manualEvent(): TriggerEvent {
  // The run_now.ts injection shape: an invocation event on the manual
  // channel, carrying the initiating member.
  return {
    pipelineInputId: 'trigger:manual-1',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString(), actorEmail: 'ada@example.com' },
    occurredAt: new Date().toISOString(),
  };
}

// ── 1. Meta-rooted dry run — the collection fan-out ─────────────────────────

describe('meta-rooted backfill: runMovement over the collection fan-out', () => {
  it('captures one write per collection record, in collection order', async () => {
    const sourceA = makeCollectionSource(COMPANIES);
    const movementWrites: CapturedWrite[] = [];
    const runResult = await runMovement({
      source: BACKFILL,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: sourceA.adapter, manual: manualAdapter, [KG]: makeFakeKg().adapter }),
      dryRun: true,
      writeSink: (w) => movementWrites.push(w),
    });
    expect(runResult.movementName).toBe('backfill');
    // The seed is the source instance's META position; the collection
    // hop walked it through getRelated with the collection as fieldId.
    expect(sourceA.relatedCalls).toEqual([{ recordType: META_RECORD_TYPE, fieldId: 'companies' }]);

    expect(movementWrites).toEqual([
      {
        kind: 'create',
        adapterType: KG,
        recordType: 'company',
        fields: { name: 'Acme', summary: 'roadrunner traps' },
      },
      {
        kind: 'create',
        adapterType: KG,
        recordType: 'company',
        fields: { name: 'Globex', summary: 'world domination' },
      },
    ]);
  });
});

// ── 2. Live run — isolation, bridges, mutation context ──────────────────────

describe('backfill live run — per-position isolation (no implicit bridge, 3b)', () => {
  it('each iteration writes ITS record; a plain write asserts no correspondence', async () => {
    const source = makeCollectionSource(COMPANIES);
    const kg = makeFakeKg();
    const result = await runMovement({
      source: BACKFILL,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: source.adapter, manual: manualAdapter, [KG]: kg.adapter }),
    });

    // Per-position isolation: one create per collection record, each
    // carrying its own record's values. The implicit per-iteration bridge
    // is GONE (bind-only model) — a plain `write graph-[:company]-> { … }` carries
    // NO bridgeToExternal. The mutation context still speaks the SOURCE
    // INSTANCE's dispatch adapter (the envelope placeholder aside), and carries
    // the firing that authored the write — the marker `suppress_self` reads.
    expect(kg.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'Acme', summary: 'roadrunner traps' },
        bridgeToExternal: null,
        mutationContext: expect.objectContaining({
          source: expect.objectContaining({ type: 'structured_input', adapterType: 'manual' }),
        }),
      },
      {
        recordType: 'company',
        fields: { name: 'Globex', summary: 'world domination' },
        bridgeToExternal: null,
        mutationContext: expect.objectContaining({
          source: expect.objectContaining({ type: 'structured_input', adapterType: 'manual' }),
        }),
      },
    ]);
    // No correspondence on a plain write — `recordLink` was retired from the
    // adapter interface (bind-only model), so one cannot be recorded.

    // The firing record: program-order writes with record-resolved
    // source provenance per field.
    expect(result.writes.map((w) => [w.recordType, w.created, w.externalId])).toEqual([
      ['company', true, 'node-1'],
      ['company', true, 'node-2'],
    ]);
    expect(result.writes[1].provenance.name).toEqual([
      {
        kind: 'source_field',
        instance: 'crm',
        adapterType: 'attio',
        recordType: 'company',
        externalId: 'co-2',
        field: 'name',
      },
    ]);
  });

  it('an identity-matched plain write updates without asserting any correspondence', async () => {
    const source = makeCollectionSource([COMPANIES[0]]);
    const kg = makeFakeKg({
      resolveCandidates: (record) =>
        record.name === 'Acme' ? [{ externalId: 'node-existing', data: { name: 'Acme' } }] : [],
    });
    await runMovement({
      source: BACKFILL,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: source.adapter, manual: manualAdapter, [KG]: kg.adapter }),
    });

    // Matched by `unique by (name)` → update, no duplicate create…
    expect(kg.creates).toEqual([]);
    expect(kg.updates).toEqual([
      {
        recordType: 'company',
        externalId: 'node-existing',
        fields: { name: 'Acme', summary: 'roadrunner traps' },
      },
    ]);
    // …and a plain write establishes NO binding — `recordLink` is gone from
    // the adapter interface (bind-only model).
  });
});

// ── 3. Streaming — iterateRelated preferred when published ──────────────────

describe('backfill streaming — the engine prefers iterateRelated', () => {
  it('walks the collection through iterateRelated, never the eager getRelated', async () => {
    const source = makeCollectionSource(COMPANIES, { streaming: true });
    const kg = makeFakeKg();
    await runMovement({
      source: BACKFILL,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: source.adapter, manual: manualAdapter, [KG]: kg.adapter }),
    });
    expect(source.iterateCalls).toBe(1);
    expect(kg.creates).toHaveLength(2);
  });
});

// ── 4. A local `=` binding used inside a hop WHERE ──────────────────────────
//
// A bare identifier in a hop WHERE that names an in-scope local `=` binding
// must resolve to that binding's VALUE, exactly as if the bound expression had
// been inlined — NOT be read as a field of the hop's landed record. Read as a
// field, `getFieldValue('threshold')` returns undefined (the source carries no
// such column) and every row filters OUT; on a real adapter the field resolver
// would throw drift ("'threshold' is not a known field"). Resolved from scope,
// the WHERE behaves like `\`name\` == "Globex"`.
const BACKFILL_BINDING_WHERE = [
  'import { manual, attio, kg } from adapters',
  'import { acme_main } from credentials',
  '',
  'runs = manual()',
  'graph = kg()',
  'crm = attio(credentials: acme_main)',
  '',
  'movement backfill(go: <runs-[:Invocation]->>) {',
  '  threshold = "Globex"',
  '  crm-[c:companies WHERE `name` == threshold]-> {',
  '    write graph-[:company]-> {',
  '      unique by (`name`)',
  '      name:    c.`name`',
  '      summary: c.`summary`',
  '    }',
  '  }',
  '}',
  '',
  'listen to runs {} fire backfill',
].join('\n');

describe('a local `=` binding resolves inside a hop WHERE', () => {
  it('filters by the binding value (not as a field of the landed record)', async () => {
    const source = makeCollectionSource(COMPANIES);
    const kg = makeFakeKg();
    await runMovement({
      source: BACKFILL_BINDING_WHERE,
      event: manualEvent(),
      teamId: TEAM_ID,
      catalog,
      resolveCredentialId: (name) => CREDENTIAL_IDS[name],
      resolveAdapter: makeResolver({ attio: source.adapter, manual: manualAdapter, [KG]: kg.adapter }),
    });
    // `threshold` == "Globex": only Globex survives the hop WHERE. Read as a
    // field, BOTH rows would drop (getFieldValue('threshold') → undefined).
    expect(kg.creates).toEqual([
      {
        recordType: 'company',
        fields: { name: 'Globex', summary: 'world domination' },
        bridgeToExternal: null,
        mutationContext: expect.anything(),
      },
    ]);
  });

  it('a binding bound to @current_date is usable in a hop WHERE (the UnsnoozeActions case)', async () => {
    // `c = @current_date`, then `\`founded\` <= c` — `c` resolves to the
    // ambient date scalar, never a field read; `founded` is a genuinely
    // date-typed field (the UnsnoozeActions shape compares a date field to
    // `@current_date`, e.g. `\`Snoozed Until\` <= c` — see
    // check_typed.unit.test.ts's identical-shape case). Both rows were
    // founded before today, so the comparison is vacuously true; the point is
    // it RUNS clean, with no type mismatch, the exact failure hit in production.
    const dated = [
      'import { manual, attio, kg } from adapters',
      'import { acme_main } from credentials',
      '',
      'runs = manual()',
      'graph = kg()',
      'crm = attio(credentials: acme_main)',
      '',
      'movement backfill(go: <runs-[:Invocation]->>) {',
      '  c = @current_date',
      '  crm-[co:companies WHERE `founded` <= c]-> {',
      '    write graph-[:company]-> { unique by (`name`) name: co.`name` }',
      '  }',
      '}',
      '',
      'listen to runs {} fire backfill',
    ].join('\n');
    const source = makeCollectionSource(COMPANIES);
    const kg = makeFakeKg();
    await expect(
      runMovement({
        source: dated,
        event: manualEvent(),
        teamId: TEAM_ID,
        catalog: datedCompanyCatalog,
        resolveCredentialId: (name) => CREDENTIAL_IDS[name],
        resolveAdapter: makeResolver({ attio: source.adapter, manual: manualAdapter, [KG]: kg.adapter }),
      }),
    ).resolves.toBeDefined();
  });
});
