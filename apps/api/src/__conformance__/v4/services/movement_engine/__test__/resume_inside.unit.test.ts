// Resuming a run parked INSIDE something: a collection op's member, a called
// movement / function / closure (however deep), a call hoisted out of an
// expression, and a `parallel` / `race` arm (literal or built at run time).
//
// Two kinds of park drive it:
//   · an ENGINE suspension (`suspendWhen` → `suspendFlow`): the flow parks just
//     before a statement — or just before one of the calls a statement makes —
//     and resume re-runs that statement, replaying the calls it had finished;
//   · an AUTHORED wait (`await sleep(…)`, `await FIRST(cb-[:Called]->)`),
//     which language version 3 allows inside members and called bodies.
//
// What is pinned: the parked leaf's address names the way back in (`c k` for
// the k-th call a statement made, `i j` for a member under it), resume re-enters
// exactly there, what the leaf's body returns flows back out through every call
// and into the statement that made it, a member's answer joins the op in member
// order, nothing that finished before the park runs again, and resuming one
// leaf leaves the others parked. A state written before these steps existed
// still resumes.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CallbackSink } from '../callback_sink';
import type { CallbackCall } from '../callback_store';
import type { ParkedScopeState } from '../serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import {
  resumeMovement,
  runMovement,
  type MovementRunResult,
  type ParkSink,
  type SuspensionPoint,
} from '../run';

const TEAM_ID = '00000000-0000-0000-0000-000000000077' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

function makeKgFake() {
  const creates: WriteInput[] = [];
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
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
    async createRecord(write) {
      creates.push(write);
      return { adapterType: KG, externalId: `note-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const kgSchema: InstanceSchema = {
  positions: { note: { properties: { body: 'text', payload: 'json' }, edges: {} } },
  collections: { note: { target: 'note' } },
  writableRoots: {
    note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-resume-inside',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-05T09:00:00.000Z' },
    occurredAt: '2026-10-05T09:00:00.000Z',
  };
}

const PRELUDE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
`;

function program(fileLevel: string, body: string): string {
  return `${PRELUDE}${fileLevel}movement recap(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire recap
`;
}

/**
 * An in-memory park sink with the durable join semantics the real one has
 * (`join_pending.ts`): a frame's pending count, one decrement per branch, the
 * closer identified, and every branch's export kept by frame.
 */
function makeParkSink() {
  const parks = new Map<string, { kind: 'timer' | 'await' | 'suspension'; state: ParkedScopeState }>();
  const joins = new Map<string, { pending: number; closedBy: string | null; decremented: Set<string> }>();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const recorded: Array<{ frameAddress: string; parkedChildren: number }> = [];
  const keep = (kind: 'timer' | 'await' | 'suspension', address: string, state: unknown): void => {
    // As the DB would hand it back.
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as ParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin(input) {
      recorded.push(input);
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
    async cancelSubtrees(input) {
      const under = (address: string): boolean =>
        input.subtreeAddresses.some((p) => address === p || address.startsWith(`${p}.`));
      for (const address of [...parks.keys()]) {
        if (under(address) && address !== input.excludeLeaf) parks.delete(address);
      }
    },
  };
  return { sink, parks, joins, recorded };
}

type Sink = ReturnType<typeof makeParkSink>;

/** A fake callback store: a ledger the test fills, as a platform reply would. */
function makeCallbackSink() {
  const ledger: Record<string, CallbackCall[]> = {};
  let n = 0;
  const sink: CallbackSink = {
    async mint() {
      const id = `cb_${++n}`;
      return { id, url: `https://api.test/api/cb/${id}` };
    },
    async calls(callbackId) {
      return ledger[callbackId] ?? [];
    },
    async correlateAwait() {},
  };
  return { sink, ledger };
}

interface Harness {
  source: string;
  parks: Sink;
  callbacks?: ReturnType<typeof makeCallbackSink>;
}

function runInput(h: Harness, kg: ReturnType<typeof makeKgFake>) {
  return {
    source: h.source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return kg.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    parkSink: h.parks.sink,
    ...(h.callbacks !== undefined ? { callbackSink: h.callbacks.sink } : {}),
    dryRun: false,
  };
}

/** Run until it parks, suspending (once each) at the given points. */
async function start(h: Harness, suspendAt: string[] = []) {
  const kg = makeKgFake();
  const pending = new Set(suspendAt);
  const points: SuspensionPoint[] = [];
  const result = await runMovement({
    ...runInput(h, kg),
    suspendWhen: (point) => {
      points.push(point);
      return pending.delete(point.address);
    },
  });
  return { result, kg, points };
}

/** Resume the leaf parked at `address` — re-entering it, as an await / a
 *  suspension resumes; stepping past it, as a sleep does. */
async function resumeAt(h: Harness, address: string): Promise<{ result: MovementRunResult; kg: ReturnType<typeof makeKgFake> }> {
  const park = h.parks.parks.get(address);
  if (park === undefined) throw new Error(`test: nothing parked at '${address}' (have ${[...h.parks.parks.keys()].join(', ')})`);
  h.parks.parks.delete(address);
  const kg = makeKgFake();
  const result = await resumeMovement({
    ...runInput(h, kg),
    state: park.state,
    reenter: park.kind !== 'timer',
  });
  return { result, kg };
}

const bodies = (creates: WriteInput[]): unknown[] => creates.map((c) => c.fields.body);
const payloadOf = (creates: WriteInput[]): unknown => creates.find((c) => c.fields.payload !== undefined)?.fields.payload;

describe('an engine suspension inside a MAP member', () => {
  const source = program(
    '',
    [
      '  xs = [1, 2, 3, 4]',
      '  out = MAP(xs, { concurrency: 2 }, (n) => {',
      '    write graph-[:note]-> { body: "member ${n}" }',
      '    return n * 10',
      '  })',
      '  write graph-[:note]-> { payload: { out: out } }',
    ].join('\n'),
  );

  it("parks member 1 at its own address while the others finish, and keeps their answers", async () => {
    const h: Harness = { source, parks: makeParkSink() };
    const { result, kg } = await start(h, ['s1.c0.i1.s0']);

    expect(result.parked).toBe(true);
    expect([...h.parks.parks.keys()]).toEqual(['s1.c0.i1.s0']);
    // Member 1 parked before its write; 0, 2 and 3 ran (two slots, one held).
    expect(bodies(kg.creates).sort()).toEqual(['member 1', 'member 3', 'member 4']);
    // The op is a join pending its one parked member.
    expect(h.parks.recorded).toEqual([{ frameAddress: 's1.c0', parkedChildren: 1 }]);
    const state = h.parks.parks.get('s1.c0.i1.s0')!.state;
    expect(state.frames?.map((f) => f.kind)).toEqual(['member']);
  });

  it('resumes the member, assembles the answer in member order, and runs on — nothing twice', async () => {
    const h: Harness = { source, parks: makeParkSink() };
    await start(h, ['s1.c0.i1.s0']);
    const { result, kg } = await resumeAt(h, 's1.c0.i1.s0');

    expect(result.parked).toBeUndefined();
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['member 2']);
    expect(payloadOf(kg.creates)).toEqual({ out: [10, 20, 30, 40] });
  });

  it('the members never started run once the parked ones finish (one slot)', async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  out = MAP([1, 2, 3], (n) => {',
          '    write graph-[:note]-> { body: "member ${n}" }',
          '    return n + 100',
          '  })',
          '  write graph-[:note]-> { payload: { out: out } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    const first = await start(h, ['s0.c0.i1.s0']);
    // One slot: member 0 ran, member 1 parked, member 2 never started.
    expect(bodies(first.kg.creates)).toEqual(['member 1']);

    const { result, kg } = await resumeAt(h, 's0.c0.i1.s0');
    expect(result.parked).toBeUndefined();
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['member 2', 'member 3']);
    expect(payloadOf(kg.creates)).toEqual({ out: [101, 102, 103] });
  });

  it('REDUCE carries the parked member’s answer into the members after it', async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  total = REDUCE([1, 2, 3], 0, (sum, n) => {',
          '    return sum + n',
          '  })',
          '  write graph-[:note]-> { payload: { total: total } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    await start(h, ['s0.c0.i1.s0']);
    const { kg } = await resumeAt(h, 's0.c0.i1.s0');
    expect(payloadOf(kg.creates)).toEqual({ total: 6 });
  });

  it("onError: a resumed member that fails is left out, as when nothing parked", async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  out = MAP([1, 0, 2], { onError: "ignore" }, (n) => {',
          '    return ONLY([])',
          '  })',
          '  write graph-[:note]-> { payload: { n: COUNT(out) } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    await start(h, ['s0.c0.i1.s0']);
    const { result, kg } = await resumeAt(h, 's0.c0.i1.s0');
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ n: 0 });
  });
});

describe('an engine suspension inside called bodies', () => {
  const FUNCTIONS = `movement inner(n: <number>) {
  write graph-[:note]-> { body: "inner before ${'$'}{n}" }
  m = n + 1
  write graph-[:note]-> { body: "inner after ${'$'}{m}" }
  return m * 2
}
movement outer(n: <number>) {
  write graph-[:note]-> { body: "outer before" }
  y = inner(n: n)
  write graph-[:note]-> { body: "outer after ${'$'}{y}" }
  return y + 1
}
`;

  it('two calls deep: parks at s0.c0.s1.c0.s1 and finishes every body outward', async () => {
    const h: Harness = {
      source: program(FUNCTIONS, '  x = outer(n: 4)\n  write graph-[:note]-> { payload: { x: x } }'),
      parks: makeParkSink(),
    };
    const first = await start(h, ['s0.c0.s1.c0.s1']);
    expect(first.result.parked).toBe(true);
    expect(bodies(first.kg.creates)).toEqual(['outer before', 'inner before 4']);
    const state = h.parks.parks.get('s0.c0.s1.c0.s1')!.state;
    expect(state.frames?.map((f) => f.kind)).toEqual(['call', 'call']);

    const { result, kg } = await resumeAt(h, 's0.c0.s1.c0.s1');
    expect(result.parked).toBeUndefined();
    // inner's rest, outer's rest, the dispatched movement's rest — once each.
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['inner after 5', 'outer after 10']);
    expect(payloadOf(kg.creates)).toEqual({ x: 11 });
  });

  it('a closure called by name', async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  base = 5',
          '  f = (n: <number>) => {',
          '    write graph-[:note]-> { body: "f before" }',
          '    return n + base',
          '  }',
          '  y = f(2)',
          '  write graph-[:note]-> { payload: { y: y } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    await start(h, ['s2.c0.s1']);
    expect([...h.parks.parks.keys()]).toEqual(['s2.c0.s1']);
    const { kg } = await resumeAt(h, 's2.c0.s1');
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual([]);
    expect(payloadOf(kg.creates)).toEqual({ y: 7 });
  });

  it('a call hoisted out of an expression: the calls before it are replayed, not made again', async () => {
    const h: Harness = {
      source: program(
        `movement mark(t: <text>) {
  write graph-[:note]-> { body: t }
  return t
}
`,
        '  x = CONCAT(mark(t: "a"), mark(t: "b"), mark(t: "c"))\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    // Suspend inside the SECOND hoisted call's body, before its write.
    const first = await start(h, ['s0.c1.s0']);
    expect(bodies(first.kg.creates)).toEqual(['a']);

    const { result, kg } = await resumeAt(h, 's0.c1.s0');
    expect(result.parked).toBeUndefined();
    // "a" is not written again; "b" finishes, "c" runs fresh.
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['b', 'c']);
    expect(payloadOf(kg.creates)).toEqual({ x: 'abc' });
  });

  it('a suspension just before a call re-runs the statement from that call', async () => {
    const h: Harness = {
      source: program(
        `movement mark(t: <text>) {
  write graph-[:note]-> { body: t }
  return t
}
`,
        '  x = CONCAT(mark(t: "a"), mark(t: "b"))\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    const first = await start(h, ['s0.c1']);
    expect(bodies(first.kg.creates)).toEqual(['a']);
    const state = h.parks.parks.get('s0')!.state;
    expect(state.suspended).toBe(true);
    expect(state.journal?.map((e) => e.index)).toEqual([0]);

    const { kg } = await resumeAt(h, 's0');
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['b']);
    expect(payloadOf(kg.creates)).toEqual({ x: 'ab' });
  });
});

describe('an engine suspension inside parallel / race arms', () => {
  it('a literal parallel arm: the other arm completes, the receipt holds both slots', async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  r = await parallel([',
          '    () => {',
          '      write graph-[:note]-> { body: "arm 0" }',
          '      return 1',
          '    },',
          '    () => {',
          '      write graph-[:note]-> { body: "arm 1" }',
          '      return 2',
          '    }',
          '  ])',
          '  write graph-[:note]-> { payload: { r: r } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    const first = await start(h, ['s0.b1.s0']);
    expect(bodies(first.kg.creates)).toEqual(['arm 0']);
    const { result, kg } = await resumeAt(h, 's0.b1.s0');
    expect(result.parked).toBeUndefined();
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['arm 1']);
    expect(payloadOf(kg.creates)).toEqual({ r: [1, 2] });
  });

  it('an arm built at run time carries its body in the park', async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  arms = MAP([1, 2], (n) => {',
          '    return () => {',
          '      write graph-[:note]-> { body: "arm ${n}" }',
          '      return n * 5',
          '    }',
          '  })',
          '  r = await parallel(arms)',
          '  write graph-[:note]-> { payload: { r: r } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    const first = await start(h, ['s1.b1.s0']);
    expect(bodies(first.kg.creates)).toEqual(['arm 1']);
    const state = h.parks.parks.get('s1.b1.s0')!.state;
    expect(state.frames?.map((f) => f.kind)).toEqual(['arm']);
    const { kg } = await resumeAt(h, 's1.b1.s0');
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['arm 2']);
    expect(payloadOf(kg.creates)).toEqual({ r: [5, 10] });
  });

  it('a call inside a race arm: the arm resumes inside the callee and wins', async () => {
    const h: Harness = {
      source: program(
        `movement slow(n: <number>) {
  write graph-[:note]-> { body: "slow ${'$'}{n}" }
  return n
}
`,
        [
          '  r = await race([',
          '    () => {',
          '      v = slow(n: 3)',
          '      return v',
          '    }',
          '  ])',
          '  write graph-[:note]-> { payload: { r: r } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    await start(h, ['s0.b0.s0.c0.s0']);
    const { result, kg } = await resumeAt(h, 's0.b0.s0.c0.s0');
    expect(result.parked).toBeUndefined();
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['slow 3']);
    expect(payloadOf(kg.creates)).toEqual({ r: [3] });
  });
});

describe('authored waits (language version 3)', () => {
  it('`await sleep` in every member of a MAP with concurrency 3: each member parks on its own', async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  out = MAP(["a", "b", "c"], { concurrency: 3 }, (t) => {',
          '    write graph-[:note]-> { body: "asked ${t}" }',
          '    await sleep(1d)',
          '    write graph-[:note]-> { body: "answered ${t}" }',
          '    return UPPER(t)',
          '  })',
          '  write graph-[:note]-> { payload: { out: out } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    const first = await start(h);
    expect(first.result.parked).toBe(true);
    expect([...h.parks.parks.keys()].sort()).toEqual(['s0.c0.i0.s1', 's0.c0.i1.s1', 's0.c0.i2.s1']);
    expect(h.parks.recorded).toEqual([{ frameAddress: 's0.c0', parkedChildren: 3 }]);

    // One member's wait ends: only that member goes on; the run stays parked.
    const one = await resumeAt(h, 's0.c0.i1.s1');
    expect(one.result.parked).toBeUndefined();
    expect(bodies(one.kg.creates)).toEqual(['answered b']);
    expect([...h.parks.parks.keys()].sort()).toEqual(['s0.c0.i0.s1', 's0.c0.i2.s1']);

    const two = await resumeAt(h, 's0.c0.i2.s1');
    expect(bodies(two.kg.creates)).toEqual(['answered c']);

    // The last one closes the op: the answer is in member order.
    const last = await resumeAt(h, 's0.c0.i0.s1');
    expect(bodies(last.kg.creates).filter((b) => b !== undefined)).toEqual(['answered a']);
    expect(payloadOf(last.kg.creates)).toEqual({ out: ['A', 'B', 'C'] });
  });

  it('awaiting a reply in each member: resuming one member never disturbs the others', async () => {
    const callbacks = makeCallbackSink();
    const h: Harness = {
      source: program(
        '',
        [
          '  cb = callback((verdict: <text>) => {})',
          '  out = MAP(["x", "y"], { concurrency: 2 }, (t) => {',
          '    reply = await FIRST(cb-[:Called]->)',
          '    write graph-[:note]-> { body: "${t}: ${reply.verdict}" }',
          '    return t',
          '  })',
          '  write graph-[:note]-> { payload: { out: out } }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
      callbacks,
    };
    const first = await start(h);
    expect([...h.parks.parks.keys()].sort()).toEqual(['s1.c0.i0.s0', 's1.c0.i1.s0']);

    callbacks.ledger.cb_1 = [{ at: '2026-10-05T10:00:00.000Z', values: { verdict: 'yes' } }];
    const y = await resumeAt(h, 's1.c0.i1.s0');
    expect(bodies(y.kg.creates)).toEqual(['y: yes']);
    expect([...h.parks.parks.keys()]).toEqual(['s1.c0.i0.s0']);

    const x = await resumeAt(h, 's1.c0.i0.s0');
    expect(bodies(x.kg.creates).filter((b) => b !== undefined)).toEqual(['x: yes']);
    expect(payloadOf(x.kg.creates)).toEqual({ out: ['x', 'y'] });
  });

  it('`await sleep` in a movement called two calls deep', async () => {
    const h: Harness = {
      source: program(
        `movement inner(n: <number>) {
  await sleep(1h)
  write graph-[:note]-> { body: "woke ${'$'}{n}" }
  return n * 3
}
movement outer(n: <number>) {
  y = inner(n: n)
  return y + 1
}
`,
        '  x = outer(n: 2)\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    const first = await start(h);
    expect([...h.parks.parks.keys()]).toEqual(['s0.c0.s0.c0.s0']);
    expect(first.kg.creates).toEqual([]);

    const { result, kg } = await resumeAt(h, 's0.c0.s0.c0.s0');
    expect(result.parked).toBeUndefined();
    expect(bodies(kg.creates).filter((b) => b !== undefined)).toEqual(['woke 2']);
    expect(payloadOf(kg.creates)).toEqual({ x: 7 });
  });

  it('a second wait in the same callee re-parks with the call frames intact', async () => {
    const h: Harness = {
      source: program(
        `movement twice(n: <number>) {
  await sleep(1h)
  write graph-[:note]-> { body: "one" }
  await sleep(1h)
  write graph-[:note]-> { body: "two" }
  return n
}
`,
        '  x = twice(n: 9)\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    await start(h);
    const one = await resumeAt(h, 's0.c0.s0');
    expect(one.result.parked).toBe(true);
    expect([...h.parks.parks.keys()]).toEqual(['s0.c0.s2']);
    expect(h.parks.parks.get('s0.c0.s2')!.state.frames?.map((f) => f.kind)).toEqual(['call']);

    const two = await resumeAt(h, 's0.c0.s2');
    expect(bodies(two.kg.creates).filter((b) => b !== undefined)).toEqual(['two']);
    expect(payloadOf(two.kg.creates)).toEqual({ x: 9 });
  });
});

describe('a state written before body steps existed', () => {
  // `parked_run.state` as a park at a root-level sleep wrote it before this
  // change: no `frames`, no `journal`, an address of `stmt` steps only.
  const OLD_STATE: ParkedScopeState = {
    version: 1,
    address: 's1',
    bindingName: null,
    scopeChain: [
      { bindings: {} },
      { bindings: { go: { kind: 'event' }, greeting: { kind: 'value', value: 'hello' } } },
    ],
  };

  it('still resumes, stepping past the sleep with its scope restored', async () => {
    const h: Harness = {
      source: program(
        '',
        [
          '  greeting = "hello"',
          '  await sleep(1h)',
          '  write graph-[:note]-> { body: "${greeting} again" }',
        ].join('\n'),
      ),
      parks: makeParkSink(),
    };
    h.parks.parks.set('s1', { kind: 'timer', state: OLD_STATE });
    const { result, kg } = await resumeAt(h, 's1');
    expect(result.parked).toBeUndefined();
    expect(bodies(kg.creates)).toEqual(['hello again']);
  });
});
