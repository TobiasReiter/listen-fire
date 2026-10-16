// Closures are values (language version 5, Dancing Wren), but not data: a
// name or parameter whose value is a closure may be called, as TypeScript
// allows, and `all(f, g)` / `race(f, g)` take closures as their arguments. The
// TypeScript engine is the reference the Rust engine is compared against, so
// it runs these forms: a closure holds the scope it is written in by
// REFERENCE, and a park inside one resumes. `all` is the join `parallel` was,
// with MAP's `concurrency` and `onError`.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink } from 'movement-engine/services/movement_engine/run';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000097');
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

function makeKgFake() {
  const creates: WriteInput[] = [];
  const updates: Array<{ externalId: string; fields: Record<string, unknown> }> = [];
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: (): RuntimeCapabilities => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
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
      updates.push({ externalId: input.externalId, fields: input.fields });
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates, updates };
}

const kgSchema: InstanceSchema = {
  positions: { note: { properties: { body: 'text', payload: 'json' }, edges: {} } },
  collections: { note: { target: 'note' } },
  writableRoots: {
    note: { fields: { body: 'text', payload: 'json' }, resultShape: { externalId: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const catalog = staticCatalogSnapshot({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-closure-values',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-14T09:00:00.000Z' },
    occurredAt: '2026-10-14T09:00:00.000Z',
  };
}

function program(body: string[]): string {
  return `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = connect manual
graph = connect kg using kg_cred
function recap(go: <runs-[:Invocation]->>) {
${body.join('\n')}
}
listen to runs {} fire recap
`;
}

/** An in-memory park sink with the durable join semantics the real one has. */
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
  return { sink, parks, exports };
}

type Sink = ReturnType<typeof makeParkSink>;

function runInput(source: string, parks: Sink, kg: ReturnType<typeof makeKgFake>) {
  return {
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'manual') return manualAdapter;
          if (adapterType === KG) return kg.adapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
      park: { sink: parks.sink },
    }),
    dryRun: false,
  };
}

async function start(source: string, parks: Sink) {
  const kg = makeKgFake();
  const result = await runMovement(runInput(source, parks, kg));
  return { result, kg };
}

async function resumeAt(
  source: string,
  parks: Sink,
  address: string,
): Promise<{ result: MovementRunResult; kg: ReturnType<typeof makeKgFake> }> {
  const park = parks.parks.get(address);
  if (park === undefined) throw new Error(`test: nothing parked at '${address}'`);
  parks.parks.delete(address);
  const kg = makeKgFake();
  const result = await resumeMovement({ ...runInput(source, parks, kg), state: park.state, reenter: park.kind !== 'timer' });
  return { result, kg };
}

/** Resume parked leaves, first address first, until none is left (a MAP
 *  member parks after the one before it resumes); the last resume's writes. */
async function resumeAll(source: string, parks: Sink) {
  let last: Awaited<ReturnType<typeof resumeAt>> | undefined;
  for (let guard = 0; parks.parks.size > 0 && guard < 10; guard++) {
    last = await resumeAt(source, parks, [...parks.parks.keys()].sort()[0]!);
  }
  if (last === undefined) throw new Error('test: nothing parked');
  return last;
}

const payloadOf = (creates: WriteInput[]): unknown => creates.find((c) => c.fields.payload !== undefined)?.fields.payload;

/** Run to the end (resuming every park), and the payload written. */
async function finalPayload(body: string[]): Promise<unknown> {
  const parks = makeParkSink();
  const source = program(body);
  const first = await start(source, parks);
  if (first.result.parked !== true) return payloadOf(first.kg.creates);
  const { result, kg } = await resumeAll(source, parks);
  expect(result.parked).toBeUndefined();
  return payloadOf(kg.creates);
}

describe('all — the join that replaces parallel', () => {
  it('answers what each arm returned, in argument order', async () => {
    expect(
      await finalPayload([
        '  k = 7',
        '  r = all(() => { return k }, () => { return k * 2 }, () => 3)',
        '  write graph-[:note]-> { payload: { r: r, second: r[1] } }',
      ]),
    ).toEqual({ r: [7, 14, 3], second: 14 });
  });

  it('a park inside an arm resumes, the arm reading its scope', async () => {
    expect(
      await finalPayload([
        '  k = 3',
        '  r = all(() => {',
        '    await sleep(1h)',
        '    return k + 1',
        '  }, () => { return 10 })',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: [4, 10] });
  });

  it('every arm waiting, at once', async () => {
    const parks = makeParkSink();
    const source = program([
      '  k = 2',
      '  r = all(() => {',
      '    await sleep(1h)',
      '    return k',
      '  }, () => {',
      '    await sleep(2h)',
      '    return k * 10',
      '  })',
      '  write graph-[:note]-> { payload: { r: r } }',
    ]);
    const first = await start(source, parks);
    expect(first.result.parked).toBe(true);
    expect(parks.parks.size).toBe(2);
    const { kg } = await resumeAll(source, parks);
    expect(payloadOf(kg.creates)).toEqual({ r: [2, 20] });
  });

  it('a named closure and a named function are arms', async () => {
    const source = program([
      '  a = () => { return "a" }',
      '  r = all(a, twice)',
      '  write graph-[:note]-> { payload: { r: r } }',
    ]).replace('function recap', 'function twice() {\n  return 2\n}\nfunction recap');
    const parks = makeParkSink();
    const { kg } = await start(source, parks);
    expect(payloadOf(kg.creates)).toEqual({ r: ['a', 2] });
  });

  it('run unbound, for the arms\' effects', async () => {
    const parks = makeParkSink();
    const { kg } = await start(program([
      '  all(() => {',
      '    write graph-[:note]-> { body: "a" }',
      '  }, () => {',
      '    write graph-[:note]-> { body: "b" }',
      '  })',
    ]), parks);
    expect(kg.creates.map((c) => c.fields.body).sort()).toEqual(['a', 'b']);
  });

  it('concurrency: 1 runs one arm at a time, and a parked arm frees its place', async () => {
    const parks = makeParkSink();
    const source = program([
      '  r = all(() => {',
      '    await sleep(1h)',
      '    return "slept"',
      '  }, () => {',
      '    write graph-[:note]-> { body: "second ran" }',
      '    return "ran"',
      '  }, { concurrency: 1 })',
      '  write graph-[:note]-> { payload: { r: r } }',
    ]);
    const first = await start(source, parks);
    // The first arm parked, so the second ran in its place before the park.
    expect(first.result.parked).toBe(true);
    expect(first.kg.creates.map((c) => c.fields.body)).toEqual(['second ran']);
    const { kg } = await resumeAll(source, parks);
    expect(payloadOf(kg.creates)).toEqual({ r: ['slept', 'ran'] });
  });

  it('an arm that fails fails the run by default', async () => {
    const parks = makeParkSink();
    const kg = makeKgFake();
    await expect(
      runMovement(runInput(program(['  r = all(() => { fail("boom") }, () => { return 2 })']), parks, kg)),
    ).rejects.toThrow('boom');
  });

  it('onError: "warn" leaves a failing arm\'s slot null, and says so', async () => {
    const parks = makeParkSink();
    const kg = makeKgFake();
    const result = await runMovement(runInput(program([
      '  r = all(() => { fail("boom") }, () => { return 2 }, { onError: "warn" })',
      '  write graph-[:note]-> { payload: { r: r } }',
    ]), parks, kg));
    expect(payloadOf(kg.creates)).toEqual({ r: [null, 2] });
    expect(JSON.stringify(result.trace)).toContain("'all' left the slot of arm 0 of 2 null, because the arm failed");
  });

  it('onError: "ignore" forgives an arm that fails after it resumed', async () => {
    expect(
      await finalPayload([
        '  r = all(() => {',
        '    await sleep(1h)',
        '    fail("late")',
        '  }, () => { return 2 }, { onError: "ignore" })',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: [null, 2] });
  });
});

describe('race — its arms are arguments', () => {
  it('the first to settle fills its slot', async () => {
    expect(
      await finalPayload([
        '  a = () => { return "a" }',
        '  r = race(a, () => {',
        '    await sleep(1h)',
        '    return "b"',
        '  })',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: ['a', null] });
  });
});

describe('a value that is a closure is called', () => {
  it('a bound closure, with an argument', async () => {
    expect(
      await finalPayload([
        '  k = 10',
        '  inc = (n: <number>) => n + k',
        '  times = (n: <number>) => { return n * k }',
        '  write graph-[:note]-> { payload: { a: inc(2), b: times(2) } }',
      ]),
    ).toEqual({ a: 12, b: 20 });
  });

  it('a function declared with a name, bound to a name', async () => {
    const source = program(['  g = twice', '  x = g(4)', '  write graph-[:note]-> { payload: { x: x } }'])
      .replace('function recap', 'function twice(n: <number>) {\n  return n * 2\n}\nfunction recap');
    const parks = makeParkSink();
    const { kg } = await start(source, parks);
    expect(payloadOf(kg.creates)).toEqual({ x: 8 });
  });

  it('a park inside a closure\'s call resumes, the closure\'s scope by reference', async () => {
    expect(
      await finalPayload([
        '  k = 5',
        '  g = () => {',
        '    await sleep(1h)',
        '    return k + 1',
        '  }',
        '  x = g()',
        '  write graph-[:note]-> { payload: { x: x } }',
      ]),
    ).toEqual({ x: 6 });
  });
});

describe('a closure made by a closure that parked, called after the resume', () => {
  // The closure the maker returns holds the maker's scope by reference, and
  // the value kept across the maker's park must carry it, not take it for the
  // file's scope (which holds none of the movement's bindings).
  it('reads the movement scope it was written under', async () => {
    expect(
      await finalPayload([
        '  a = 3',
        '  mk = (n: <number>) => {',
        '    await sleep(1h)',
        '    return () => { return a + n }',
        '  }',
        '  h = mk(1)',
        '  x = h()',
        '  write graph-[:note]-> { payload: { x: x } }',
      ]),
    ).toEqual({ x: 4 });
  });
});

describe('a closure\'s value flows through every value position, and a call through it runs', () => {
  const FNS = ['function one() {', '  return "one"', '}', 'function pickOne() {', '  return one', '}'].join('\n');
  async function payloadWith(body: string[]): Promise<unknown> {
    const source = program([...body, '  write graph-[:note]-> { payload: { x: x } }']).replace('function recap', `${FNS}\nfunction recap`);
    const parks = makeParkSink();
    const { kg } = await start(source, parks);
    return payloadOf(kg.creates);
  }

  it.each<[string, string[]]>([
    ['a named function bound to a name', ['  g = one', '  x = g()']],
    ['a named function a concise closure returns', ['  mk = () => one', '  h = mk()', '  x = h()']],
    ['a named function a declared function returns', ['  h = pickOne()', '  x = h()']],
  ])('%s', async (_label, body) => {
    expect(await payloadWith(body)).toEqual({ x: 'one' });
  });
});

describe('a parameter of closure type (<(params) => <return>>)', () => {
  const FNS = [
    'function run(h: <(n: <number>) => <number>>) {',
    '  return h(20)',
    '}',
  ].join('\n');
  async function payloadWith(body: string[]): Promise<unknown> {
    const source = program([...body, '  write graph-[:note]-> { payload: { x: x } }']).replace('function recap', `${FNS}\nfunction recap`);
    const parks = makeParkSink();
    const { kg } = await start(source, parks);
    return payloadOf(kg.creates);
  }

  it('a bound closure is passed, and called', async () => {
    expect(await payloadWith(['  inc = (n: <number>) => n + 1', '  x = run(inc)'])).toEqual({ x: 21 });
  });

  it('a closure written in place is the argument, holding its scope', async () => {
    expect(await payloadWith(['  k = 2', '  x = run((n) => n + k)'])).toEqual({ x: 22 });
  });

  it('a closure taking fewer parameters than the type supplies is called, the extra argument dropped', async () => {
    expect(await payloadWith(['  x = run(() => 5)'])).toEqual({ x: 5 });
  });
});

describe('an arrow body that is a combinator (language version 5)', () => {
  it('returns its answer: the race runs, and the closure hands back its receipt', async () => {
    expect(
      await finalPayload(['  g = () => race(() => "first")', '  r = g()', '  write graph-[:note]-> { payload: { r: r } }']),
    ).toEqual({ r: ['first'] });
  });
});

// ── Both engines ──────────────────────────────────────────────────────────────
//
// The Rust engine runs every form above as the TypeScript engine does: the
// same writes, and where a run parks, the same parked bytes whichever engine
// wrote them, resuming on either engine to the same end. Under `rust` the
// fallback is `none`, so a run the Rust engine refused fails here.

type Engine = 'ts' | 'rust';
const ENGINES: Engine[] = ['ts', 'rust'];

async function onEngine<T>(engine: Engine, run: () => Promise<T>): Promise<T> {
  const previous = { engine: process.env.MOVEMENT_ENGINE, fallback: process.env.MOVEMENT_ENGINE_FALLBACK };
  process.env.MOVEMENT_ENGINE = engine;
  if (engine === 'rust') process.env.MOVEMENT_ENGINE_FALLBACK = 'none';
  else delete process.env.MOVEMENT_ENGINE_FALLBACK;
  try {
    return await run();
  } finally {
    if (previous.engine === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous.engine;
    if (previous.fallback === undefined) delete process.env.MOVEMENT_ENGINE_FALLBACK;
    else process.env.MOVEMENT_ENGINE_FALLBACK = previous.fallback;
  }
}

/** Everything a run parked: each leaf's state and each branch's export. */
function parkedBytes(parks: Sink): string {
  return JSON.stringify({
    parks: [...parks.parks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    exports: [...parks.exports.entries()].map(([frame, rows]) => [frame, [...rows.entries()]]),
  });
}

/** `source` started on each engine and, where it parks, resumed on each
 *  engine (each way round from a fresh start, so the sink's joins are the
 *  run's own): the first parks are the same bytes, and every way round ends
 *  with the same writes and leaves the same parks. The TypeScript engine's
 *  end. */
async function acrossEngines(source: string): Promise<{ creates: WriteInput[]; parked: boolean }> {
  const firstParks: Record<string, string> = {};
  const ends: Record<string, { creates: WriteInput[]; left: string }> = {};
  let parked = false;
  for (const parkOn of ENGINES) {
    for (const resumeOn of ENGINES) {
      const parks = makeParkSink();
      const first = await onEngine(parkOn, () => start(source, parks));
      firstParks[parkOn] = parkedBytes(parks);
      parked = first.result.parked === true;
      const creates: WriteInput[] = [...first.kg.creates];
      for (let guard = 0; parked && parks.parks.size > 0 && guard < 10; guard++) {
        const address = [...parks.parks.keys()].sort()[0]!;
        const { kg } = await onEngine(resumeOn, () => resumeAt(source, parks, address));
        creates.push(...kg.creates);
      }
      ends[`${parkOn}→${resumeOn}`] = { creates, left: parkedBytes(parks) };
    }
  }
  expect(firstParks.rust).toEqual(firstParks.ts);
  const reference = ends['ts→ts']!;
  for (const [way, end] of Object.entries(ends)) expect({ way, ...end }).toEqual({ way, ...reference });
  return { creates: reference.creates, parked };
}

describe('both engines: closures as values (version 5)', () => {
  const TOP = [
    'function one() {',
    '  return "one"',
    '}',
    'function pickOne() {',
    '  return one',
    '}',
    'function twice() {',
    '  return 2',
    '}',
    'function run(h: <(n: <number>) => <number>>) {',
    '  return h(20)',
    '}',
  ].join('\n');
  const withTop = (body: string[]): string => program(body).replace('function recap', `${TOP}\nfunction recap`);
  const write = (fields: string): string => `  write graph-[:note]-> { payload: { ${fields} } }`;
  const CASES: Record<string, { body: string[]; payload: unknown }> = {
    allJoin: { body: ['  k = 7', '  r = all(() => { return k }, () => { return k * 2 }, () => 3)', write('r: r, second: r[1]')], payload: { r: [7, 14, 3], second: 14 } },
    allArmParks: {
      body: ['  k = 3', '  r = all(() => {', '    await sleep(1h)', '    return k + 1', '  }, () => { return 10 })', write('r: r')],
      payload: { r: [4, 10] },
    },
    everyArmWaiting: {
      body: ['  k = 2', '  r = all(() => {', '    await sleep(1h)', '    return k', '  }, () => {', '    await sleep(2h)', '    return k * 10', '  })', write('r: r')],
      payload: { r: [2, 20] },
    },
    namedArms: { body: ['  a = () => { return "a" }', '  r = all(a, twice)', write('r: r')], payload: { r: ['a', 2] } },
    concurrencyOneWithAParkedArm: {
      body: [
        '  r = all(() => {',
        '    await sleep(1h)',
        '    return "slept"',
        '  }, () => {',
        '    write graph-[:note]-> { body: "second ran" }',
        '    return "ran"',
        '  }, { concurrency: 1 })',
        write('r: r'),
      ],
      payload: { r: ['slept', 'ran'] },
    },
    onErrorWarn: { body: ['  r = all(() => { fail("boom") }, () => { return 2 }, { onError: "warn" })', write('r: r')], payload: { r: [null, 2] } },
    onErrorIgnoreAfterResume: {
      body: ['  r = all(() => {', '    await sleep(1h)', '    fail("late")', '  }, () => { return 2 }, { onError: "ignore" })', write('r: r')],
      payload: { r: [null, 2] },
    },
    onErrorWarnAfterResume: {
      body: ['  r = all(() => {', '    await sleep(1h)', '    fail("late")', '  }, () => { return 2 }, { onError: "warn" })', write('r: r')],
      payload: { r: [null, 2] },
    },
    raceArguments: {
      body: ['  a = () => { return "a" }', '  r = race(a, () => {', '    await sleep(1h)', '    return "b"', '  })', write('r: r')],
      payload: { r: ['a', null] },
    },
    closureFromParkedMaker: {
      body: ['  a = 3', '  mk = (n: <number>) => {', '    await sleep(1h)', '    return () => { return a + n }', '  }', '  h = mk(1)', '  x = h()', write('x: x')],
      payload: { x: 4 },
    },
    namedFunctionBound: { body: ['  g = one', '  x = g()', write('x: x')], payload: { x: 'one' } },
    namedFunctionFromConcise: { body: ['  mk = () => one', '  h = mk()', '  x = h()', write('x: x')], payload: { x: 'one' } },
    namedFunctionReturned: { body: ['  h = pickOne()', '  x = h()', write('x: x')], payload: { x: 'one' } },
    closureInPlaceArgument: { body: ['  k = 2', '  x = run((n) => n + k)', write('x: x')], payload: { x: 22 } },
    extraArgumentDropped: { body: ['  x = run(() => 5)', write('x: x')], payload: { x: 5 } },
    combinatorArrowBody: { body: ['  g = () => race(() => "first")', '  r = g()', write('r: r')], payload: { r: ['first'] } },
    effectsOnly: {
      body: ['  all(() => {', '    write graph-[:note]-> { body: "a" }', '  }, () => {', '    write graph-[:note]-> { body: "b" }', '  })', write('done: 1')],
      payload: { done: 1 },
    },
  };
  for (const [name, { body, payload }] of Object.entries(CASES)) {
    it(`${name}: the same writes, and the same parks, on both engines`, async () => {
      const { creates } = await acrossEngines(withTop(body));
      expect(payloadOf(creates)).toEqual(payload);
    }, 30_000);
  }

  it('an arm onError: "warn" forgives leaves the same trace on both engines', async () => {
    const source = withTop(['  r = all(() => { fail("boom") }, () => { return 2 }, { onError: "warn" })', write('r: r')]);
    const traces: unknown[] = [];
    for (const engine of ENGINES) traces.push(await onEngine(engine, async () => (await start(source, makeParkSink())).result.trace));
    expect(JSON.stringify(traces[1])).toEqual(JSON.stringify(traces[0]));
    expect(JSON.stringify(traces[0])).toContain("'all' left the slot of arm 0 of 2 null, because the arm failed");
  });

  it('an arm that fails fails the run on both engines, with the same error', async () => {
    const source = withTop(['  r = all(() => { fail("boom") }, () => { return 2 })', write('r: r')]);
    const errors: string[] = [];
    for (const engine of ENGINES) errors.push(await onEngine(engine, () => start(source, makeParkSink()).then(() => 'no error', (e: unknown) => String(e))));
    expect(errors[1]).toEqual(errors[0]);
    expect(errors[0]).toContain('boom');
  });
});
