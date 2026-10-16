// Recursion through the real interpreter (language version 3; Henry's rulings,
// 2026-10-05):
//
//   · a function calls itself, directly or through another, and a closure
//     bound to a name calls itself by it — inside the same run, so the run's
//     one cost account holds every level;
//   · a call by name that would nest deeper than MOVEMENT_MAX_CALL_DEPTH
//     (default 32) fails the run loudly, naming the chain, and `onError`
//     never forgives it;
//   · depth is per flow: MAP members recursing at once each count their own;
//   · the cost cap met deep in a recursion pauses the run there, and resuming
//     carries every level on from where it stopped.

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { resumeMovement, runMovement, runFailureCause, type MovementRunResult, type ParkSink } from 'movement-engine/services/movement_engine/run';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';
import { CallDepthExceeded, parseMaxCallDepth } from 'movement-engine/services/movement_engine/call_depth';
import { assertRunBudget, reportRunCost, runCostCapFromEnv, withSpendMeter } from 'movement-engine/lib/run_spend';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { type Adapter, type RuntimeCapabilities } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import type { HostTransformInvoker } from 'movement-engine/services/movement_engine/host';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000077');
const COST_ENV = 'MOVEMENT_MAX_RUN_COST_USD';
const DEPTH_ENV = 'MOVEMENT_MAX_CALL_DEPTH';
const DOLLAR = 1_000_000;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of [COST_ENV, DEPTH_ENV]) saved[name] = process.env[name];
  delete process.env[COST_ENV];
  delete process.env[DEPTH_ENV];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function makeFakeAdapter(adapterType: string) {
  const creates: Array<Record<string, unknown>> = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: (): RuntimeCapabilities => ({
      traversal: { incoming: true, edgeProperties: true },
      resources: true,
    }),
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
      creates.push(input.fields);
      return { adapterType, externalId: `ext-${creates.length}`, data: { ...input.fields } };
    },
    async updateRecord() {
      throw new Error('test: no updates expected');
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const catalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetchUrl as fetch_url } from plugins',
  '',
  'inbox = connect email',
  'crm = connect attio using acme_main',
  '',
].join('\n');

/** The version 4 spelling of the same prelude, for the program that joins with `parallel`. */
const PRELUDE_V4 = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetch_url } from plugins',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
].join('\n');

/** A `fetch_url` that costs one dollar: refused first if the run has spent its
 *  cap, then charged. Shared across segments, so `charged` is the whole run. */
function pricedInvoker() {
  const charged: string[] = [];
  const invoker: HostTransformInvoker = {
    async invoke({ config, budget }) {
      const url = String(config.url);
      const { value, cost } = await withSpendMeter(budget, async () => {
        assertRunBudget();
        reportRunCost({ source: { kind: 'service', name: 'test.fetch' }, microdollars: DOLLAR });
        charged.push(url);
        return { text: `got-${url}` };
      });
      return { ...value, cost };
    },
  };
  return { invoker, charged };
}

/** An in-memory park sink with the durable join semantics of the real one —
 *  what a suspension inside a MAP member or a `parallel` arm needs to resume. */
function makeParkSink() {
  const parks = new Map<string, { kind: 'timer' | 'await' | 'suspension'; state: ParkedScopeState }>();
  const joins = new Map<string, { pending: number; closedBy: string | null; decremented: Set<string> }>();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const keep = (kind: 'timer' | 'await' | 'suspension', address: string, state: unknown): void => {
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as ParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin(input) {
      const existing = joins.get(input.frameAddress);
      joins.set(input.frameAddress, {
        pending: input.parkedChildren,
        closedBy: existing?.closedBy ?? null,
        decremented: existing?.decremented ?? new Set(),
      });
    },
    async commitTimerPark(input) {
      keep('timer', input.address, input.state);
    },
    async commitAwaitPark(input) {
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      keep('suspension', input.address, input.state);
    },
    async commitLimitPause() {},
    async decrementJoin(input) {
      const frame = joins.get(input.frameAddress);
      if (frame === undefined) return { closed: true };
      if (frame.decremented.has(input.branchAddress)) return { closed: frame.closedBy === input.leafAddress };
      frame.decremented.add(input.branchAddress);
      if (frame.pending === 0) return { closed: frame.closedBy === input.leafAddress };
      frame.pending -= 1;
      if (frame.pending > 0) return { closed: false };
      frame.closedBy = input.leafAddress;
      return { closed: true };
    },
    async persistBranchExport(input) {
      const byBranch = exports.get(input.frameAddress) ?? new Map();
      byBranch.set(input.branchAddress, {
        branchIndex: input.branchIndex,
        exports: JSON.parse(JSON.stringify(input.exports)) as unknown,
      });
      exports.set(input.frameAddress, byBranch);
    },
    async collectBranchExports(input) {
      return [...(exports.get(input.frameAddress) ?? new Map()).entries()]
        .map(([branchAddress, row]) => ({ branchAddress, branchIndex: row.branchIndex, exports: row.exports }))
        .sort((a, b) => a.branchIndex - b.branchIndex);
    },
    async cancelSubtrees() {},
  };
  return { sink, parks };
}

function webhookEvent(): TriggerEvent {
  return {
    pipelineInputId: 'pi-recursion',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Acme' },
  };
}

function harness(source: string) {
  const email = makeFakeAdapter('email');
  const attio = makeFakeAdapter('attio');
  const plugin = pricedInvoker();
  const parks = makeParkSink();
  let spent = 0;
  const input = () => ({
    source: (source.includes('await parallel') ? PRELUDE_V4 : PRELUDE) + source,
    movementName: 'intake',
    event: webhookEvent(),
    teamId: TEAM_ID,
    catalog,
    costCapMicrodollars: runCostCapFromEnv(),
    credentialIds: credentialIdsFor(catalog, (name: string) => (name === 'acme_main' ? 'cred-attio-1' : undefined)),
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) =>
          adapterType === 'email' ? email.adapter : attio.adapter,
      },
      llm: { transforms: plugin.invoker },
      park: { sink: parks.sink },
    }),
    dryRun: false,
    // `parallel` is retired under 5; a program that joins with it runs under 4.
    ...(source.includes('await parallel') ? { languageVersion: 4 as const } : {}),
  });
  const record = (result: MovementRunResult): MovementRunResult => {
    spent = result.runSpentMicrodollars ?? spent;
    return result;
  };
  return {
    attio,
    plugin,
    parks,
    async start() {
      return record(await runMovement(input()));
    },
    /** Resume the run as the Resume action does: every suspended leaf, with
     *  the usage reset to what the run had spent when it paused. */
    async resumeRun(): Promise<MovementRunResult[]> {
      const baseline = spent;
      const results: MovementRunResult[] = [];
      for (const [address, park] of [...parks.parks.entries()]) {
        if (park.kind !== 'suspension') continue;
        parks.parks.delete(address);
        results.push(
          record(
            await resumeMovement({
              ...input(),
              state: park.state,
              reenter: true,
              priorSpentMicrodollars: spent,
              capBaselineMicrodollars: baseline,
            }),
          ),
        );
      }
      return results;
    },
  };
}

/** What a run that should fail died of. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return runFailureCause(err);
  }
  throw new Error('test: the run was expected to fail');
}

const summaries = (creates: Array<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(creates.map((c) => [c.name, c.summary]));

const COUNTDOWN = [
  'function countdown(n: <number>): <number> {',
  '  if (n <= 0) {',
  '    return 0',
  '  }',
  '  return 1 + countdown(n - 1)',
  '}',
].join('\n');

describe('a function calling itself', () => {
  it('direct recursion: factorial', async () => {
    const h = harness(
      [
        'function fact(n: <number>): <number> {',
        '  if (n <= 1) {',
        '    return 1',
        '  }',
        '  return n * fact(n - 1)',
        '}',
        'function intake(m: <inbox-[:message]->>) {',
        '  x = fact(5)',
        '  write crm-[:companies]-> { name: "fact", summary: "${x}" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(summaries(h.attio.creates)).toEqual({ fact: '120' });
  });

  it('mutual recursion', async () => {
    const h = harness(
      [
        'function is_even(n: <number>): <boolean> {',
        '  if (n == 0) {',
        '    return true',
        '  }',
        '  return is_odd(n - 1)',
        '}',
        'function is_odd(n: <number>): <boolean> {',
        '  if (n == 0) {',
        '    return false',
        '  }',
        '  return is_even(n - 1)',
        '}',
        'function intake(m: <inbox-[:message]->>) {',
        '  a = is_even(10)',
        '  b = is_even(7)',
        '  write crm-[:companies]-> { name: "parity", summary: "${a} ${b}" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(summaries(h.attio.creates)).toEqual({ parity: 'true false' });
  });

  it('a tree walk over a local graph, recursing from inside a MAP', async () => {
    const h = harness(
      [
        'function size(id: <text>, nodes: <{ id: text, parent: text }[]>): <number> {',
        '  kids = filter(nodes, (n) => n.parent == id)',
        '  return 1 + List.sum(map(kids, (k) => size(k.id, nodes)))',
        '}',
        'function intake(m: <inbox-[:message]->>) {',
        '  tree = [',
        '    { id: "root", parent: "" },',
        '    { id: "a", parent: "root" },',
        '    { id: "b", parent: "root" },',
        '    { id: "c", parent: "a" },',
        '    { id: "d", parent: "c" },',
        '  ]',
        '  n = size("root", tree)',
        '  write crm-[:companies]-> { name: "tree", summary: "${n}" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(summaries(h.attio.creates)).toEqual({ tree: '5' });
  });

  it('a closure bound to a name calls itself by it', async () => {
    const h = harness(
      [
        'function intake(m: <inbox-[:message]->>) {',
        '  sum_to = (n: <number>): <number> => n <= 0 ? 0 : n + sum_to(n - 1)',
        '  x = sum_to(4)',
        '  write crm-[:companies]-> { name: "closure", summary: "${x}" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(summaries(h.attio.creates)).toEqual({ closure: '10' });
  });
});

describe('the call depth limit', () => {
  const LOOP = [
    'function loop(n: <number>): <number> {',
    '  return loop(n + 1)',
    '}',
  ].join('\n');

  it('defaults to 32 and fails the run loudly, naming the chain', async () => {
    const h = harness(
      [
        LOOP,
        'function intake(m: <inbox-[:message]->>) {',
        '  x = loop(0)',
        '  write crm-[:companies]-> { name: "never" }',
        '}',
      ].join('\n'),
    );
    const cause = await failureOf(h.start());
    expect(cause).toBeInstanceOf(CallDepthExceeded);
    const error = cause as CallDepthExceeded;
    expect(error.limit).toBe(32);
    expect(error.chain).toHaveLength(34);
    expect(error.chain[0]).toBe('intake');
    expect(error.message).toContain('MOVENG_CALL_DEPTH: call depth limit reached');
    expect(error.message).toContain("'intake → loop → loop → loop → … 24 more … → loop → loop → loop → loop → loop → loop'");
    expect(error.message).toContain('would nest 33 calls deep');
    expect(error.message).toContain('the limit set by MOVEMENT_MAX_CALL_DEPTH is 32');
    expect(h.attio.creates).toEqual([]);
  });

  it('is set per deployment, and counts calls below the run’s own movement', async () => {
    process.env[DEPTH_ENV] = '5';
    const source = (n: number) =>
      [
        COUNTDOWN,
        'function intake(m: <inbox-[:message]->>) {',
        `  x = countdown(${n})`,
        '  write crm-[:companies]-> { name: "count", summary: "${x}" }',
        '}',
      ].join('\n');
    // countdown(4) is five calls deep: countdown(4) … countdown(0).
    const fits = harness(source(4));
    await fits.start();
    expect(summaries(fits.attio.creates)).toEqual({ count: '4' });

    const deeper = harness(source(5));
    const cause = await failureOf(deeper.start());
    expect(cause).toBeInstanceOf(CallDepthExceeded);
    expect((cause as CallDepthExceeded).message).toContain(
      "'intake → countdown → countdown → countdown → countdown → countdown → countdown' would nest 6 calls deep, and the limit set by MOVEMENT_MAX_CALL_DEPTH is 5",
    );
  });

  it('refuses a value that is not a positive whole number', () => {
    expect(parseMaxCallDepth(undefined)).toBe(32);
    expect(parseMaxCallDepth('64')).toBe(64);
    for (const bad of ['0', '-3', '2.5', 'deep']) {
      expect(() => parseMaxCallDepth(bad)).toThrow(/MOVEMENT_MAX_CALL_DEPTH=".*" is not a positive whole number/);
    }
  });

  it('is counted per flow: MAP members recursing at once each count their own chain', async () => {
    process.env[DEPTH_ENV] = '6';
    const h = harness(
      [
        COUNTDOWN,
        'function intake(m: <inbox-[:message]->>) {',
        '  xs = map([3, 4, 5], countdown, { concurrency: 3 })',
        '  write crm-[:companies]-> { name: "each", summary: Text.join(map(xs, (x) => "${x}"), ",") }',
        '}',
      ].join('\n'),
    );
    await h.start();
    // Sharing one stack, the three chains would stack to 3+4+5 calls.
    expect(summaries(h.attio.creates)).toEqual({ each: '3,4,5' });
  });

  it.each(['ignore', 'warn'])('is never forgiven by onError: "%s"', async (onError) => {
    process.env[DEPTH_ENV] = '4';
    const h = harness(
      [
        COUNTDOWN,
        'function intake(m: <inbox-[:message]->>) {',
        `  xs = map([1, 9], (n) => countdown(n), { onError: "${onError}" })`,
        '  write crm-[:companies]-> { name: "kept", summary: Text.join(map(xs, (x) => "${x}"), ",") }',
        '}',
      ].join('\n'),
    );
    const cause = await failureOf(h.start());
    expect(cause).toBeInstanceOf(CallDepthExceeded);
    expect(h.attio.creates).toEqual([]);
  });
});

describe('the cost cap met deep inside a recursion', () => {
  const source = [
    'function crawl(n: <number>): <text> {',
    '  if (n <= 0) {',
    '    return "end"',
    '  }',
    '  page = fetch_url("p${n}")',
    '  rest = crawl(n - 1)',
    '  return Text.concat(coalesce(page, "none"), ",", rest)',
    '}',
    'function intake(m: <inbox-[:message]->>) {',
    '  x = crawl(4)',
    '  write crm-[:companies]-> { name: "done", summary: x }',
    '}',
  ].join('\n');

  it('pauses at the level that would spend, and resuming carries every level on', async () => {
    process.env[COST_ENV] = '1.5';
    const h = harness(source);
    const first = await h.start();
    // p4 then p3 spent $2; the third level stopped before its fetch.
    expect(first.parked).toBe(true);
    expect(h.plugin.charged).toEqual(['p4', 'p3']);
    const [[address, park]] = [...h.parks.parks.entries()];
    expect(park.kind).toBe('suspension');
    expect(park.state.frames?.map((f) => f.kind)).toEqual(['call', 'call', 'call']);
    expect(address).toBe('s0.c0.s2.c0.s2.c0.s1');
    expect(h.attio.creates).toEqual([]);

    // Resumed with its usage reset: p2 ($1, under the cap) and p1 run, every
    // level returns outward once, and nothing is fetched twice.
    const [resumed] = await h.resumeRun();
    expect(resumed?.parked).toBeUndefined();
    expect(h.parks.parks.size).toBe(0);
    expect(h.plugin.charged).toEqual(['p4', 'p3', 'p2', 'p1']);
    expect(summaries(h.attio.creates)).toEqual({ done: 'got-p4,got-p3,got-p2,got-p1,end' });
  });
});

describe('the call depth after a resume', () => {
  // Each level fetches a page, then recurses. With the cap at $1.50 the third
  // fetch pauses the run, and the levels below it run after the resume —
  // counted from where they really are, the frames above them put back.
  const CRAWL = [
    'function crawl(n: <number>): <text> {',
    '  if (n <= 0) {',
    '    return "end"',
    '  }',
    '  page = fetch_url("p${n}")',
    '  rest = crawl(n - 1)',
    '  return Text.concat(coalesce(page, "none"), ",", rest)',
    '}',
  ].join('\n');

  // Version 4 spelling: the `parallel` program below runs under 4.
  const CRAWL_V4 = [
    'function crawl(n: <number>): <text> {',
    '  if n <= 0 {',
    '    return "end"',
    '  }',
    '  page = fetch_url(url: "p${n}")',
    '  rest = crawl(n - 1)',
    '  return CONCAT(COALESCE(page, "none"), ",", rest)',
    '}',
  ].join('\n');

  /** Start, pause at the cap, resume: what the resumed segment failed of, if it did. */
  async function pausedThenResumed(source: string, depth: number) {
    process.env[COST_ENV] = '1.5';
    process.env[DEPTH_ENV] = String(depth);
    const h = harness(source);
    const first = await h.start();
    expect(first.parked).toBe(true);
    try {
      await h.resumeRun();
      return { h, cause: undefined };
    } catch (err) {
      return { h, cause: runFailureCause(err) };
    }
  }

  describe('inside a MAP member that is a function handed over by name', () => {
    // The member is crawl(3), one call deep; crawl(0) is four deep.
    const source = [
      CRAWL,
      'function intake(m: <inbox-[:message]->>) {',
      '  xs = map([3], crawl)',
      '  write crm-[:companies]-> { name: "done", summary: Text.join(xs, ";") }',
      '}',
    ].join('\n');

    it('counts the member as a call: four deep fits a limit of four', async () => {
      const { h, cause } = await pausedThenResumed(source, 4);
      expect(cause).toBeUndefined();
      expect(summaries(h.attio.creates)).toEqual({ done: 'got-p3,got-p2,got-p1,end' });
    });

    it('counts the member as a call: four deep is refused at a limit of three', async () => {
      const { h, cause } = await pausedThenResumed(source, 3);
      expect(cause).toBeInstanceOf(CallDepthExceeded);
      expect((cause as CallDepthExceeded).chain).toEqual(['intake', 'crawl', 'crawl', 'crawl', 'crawl']);
      expect(h.attio.creates).toEqual([]);
    });
  });

  describe('inside a parallel arm that names a function (version 4)', () => {
    // The arm is `deep`, one call deep; crawl(3) is two, crawl(0) five.
    const source = [
      CRAWL_V4,
      'function deep(): <text> {',
      '  return crawl(3)',
      '}',
      'movement intake(m: <inbox-[:message]->>) {',
      '  r = await parallel([deep])',
      '  write crm-[:companies]-> { name: "done" }',
      '}',
    ].join('\n');

    it('counts the arm as a call: five deep fits a limit of five', async () => {
      const { h, cause } = await pausedThenResumed(source, 5);
      expect(cause).toBeUndefined();
      expect(h.plugin.charged).toEqual(['p3', 'p2', 'p1']);
      expect(h.attio.creates.map((c) => c.name)).toEqual(['done']);
    });

    it('counts the arm as a call: five deep is refused at a limit of four', async () => {
      const { h, cause } = await pausedThenResumed(source, 4);
      expect(cause).toBeInstanceOf(CallDepthExceeded);
      expect((cause as CallDepthExceeded).chain).toEqual(['intake', 'deep', 'crawl', 'crawl', 'crawl', 'crawl']);
      expect(h.attio.creates).toEqual([]);
    });
  });
});
