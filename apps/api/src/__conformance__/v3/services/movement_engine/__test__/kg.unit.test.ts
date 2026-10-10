// E3 — the knowledge graph as a true adapter for the movement engine.
//
//   1. PARITY — the golden-path-style movement (extract → `write
//      kg.funding_round` + linked `write fr-[:participants]->` with
//      compound `unique by (fr AND `name`)`) run through BOTH `runMovement`
//      AND the frozen compile + TG-engine path with identical mocked
//      extraction and the same recording fake KG adapter: byte-equal
//      resolveEntity inputs (including the folded edge-scoped parent
//      neighbour), creates (fields + parentLinks), and write order.
//      (Graph mutation events are NOT asserted here: since M-38 the
//      knowledge write door derives them inside the write transaction and
//      the outbox drainer delivers them — no engine surfaces them.)
//   2. Edge-identity resolve — a second run matches the funding round by
//      property identity and each participation by edge-scoped compound
//      identity (adjacency to the SAME parent + name): updates, no
//      duplicates.
//   3. Dry-run — KG writes are captured by the sink and never reach the
//      adapter's write methods.
//   4. Linked-write type inference — the written type comes from the
//      parent's graph schema; polymorphic edges demand an explicit type
//      (checker-gated when the ontology is typed, loud at runtime when
//      it isn't); explicit types are honored at runtime.

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

// The real KG adapter module reaches prisma through the knowledge write
// path. These suites exercise the KG through a recording fake resolved
// via the standard `resolveAdapter` seam — exactly how the TG engine's
// own unit suites fake the KG (per-action-target.unit.test.ts,
// engine.unit.test.ts) — so only the manifest constants are needed.
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
// The TG-side parity run drives the PRODUCTION batcher, whose LlmClient
// wraps `anthropicChat` — the per-test responder is installed on this mock.
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

import { mockCatalog, type Catalog, type InstanceSchema } from 'movement-lang';
import { anthropicChat } from '../../../lib/anthropic';
import { runFailureCause, runMovement } from '../run';

import { MovementEngineError } from '../expression';
import type {
  LlmCallInput,
  LlmCallResult,
} from '../../translation_graph/engine/batched_extraction';
import type { CapturedWrite } from '../../translation_graph/engine/dry_run_adapter';
import type {
  Adapter,
  RuntimeCapabilities,
  LinkRecordsInput,
  UpdateInput,
  WriteInput,
} from '../../translation_graph/adapter';
import { writeParentLinks } from '../../translation_graph/adapter';
import { containerAssociation } from '../../translation_graph/adapter';
import type { SchemaTypeDescriptor } from '../../translation_graph/types';
import type { UniquenessConstraints } from '../../translation_graph/uniqueness';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

/**
 * The error a rejected run really died of. A failure raised once the
 * interpreter is running comes out wrapped in `MovementRunFailed` (it carries
 * the run's partial write ledger out with it); parse/check failures are
 * unwrapped. The message is identical either way — only the class needs
 * looking through.
 */
async function rejectionCause(promise: Promise<unknown>): Promise<unknown> {
  const settled: unknown = await promise.then(
    () => new Error('expected the run to reject, but it resolved'),
    (e: unknown) => e,
  );
  return runFailureCause(settled);
}


const TEAM_ID = '00000000-0000-0000-0000-000000000010' as TeamId;
const KG = 'kg';

// ── Fakes ───────────────────────────────────────────────────────────────────

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

/** The fake source adapter — `getFieldValue` reads the position's data. */
function makeFakeSource(adapterType: string): Adapter {
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
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
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
}

/** Descriptor surface both engines read — references carry the edge the
 *  resolve fold keys on (the real adapter publishes ontology edges the
 *  same way, with edge_type ids for fieldIds). */
const KG_DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  funding_round: {
    typeId: 'funding_round',
    displayName: 'Funding Round',
    fields: [
      { fieldId: 'company', displayName: 'company', kind: 'string', writable: true, required: false, cardinality: 'one' },
      { fieldId: 'amount', displayName: 'amount', kind: 'string', writable: true, required: false, cardinality: 'one' },
    ],
    references: [
      { fieldId: 'participants', targetTypeId: 'round_participation', cardinality: 'many', direction: 'outgoing', name: 'participants', writable: true },
    ],
  },
  round_participation: {
    typeId: 'round_participation',
    displayName: 'Round Participation',
    fields: [
      { fieldId: 'name', displayName: 'name', kind: 'string', writable: true, required: false, cardinality: 'one' },
    ],
    references: [
      { fieldId: 'participants', targetTypeId: 'funding_round', cardinality: 'many', direction: 'incoming', name: 'participants', writable: true },
      { fieldId: 'participations', targetTypeId: 'investor', cardinality: 'many', direction: 'incoming', name: 'participations', writable: true },
    ],
  },
  investor: {
    typeId: 'investor',
    displayName: 'Investor',
    fields: [
      { fieldId: 'name', displayName: 'name', kind: 'string', writable: true, required: false, cardinality: 'one' },
    ],
    references: [
      { fieldId: 'participations', targetTypeId: 'round_participation', cardinality: 'many', direction: 'outgoing', name: 'participations', writable: true },
    ],
  },
};

interface FakeKgNode {
  id: string;
  recordType: string;
  fields: Record<string, unknown>;
  edges: Array<{ edge: string; otherId: string }>;
}

interface RecordedResolve {
  recordType: string;
  record: Record<string, unknown>;
  constraints: UniquenessConstraints;
}

interface RecordedCreate {
  recordType: string;
  fields: Record<string, unknown>;
  /** Per-field provenance the engine attached (E4) — the KG persists
   *  these as its native evidence rows. */
  evidence: WriteInput['evidence'] | null;
  /** The write's parent set (0/1/N) — null when absent. A linked write is
   *  just the 1-element case. */
  parentLinks: WriteInput['parentLinks'] | null;
  bridgeToExternal: WriteInput['bridgeToExternal'] | null;
}

interface RecordedUpdate {
  recordType: string;
  externalId: string;
  fields: Record<string, unknown>;
  evidence: UpdateInput['evidence'] | null;
  parentLinks: UpdateInput['parentLinks'] | null;
}

/**
 * A stateful fake KG adapter: candidate search honours the opaque
 * constraints over its stored nodes — properties by case-folded equality,
 * edge-valued entries (`record[field] = { id }`) by adjacency to the
 * asserted neighbour — exactly the contract `kg_uniqueness`'s
 * `searchKgCandidatesByUniqueness` implements over the real tables.
 * Each parent link inserts a connecting edge.
 */
function makeFakeKg() {
  const nodes: FakeKgNode[] = [];
  const resolveCalls: RecordedResolve[] = [];
  const creates: RecordedCreate[] = [];
  const updates: RecordedUpdate[] = [];
  const linkCalls: LinkRecordsInput[] = [];
  let seq = 0;

  const asNeighbour = (val: unknown): { id: string } | null =>
    typeof val === 'object' && val !== null && 'id' in val && typeof (val as { id: unknown }).id === 'string'
      ? { id: (val as { id: string }).id }
      : null;

  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe(typeId) {
      return KG_DESCRIPTORS[typeId] ?? null;
    },
    async resolveEntity({ record, recordType, constraints }) {
      resolveCalls.push({ recordType, record, constraints });
      const matches = nodes.filter(
        (node) =>
          node.recordType === recordType &&
          constraints.any.some(
            (branch) =>
              branch.all.length > 0 &&
              branch.all.every((entry) => {
                const val = record[entry.field];
                if (val === null || val === undefined) return false;
                const neighbour = asNeighbour(val);
                if (neighbour) {
                  return node.edges.some(
                    (e) => e.edge === entry.field && e.otherId === neighbour.id,
                  );
                }
                const own = node.fields[entry.field];
                if (own === null || own === undefined) return false;
                return String(own).toLowerCase() === String(val).toLowerCase();
              }),
          ),
      );
      return {
        candidates: matches.map((node) => ({
          adapterType: KG,
          externalId: node.id,
          data: node.fields,
        })),
      };
    },
    async getFieldValue() {
      return null;
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      const id = `kg-${++seq}`;
      const node: FakeKgNode = {
        id,
        recordType: input.recordType,
        fields: { ...input.fields },
        edges: [],
      };
      // The full parent set — one edge per link, exactly like
      // `createKgRecord`'s step-5 loop (N for tuple-path writes).
      for (const parentLink of writeParentLinks(input)) {
        node.edges.push({ edge: parentLink.edgeName, otherId: parentLink.externalId });
      }
      nodes.push(node);
      creates.push({
        recordType: input.recordType,
        fields: input.fields,
        evidence: input.evidence ?? null,
        parentLinks: input.parentLinks ?? null,
        bridgeToExternal: input.bridgeToExternal ?? null,
      });
      return { adapterType: KG, externalId: id, data: {} };
    },
    async updateRecord(input) {
      const node = nodes.find((n) => n.id === input.externalId);
      if (node) Object.assign(node.fields, input.fields);
      updates.push({
        recordType: input.recordType,
        externalId: input.externalId,
        fields: input.fields,
        evidence: input.evidence ?? null,
        parentLinks: input.parentLinks ?? null,
      });
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
    // Standalone edge assert (E7) — mirrors `linkKgRecords`: an idempotent
    // edge-row insert (here: the from node's `edges`).
    async linkRecords(input) {
      linkCalls.push(input);
      const from = nodes.find((n) => n.id === input.from.externalId);
      if (!from) throw new Error(`test: linkRecords from unknown node ${input.from.externalId}`);
      const already = from.edges.some(
        (e) => e.edge === input.edgeName && e.otherId === input.to.externalId,
      );
      if (already) return { created: false };
      from.edges.push({ edge: input.edgeName, otherId: input.to.externalId });
      return { created: true };
    },
  };

  return { adapter, nodes, resolveCalls, creates, updates, linkCalls };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

function webhookEvent(adapterType: string, payload: Record<string, unknown>): TriggerEvent {
  return {
    pipelineInputId: 'pi-movement-kg',
    adapterType,
    triggerType: 'webhook',
    payload,
  };
}

// ── LLM shims (per extraction.unit.test.ts) ─────────────────────────────────

function queuedMovementLlm(responses: unknown[]): {
  calls: LlmCallInput[];
  client: { call(input: LlmCallInput): Promise<LlmCallResult> };
} {
  const calls: LlmCallInput[] = [];
  return {
    calls,
    client: {
      async call(input: LlmCallInput): Promise<LlmCallResult> {
        calls.push(input);
        if (calls.length > responses.length) {
          throw new Error(`test: unexpected extraction call #${calls.length}:\n${input.system}`);
        }
        return { parsedJson: responses[calls.length - 1] };
      },
    },
  };
}

const wrap = (value: unknown) => ({ evidence: 'q', value });

// ── Catalog (typed kg ontology) ─────────────────────────────────────────────

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const kgSchema: InstanceSchema = {
  positions: {
    funding_round: {
      properties: { company: 'text', amount: 'text' },
      // Every KG ontology edge is writable — the adapter resolves an edge by
      // name from either end and inserts/asserts it (`resolveParentLinkEdgeType`
      // backs the linked create, `link` and `unlink` alike).
      edges: {
        participants: { target: 'round_participation', writable: true },
        related: { target: 'item', polymorphic: true, writable: true },
      },
    },
    round_participation: { properties: { name: 'text' }, edges: {} },
    investor: {
      properties: { name: 'text' },
      edges: { participations: { target: 'round_participation', writable: true } },
    },
  },
  collections: {
    funding_round: { target: 'funding_round' },
    round_participation: { target: 'round_participation' },
    investor: { target: 'investor' }
  },
  unions: { item: ['funding_round', 'round_participation'] },
  writableRoots: {
    funding_round: {
      fields: { company: 'text', amount: 'text' },
      resultShape: { externalId: 'text', company: 'text', amount: 'text' },
    },
    round_participation: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
    investor: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
  },
};

function makeCatalog(options: { kg?: InstanceSchema } = { kg: kgSchema }): Catalog {
  return mockCatalog({
    adapters: {
      email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
      kg: { constructionArgs: [], ...(options.kg ? { schema: options.kg } : {}) },
    },
    credentials: { dealflow_inbox: { adapter: 'email' } },
  });
}

const PRELUDE = [
  'import { email, kg } from adapters',
  'import { dealflow_inbox } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'graph = kg()',
].join('\n');

// ═════════════════════════════════════════════════════════════════════════════
// 1+2. Golden path — extract → kg.funding_round + linked round_participation
// ═════════════════════════════════════════════════════════════════════════════

const GOLDEN_PATH = [
  PRELUDE,
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '',
  '  deals = extract from [msg.`text`] {',
  '    node round: "each funding round announced in this message" {',
  '      company: "the raising company\'s name"',
  '      amount:  "the round amount"',
  '      node investor: "each investor participating in this round" {',
  '        name: "the investor\'s name"',
  '      }',
  '    }',
  '  }',
  '',
  '  deals-[r:round]-> {',
  '    fr = write graph-[:funding_round]-> {',
  '      unique by (`company`)',
  '      company: r.`company`',
  '      amount:  r.`amount`',
  '    }',
  '    r-[i:investor]-> {',
  '      write fr-[:participants]-> {',
  '        unique by (fr AND `name`)',
  '        name: i.`name`',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const GOLDEN_MOVEMENT_RESPONSE = {
  'x:extract_result#1': [
    {
      round: [
        {
          company: wrap('Acme'),
          amount: wrap('5M'),
          investor: [{ name: wrap('Alice Capital') }, { name: wrap('Bob Ventures') }],
        },
      ],
    },
  ],
};

const goldenEvent = () =>
  webhookEvent('email', {
    subject: 'Deals',
    text: 'Acme is raising 5M from Alice Capital and Bob Ventures.',
  });

async function runGoldenThroughMovementEngine(input: {
  kg: ReturnType<typeof makeFakeKg>;
  dryRun?: boolean;
  writeSink?: (w: CapturedWrite) => void;
}) {
  const llm = queuedMovementLlm([GOLDEN_MOVEMENT_RESPONSE]);
  return runMovement({
    source: GOLDEN_PATH,
    event: goldenEvent(),
    teamId: TEAM_ID,
    catalog: makeCatalog(),
    resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: input.kg.adapter }),
    llm: llm.client,
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    ...(input.writeSink !== undefined ? { writeSink: input.writeSink } : {}),
  });
}

describe('golden-path KG movement through runMovement', () => {
  it('produces the full KG effect set (resolve folds, creates, evidence, parent links, order)', async () => {
    const movementKg = makeFakeKg();
    const runResult = await runGoldenThroughMovementEngine({ kg: movementKg });
    expect(runResult.movementName).toBe('intake');

    // Deterministic node ids per fake (kg-1, kg-2, …) — including the
    // edge-scoped compound-identity fold (`participants: { id: kg-1 }`)
    // on the participation's resolve record AND the per-field
    // `WriteInput.evidence` (E4 — the engine keeps the extraction
    // responses' `{ evidence, value }` and translates faithful trails).
    expect(movementKg.creates).toEqual([
      {
        recordType: 'funding_round',
        fields: { company: 'Acme', amount: '5M' },
        evidence: {
          company: { quote: 'q', type: 'extraction' },
          amount: { quote: 'q', type: 'extraction' },
        },
        parentLinks: [],
        bridgeToExternal: null,
      },
      {
        recordType: 'round_participation',
        fields: { name: 'Alice Capital' },
        evidence: { name: { quote: 'q', type: 'extraction' } },
        parentLinks: [{ recordType: 'funding_round', externalId: 'kg-1', edgeName: 'participants', data: {}  }],
        bridgeToExternal: null,
      },
      {
        recordType: 'round_participation',
        fields: { name: 'Bob Ventures' },
        evidence: { name: { quote: 'q', type: 'extraction' } },
        parentLinks: [{ recordType: 'funding_round', externalId: 'kg-1', edgeName: 'participants', data: {}  }],
        bridgeToExternal: null,
      },
    ]);
    expect(movementKg.resolveCalls).toEqual([
      {
        recordType: 'funding_round',
        record: { company: 'Acme', amount: '5M' },
        constraints: { any: [{ all: [{ field: 'company' }] }] },
      },
      {
        recordType: 'round_participation',
        record: { name: 'Alice Capital', participants: { id: 'kg-1' } },
        constraints: { any: [{ all: [{ field: 'participants' }, { field: 'name' }] }] },
      },
      {
        recordType: 'round_participation',
        record: { name: 'Bob Ventures', participants: { id: 'kg-1' } },
        constraints: { any: [{ all: [{ field: 'participants' }, { field: 'name' }] }] },
      },
    ]);

    // The movement's own firing record: program order, handle binding,
    // KG node ids as externalIds.
    expect(
      runResult.writes.map((w) => [w.bindingName, w.adapterType, w.recordType, w.created, w.externalId]),
    ).toEqual([
      ['fr', KG, 'funding_round', true, 'kg-1'],
      [undefined, KG, 'round_participation', true, 'kg-2'],
      [undefined, KG, 'round_participation', true, 'kg-3'],
    ]);

    // … now field-resolved (E4): each written field cites its
    // extraction origin by interned site ref + description + quote.
    expect(runResult.writes[0].provenance).toEqual({
      company: [
        {
          kind: 'extraction',
          site: 'x:round#2',
          field: 'company',
          description: "the raising company's name",
          quote: 'q',
        },
      ],
      amount: [
        {
          kind: 'extraction',
          site: 'x:round#2',
          field: 'amount',
          description: 'the round amount',
          quote: 'q',
        },
      ],
    });
    expect(runResult.writes[1].provenance).toEqual({
      name: [
        {
          kind: 'extraction',
          site: 'x:investor#3',
          field: 'name',
          description: "the investor's name",
          quote: 'q',
        },
      ],
    });

    // The sites are interned once on the run result — refs not blobs —
    // and carry the data sources in context at their stage (here the
    // single through-free call: the event's `text` source field).
    const textSource = {
      kind: 'source_field',
      instance: 'inbox',
      adapterType: 'email',
      field: 'text',
    };
    expect(runResult.extractionSites).toEqual({
      'x:round#2': {
        node: 'round',
        description: 'each funding round announced in this message',
        stage: 0,
        dataSources: [textSource],
      },
      'x:investor#3': {
        node: 'investor',
        description: 'each investor participating in this round',
        stage: 0,
        dataSources: [textSource],
      },
    });
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Edge-identity resolve — second run updates, no duplicate participation
// ═════════════════════════════════════════════════════════════════════════════

describe('edge-scoped compound identity — re-runs update instead of duplicating', () => {
  it('matches the round by property identity and each participation by (parent edge, name)', async () => {
    const kg = makeFakeKg();

    const first = await runGoldenThroughMovementEngine({ kg });
    expect(first.writes.map((w) => w.created)).toEqual([true, true, true]);
    expect(kg.nodes.map((n) => n.id)).toEqual(['kg-1', 'kg-2', 'kg-3']);

    const second = await runGoldenThroughMovementEngine({ kg });
    expect(second.writes.map((w) => [w.recordType, w.created, w.externalId])).toEqual([
      ['funding_round', false, 'kg-1'],
      ['round_participation', false, 'kg-2'],
      ['round_participation', false, 'kg-3'],
    ]);

    // No new nodes; everything resolved onto the first run's records —
    // the participations through adjacency to the SAME funding round.
    expect(kg.creates).toHaveLength(3);
    expect(kg.nodes).toHaveLength(3);
    expect(kg.updates.map((u) => [u.recordType, u.externalId])).toEqual([
      ['funding_round', 'kg-1'],
      ['round_participation', 'kg-2'],
      ['round_participation', 'kg-3'],
    ]);
    // Updates still carry the parent link so edge-anchored fields can
    // resolve the existing edge (W4-KG3 contract).
    expect(kg.updates[1].parentLinks).toEqual([
      { recordType: 'funding_round', externalId: 'kg-1', edgeName: 'participants', data: {}  },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Dry-run — KG writes captured, not committed
// ═════════════════════════════════════════════════════════════════════════════

describe('dry-run — KG writes are captured by the sink, never committed', () => {
  it('captures the would-be writes without touching the adapter', async () => {
    const kg = makeFakeKg();
    const captured: CapturedWrite[] = [];
    const result = await runGoldenThroughMovementEngine({
      kg,
      dryRun: true,
      writeSink: (w) => captured.push(w),
    });

    expect(captured.map((w) => [w.kind, w.adapterType, w.recordType, w.fields])).toEqual([
      ['create', KG, 'funding_round', { company: 'Acme', amount: '5M' }],
      ['create', KG, 'round_participation', { name: 'Alice Capital' }],
      ['create', KG, 'round_participation', { name: 'Bob Ventures' }],
    ]);
    // A rehearsal shows the whole write, and a record is not just its fields:
    // the participations hang off the round through `participants`, and that
    // round is one this same rehearsal invented a moment ago — so the trace
    // says `rehearsed` rather than handing over an id that reads real.
    const roundId = result.writes[0].externalId;
    expect(captured[0].parents).toBeUndefined();
    expect(captured.slice(1).map((w) => w.parents)).toEqual([
      [
        {
          recordType: 'funding_round',
          externalId: roundId,
          edgeName: 'participants',
          rehearsed: true,
        },
      ],
      [
        {
          recordType: 'funding_round',
          externalId: roundId,
          edgeName: 'participants',
          rehearsed: true,
        },
      ],
    ]);
    // Nothing reached the adapter's write methods.
    expect(kg.creates).toEqual([]);
    expect(kg.updates).toEqual([]);
    expect(kg.nodes).toEqual([]);
    // Every write is flagged captured, not committed — the per-write truth
    // the run-inspection surface reports.
    expect(result.writes.map((w) => w.committed)).toEqual([false, false, false]);
    // The preview still carries the field-resolved trails (E4) — a dry
    // run shows where each would-be value came from.
    expect(result.writes.map((w) => Object.keys(w.provenance))).toEqual([
      ['company', 'amount'],
      ['name'],
      ['name'],
    ]);
    expect(result.writes[0].provenance.company).toEqual([
      {
        kind: 'extraction',
        site: 'x:round#2',
        field: 'company',
        description: "the raising company's name",
        quote: 'q',
      },
    ]);
    expect(Object.keys(result.extractionSites)).toEqual(['x:round#2', 'x:investor#3']);
    // Matching still ran against the (empty) live graph.
    expect(kg.resolveCalls.map((c) => c.recordType)).toEqual([
      'funding_round',
      'round_participation',
      'round_participation',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4b. Correspondence is now BIND-only — a plain write no longer auto-bridges
//     (the implicit KG bridge was removed; explicit-linking 3b). A non-bind
//     write dedups purely by its declared identity (`unique by`); it carries
//     NO bridgeToExternal and asserts NO recordLink.
// ═════════════════════════════════════════════════════════════════════════════

describe('plain write — no implicit correspondence (bind-only model, 3b)', () => {
  const PLAIN_WRITE = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  fr = write graph-[:funding_round]-> {',
    '    unique by (`company`)',
    '    company: msg.`subject`',
    '  }',
    '}',
  ].join('\n');

  const discriminatedEvent = (): TriggerEvent => ({
    ...webhookEvent('email', { subject: 'Acme' }),
    externalRecordRef: { adapterType: 'email', externalId: 'msg-ext-1', recordType: 'message' },
    rootRecordType: 'message',
  });

  it('creates WITHOUT bridgeToExternal and never calls recordLink', async () => {
    const kg = makeFakeKg();
    await runMovement({
      source: PLAIN_WRITE,
      event: discriminatedEvent(),
      teamId: TEAM_ID,
      catalog: makeCatalog(),
      resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: kg.adapter }),
    });
    // The implicit bridge is gone: no bridgeToExternal on the create.
    expect(kg.creates).toEqual([
      {
        recordType: 'funding_round',
        fields: { company: 'Acme' },
        evidence: null,
        parentLinks: [],
        bridgeToExternal: null,
      },
    ]);
    // No correspondence is established — `recordLink`/`getPriorMatch` were
    // retired from the adapter interface (bind-only model), so a plain write
    // structurally cannot record one.
  });

  it('dedups a re-fire by `unique by` identity — same node, no duplicate', async () => {
    const kg = makeFakeKg();
    const run = () =>
      runMovement({
        source: PLAIN_WRITE,
        event: discriminatedEvent(),
        teamId: TEAM_ID,
        catalog: makeCatalog(),
        resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: kg.adapter }),
      });
    await run();
    await run();
    // The fake KG resolves the second run by the `company` unique constraint
    // and updates the same node — identity dedup, independent of any bridge.
    expect(kg.creates).toHaveLength(1);
    expect(kg.updates.map((u) => u.externalId)).toEqual(['kg-1']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Linked-write type inference / polymorphic edges
// ═════════════════════════════════════════════════════════════════════════════

describe('linked-write type inference', () => {
  const SIMPLE_LINKED = (edge: string, explicitType?: string) =>
    [
      PRELUDE,
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      '  fr = write graph-[:funding_round]-> {',
      '    unique by (`company`)',
      '    company: msg.`subject`',
      '  }',
      `  write fr-[:${edge}]->${explicitType ?? ''} {`,
      '    unique by (fr AND `name`)',
      '    name: msg.`subject`',
      '  }',
      '}',
    ].join('\n');

  function run(source: string, options: { kg?: InstanceSchema } = { kg: kgSchema }) {
    const kg = makeFakeKg();
    const promise = runMovement({
      source,
      event: webhookEvent('email', { subject: 'Acme' }),
      teamId: TEAM_ID,
      catalog: makeCatalog(options),
      resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: kg.adapter }),
    });
    return { kg, promise };
  }

  it('infers the written type from the parent’s ontology edge', async () => {
    const { kg, promise } = run(SIMPLE_LINKED('participants'));
    await promise;
    expect(kg.creates.map((c) => c.recordType)).toEqual(['funding_round', 'round_participation']);
    expect(kg.creates[1].parentLinks?.[0]?.edgeName).toBe('participants');
  });

  it('a polymorphic edge without an explicit type fails the check (LINKED_NEEDS_TYPE)', async () => {
    const { promise } = run(SIMPLE_LINKED('related'));
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(/MOVENG_CHECK[\s\S]*polymorphic/);
  });

  it('an explicit type on a polymorphic edge is honored at runtime', async () => {
    const { kg, promise } = run(SIMPLE_LINKED('related', '<round_participation>'));
    await promise;
    expect(kg.creates.map((c) => c.recordType)).toEqual(['funding_round', 'round_participation']);
    expect(kg.creates[1].parentLinks).toEqual([
      { recordType: 'funding_round', externalId: 'kg-1', edgeName: 'related', data: {}  },
    ]);
  });

  it('an untyped ontology cannot infer — the runtime demands an explicit type, loudly', async () => {
    const untyped = run(SIMPLE_LINKED('participants'), {});
    await expect(untyped.promise).rejects.toThrow(
      /MOVENG_RUNTIME[\s\S]*cannot infer the written type for edge 'participants'/,
    );

    const explicit = run(SIMPLE_LINKED('participants', '<round_participation>'), {});
    await explicit.promise;
    expect(explicit.kg.creates.map((c) => c.recordType)).toEqual([
      'funding_round',
      'round_participation',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Standalone edge statements — `edge a -[:e]-> b` through linkRecords (E7)
// ═════════════════════════════════════════════════════════════════════════════

describe('standalone edge statements — kg linkRecords', () => {
  // Both records exist as ROOT writes (no parent-child shape — the case
  // linked writes don't cover); the edge statement then asserts the
  // connection. Stated twice to prove idempotence end-to-end: the second
  // assert finds the edge row and emits nothing.
  const EDGE_ASSERT = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  fr = write graph-[:funding_round]-> {',
    '    unique by (`company`)',
    '    company: msg.`subject`',
    '  }',
    '  part = write graph-[:round_participation]-> {',
    '    unique by (`name`)',
    '    name: msg.`text`',
    '  }',
    '  link fr -[:participants]-> part',
    '  link fr -[:participants]-> part',
    '}',
  ].join('\n');

  function run(input: { kg: ReturnType<typeof makeFakeKg> }) {
    return runMovement({
      source: EDGE_ASSERT,
      event: webhookEvent('email', { subject: 'Acme', text: 'Alice Capital' }),
      teamId: TEAM_ID,
      catalog: makeCatalog(),
      resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: input.kg.adapter }),
    });
  }

  it('asserts the edge row once and records both asserts on the firing record', async () => {
    const kg = makeFakeKg();
    const result = await run({ kg });

    // The adapter received both asserts in engine currency; the edge row
    // landed exactly once on the from node.
    expect(kg.linkCalls).toHaveLength(2);
    expect(kg.linkCalls[0]).toEqual({
      from: { recordType: 'funding_round', externalId: 'kg-1' },
      edgeName: 'participants',
      to: { recordType: 'round_participation', externalId: 'kg-2' },
      mutationContext: expect.objectContaining({
        source: expect.objectContaining({ adapterType: 'email' }),
      }),
    });
    expect(kg.nodes.find((n) => n.id === 'kg-1')?.edges).toEqual([
      { edge: 'participants', otherId: 'kg-2' },
    ]);

    // The firing record carries both asserts as edge entries whose
    // provenance references the endpoint writes by index.
    expect(result.writes).toHaveLength(4);
    expect(result.writes[2]).toEqual({
      kind: 'link',
      adapterType: KG,
      recordType: 'funding_round',
      created: true,
      committed: true,
      externalId: 'kg-1',
      writtenValues: {},
      link: { edgeName: 'participants', toRecordType: 'round_participation', toExternalId: 'kg-2' },
      provenance: {
        from: [{ kind: 'write', write: 0, externalId: 'kg-1' }],
        to: [{ kind: 'write', write: 1, externalId: 'kg-2' }],
      },
    });
    expect(result.writes[3]).toEqual(expect.objectContaining({ created: false }));
  });

  it('an edge the from-side type does not declare is rejected by name (the checker only name-checks)', async () => {
    const kg = makeFakeKg();
    const promise = runMovement({
      source: EDGE_ASSERT.replace(/-\[:participants\]->/g, '-[:sponsors]->'),
      event: webhookEvent('email', { subject: 'Acme', text: 'Alice Capital' }),
      teamId: TEAM_ID,
      catalog: makeCatalog(),
      resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: kg.adapter }),
    });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(
      /MOVENG_RUNTIME[\s\S]*'sponsors' is not a declared edge of funding_round/,
    );
    expect(kg.linkCalls).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Tuple-path multi-parent writes — ONE create carrying N parent links,
//    identity scoped by ALL tuple parents (consolidate's AND semantics)
// ═════════════════════════════════════════════════════════════════════════════

describe('tuple-path multi-parent writes — kg', () => {
  const TUPLE = [
    PRELUDE,
    '',
    'movement m(msg: <inbox-[:message]->>) {',
    '  fr = write graph-[:funding_round]-> {',
    '    unique by (`company`)',
    '    company: msg.`subject`',
    '  }',
    '  inv = write graph-[:investor]-> {',
    '    unique by (`name`)',
    '    name: msg.`text`',
    '  }',
    '  write (fr-[:participants]->, inv-[:participations]->) {',
    '    unique by (fr AND inv)',
    '    name: msg.`text`',
    '  }',
    '}',
  ].join('\n');

  async function runTuple(kg: ReturnType<typeof makeFakeKg>, payload: Record<string, unknown>) {
    return runMovement({
      source: TUPLE,
      event: webhookEvent('email', payload),
      teamId: TEAM_ID,
      catalog: makeCatalog(),
      resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: kg.adapter }),
    });
  }

  it('one create carries BOTH parent links (no single parentLink slot), in path order', async () => {
    const kg = makeFakeKg();
    const result = await runTuple(kg, { subject: 'Acme', text: 'Alice Capital' });

    expect(result.writes.map((w) => [w.recordType, w.created])).toEqual([
      ['funding_round', true],
      ['investor', true],
      ['round_participation', true],
    ]);
    const participation = kg.creates[2];
    expect(participation.parentLinks).toEqual([
      { recordType: 'funding_round', externalId: 'kg-1', edgeName: 'participants', data: {}  },
      { recordType: 'investor', externalId: 'kg-2', edgeName: 'participations', data: {}  },
    ]);
  });

  it('identity folds ALL tuple parents into the resolve (AND semantics): same parents update, a different parent creates', async () => {
    const kg = makeFakeKg();
    await runTuple(kg, { subject: 'Acme', text: 'Alice Capital' });

    // Same company + same investor → every record matches; no new creates.
    await runTuple(kg, { subject: 'Acme', text: 'Alice Capital' });
    expect(kg.creates.map((c) => c.recordType)).toEqual([
      'funding_round',
      'investor',
      'round_participation',
    ]);
    // The tuple resolve folded BOTH parents as edge-scoped neighbours.
    const tupleResolve = kg.resolveCalls.filter((r) => r.recordType === 'round_participation');
    expect(tupleResolve[1].record).toMatchObject({
      participants: { id: 'kg-1' },
      participations: { id: 'kg-2' },
    });

    // Same company, DIFFERENT investor → the participation does NOT match
    // (adjacency to BOTH parents is required), so a new one is created
    // linked to the new investor.
    await runTuple(kg, { subject: 'Acme', text: 'Bob Ventures' });
    expect(kg.creates.map((c) => c.recordType)).toEqual([
      'funding_round',
      'investor',
      'round_participation',
      'investor',
      'round_participation',
    ]);
    expect(kg.creates[4].parentLinks).toEqual([
      { recordType: 'funding_round', externalId: 'kg-1', edgeName: 'participants', data: {}  },
      { recordType: 'investor', externalId: 'kg-4', edgeName: 'participations', data: {}  },
    ]);
  });

  it('a mismatched tuple (paths inferring different types) is caught by the checker', async () => {
    const kg = makeFakeKg();
    const promise = runMovement({
      source: TUPLE.replace('inv-[:participations]->', 'fr-[:related]->'),
      event: webhookEvent('email', { subject: 'Acme', text: 'Alice Capital' }),
      teamId: TEAM_ID,
      catalog: makeCatalog(),
      resolveAdapter: makeResolver({ email: makeFakeSource('email'), [KG]: kg.adapter }),
    });
    expect(await rejectionCause(promise)).toBeInstanceOf(MovementEngineError);
    await expect(promise).rejects.toThrow(/MOVENG_CHECK/);
  });
});
