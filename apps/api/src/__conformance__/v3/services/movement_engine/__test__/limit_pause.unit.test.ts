// Meeting the per-run cost cap PAUSES the run instead of failing it, through
// the real interpreter (Henry's rulings, 2026-10-05):
//
//   · the flow that met the cap suspends just before the statement that would
//     have spent; every other flow finishes the statement it is in and suspends
//     before its next; a collection op starts no further member;
//   · the run is marked paused once (`commitLimitPause`), however many flows
//     met the cap;
//   · a branch waiting on something ordinary that is woken while the run is
//     paused takes its event and then holds the pause;
//   · resuming every suspended flow with the usage reset (`capBaselineMicrodollars`)
//     finishes the run: results correct, nothing done twice;
//   · where nothing durable can hold the suspension, the cap still fails the run.
//
// The members' priced work is a plugin standing in for a model call: it asks
// the run's account first and reports its cost, exactly as the model clients do.

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { resumeMovement, runMovement, runFailureCause, MovementRunFailed, type MovementRunResult, type ParkSink, type RunLimitPause } from '../run';
import type { MovementTransformInvoker } from '../extraction';
import type { ParkedScopeState } from '../serialize';
import { assertRunBudget, reportRunCost, RunCostCapExceeded } from '../../../lib/run_spend';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { type Adapter, type RuntimeCapabilities } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData, type TransformOutputShape } from '../../translation_graph/types';
import { getTransform } from '../../translation_graph/engine/transforms/registry';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000053' as TeamId;
const ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';
const DOLLAR = 1_000_000;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_VAR];
  process.env[ENV_VAR] = '1.5';
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

/** How long each url's fetch takes — fixes the order members finish in. */
const DELAY_MS: Record<string, number> = { a: 30, b: 5, c: 20, d: 1, e: 10 };

/** A `fetch_url` that costs one dollar: refused first if the run has spent its
 *  cap, then charged. Shared across segments, so `charged` is the whole run. */
function pricedInvoker() {
  const charged: string[] = [];
  const invoker: MovementTransformInvoker = {
    declaredOutput: (plugin) => {
      const impl = getTransform(plugin) ?? getTransform(plugin.replace(/_/g, '-'));
      return impl?.signature.output as TransformOutputShape | undefined;
    },
    async invoke({ config }) {
      const url = String(config.url);
      assertRunBudget();
      await wait(DELAY_MS[url] ?? 0);
      reportRunCost({ source: { kind: 'service', name: 'test.fetch' }, microdollars: DOLLAR });
      charged.push(url);
      return { text: `got-${url}` };
    },
  };
  return { invoker, charged };
}

type ParkKind = 'timer' | 'await' | 'suspension';

/** An in-memory park sink with the durable join semantics of the real one —
 *  the same shape `resume_inside.unit.test.ts` drives — plus the pause. */
function makeParkSink() {
  const parks = new Map<string, { kind: ParkKind; state: ParkedScopeState }>();
  const joins = new Map<string, { pending: number; closedBy: string | null; decremented: Set<string> }>();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const pauses: RunLimitPause[] = [];
  const keep = (kind: ParkKind, address: string, state: unknown): void => {
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
      await input.correlate('run-1');
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      keep('suspension', input.address, input.state);
    },
    async commitLimitPause(pause) {
      pauses.push(pause);
    },
    async decrementJoin(input) {
      const frame = joins.get(input.frameAddress);
      if (frame === undefined) return { closed: false };
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
  return { sink, parks, pauses };
}

function webhookEvent(): TriggerEvent {
  return {
    pipelineInputId: 'pi-limit-pause',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Acme' },
  };
}

/** One run: what it wrote is collected across every segment of it. */
function harness(source: string, options: { parkSink?: boolean } = {}) {
  const email = makeFakeAdapter('email');
  const attio = makeFakeAdapter('attio');
  const plugin = pricedInvoker();
  const parks = makeParkSink();
  /** The run's whole spend so far — what the host reads back off the run row. */
  let spent = 0;
  const input = () => ({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name: string) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) =>
      adapterType === 'email' ? email.adapter : attio.adapter,
    transformInvoker: plugin.invoker,
    ...(options.parkSink === false ? {} : { parkSink: parks.sink }),
    dryRun: false,
  });
  const record = (result: MovementRunResult): MovementRunResult => {
    spent = result.runSpentMicrodollars ?? spent;
    return result;
  };
  return {
    attio,
    plugin,
    parks,
    get spent() {
      return spent;
    },
    async start(extra: { priorSpentMicrodollars?: number } = {}) {
      if (extra.priorSpentMicrodollars !== undefined) spent = extra.priorSpentMicrodollars;
      return record(await runMovement({ ...input(), ...extra }));
    },
    /** Resume one parked leaf as its driver would: a suspension re-enters its
     *  statement, a sleep steps past. `limitPaused` is what the run row says. */
    async resumeLeaf(address: string, options: { limitPaused?: boolean; capBaselineMicrodollars?: number } = {}) {
      const park = parks.parks.get(address);
      if (park === undefined) {
        throw new Error(`test: nothing parked at '${address}' (have ${[...parks.parks.keys()].join(', ')})`);
      }
      parks.parks.delete(address);
      return record(
        await resumeMovement({
          ...input(),
          state: park.state,
          reenter: park.kind !== 'timer',
          priorSpentMicrodollars: spent,
          ...options,
        }),
      );
    },
    /** Resume the run: every limit-suspended leaf, with the usage reset to now. */
    async resumeRun(): Promise<MovementRunResult[]> {
      const baseline = spent;
      const leaves = [...parks.parks.entries()].filter(([, p]) => p.kind === 'suspension').map(([a]) => a);
      const results: MovementRunResult[] = [];
      for (const address of leaves) {
        results.push(await this.resumeLeaf(address, { capBaselineMicrodollars: baseline }));
      }
      return results;
    },
  };
}

const names = (creates: Array<Record<string, unknown>>): unknown[] => creates.map((c) => c.name);

describe('the cap met inside a MAP member running three at a time', () => {
  const source = [
    'movement intake(m: <inbox-[:message]->>) {',
    '  pages = MAP(["a", "b", "c", "d", "e"], { concurrency: 3 }, (u) => {',
    '    page = fetch_url(url: u)',
    '    write crm-[:companies]-> { name: COALESCE(page, "none") }',
    '    return COALESCE(page, "none")',
    '  })',
    '  write crm-[:companies]-> { name: "done", summary: JOIN(pages, ",") }',
    '}',
  ].join('\n');

  // a, b, c start together under the cap. b lands first ($1) and writes; its
  // slot starts d ($1 < $1.50, allowed), which lands ($2) and writes; that slot
  // starts e, which meets the cap before its fetch. c and a were already
  // fetching: each finishes its fetch, then stops before its write.

  it('suspends the member that met the cap before its priced statement, and the others after their current one', async () => {
    const h = harness(source);
    const result = await h.start();

    expect(result.parked).toBe(true);
    expect([...h.plugin.charged].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(names(h.attio.creates).sort()).toEqual(['got-b', 'got-d']);
    expect([...h.parks.parks.entries()].map(([address, p]) => [address, p.kind]).sort()).toEqual([
      ['s0.c0.i0.s1', 'suspension'],
      ['s0.c0.i2.s1', 'suspension'],
      ['s0.c0.i4.s0', 'suspension'],
    ]);
    // The run was paused once, by the member that met the cap.
    expect(h.parks.pauses).toEqual([{ limit: 'cost', capMicrodollars: 1.5 * DOLLAR, spentMicrodollars: 2 * DOLLAR }]);
    expect(result.trace.some((e) => e.kind === 'warning' && e.code === 'RUN_PAUSED_COST_CAP')).toBe(true);
  });

  it('resuming the run resumes every member with its usage reset: right answer, nothing twice', async () => {
    const h = harness(source);
    await h.start();
    const results = await h.resumeRun();

    expect(results).toHaveLength(3);
    expect(results.at(-1)?.parked).toBeUndefined();
    expect(h.parks.parks.size).toBe(0);
    // Only e fetched again: a and c had finished their fetch, and re-ran only
    // their write. Spent since the reset: one dollar, under the cap.
    expect([...h.plugin.charged].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(names(h.attio.creates).sort()).toEqual(['done', 'got-a', 'got-b', 'got-c', 'got-d', 'got-e']);
    const done = h.attio.creates.find((c) => c.name === 'done');
    expect(done?.summary).toBe('got-a,got-b,got-c,got-d,got-e');
    expect(h.parks.pauses).toHaveLength(1);
  });

  it('without the reset the resumed run would meet the cap again at once', async () => {
    const h = harness(source);
    await h.start();
    const first = [...h.parks.parks.keys()].sort()[2]!; // e, before its fetch
    const again = await h.resumeLeaf(first);
    expect(again.parked).toBe(true);
    expect(h.plugin.charged).not.toContain('e');
    expect(h.parks.parks.get(first)?.kind).toBe('suspension');
  });
});

describe('a branch waiting on something ordinary while the run is paused', () => {
  const source = [
    'movement intake(m: <inbox-[:message]->>) {',
    '  pages = MAP(["slow", "x"], { concurrency: 2 }, (u) => {',
    '    if u == "slow" {',
    '      await sleep(1h)',
    '    }',
    '    page = fetch_url(url: u)',
    '    write crm-[:companies]-> { name: COALESCE(page, "none") }',
    '    return COALESCE(page, "none")',
    '  })',
    '  write crm-[:companies]-> { name: "done", summary: JOIN(pages, ",") }',
    '}',
  ].join('\n');

  it('stays parked on its own wait when the run pauses', async () => {
    const h = harness(source);
    const result = await h.start({ priorSpentMicrodollars: 2 * DOLLAR });
    expect(result.parked).toBe(true);
    expect(h.plugin.charged).toEqual([]);
    expect([...h.parks.parks.entries()].map(([a, p]) => [a, p.kind]).sort()).toEqual([
      ['s0.c0.i0.s0.b0.s0', 'timer'],
      ['s0.c0.i1.s1', 'suspension'],
    ]);
  });

  it('takes its event while paused, then holds the pause before its next statement', async () => {
    const h = harness(source);
    await h.start({ priorSpentMicrodollars: 2 * DOLLAR });
    // The timer fires; the run row says it is paused.
    const woke = await h.resumeLeaf('s0.c0.i0.s0.b0.s0', { limitPaused: true });
    expect(woke.parked).toBe(true);
    // It stepped past the sleep and stopped before the fetch: nothing spent,
    // nothing written, and it is now one of the run's paused flows.
    expect(h.plugin.charged).toEqual([]);
    expect(h.attio.creates).toEqual([]);
    expect([...h.parks.parks.entries()].map(([a, p]) => [a, p.kind]).sort()).toEqual([
      ['s0.c0.i0.s1', 'suspension'],
      ['s0.c0.i1.s1', 'suspension'],
    ]);

    // Resuming the run carries both on, with the usage reset.
    await h.resumeRun();
    expect(h.parks.parks.size).toBe(0);
    expect([...h.plugin.charged].sort()).toEqual(['slow', 'x']);
    expect(h.attio.creates.find((c) => c.name === 'done')?.summary).toBe('got-slow,got-x');
  });
});

describe('the cap met in a movement called two deep', () => {
  const source = [
    'movement inner(u: <text>) {',
    '  page = fetch_url(url: u)',
    '  write crm-[:companies]-> { name: COALESCE(page, "none") }',
    '  return COALESCE(page, "none")',
    '}',
    'movement outer(u: <text>) {',
    '  write crm-[:companies]-> { name: "outer before" }',
    '  y = inner(u: u)',
    '  return y',
    '}',
    'movement intake(m: <inbox-[:message]->>) {',
    '  x = outer(u: "a")',
    '  write crm-[:companies]-> { name: "end", summary: x }',
    '}',
  ].join('\n');

  it('suspends inside the callee before its priced statement, and resumes every body outward once', async () => {
    const h = harness(source);
    const first = await h.start({ priorSpentMicrodollars: 2 * DOLLAR });
    expect(first.parked).toBe(true);
    expect([...h.parks.parks.keys()]).toEqual(['s0.c0.s1.c0.s0']);
    expect(h.parks.parks.get('s0.c0.s1.c0.s0')?.state.frames?.map((f) => f.kind)).toEqual(['call', 'call']);
    expect(names(h.attio.creates)).toEqual(['outer before']);

    const [resumed] = await h.resumeRun();
    expect(resumed?.parked).toBeUndefined();
    expect(h.plugin.charged).toEqual(['a']);
    expect(names(h.attio.creates)).toEqual(['outer before', 'got-a', 'end']);
    expect(h.attio.creates.at(-1)?.summary).toBe('got-a');
  });
});

describe('with nowhere durable to suspend', () => {
  it('the cap still fails the run, as a rehearsal has no park to hold it', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  page = fetch_url(url: "a")',
        '  write crm-[:companies]-> { name: COALESCE(page, "none") }',
        '}',
      ].join('\n'),
      { parkSink: false },
    );
    let failure: unknown;
    try {
      await h.start({ priorSpentMicrodollars: 2 * DOLLAR });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(MovementRunFailed);
    expect(runFailureCause(failure)).toBeInstanceOf(RunCostCapExceeded);
  });
});
