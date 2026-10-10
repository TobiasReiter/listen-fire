// `MAP(xs, { … }, f)` / `FILTER(xs, { … }, f)` through the REAL interpreter:
// what a failing member does (`onError`), and how many members run at once
// (`concurrency`, `initialConcurrency`).
//
// The members' work is a plugin call, because that is what a member does
// alongside the others — a stubbed plugin whose answer arrives after a delay
// chosen per member, so members FINISH in a different order from the one they
// started in. Every test then reads the answer (written to a fake CRM), the
// plugin's own record of how many calls were in flight, and the run's trace.

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

import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type RuntimeCapabilities,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData, type TransformOutputShape } from '../../translation_graph/types';
import { getTransform } from '../../translation_graph/engine/transforms/registry';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000051' as TeamId;

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A CRM fake that answers `unique by` lookups from what it has itself created,
 * slowly — the window in which two members writing the same record at once
 * would each find nothing and each create it.
 */
function makeFakeAdapter(adapterType: string, latencyMs = 0) {
  const creates: Array<{ recordType: string; fields: Record<string, unknown> }> = [];
  const updates: Array<{ externalId: string; fields: Record<string, unknown> }> = [];
  const store: ExternalRecordRef[] = [];
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
    async resolveEntity({ record }) {
      await sleep(latencyMs);
      return { candidates: store.filter((held) => held.data.name === record.name) };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      await sleep(latencyMs);
      creates.push({ recordType: input.recordType, fields: input.fields });
      const created = { adapterType, externalId: `ext-${creates.length}`, data: { ...input.fields } };
      store.push(created);
      return created;
    },
    async updateRecord(input) {
      await sleep(latencyMs);
      updates.push({ externalId: input.externalId, fields: input.fields });
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
  return { adapter, creates, updates };
}

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
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

/** How long each member's plugin call takes: deliberately NOT increasing, so
 *  members finish out of the order they started in. */
const DELAY_MS: Record<string, number> = { a: 40, b: 5, c: 25, d: 1, e: 15 };
const MEMBERS = '["a", "b", "c", "d", "e"]';

/**
 * A `fetch_url` that waits per member and records what was in flight. `fail`
 * names members whose call throws, which is a member's function failing.
 */
function delayedInvoker(fail: ReadonlySet<string> = new Set()) {
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const invoker: MovementTransformInvoker = {
    declaredOutput: (plugin) => realOutput(plugin),
    async invoke({ config }) {
      const url = String(config.url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start ${url}`);
      try {
        await sleep(DELAY_MS[url] ?? 0);
        if (fail.has(url)) throw new Error(`could not fetch ${url}`);
        return { text: `got-${url}` };
      } finally {
        inFlight -= 1;
        events.push(`end ${url}`);
      }
    },
  };
  return {
    invoker,
    events,
    maxInFlight: () => maxInFlight,
    finished: () => events.filter((e) => e.startsWith('end ')).map((e) => e.slice(4)),
  };
}

function realOutput(plugin: string): TransformOutputShape | undefined {
  const impl = getTransform(plugin) ?? getTransform(plugin.replace(/_/g, '-'));
  return impl?.signature.output;
}

function webhookEvent(): TriggerEvent {
  return {
    pipelineInputId: 'pi-collection-settings',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Acme' },
  };
}

async function run(source: string, invoker: MovementTransformInvoker, latencyMs = 0) {
  const email = makeFakeAdapter('email');
  const attio = makeFakeAdapter('attio', latencyMs);
  const result = await runMovement({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) =>
      adapterType === 'email' ? email.adapter : attio.adapter,
    transformInvoker: invoker,
  });
  return { result, attio };
}

/** A movement that MAPs the five members through `fetch_url` with the given
 *  settings and writes what came back, joined, as one company's summary. */
function mapMovement(settings: string): string {
  const config = settings === '' ? '' : `${settings}, `;
  return [
    'movement intake(m: <inbox-[:message]->>) {',
    `  pages = MAP(${MEMBERS}, ${config}(u) => {`,
    '    page = fetch_url(url: u)',
    '    return COALESCE(page, "none")',
    '  })',
    '  write crm-[:companies]-> { name: m.`subject`, summary: JOIN(pages, ",") }',
    '}',
  ].join('\n');
}

const pluginUrls = (trace: MovementTraceEntry[]) =>
  trace.flatMap((e) => (e.kind === 'plugin' ? [e.url] : []));
const warnings = (trace: MovementTraceEntry[]) =>
  trace.filter((e): e is Extract<MovementTraceEntry, { kind: 'warning' }> => e.kind === 'warning');

describe('concurrency: members run together, and the answer is in member order', () => {
  it('with no settings, one member runs at a time — as every MAP always has', async () => {
    const plugin = delayedInvoker();
    const { attio } = await run(mapMovement(''), plugin.invoker);
    expect(plugin.maxInFlight()).toBe(1);
    expect(plugin.finished()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(attio.creates[0]?.fields.summary).toBe('got-a,got-b,got-c,got-d,got-e');
  });

  it('three at a time: they finish out of order, and the answer is still in member order', async () => {
    const plugin = delayedInvoker();
    const { result, attio } = await run(mapMovement('{ concurrency: 3 }'), plugin.invoker);
    expect(plugin.maxInFlight()).toBe(3);
    // Proof they really overlapped: a member that started later finished first.
    expect(plugin.finished()).not.toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(attio.creates[0]?.fields.summary).toBe('got-a,got-b,got-c,got-d,got-e');
    // The trace reads as it would had they run one after another.
    expect(pluginUrls(result.trace)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a first batch runs on its own, to the end, before the rest fan out', async () => {
    const plugin = delayedInvoker();
    const { attio } = await run(
      mapMovement('{ concurrency: 3, initialConcurrency: 1 }'),
      plugin.invoker,
    );
    // The first member ran alone and finished before any other started …
    expect(plugin.events.slice(0, 2)).toEqual(['start a', 'end a']);
    // … and then the rest ran three at a time.
    expect(plugin.maxInFlight()).toBe(3);
    expect(attio.creates[0]?.fields.summary).toBe('got-a,got-b,got-c,got-d,got-e');
  });

  it('a first batch of two runs both together, then waits for both', async () => {
    const plugin = delayedInvoker();
    await run(mapMovement('{ concurrency: 3, initialConcurrency: 2 }'), plugin.invoker);
    const firstFour = plugin.events.slice(0, 4);
    expect(firstFour.filter((e) => e.startsWith('start')).sort()).toEqual(['start a', 'start b']);
    expect(firstFour.filter((e) => e.startsWith('end')).sort()).toEqual(['end a', 'end b']);
  });

  it('FILTER keeps its survivors in member order, whatever order they finished in', async () => {
    const plugin = delayedInvoker();
    const { attio } = await run(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        `  kept = FILTER(${MEMBERS}, { concurrency: 5 }, (u) => {`,
        '    page = fetch_url(url: u)',
        '    return u != "c"',
        '  })',
        '  write crm-[:companies]-> { name: m.`subject`, summary: JOIN(kept, ",") }',
        '}',
      ].join('\n'),
      plugin.invoker,
    );
    expect(plugin.maxInFlight()).toBe(5);
    expect(attio.creates[0]?.fields.summary).toBe('a,b,d,e');
  });
});

describe('onError: what a member whose function failed does', () => {
  const FAIL_C = new Set(['c']);

  it('"error" (the default) fails the run, naming the failure', async () => {
    const plugin = delayedInvoker(FAIL_C);
    await expect(run(mapMovement('{ concurrency: 2 }'), plugin.invoker)).rejects.toThrow(
      /could not fetch c/,
    );
    await expect(run(mapMovement(''), delayedInvoker(FAIL_C).invoker)).rejects.toThrow(
      /could not fetch c/,
    );
  });

  it('"error" under concurrency starts nothing new once a member fails, and lets running ones finish', async () => {
    const plugin = delayedInvoker(new Set(['b']));
    await expect(run(mapMovement('{ concurrency: 2 }'), plugin.invoker)).rejects.toThrow(
      /could not fetch b/,
    );
    // b failed while a was still running; c, d and e never started, and a ran
    // to its end rather than being abandoned mid-flight.
    expect(plugin.events).toEqual(['start a', 'start b', 'end b', 'end a']);
  });

  it('"ignore" leaves the member out, and says nothing', async () => {
    const plugin = delayedInvoker(FAIL_C);
    const { result, attio } = await run(
      mapMovement('{ onError: "ignore", concurrency: 3 }'),
      plugin.invoker,
    );
    expect(attio.creates[0]?.fields.summary).toBe('got-a,got-b,got-d,got-e');
    expect(warnings(result.trace)).toEqual([]);
  });

  it('"warn" leaves the member out, and the trace says which one and why', async () => {
    const plugin = delayedInvoker(FAIL_C);
    const { result, attio } = await run(
      mapMovement('{ onError: "warn", concurrency: 3 }'),
      plugin.invoker,
    );
    expect(attio.creates[0]?.fields.summary).toBe('got-a,got-b,got-d,got-e');
    const [warning, ...rest] = warnings(result.trace);
    expect(rest).toEqual([]);
    expect(warning?.code).toBe('MOVENG_COLLECTION_MEMBER_FAILED');
    expect(warning?.message).toContain('index 2');
    expect(warning?.message).toContain('could not fetch c');
  });

  it('an author-raised ERROR inside a member is that member failing, and is forgiven the same way', async () => {
    const plugin = delayedInvoker();
    const { attio } = await run(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        `  pages = MAP(${MEMBERS}, { onError: "ignore" }, (u) => {`,
        '    if u == "d" {',
        '      ERROR("not this one")',
        '    }',
        '    return u',
        '  })',
        '  write crm-[:companies]-> { name: m.`subject`, summary: JOIN(pages, ",") }',
        '}',
      ].join('\n'),
      plugin.invoker,
    );
    expect(attio.creates[0]?.fields.summary).toBe('a,b,c,e');
  });

  it('FILTER drops a member whose predicate failed', async () => {
    const plugin = delayedInvoker(FAIL_C);
    const { attio } = await run(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        `  kept = FILTER(${MEMBERS}, { onError: "ignore", concurrency: 2 }, (u) => {`,
        '    page = fetch_url(url: u)',
        '    return TRUE',
        '  })',
        '  write crm-[:companies]-> { name: m.`subject`, summary: JOIN(kept, ",") }',
        '}',
      ].join('\n'),
      plugin.invoker,
    );
    expect(attio.creates[0]?.fields.summary).toBe('a,b,d,e');
  });
});

describe('members writing the same record take turns', () => {
  it('members writing the same record at once make it once — the rest find it', async () => {
    const plugin = delayedInvoker();
    const { result, attio } = await run(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        `  MAP(${MEMBERS}, { concurrency: 5 }, (u) => {`,
        '    page = fetch_url(url: u)',
        '    write crm-[:companies]-> {',
        '      unique by (`name`)',
        '      name: "Acme"',
        '      summary: COALESCE(page, "none")',
        '    }',
        '  })',
        '}',
      ].join('\n'),
      plugin.invoker,
      // A slow lookup and a slow create: the window two unqueued members
      // would both fall through.
      10,
    );
    expect(plugin.maxInFlight()).toBe(5);
    expect(attio.creates).toHaveLength(1);
    expect(attio.updates).toHaveLength(4);
    expect(result.writes).toHaveLength(5);
  });

  it('members calling the same movement at once are not a recursion', async () => {
    const plugin = delayedInvoker();
    const { attio } = await run(
      [
        'node Link {',
        '  url: <text>',
        '}',
        '',
        'movement fetch_one(l: <Link>) {',
        '  page = fetch_url(url: l.url)',
        '  return COALESCE(page, "none")',
        '}',
        '',
        'movement intake(m: <inbox-[:message]->>) {',
        `  pages = MAP(${MEMBERS}, { concurrency: 3 }, (u) => {`,
        '    got = fetch_one(l: node { url: u })',
        '    return got',
        '  })',
        '  write crm-[:companies]-> { name: m.`subject`, summary: JOIN(pages, ",") }',
        '}',
      ].join('\n'),
      plugin.invoker,
    );
    expect(plugin.maxInFlight()).toBe(3);
    expect(attio.creates[0]?.fields.summary).toBe('got-a,got-b,got-c,got-d,got-e');
  });
});
