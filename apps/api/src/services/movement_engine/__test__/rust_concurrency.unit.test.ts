// Awaits, `all` and `race` in the Rust engine: each program runs on the Rust
// engine (version 5) against fakes of its own. What a caller can see — the
// result or the error, the trace (whole, and as each hand-over carried it),
// the writes the adapter received, and every call the park sink and the
// callback store received, in order — is recorded as a snapshot (a park's
// state is shown by its address only; rust_park_identity holds the states),
// and the assertions beside each case say what it is for.

import { spelledForVersion5 } from './combinator_spelling';
import { fromCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';
import { tenantIdOf, type CallbackCall } from 'engine-contracts';

import type { Adapter, RuntimeCapabilities, WriteInput } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, makeUnstablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import type { CallbackSink } from 'movement-engine/services/movement_engine/host';
import type { MovementTraceEntry } from 'movement-engine/services/movement_engine/expression';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame, type MovementRunResult, type ParkSink } from 'movement-engine/services/movement_engine/run';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c4');
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

const kgSchema: InstanceSchema = {
  positions: {
    note: { properties: { body: 'text', payload: 'json' }, edges: {} },
    'Check Response': { properties: { Answer: 'boolean' }, edges: {} },
    // A check already in the graph, walked to rather than written.
    Check: { properties: { Prompt: 'text' }, edges: { Response: { target: 'Check Response', awaitable: true, watchable: true, resolvesEmpty: true } } },
  },
  collections: { note: { target: 'note' }, Check: { target: 'Check' } },
  writableRoots: {
    note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text' } },
    // A check whose response an awaitable adapter lands later.
    Check: {
      fields: { Prompt: 'text' },
      resultShape: { externalId: 'text', Prompt: 'text' },
      requiredFields: ['Prompt'],
      edges: { Response: { target: 'Check Response', writable: true, awaitable: true, watchable: true, resolvesEmpty: true } },
    },
  },
  createShapes: { 'Check Response': { fields: { Answer: 'boolean' }, resultShape: { externalId: 'text', Answer: 'boolean' }, requiredFields: ['Answer'] } },
};

/** What the awaitable adapter's `resolveAwait` answers: still pending (with
 *  the key a wake names the park by), landed, or settled empty. */
type Landing = 'pending' | 'landed' | 'empty';

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

function makeKgFake(landing: Landing) {
  const creates: WriteInput[] = [];
  const awaited: unknown[] = [];
  const caps = (): RuntimeCapabilities => ({ traversal: { incoming: false, edgeProperties: false }, resources: false });
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: caps,
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => (positionData(position) as Record<string, unknown> | undefined)?.[fieldId] ?? null,
    // Two notes under the instance, for a block to walk.
    getRelated: async ({ fieldId }) =>
      fieldId === 'note'
        ? ['a', 'b'].map((body) => ({ position: makeUnstablePosition({ adapterType: KG, recordType: 'note', data: { body } }) }))
        : fieldId === 'Check'
          ? [{ position: makeStablePosition({ adapterType: KG, recordType: 'Check', recordId: 'check-7', data: { Prompt: 'q' } }) }]
          : [],
    async createRecord(write) {
      creates.push(write);
      return { adapterType: KG, externalId: `note-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
    awaitable: {
      async resolveAwait(point) {
        awaited.push(point);
        if (landing === 'pending') return { status: 'pending', correlationKey: `ck:${point.recordId}` };
        if (landing === 'empty') return { status: 'empty' };
        return { status: 'landed', correlationKey: `ck:${point.recordId}`, landings: [{ recordId: 'r1', recordType: 'Check Response', fields: { Answer: true } }] };
      },
    },
  };
  return { adapter, creates, awaited };
}

/** Every call the park sink and the callback store get, in order: the
 *  method, and its input as JSON (key order kept). */
type Events = Array<[string, string]>;

/** An in-memory park sink with the durable join semantics the real one has
 *  (join_pending.ts): a frame's pending count, one decrement per branch, the
 *  closer identified, every branch's export kept by frame. */
function makeSink(events: Events, seed?: SinkRows) {
  // As the sink's rows are stored: JSON, read back.
  const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const joins: SinkRows['joins'] = new Map(
    [...(seed?.joins ?? [])].map(([frame, row]) => [frame, { pending: row.pending, closedBy: row.closedBy, decremented: new Set(row.decremented) }]),
  );
  const exports: SinkRows['exports'] = new Map([...(seed?.exports ?? [])].map(([frame, rows]) => [frame, new Map([...rows].map(([b, row]) => [b, stored(row)]))]));
  const parks: SinkRows['parks'] = new Map([...(seed?.parks ?? [])].map(([address, park]) => [address, stored(park)]));
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

/** What a park sink holds between segments. */
interface SinkRows {
  joins: Map<string, { pending: number; closedBy: string | null; decremented: Set<string> }>;
  exports: Map<string, Map<string, { branchIndex: number; exports: unknown }>>;
  parks: Map<string, { kind: 'timer' | 'await' | 'suspension'; state: ParkedScopeState }>;
}

/** A callback store: a ledger the test fills, as a platform's fire would. */
function makeCallbacks(events: Events, ledger: Record<string, CallbackCall[]>, minted: ParkedScopeState[]) {
  let n = 0;
  const sink: CallbackSink = {
    async mint(input) {
      const { segmentId: _segment, ...rest } = input as typeof input & { segmentId: string };
      events.push(['mint', JSON.stringify(rest)]);
      minted.push(JSON.parse(JSON.stringify(input.state)) as ParkedScopeState);
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
  /** The sink's rows, as an earlier segment left them. */
  rows?: SinkRows;
  dryRun?: boolean;
  suspendAt?: string[];
  deferRaceSettlement?: boolean;
  /** Settle this race frame from `resume` (`settleRaceFrame`). */
  settle?: string;
  /** Fire `resume`, a callback's state, with these values (`fireCallbackBody`). */
  fire?: { values: Record<string, unknown>; callIndex: number };
  /** What an awaited landing's adapter answers; pending by default. */
  landing?: Landing;
}

interface Outcome {
  result?: MovementRunResult;
  error?: string;
  trace: MovementTraceEntry[];
  appends: MovementTraceEntry[][];
  events: Events;
  wakes: unknown[];
  bodies: unknown[];
  parks: SinkRows['parks'];
  rows: SinkRows;
  /** The state each minted callback captured. */
  minted: ParkedScopeState[];
  /** Each point the awaitable adapter was asked to resolve. */
  awaited: unknown[];
}

async function runOn(c: Case): Promise<Outcome> {
  const kg = makeKgFake(c.landing ?? 'pending');
  const events: Events = [];
  const sink = makeSink(events, c.rows);
  const minted: ParkedScopeState[] = [];
  const trace: MovementTraceEntry[] = [];
  const appends: MovementTraceEntry[][] = [];
  const wakes: unknown[] = [];
  const input = {
    // Written in the spelling versions 1–4 read; the run reads it as the upgrade tool respells it.
    source: spelledFor(5, spelledForVersion5(c.source), fromCatalogSnapshot(catalog)),
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    firedAt: '2026-10-05T09:00:00.000Z',
    ...(c.dryRun === true ? { dryRun: true } : {}),
    ...(c.suspendAt !== undefined ? { suspendAt: c.suspendAt } : {}),
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: unknown }) => {
          if (adapterType === 'manual') return manualAdapter;
          if (adapterType === KG) return kg.adapter;
          throw new Error(`test: no fake adapter for '${String(adapterType)}'`);
        },
      },
      park: { sink: sink.sink, callbacks: makeCallbacks(events, c.ledger ?? {}, minted) },
      trace,
      traceAppends: appends,
      wakes: wakes as never[],
    }),
  };
  const world = () => ({ trace, appends, events, wakes, bodies: kg.creates.map((w) => w.fields), parks: sink.parks, rows: sink, minted, awaited: kg.awaited });
  const enter = () => {
    if (c.resume === undefined) return runMovement(input);
    const resumed = { ...input, state: c.resume };
    if (c.settle !== undefined) return settleRaceFrame({ ...resumed, frameAddress: c.settle });
    if (c.fire !== undefined) return fireCallbackBody({ ...resumed, ...c.fire });
    return resumeMovement({
      ...resumed,
      ...(c.reenter === true ? { reenter: true } : {}),
      ...(c.deferRaceSettlement === true ? { deferRaceSettlement: true } : {}),
    });
  };
  try {
    const result = await enter();
    return { result, ...world() };
  } catch (error) {
    return { error: String(error), ...world() };
  }
}

/** What a snapshot shows of a run: the writes without their provenance, and
 *  the sink's calls with a park's state left out. */
function observed(o: Outcome) {
  const events = o.events.map(([method, input]) => {
    // A callback store's `calls` is noted as the bare id, not JSON.
    if (method === 'calls') return [method, input];
    const { state: _state, ...rest } = JSON.parse(input) as Record<string, unknown>;
    return [method, rest];
  });
  return JSON.parse(
    JSON.stringify({
      error: o.error,
      writes: o.result?.writes.map((w) => ({ recordType: w.recordType, outcome: w.outcome, externalId: w.externalId, writtenValues: w.writtenValues })),
      parkedAddress: o.result?.parkedAddress,
      parked: o.result?.parked,
      deferredRaceFrames: o.result?.deferredRaceFrames,
      cancelled: o.result?.cancelled,
      trace: o.trace,
      appends: o.appends,
      events,
      wakes: o.wakes,
      bodies: o.bodies,
      awaited: o.awaited,
    }),
  ) as unknown;
}

/** The case on the Rust engine: it ran the segment whole, refusing nothing. */
async function run(c: Case): Promise<Outcome> {
  resetRustRunStats();
  const outcome = await runOn(c);
  if (rustRunStats.segments !== 1) expect({ error: outcome.error, stats: rustRunStats }).toEqual({});
  expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {}, shimFaults: 0 });
  expect(observed(outcome)).toMatchSnapshot();
  return outcome;
}

const bodies = (o: Outcome): unknown[] => o.bodies.map((b) => (b as { body?: unknown }).body);

describe('all and race in the Rust engine', () => {
  it('runs an `all`’s arms and binds its receipt, slot by arm', async () => {
    const rust = await run({
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
    await run({
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

  it('runs named closures as arms', async () => {
    const rust = await run({
      source: program(
        [
          '  base = 7',
          '  f = () => { return base }',
          '  s = await parallel([f, () => { return base + 1 }])',
          '  write graph-[:note]-> { body: "${AT(s, 0)} ${AT(s, 1)}" }',
        ].join('\n'),
      ),
    });
    expect(bodies(rust)).toEqual(['7 8']);
  });

  it('fails with the earliest arm’s failure once every arm has stopped', async () => {
    const rust = await run({
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

  it('parks an `all` whose arms sleep, keeping the finished arm’s slot at the frame', async () => {
    const rust = await run({
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
    const rust = await run({
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
    await run({
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
    await run({ source: program('  ok = await until(1 == 1)\n  write graph-[:note]-> { payload: { ok: ok } }') });
    const rust = await run({
      source: program('  subject = "wait"\n  ready = () => {\n    return subject == "go"\n  }\n  await until(ready, every: 2h)\n  write graph-[:note]-> { body: subject }'),
    });
    expect(rust.result?.parkedAddress).toBe('s2');
  });

  it('mints a callback with its captured scope, and reads its id and url', async () => {
    const rust = await run({
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
    await run({
      source: program(
        [
          '  cb = callback((note: <text>) => { write graph-[:note]-> { body: note } })',
          '  cb-[c:Called]-> {',
          '    write graph-[:note]-> { body: "${c.note} at ${c.At}" }',
          '  }',
          '  got = await FIRST(cb-[:Called]->)',
          '  write graph-[:note]-> { body: COALESCE(got.note, "unknown") }',
        ].join('\n'),
      ),
      ledger,
    });
    const rust = await run({
      source: program('  cb = callback()\n  c = await FIRST(cb-[:Called]->)\n  write graph-[:note]-> { body: "continued" }'),
    });
    expect(rust.result?.parkedAddress).toBe('s1');
  });
});

/** The one park a segment left at `address` (or its only one). */
function parkAt(o: Outcome, address?: string): ParkedScopeState {
  const entries = [...o.parks.entries()];
  const found = address !== undefined ? o.parks.get(address) : entries.length === 1 ? entries[0]?.[1] : undefined;
  if (found === undefined) throw new Error(`test: no park at ${address ?? '(the only one)'} among ${entries.map(([a]) => a).join(', ')}`);
  return found.state;
}

/** A case parked, then each step's case run from the sink rows the step
 *  before left. A park is resumed under the pin it was written under, as a
 *  run's is (its code rides in it as written). */
async function parkThenResume(c: Case, steps: Array<(previous: Outcome) => Case>) {
  const parked = await run(c);
  let last = parked;
  for (const step of steps) {
    const next = step(last);
    last = await run({ ...next, rows: next.rows ?? last.rows });
  }
  return { parked, last };
}

describe('parks resumed', () => {
  it('resumes a block’s parked iterations, the last closing the join', async () => {
    const source = program(
      ['  graph-[n:note]-> {', '    await sleep(1h)', '    write graph-[:note]-> { body: "after ${n.`body`}" }', '  }', '  write graph-[:note]-> { body: "done" }'].join('\n'),
    );
    const { parked, last } = await parkThenResume({ source }, [
      (p) => ({ source, resume: parkAt(p, 's0.i0.s0') }),
      (p) => ({ source, resume: parkAt(p, 's0.i1.s0') }),
    ]);
    expect(parked.events.map(([method]) => method)).toContain('recordJoin');
    expect(bodies(last)).toEqual(['after b', 'done']);
  });

  it('resumes a park inside a callee through its call frame', async () => {
    const callee = 'movement wait(t: <text>) {\n  await sleep(1h)\n  write graph-[:note]-> { body: t }\n}\n';
    const source = program('  wait(t: "hi")\n  write graph-[:note]-> { body: "after" }', callee);
    const { last } = await parkThenResume({ source }, [(p) => ({ source, resume: parkAt(p) })]);
    expect(bodies(last)).toEqual(['hi', 'after']);
  });

  it('resumes a collection op’s parked members, in member order', async () => {
    const source = program(
      ['  xs = MAP(["a", "b"], (v) => {', '    await sleep(1h)', '    write graph-[:note]-> { body: "member" }', '    return UPPER(v)', '  })', '  write graph-[:note]-> { body: "done" }'].join('\n'),
    );
    const parked = await run({ source });
    const addresses = [...parked.parks.keys()];
    expect(addresses.length).toBeGreaterThan(0);
    await parkThenResume({ source }, addresses.map((address) => (p: Outcome) => ({ source, resume: parkAt(p, address) })));
  });

  it('resumes an `all`’s parked arm, closing the join with the finished arm’s slot', async () => {
    const source = program(
      ['  r = await parallel([', '    () => { return "now" },', '    () => {', '      await sleep(1h)', '      return "later"', '    },', '  ])', '  write graph-[:note]-> { payload: { r: r } }'].join('\n'),
    );
    const { last } = await parkThenResume({ source }, [(p) => ({ source, resume: parkAt(p) })]);
    expect(last.events.map(([method]) => method)).toContain('collectBranchExports');
  });

  const RACE = program(
    ['  r = await race([', '    () => {', '      await sleep(30d)', '      return "a"', '    },', '    () => { await sleep(1d) },', '  ])', '  write graph-[:note]-> { payload: { r: r } }'].join('\n'),
  );

  it('settles a race on the arm that woke, cancelling the other', async () => {
    const parked = await run({ source: RACE });
    const [first] = [...parked.parks.keys()];
    const { last } = await parkThenResume({ source: RACE }, [(p) => ({ source: RACE, resume: parkAt(p, first) })]);
    expect(last.events.map(([method]) => method)).toContain('cancelSubtrees');
  });

  it('defers a race’s settlement under a batch resume, then settles it once', async () => {
    const parked = await run({ source: RACE });
    const [first] = [...parked.parks.keys()];
    const { last } = await parkThenResume({ source: RACE }, [
      (p) => ({ source: RACE, resume: parkAt(p, first), deferRaceSettlement: true }),
      (p) => {
        // The batch resume settled nothing: it handed the frame back.
        expect(p.result?.deferredRaceFrames).toEqual(['s0']);
        expect(p.events.map(([method]) => method)).not.toContain('cancelSubtrees');
        return { source: RACE, resume: parkAt(p, first), settle: 's0' };
      },
    ]);
    // Settled once: the loser cancelled, the continuation run.
    expect(last.events.filter(([method]) => method === 'cancelSubtrees')).toHaveLength(1);
    expect(last.result?.deferredRaceFrames).toBeUndefined();
  });

  it('re-enters an until that still does not hold, and parks it again', async () => {
    const source = program('  subject = "wait"\n  ready = () => {\n    return subject == "go"\n  }\n  await until(ready, every: 2h)\n  write graph-[:note]-> { body: subject }');
    await parkThenResume({ source }, [(p) => ({ source, resume: parkAt(p), reenter: true })]);
  });

  it('re-enters an await on a callback once it has been called', async () => {
    const source = program('  cb = callback()\n  c = await FIRST(cb-[:Called]->)\n  write graph-[:note]-> { body: "continued" }');
    const ledger = { cb_1: [{ at: '2026-10-05T10:00:00.000Z', values: {} }] };
    const { last } = await parkThenResume({ source }, [(p) => ({ source, resume: parkAt(p), reenter: true, ledger })]);
    expect(bodies(last)).toEqual(['continued']);
  });

  it('runs a fired callback’s body from the state it captured', async () => {
    const source = program(['  greeting = "hello"', '  cb = callback((note: <text>) => { write graph-[:note]-> { body: "${greeting}: ${note}" } })'].join('\n'));
    const minted = await run({ source });
    const [state] = minted.minted;
    if (state === undefined) throw new Error('test: nothing minted');
    const fired = await run({ source, resume: state, fire: { values: { note: 'yes' }, callIndex: 0 } });
    expect(bodies(fired)).toEqual(['hello: yes']);
  });

  it('suspends inside a callee past its statement’s first call: the call frame keeps that call, and the re-entry replays it', async () => {
    const make = 'movement mk(t: <text>) {\n  write graph-[:note]-> { body: t }\n  return UPPER(t)\n}\n';
    const source = program('  x = mk(t: mk(t: "a"))\n  write graph-[:note]-> { body: "end" }', make);
    const { parked, last } = await parkThenResume({ source, suspendAt: ['s0.c0.s1'] }, [(p) => ({ source, resume: parkAt(p), reenter: true })]);
    const [frame] = parkAt(parked).frames ?? [];
    expect(frame).toMatchObject({ kind: 'call', journal: [{ index: 1 }] });
    // Both callees wrote before the suspension; the re-entry writes nothing again.
    expect(bodies(parked)).toEqual(['a', 'A']);
    expect(bodies(last)).toEqual(['end']);
  });

  it('suspends inside a block’s iteration, and re-enters it there', async () => {
    const source = program(['  graph-[n:note]-> {', '    write graph-[:note]-> { body: n.`body` }', '  }', '  write graph-[:note]-> { body: "done" }'].join('\n'));
    await parkThenResume({ source, suspendAt: ['s0.i1.s0'] }, [(p) => ({ source, resume: parkAt(p), reenter: true })]);
  });

  const LANDING = program(['  a = write graph-[:Check]-> { Prompt: "q" }', '  r = await FIRST(a-[:Response]->)', '  write graph-[:note]-> { body: "after" }'].join('\n'));

  it('parks an await on a landing still pending, under the key the adapter names', async () => {
    const rust = await run({ source: LANDING });
    expect(rust.events.map(([method]) => method)).toEqual(['commitAwaitPark']);
    expect(rust.events[0]?.[1]).toContain('"correlationKey":"ck:');
    expect(rust.result?.parkedAddress).toBe('s1');
  });

  it('goes on past a landing that has landed, and past one settled empty', async () => {
    for (const landing of ['landed', 'empty'] as const) {
      const rust = await run({ source: LANDING, landing });
      expect(rust.events).toEqual([]);
      expect(bodies(rust)).toContain('after');
    }
  });

  it('awaits an edge of a record it walked to, asking by that record\'s own id and data', async () => {
    const source = program(['  c = ONLY(graph-[k:Check]->)', '  r = await FIRST(c-[:Response]->)', '  write graph-[:note]-> { payload: { a: r.`Answer` } }'].join('\n'));
    const pending = await run({ source });
    expect(pending.events.map(([method]) => method)).toEqual(['commitAwaitPark']);
    expect(pending.events[0]?.[1]).toContain('"correlationKey":"ck:check-7"');
    expect(pending.awaited).toContainEqual({ recordId: 'check-7', edge: 'Response', headData: { Prompt: 'q' } });
    const landed = await run({ source, landing: 'landed' });
    expect(landed.error).toBeUndefined();
    expect(bodies(landed)).toEqual([undefined]);
    expect(landed.bodies).toEqual([{ payload: { a: true } }]);
  });

  it('re-enters a parked landing await: landed, it goes on; still pending, it parks again', async () => {
    const landed = await parkThenResume({ source: LANDING }, [(p) => ({ source: LANDING, resume: parkAt(p), reenter: true, landing: 'landed' })]);
    expect(bodies(landed.last)).toEqual(['after']);
    const pending = await parkThenResume({ source: LANDING }, [(p) => ({ source: LANDING, resume: parkAt(p), reenter: true })]);
    expect(pending.last.events.map(([method]) => method)).toEqual(['commitAwaitPark']);
  });

});

/** The one park's state, as the sink stored it. */
const stateText = (o: Outcome): string => JSON.stringify([...o.parks.values()].map((p) => p.state));

describe('binding kinds parked and resumed', () => {
  // Each binds a name of one kind, parks with it in scope, and reads it
  // after: the state is written with the kind, and resumes to the write.
  const cases: Array<[string, string[], Record<string, CallbackCall[]> | undefined]> = [
    ['sourcePosition', ['  x = FIRST(graph-[n:note ORDER BY `body`]->)', '  await sleep(1h)', '  write graph-[:note]-> { payload: { b: x.`body` } }'], undefined],
    ['positions', ['  xs = graph-[n:note]-> {', '    return n', '  }', '  await sleep(1h)', '  total = COUNT(xs)', '  write graph-[:note]-> { payload: { n: total } }'], undefined],
    ['recordValue', ['  x = FIRST(graph-[n:note ORDER BY `body`]->)', '  l = [x, x]', '  await sleep(1h)', '  y = FIRST(l)', '  write graph-[:note]-> { payload: { b: y.`body`, n: COUNT(l) } }'], undefined],
    [
      'shapePosition',
      ['  cb = callback((note: <text>) => { write graph-[:note]-> { body: note } })', '  c = await FIRST(cb-[:Called]->)', '  await sleep(1h)', '  write graph-[:note]-> { payload: { b: c.note } }'],
      { cb_1: [{ at: '2026-10-05T10:00:00.000Z', values: { note: 'yes' } }] },
    ],
  ];
  for (const [kind, body, ledger] of cases) {
    it(`parks a ${kind} and resumes it`, async () => {
      const source = program(body.join('\n'));
      const c: Case = { source, ...(ledger !== undefined ? { ledger } : {}) };
      const { parked, last } = await parkThenResume(c, [(p) => ({ ...c, resume: parkAt(p) })]);
      expect(parked.error).toBeUndefined();
      expect(stateText(parked)).toContain(`"kind":"${kind}"`);
      expect([last.error, last.bodies.length]).toEqual([undefined, 1]);
    });
  }
});
