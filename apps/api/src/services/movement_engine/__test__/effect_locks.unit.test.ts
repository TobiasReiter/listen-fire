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

import { runMovement } from '../run';
import type { MovementTransformInvoker } from '../extraction';
import type { MovementTraceEntry } from '../expression';
import {
  EffectLocks,
  bindLock,
  crossRunNames,
  edgeLock,
  foldKeyValue,
  identityLocks,
  recordLock,
  type CrossRunLocks,
} from '../effect_locks';
import { InMemoryWriteLocks, type WriteLockHolder } from '../../write_locks/write_locks';

import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData, type SchemaTypeDescriptor } from '../../translation_graph/types';
import type { UniquenessConstraints } from '../../translation_graph/uniqueness';
import { tenantIdOf } from 'engine-contracts';
import { CURRENT_LANGUAGE_VERSION, type InstanceSchema } from 'movement-lang';
import { credentialIdsFor, makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000052');

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

const catalog = staticCatalogSnapshot({
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

/** A `fetch_url` that takes as long as its url says (`"40"` → 40ms). */
const delayedFetch: MovementTransformInvoker = {
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
    credentialIds: credentialIdsFor(catalog, (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined)),
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) =>
          adapterType === 'email' ? email : crm.adapter,
      },
      llm: { transforms: delayedFetch },
    }),
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

// `parallel` is retired under Dancing Wren (5); the MAP that replaced it runs
// its functions at once, each isolated as a member is.
describe('the arms all runs at once, and race arms, are isolated as members are', () => {
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

  it('two arms calling the same movement at once are not a recursion; the trace reads in argument order', async () => {
    const { result } = await run(
      [
        '  r = all(',
        '    () => {',
        '      got = fetch_one(l: node { url: "40" })',
        '      return got',
        '    },',
        '    () => {',
        '      got = fetch_one(l: node { url: "5" })',
        '      return got',
        '    },',
        '  )',
        '  write crm-[:companies]-> { name: "${AT(r, 0)}/${AT(r, 1)}" }',
      ],
      makeCrm(),
      FETCH_ONE,
    );
    // The second arm finished first, and its entries still come second.
    expect(pluginUrls(result.trace)).toEqual(['40', '5']);
    expect(result.writes[0]?.writtenValues.name).toBe('got-40/got-5');
  });

  it('functions writing one key at once make one record', async () => {
    const { crm } = await run([
      '  all(',
      '    () => { write crm-[:companies]-> { unique by (`name`), name: "Acme", summary: "left" } },',
      '    () => { write crm-[:companies]-> { unique by (`name`), name: "Acme", summary: "right" } },',
      '    () => { write crm-[:companies]-> { unique by (`name`), name: "Acme", summary: "third" } },',
      '  )',
    ]);
    expect(crm.creates).toHaveLength(1);
    expect(crm.updates).toHaveLength(2);
  });

  it('a race arm that finishes in the same burst as the winner is not undone: its writes stay, and its slot is filled', async () => {
    const { crm, result } = await run([
      '  r = race(',
      '    () => {',
      '      co = write crm-[:companies]-> { unique by (`name`), name: "Fast" }',
      '      return "fast"',
      '    },',
      '    () => {',
      '      page = fetch_url(url: "30")',
      '      co = write crm-[:companies]-> { unique by (`name`), name: "Slow" }',
      '      return "slow"',
      '    },',
      '  )',
      '  write crm-[:notes]-> { text: "${AT(r, 0)}/${AT(r, 1)}" }',
    ]);
    expect(crm.creates.map((c) => c.name ?? c.text)).toEqual(['Fast', 'Slow', 'fast/slow']);
    expect(result.writes).toHaveLength(3);
  });
});

/** A holder as the host's token-based locks: each acquire answers a token
 *  that gives back exactly its names. */
function byToken(holder: WriteLockHolder): CrossRunLocks {
  const taken = new Map<string, readonly string[]>();
  let next = 0;
  return {
    acquire: async (names) => {
      await holder.acquire(names);
      const token = `t${++next}`;
      taken.set(token, names);
      return token;
    },
    release: async (token) => {
      const names = taken.get(token);
      taken.delete(token);
      if (names !== undefined) await holder.release(names);
    },
  };
}

describe('the lock table', () => {
  const exclusive = { kind: 'exclusive' } as const;
  const inMemoryHolder = () => new InMemoryWriteLocks().holder(TEAM_ID);

  it('two effects wanting the same locks in opposite orders both finish', async () => {
    const locks = new EffectLocks({ crossRun: byToken(inMemoryHolder()) });
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
    const locks = new EffectLocks({ crossRun: byToken(inMemoryHolder()) });
    const answer = await locks.withLocks([{ name: 'k', mode: exclusive }], () =>
      locks.withLocks([{ name: 'k', mode: exclusive }], async () => 'inner'),
    );
    expect(answer).toBe('inner');
  });

  it('one group shares a lock; another group, and an exclusive holder, wait — first come, first served', async () => {
    const locks = new EffectLocks({ crossRun: byToken(inMemoryHolder()) });
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
      languageVersion: CURRENT_LANGUAGE_VERSION,
    });
    expect(locks).toEqual([{ name: expect.stringMatching(/^identity /), mode: { kind: 'exclusive' } }]);
  });
});

describe('the cross-run locks beneath the lock table', () => {
  const system = { adapterType: 'attio' };
  const companyIdentity = identityLocks({
    system,
    recordType: 'companies',
    constraints: { any: [{ all: [{ field: 'domain' }] }] },
    resolveRecord: { domain: 'acme.com' },
    fields: { domain: 'acme.com' },
    languageVersion: CURRENT_LANGUAGE_VERSION,
  });
  const typeLockName = companyIdentity[0]!.name;

  function recordingHolder(): WriteLockHolder & { calls: string[][]; events: string[] } {
    const calls: string[][] = [];
    const events: string[] = [];
    return {
      calls,
      events,
      async acquire(names) {
        calls.push([...names]);
        events.push(`acquire ${names.join(',')}`);
      },
      async release(names) {
        events.push(`release ${(names ?? ['everything']).join(',')}`);
      },
    };
  }

  it.each([
    ['a record lock as is', [recordLock(system, 'r1')], [recordLock(system, 'r1').name]],
    [
      'an edge lock as is',
      [edgeLock({ system, from: { recordType: 'people', externalId: 'p' }, edgeName: 'works_at', to: { recordType: 'companies', externalId: 'c' } })],
      [edgeLock({ system, from: { recordType: 'people', externalId: 'p' }, edgeName: 'works_at', to: { recordType: 'companies', externalId: 'c' } }).name],
    ],
    ['a bind lock as is', [bindLock({ id: 'o' }, { type: 't' })], [bindLock({ id: 'o' }, { type: 't' }).name]],
    ['an identity write: its record type only, not its keys', companyIdentity, [typeLockName]],
    [
      'a fuzzy identity write: its record type',
      identityLocks({
        system,
        recordType: 'companies',
        constraints: { any: [{ all: [{ field: 'name', fuzzy: true }] }] },
        resolveRecord: { name: 'Acme' },
        fields: { name: 'Acme' },
        languageVersion: CURRENT_LANGUAGE_VERSION,
      }),
      [typeLockName],
    ],
    [
      'several requests: sorted, one per name',
      [recordLock(system, 'r2'), ...companyIdentity, recordLock(system, 'r1'), recordLock(system, 'r2')],
      [recordLock(system, 'r1').name, recordLock(system, 'r2').name, typeLockName].sort(),
    ],
  ])('%s', (_label, requests, expected) => {
    expect(crossRunNames(requests)).toEqual(expected);
  });

  it("takes a flow's cross-run names once, after the run's own gate and before the effect", async () => {
    const holder = recordingHolder();
    const locks = new EffectLocks({ crossRun: byToken(holder) });
    await locks.withLocks([recordLock(system, 'r1'), ...companyIdentity, recordLock(system, 'r1')], async () => {
      holder.events.push('effect');
    });
    expect(holder.calls).toEqual([[recordLock(system, 'r1').name, typeLockName].sort()]);
    const names = [recordLock(system, 'r1').name, typeLockName].sort();
    expect(holder.events).toEqual([`acquire ${names.join(',')}`, 'effect', `release ${names.join(',')}`]);
  });

  it('gives back exactly what it took when the effect throws', async () => {
    const holder = recordingHolder();
    const locks = new EffectLocks({ crossRun: byToken(holder) });
    await expect(
      locks.withLocks([recordLock(system, 'r1')], async () => {
        throw new Error('the write failed');
      }),
    ).rejects.toThrow('the write failed');
    expect(holder.events).toEqual([
      `acquire ${recordLock(system, 'r1').name}`,
      `release ${recordLock(system, 'r1').name}`,
    ]);
  });

  it('a nested flow gives back only what it took itself, before the outer flow gives back its own', async () => {
    const holder = recordingHolder();
    const locks = new EffectLocks({ crossRun: byToken(holder) });
    await locks.withLocks(companyIdentity, () =>
      locks.withLocks([...companyIdentity, recordLock(system, 'r1')], async () => undefined),
    );
    expect(holder.events).toEqual([
      `acquire ${typeLockName}`,
      `acquire ${recordLock(system, 'r1').name}`,
      `release ${recordLock(system, 'r1').name}`,
      `release ${typeLockName}`,
    ]);
  });

  it('two flows sharing the type lock each take and give back their own count; another run waits for both', async () => {
    const table = new InMemoryWriteLocks();
    const holder = table.holder(TEAM_ID);
    const acquire = jest.spyOn(holder, 'acquire');
    const release = jest.spyOn(holder, 'release');
    const locks = new EffectLocks({ crossRun: byToken(holder) });
    const identity = (domain: string) =>
      identityLocks({
        system,
        recordType: 'companies',
        constraints: { any: [{ all: [{ field: 'domain' }] }] },
        resolveRecord: { domain },
        fields: { domain },
        languageVersion: CURRENT_LANGUAGE_VERSION,
      });
    let releaseSecond: () => void = () => {};
    const secondRunning = new Promise<void>((resolve) => (releaseSecond = resolve));
    const first = locks.withLocks(identity('acme.com'), async () => sleep(5));
    const second = locks.withLocks(identity('globex.com'), () => secondRunning);
    await first;

    const otherRun = table.holder(TEAM_ID);
    let otherGot = false;
    const otherAcquire = otherRun.acquire([typeLockName]).then(() => (otherGot = true));
    await sleep(20);
    expect(otherGot).toBe(false);

    releaseSecond();
    await second;
    await otherAcquire;
    expect(acquire.mock.calls).toEqual([[[typeLockName]], [[typeLockName]]]);
    expect(release.mock.calls).toEqual([[[typeLockName]], [[typeLockName]]]);
    await otherRun.release();
  });

  it('a flow asking again for names it holds does not take them again', async () => {
    const holder = recordingHolder();
    const locks = new EffectLocks({ crossRun: byToken(holder) });
    await locks.withLocks(companyIdentity, () =>
      locks.withLocks([...companyIdentity, recordLock(system, 'r1')], async () => undefined),
    );
    expect(holder.calls).toEqual([[typeLockName], [recordLock(system, 'r1').name]]);
  });

  it('a flow whose locks are all its own takes nothing across runs', async () => {
    const holder = recordingHolder();
    const locks = new EffectLocks({ crossRun: byToken(holder) });
    await locks.withLocks(companyIdentity, () =>
      locks.withLocks(companyIdentity, async () => undefined),
    );
    expect(holder.calls).toEqual([[typeLockName]]);
  });

  it("a second flow waiting on the run's own gate does not wait across runs until it is let through", async () => {
    const holder = recordingHolder();
    const locks = new EffectLocks({ crossRun: byToken(holder) });
    const flow = (label: string) =>
      locks.withLocks([recordLock(system, 'r1')], async () => {
        holder.events.push(`start ${label}`);
        await sleep(5);
        holder.events.push(`end ${label}`);
      });
    await Promise.all([flow('one'), flow('two')]);
    const acquire = `acquire ${recordLock(system, 'r1').name}`;
    const release = `release ${recordLock(system, 'r1').name}`;
    expect(holder.events).toEqual([
      acquire, 'start one', 'end one', release,
      acquire, 'start two', 'end two', release,
    ]);
  });
});
