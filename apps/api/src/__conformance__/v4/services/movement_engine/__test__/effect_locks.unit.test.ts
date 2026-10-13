// Effects on the world from flows running at once — a collection op's members,
// a combinator's arms — through the REAL interpreter: writes to different keys
// run together, writes to the same key wait for each other (so a `unique by`
// write makes its record once), and the arms of `parallel` / `race` are
// isolated the way members are. The lock table itself is tested directly at the
// bottom.
//
// The fake CRM answers identity lookups from what it has itself created, by
// the constraints it is handed, slowly — the window in which two flows writing
// one record at once would each find nothing and each create it — and counts
// how many lookups, creates and updates were in flight at once.

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

import { runMovement } from '../run';
import type { MovementTransformInvoker } from '../extraction';
import type { MovementTraceEntry } from '../expression';
import { EffectLocks, foldKeyValue, identityLocks } from '../effect_locks';

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData, type SchemaTypeDescriptor, type TransformOutputShape } from '../../translation_graph/types';
import type { UniquenessConstraints } from '../../translation_graph/uniqueness';
import { getTransform } from '../../translation_graph/engine/transforms/registry';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { InstanceSchema } from 'movement-lang';

const TEAM_ID = '00000000-0000-0000-0000-000000000052' as TeamId;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

const same = (a: unknown, b: unknown) =>
  a !== null && a !== undefined && b !== null && b !== undefined &&
  String(a).toLowerCase() === String(b).toLowerCase();
/** A deliberately loose stand-in for a fuzzy search: either contains the other. */
const alike = (a: unknown, b: unknown) =>
  a !== null && a !== undefined && b !== null && b !== undefined &&
  (String(a).toLowerCase().includes(String(b).toLowerCase()) ||
    String(b).toLowerCase().includes(String(a).toLowerCase()));

/**
 * A CRM whose identity lookup honours the constraints it is handed (any
 * branch, every entry of it), over the records it has itself created.
 */
function makeCrm(options: { latencyMs?: number; native?: UniquenessConstraints } = {}) {
  const latency = options.latencyMs ?? 10;
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<{ externalId: string; fields: Record<string, unknown> }> = [];
  const store: ExternalRecordRef[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const busy = async <T>(work: () => T): Promise<T> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await sleep(latency);
      return work();
    } finally {
      inFlight -= 1;
    }
  };
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe(recordType): Promise<SchemaTypeDescriptor | null> {
      if (options.native === undefined) return null;
      return {
        typeId: recordType,
        displayName: recordType,
        fields: [],
        references: [],
        uniquenessConstraints: options.native,
      };
    },
    async resolveEntity({ record, constraints }) {
      return busy(() => ({
        candidates: store.filter((held) =>
          constraints.any.some((branch) =>
            branch.all.length > 0 &&
            branch.all.every((entry) =>
              (entry.fuzzy === true ? alike : same)(record[entry.field], held.data[entry.field]),
            ),
          ),
        ),
      }));
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      return busy(() => {
        creates.push(input.fields);
        const created = { adapterType: 'attio', externalId: `ext-${creates.length}`, data: { ...input.fields } };
        store.push(created);
        return created;
      });
    },
    async updateRecord(input) {
      return busy(() => {
        updates.push({ externalId: input.externalId, fields: input.fields });
        return {
          adapterType: 'attio',
          externalId: input.externalId,
          data: {},
          association: containerAssociation(input),
        };
      });
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates, maxInFlight: () => maxInFlight };
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
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
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

/** A CRM that resolves FUZZY by similarity and updates records in place. */
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', domain: 'text', summary: 'text' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: {
      fields: { name: 'text', domain: 'text', summary: 'text' },
      resultShape: { externalId: 'text', name: 'text', domain: 'text', summary: 'text' },
      fuzzyResolution: true,
    },
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: ATTIO_SCHEMA },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetch_url } from plugins',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
].join('\n');

function realOutput(plugin: string): TransformOutputShape | undefined {
  const impl = getTransform(plugin) ?? getTransform(plugin.replace(/_/g, '-'));
  return impl?.signature.output;
}

/** A `fetch_url` that takes as long as its url says (`"40"` → 40ms). */
const delayedFetch: MovementTransformInvoker = {
  declaredOutput: (plugin) => realOutput(plugin),
  async invoke({ config }) {
    await sleep(Number(config.url));
    return { text: `got-${String(config.url)}` };
  },
};

function webhookEvent(): TriggerEvent {
  return {
    pipelineInputId: 'pi-effect-locks',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Acme' },
  };
}

async function run(
  body: string[],
  crm = makeCrm(),
  movements: string[] = [],
) {
  const email = inertAdapter('email');
  const result = await runMovement({
    source: PRELUDE + [...movements, 'movement intake(m: <inbox-[:message]->>) {', ...body, '}'].join('\n'),
    movementName: 'intake',
    event: webhookEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) =>
      adapterType === 'email' ? email : crm.adapter,
    transformInvoker: delayedFetch,
  });
  return { result, crm };
}

const pluginUrls = (trace: MovementTraceEntry[]) =>
  trace.flatMap((e) => (e.kind === 'plugin' ? [e.url] : []));

describe('members writing different keys write at once; the same key, one at a time', () => {
  it('different keys: the writes overlap, and each makes its own record', async () => {
    const { crm } = await run([
      '  MAP(["a", "b", "c", "d", "e"], { concurrency: 5 }, (n) => {',
      '    write crm-[:companies]-> { unique by (`name`), name: n }',
      '  })',
    ]);
    expect(crm.maxInFlight()).toBeGreaterThan(1);
    expect(crm.creates.map((c) => c.name).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(crm.updates).toEqual([]);
  });

  it('one key, five members at once: one create, four updates', async () => {
    const { crm, result } = await run([
      '  MAP(["a", "b", "c", "d", "e"], { concurrency: 5 }, (n) => {',
      '    write crm-[:companies]-> { unique by (`name`), name: "Acme", summary: n }',
      '  })',
    ]);
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(4);
    expect(crm.maxInFlight()).toBe(1);
    expect(result.writes).toHaveLength(5);
  });

  it('a key is compared as the system would compare it: letter case does not split it', async () => {
    const { crm } = await run([
      '  MAP(["Acme", "ACME", "acme"], { concurrency: 3 }, (n) => {',
      '    write crm-[:companies]-> { unique by (`name`), name: n }',
      '  })',
    ]);
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(2);
  });

  it("the target's own uniqueness rule is honoured, with no `unique by` written", async () => {
    const { crm } = await run(
      [
        '  MAP(["a", "b", "c", "d"], { concurrency: 4 }, (n) => {',
        '    write crm-[:companies]-> { name: n, domain: "acme.com" }',
        '  })',
      ],
      makeCrm({ native: { any: [{ all: [{ field: 'domain' }] }] } }),
    );
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(3);
  });

  it('several `unique by` lines, written in either order, take their keys in one order — no deadlock, one record', async () => {
    const { crm } = await run([
      '  MAP([0, 1, 2, 3], { concurrency: 4 }, (i) => {',
      '    if i == 0 OR i == 2 {',
      '      write crm-[:companies]-> {',
      '        unique by (`name`)',
      '        unique by (`domain`)',
      '        name: "Acme"',
      '        domain: "acme.com"',
      '      }',
      '    } else {',
      '      write crm-[:companies]-> {',
      '        unique by (`domain`)',
      '        unique by (`name`)',
      '        name: "Acme"',
      '        domain: "acme.com"',
      '      }',
      '    }',
      '  })',
    ]);
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(3);
  });

  it('a FUZZY key has no exact value to wait on, so fuzzy writes to a type take turns — and never duplicate', async () => {
    const { crm } = await run([
      '  MAP(["Acme", "Acme", "Acme", "Beta"], { concurrency: 4 }, (n) => {',
      '    write crm-[:companies]-> { unique by (FUZZY `name`), name: n }',
      '  })',
    ]);
    expect(crm.maxInFlight()).toBe(1);
    expect(crm.creates.map((c) => c.name).sort()).toEqual(['Acme', 'Beta']);
    expect(crm.updates).toHaveLength(2);
  });

  it('a write with no identity at all creates, alongside the others', async () => {
    const { crm } = await run([
      '  MAP(["a", "b", "c"], { concurrency: 3 }, (n) => {',
      '    write crm-[:notes]-> { text: n }',
      '  })',
    ]);
    expect(crm.creates).toHaveLength(3);
    expect(crm.maxInFlight()).toBeGreaterThan(1);
  });

  it("a member's later writes off the record it wrote do not wait on that record's own key", async () => {
    const { crm } = await run([
      '  MAP(["a", "b", "a"], { concurrency: 3 }, (n) => {',
      '    co = write crm-[:companies]-> { unique by (`name`), name: n }',
      '    write co { summary: "seen" }',
      '  })',
    ]);
    expect(crm.creates.map((c) => c.name).sort()).toEqual(['a', 'b']);
    // One identity update, three updates by handle.
    expect(crm.updates).toHaveLength(4);
  });
});

describe('the arms of parallel and race are isolated as members are', () => {
  const FETCH_ONE = [
    'node Link {',
    '  url: <text>',
    '}',
    '',
    'movement fetch_one(l: <Link>) {',
    '  page = fetch_url(url: l.url)',
    '  return COALESCE(page, "none")',
    '}',
    '',
  ];

  it('two arms calling the same movement at once are not a recursion; the trace reads in arm order', async () => {
    const { result } = await run(
      [
        '  r = await parallel([',
        '    () => {',
        '      got = fetch_one(l: node { url: "40" })',
        '      return got',
        '    },',
        '    () => {',
        '      got = fetch_one(l: node { url: "5" })',
        '      return got',
        '    },',
        '  ])',
        '  write crm-[:companies]-> { name: "${AT(r, 0)}/${AT(r, 1)}" }',
      ],
      makeCrm(),
      FETCH_ONE,
    );
    // The second arm finished first, and its entries still come second.
    expect(pluginUrls(result.trace)).toEqual(['40', '5']);
    expect(result.writes[0]?.writtenValues.name).toBe('got-40/got-5');
  });

  it('arms writing one key at once make one record', async () => {
    const { crm } = await run([
      '  await parallel([',
      '    () => { write crm-[:companies]-> { unique by (`name`), name: "Acme", summary: "left" } },',
      '    () => { write crm-[:companies]-> { unique by (`name`), name: "Acme", summary: "right" } },',
      '    () => { write crm-[:companies]-> { unique by (`name`), name: "Acme", summary: "third" } },',
      '  ])',
    ]);
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(2);
  });

  it('a race arm that finishes in the same burst as the winner is not undone: its writes stay, and its slot is filled', async () => {
    const { crm, result } = await run([
      '  r = await race([',
      '    () => {',
      '      co = write crm-[:companies]-> { unique by (`name`), name: "Fast" }',
      '      return "fast"',
      '    },',
      '    () => {',
      '      page = fetch_url(url: "30")',
      '      co = write crm-[:companies]-> { unique by (`name`), name: "Slow" }',
      '      return "slow"',
      '    },',
      '  ])',
      '  write crm-[:notes]-> { text: "${AT(r, 0)}/${AT(r, 1)}" }',
    ]);
    expect(crm.creates.map((c) => c.name ?? c.text)).toEqual(['Fast', 'Slow', 'fast/slow']);
    expect(result.writes).toHaveLength(3);
  });
});

describe('the lock table', () => {
  const exclusive = { kind: 'exclusive' } as const;

  it('two effects wanting the same locks in opposite orders both finish', async () => {
    const locks = new EffectLocks();
    const done: string[] = [];
    await Promise.all([
      locks.withLocks(
        [{ name: 'a', mode: exclusive }, { name: 'b', mode: exclusive }],
        async () => {
          await sleep(5);
          done.push('ab');
        },
      ),
      locks.withLocks(
        [{ name: 'b', mode: exclusive }, { name: 'a', mode: exclusive }],
        async () => {
          await sleep(5);
          done.push('ba');
        },
      ),
    ]);
    expect(done).toEqual(['ab', 'ba']);
  });

  it('an effect asking again for a lock it holds does not wait on itself', async () => {
    const locks = new EffectLocks();
    const answer = await locks.withLocks([{ name: 'k', mode: exclusive }], () =>
      locks.withLocks([{ name: 'k', mode: exclusive }], async () => 'inner'),
    );
    expect(answer).toBe('inner');
  });

  it('one group shares a lock; another group, and an exclusive holder, wait — first come, first served', async () => {
    const locks = new EffectLocks();
    const events: string[] = [];
    const hold = (label: string, mode: { kind: 'exclusive' } | { kind: 'shared'; group: string }, ms: number) =>
      locks.withLocks([{ name: 't', mode }], async () => {
        events.push(`start ${label}`);
        await sleep(ms);
        events.push(`end ${label}`);
      });
    await Promise.all([
      hold('g1', { kind: 'shared', group: 'g' }, 10),
      hold('g2', { kind: 'shared', group: 'g' }, 10),
      hold('x', exclusive, 1),
      // Same group as the holders, but behind a waiter: it waits too.
      hold('g3', { kind: 'shared', group: 'g' }, 1),
    ]);
    expect(events.slice(0, 2)).toEqual(['start g1', 'start g2']);
    expect(events.indexOf('start x')).toBeGreaterThan(events.indexOf('end g2'));
    expect(events.indexOf('start g3')).toBeGreaterThan(events.indexOf('end x'));
  });

  it('folds a key value at least as coarsely as a system matches it', () => {
    expect(foldKeyValue('https://www.Acme.com/about')).toBe(foldKeyValue('acme.com'));
    expect(foldKeyValue('Café  Inc.')).toBe(foldKeyValue('cafe inc'));
    expect(foldKeyValue({ id: 'rec-1' })).toBe('@rec-1');
    expect(foldKeyValue(['a', 'b'])).toBeUndefined();
  });

  it('a key value with no exact text locks the whole record type', () => {
    const locks = identityLocks({
      system: { adapterType: 'attio' },
      recordType: 'companies',
      constraints: { any: [{ all: [{ field: 'tags' }] }] },
      resolveRecord: { tags: ['a'] },
      fields: { tags: ['a'] },
    });
    expect(locks).toEqual([{ name: expect.stringMatching(/^identity /), mode: { kind: 'exclusive' } }]);
  });
});
