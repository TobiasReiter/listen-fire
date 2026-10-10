// Awaits, `parallel` and `race` in the Rust engine, held to the TypeScript
// engine: each program runs under MOVEMENT_ENGINE=ts and =rust against fakes
// of its own, and the two must agree on everything a caller can see — the
// result or the error, the trace (whole, and as each hand-over carried it),
// the writes the adapter received, and every call the park sink and the
// callback store received, in order, each state key for key.

import type { InstanceSchema } from 'movement-lang';
import { tenantIdOf, type CallbackCall } from 'engine-contracts';

import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import type { CallbackSink } from '../host';
import type { MovementTraceEntry } from '../expression';
import { makeTestHost } from '../test_host';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink } from '../run';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from '../rust_stats';
import type { ParkedScopeState } from '../serialize';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c4');
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

const kgSchema: InstanceSchema = {
  positions: { note: { properties: { body: 'text', payload: 'json' }, edges: {} } },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text' } } },
};

const catalog = staticCatalogSnapshot({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

const PRELUDE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
`;

function program(body: string, fileLevel = ''): string {
  return `${PRELUDE}${fileLevel}movement recap(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire recap
`;
}

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-concurrency',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-05T09:00:00.000Z' },
    occurredAt: '2026-10-05T09:00:00.000Z',
  };
}

function makeKgFake() {
  const creates: WriteInput[] = [];
  const caps = (): RuntimeCapabilities => ({ traversal: { incoming: false, edgeProperties: false }, resources: false });
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: caps,
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    async createRecord(write) {
      creates.push(write);
      return { adapterType: KG, externalId: `note-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, creates };
}

/** Every call the park sink and the callback store get, in order: the
 *  method, and its input as JSON (key order kept). */
type Events = Array<[string, string]>;

/** An in-memory park sink with the durable join semantics the real one has
 *  (join_pending.ts): a frame's pending count, one decrement per branch, the
 *  closer identified, every branch's export kept by frame. */
function makeSink(events: Events) {
  const joins = new Map<string, { pending: number; closedBy: string | null; decremented: Set<string> }>();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const parks = new Map<string, { kind: 'timer' | 'await' | 'suspension'; state: ParkedScopeState }>();
  const note = (method: string, input: unknown) => {
    const { segmentId: _segment, ...rest } = input as Record<string, unknown>;
    events.push([method, JSON.stringify(rest)]);
  };
  const keep = (kind: 'timer' | 'await' | 'suspension', address: string, state: unknown) => {
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as ParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin(input) {
      note('recordJoin', input);
      const existing = joins.get(input.frameAddress);
      joins.set(input.frameAddress, { pending: input.parkedChildren, closedBy: existing?.closedBy ?? null, decremented: existing?.decremented ?? new Set() });
    },
    async commitTimerPark(input) {
      note('commitTimerPark', input);
      keep('timer', input.address, input.state);
    },
    async commitAwaitPark(input) {
      note('commitAwaitPark', input);
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      note('commitSuspension', input);
      keep('suspension', input.address, input.state);
    },
    async decrementJoin(input) {
      note('decrementJoin', input);
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
      note('persistBranchExport', input);
      const byBranch = exports.get(input.frameAddress) ?? new Map();
      byBranch.set(input.branchAddress, { branchIndex: input.branchIndex, exports: JSON.parse(JSON.stringify(input.exports)) as unknown });
      exports.set(input.frameAddress, byBranch);
    },
    async collectBranchExports(input) {
      note('collectBranchExports', input);
      return [...(exports.get(input.frameAddress) ?? new Map()).entries()]
        .map(([branchAddress, row]) => ({ branchAddress, branchIndex: row.branchIndex, exports: row.exports }))
        .sort((a, b) => a.branchIndex - b.branchIndex);
    },
    async cancelSubtrees(input) {
      note('cancelSubtrees', input);
      const under = (address: string) => input.subtreeAddresses.some((p) => address === p || address.startsWith(`${p}.`));
      for (const address of [...parks.keys()]) if (under(address) && address !== input.excludeLeaf) parks.delete(address);
    },
  };
  return { sink, parks, joins, exports };
}

/** A callback store: a ledger the test fills, as a platform's fire would. */
function makeCallbacks(events: Events, ledger: Record<string, CallbackCall[]>) {
  let n = 0;
  const sink: CallbackSink = {
    async mint(input) {
      const { segmentId: _segment, ...rest } = input as typeof input & { segmentId: string };
      events.push(['mint', JSON.stringify(rest)]);
      const id = `cb_${++n}`;
      return { id, url: `https://api.test/api/cb/${id}` };
    },
    async calls(input) {
      events.push(['calls', input.callbackId]);
      return ledger[input.callbackId] ?? [];
    },
  };
  return sink;
}

interface Case {
  source: string;
  /** What the callback store's ledger holds, by callback id. */
  ledger?: Record<string, CallbackCall[]>;
  /** Resume this state rather than run. */
  resume?: ParkedScopeState;
  reenter?: boolean;
  /** The sink's frames and exports, as an earlier segment left them. */
  sink?: ReturnType<typeof makeSink>;
  dryRun?: boolean;
}

interface Outcome {
  result?: MovementRunResult;
  error?: string;
  trace: MovementTraceEntry[];
  appends: MovementTraceEntry[][];
  events: Events;
  wakes: unknown[];
  bodies: unknown[];
  parks: Map<string, { kind: string; state: ParkedScopeState }>;
}

async function runOn(engine: 'ts' | 'rust', c: Case): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const kg = makeKgFake();
  const events: Events = [];
  const sink = c.sink ?? makeSink(events);
  const trace: MovementTraceEntry[] = [];
  const appends: MovementTraceEntry[][] = [];
  const wakes: unknown[] = [];
  const input = {
    source: c.source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    firedAt: '2026-10-05T09:00:00.000Z',
    ...(c.dryRun === true ? { dryRun: true } : {}),
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: unknown }) => {
          if (adapterType === 'manual') return manualAdapter;
          if (adapterType === KG) return kg.adapter;
          throw new Error(`test: no fake adapter for '${String(adapterType)}'`);
        },
      },
      park: { sink: sink.sink, callbacks: makeCallbacks(events, c.ledger ?? {}) },
      trace,
      traceAppends: appends,
      wakes: wakes as never[],
    }),
  };
  const world = () => ({ trace, appends, events, wakes, bodies: kg.creates.map((w) => w.fields), parks: sink.parks });
  try {
    const result =
      c.resume !== undefined
        ? await resumeMovement({ ...input, state: c.resume, ...(c.reenter === true ? { reenter: true } : {}) })
        : await runMovement(input);
    return { result, ...world() };
  } catch (error) {
    return { error: String(error), ...world() };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** The case on both engines: they agree, and the Rust run was the Rust
 *  engine's alone, routed whole. */
async function agree(c: Case) {
  const ts = await runOn('ts', c);
  resetRustEvalStats();
  resetRustRunStats();
  const rust = await runOn('rust', c);
  expect({ notAdmitted: rustRunStats.notAdmitted, declined: rustRunStats.declined, ranWhole: rustRunStats.ranWhole }).toEqual({
    notAdmitted: {},
    declined: {},
    ranWhole: 1,
  });
  expect(rust.error).toBe(ts.error);
  expect(JSON.stringify(rust.result?.writes)).toBe(JSON.stringify(ts.result?.writes));
  expect(rust.result?.parkedAddress).toBe(ts.result?.parkedAddress);
  expect(rust.result?.parked).toBe(ts.result?.parked);
  expect(rust.trace).toEqual(ts.trace);
  expect(rust.appends).toEqual(ts.appends);
  // Key for key, in order.
  expect(rust.events).toEqual(ts.events);
  expect(rust.wakes).toEqual(ts.wakes);
  expect(rust.bodies).toEqual(ts.bodies);
  return { ts, rust };
}

const bodies = (o: Outcome): unknown[] => o.bodies.map((b) => (b as { body?: unknown }).body);

describe('parallel and race in the Rust engine', () => {
  it('runs a parallel’s arms and binds its receipt, slot by arm', async () => {
    const { rust } = await agree({
      source: program(
        [
          '  r = await parallel([',
          '    () => {',
          '      write graph-[:note]-> { body: "arm 0" }',
          '      return 1',
          '    },',
          '    () => {',
          '      write graph-[:note]-> { body: "arm 1" }',
          '      return 2',
          '    },',
          '    () => { done = "acted" },',
          '  ])',
          '  write graph-[:note]-> { payload: { r: r, first: AT(r, 0), none: AT(r, 2) } }',
        ].join('\n'),
      ),
    });
    expect(bodies(rust)).toEqual(['arm 0', 'arm 1', undefined]);
  });

  it('settles a race on every arm that finished, a null slot for the rest', async () => {
    await agree({
      source: program(
        [
          '  r = await race([',
          '    () => { return "first" },',
          '    () => { return "second" },',
          '  ])',
          '  write graph-[:note]-> { body: "${AT(r, 0)}/${AT(r, 1)}" }',
        ].join('\n'),
      ),
    });
  });

  it('binds an empty receipt for a parallel over nothing, and fails a race over nothing', async () => {
    await agree({ source: program('  arms = []\n  r = await parallel(arms)\n  write graph-[:note]-> { payload: { n: COUNT(r) } }') });
    const { rust } = await agree({ source: program('  arms = []\n  r = await race(arms)') });
    expect(rust.error).toContain('a race over no arms can never settle');
  });

  it('runs arms built at run time, and named closures as arms', async () => {
    await agree({
      source: program(
        [
          '  arms = MAP([1, 2], (n) => {',
          '    return () => {',
          '      write graph-[:note]-> { body: "arm ${n}" }',
          '      return n * 5',
          '    }',
          '  })',
          '  r = await parallel(arms)',
          '  base = 7',
          '  f = () => { return base }',
          '  s = await parallel([f, () => { return base + 1 }])',
          '  write graph-[:note]-> { body: "${AT(r, 0)} ${AT(r, 1)} ${AT(s, 0)} ${AT(s, 1)}" }',
        ].join('\n'),
      ),
    });
  });

  it('fails with the earliest arm’s failure once every arm has stopped', async () => {
    const { rust } = await agree({
      source: program(
        [
          '  r = await parallel([',
          '    () => { write graph-[:note]-> { body: "kept" } },',
          '    () => { ERROR("second") },',
          '    () => { ERROR("third") },',
          '  ])',
        ].join('\n'),
      ),
    });
    expect(rust.error).toContain('second');
  });

  it('parks a parallel whose arms sleep, keeping the finished arm’s slot at the frame', async () => {
    const { rust } = await agree({
      source: program(
        [
          '  r = await parallel([',
          '    () => { return "now" },',
          '    () => {',
          '      await sleep(1h)',
          '      return "later"',
          '    },',
          '  ])',
          '  write graph-[:note]-> { payload: { r: r } }',
        ].join('\n'),
      ),
    });
    expect(rust.result?.parkedAddress).toBe('s0');
    expect(rust.events.map(([method]) => method)).toEqual(['commitTimerPark', 'persistBranchExport', 'recordJoin']);
  });

  it('parks a race all of whose arms wait, as a join of one', async () => {
    const { rust } = await agree({
      source: program(
        [
          '  r = await race([',
          '    () => {',
          '      await sleep(30d)',
          '      return "a"',
          '    },',
          '    () => { await sleep(1d) },',
          '  ])',
        ].join('\n'),
      ),
    });
    expect(rust.events.map(([method]) => method)).toEqual(['commitTimerPark', 'commitTimerPark', 'recordJoin']);
  });

  it('stops listening on the arms still parked once one finishes', async () => {
    await agree({
      source: program(
        [
          '  r = await race([',
          '    () => { await sleep(1d) },',
          '    () => { return 2 },',
          '  ])',
          '  write graph-[:note]-> { payload: { r: r } }',
        ].join('\n'),
      ),
    });
  });
});

describe('until and callbacks in the Rust engine', () => {
  it('goes on past an until whose condition holds, and parks on one that does not', async () => {
    await agree({ source: program('  ok = await until(1 == 1)\n  write graph-[:note]-> { payload: { ok: ok } }') });
    const { rust } = await agree({
      source: program('  subject = "wait"\n  ready = () => {\n    return subject == "go"\n  }\n  await until(ready, every: 2h)\n  write graph-[:note]-> { body: subject }'),
    });
    expect(rust.result?.parkedAddress).toBe('s2');
  });

  it('mints a callback with its captured scope, and reads its id and url', async () => {
    const { rust } = await agree({
      source: program(
        [
          '  greeting = "hello"',
          '  cb = callback((note: <text>) => { write graph-[:note]-> { body: "${greeting}: ${note}" } })',
          '  b = callback({ write graph-[:note]-> { body: "b" } }, { once: FALSE, ttl: 2d })',
          '  write graph-[:note]-> { body: cb.id, payload: { url: b.url } }',
        ].join('\n'),
      ),
    });
    expect(rust.events.map(([method]) => method)).toEqual(['mint', 'mint']);
  });

  it('reads the calls so far as a block head, and awaits the next', async () => {
    const ledger = { cb_1: [{ at: '2026-10-05T10:00:00.000Z', values: { note: 'yes' } }] };
    await agree({
      source: program(
        [
          '  cb = callback((note: <text>) => { write graph-[:note]-> { body: note } })',
          '  cb-[c:Called]-> {',
          '    write graph-[:note]-> { body: "${c.note} at ${c.At}" }',
          '  }',
          '  got = await FIRST(cb-[:Called]->)',
          '  write graph-[:note]-> { body: got.note }',
        ].join('\n'),
      ),
      ledger,
    });
    const { rust } = await agree({
      source: program('  cb = callback()\n  c = await FIRST(cb-[:Called]->)\n  write graph-[:note]-> { body: "continued" }'),
    });
    expect(rust.result?.parkedAddress).toBe('s1');
  });
});
