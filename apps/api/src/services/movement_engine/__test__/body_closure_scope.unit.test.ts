// A closure written in a movement BODY holds the scope it was written in by
// REFERENCE, as a JavaScript closure does (and as a file-level closure has
// since B13): a pointer to the live scope, not a snapshot of it.
//
// A park writes each scope ONCE and a closure as its code plus the number of
// its scope. Before, each body closure snapshotted its whole scope — every
// earlier closure with ITS snapshot — so a parked state doubled per closure.
//
// Pinned here: the size of a park grows linearly with the closures a body
// declares; a park inside a closure's call (one that read an outer scope and
// a block scope, one MAP calls, one a `parallel` arm runs) resumes with the
// answers it always gave; a handle a closure and its scope both hold comes
// back as one; and a park written before this (each closure with its full
// snapshot) resumes exactly as it did.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';
import type { ParkedScopeState } from '../serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink } from '../run';
import { makeTestHost } from '../test_host';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000079');
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
    pipelineInputId: 'trigger:manual-body-closure',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-14T09:00:00.000Z' },
    occurredAt: '2026-10-14T09:00:00.000Z',
  };
}

function program(body: string[]): string {
  return `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement recap(go: <runs-[:Invocation]->>) {
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
    // `parallel` is retired under 5: a program that joins with it runs under 4,
    // where it still does (the version loops below pass their own).
    ...(source.includes('await parallel') ? { languageVersion: 4 as const } : {}),
  };
}

/** The join over `arms` under `version`: `parallel` before 5, the MAP that
 *  replaced it from 5. */
const joined = (version: number, arms: string): string =>
  version >= 5 ? `MAP(${arms}, { concurrency: 2 }, (fn) => fn())` : `await parallel(${arms})`;

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

/** The programs that park inside a body closure's call, and what each ends with. */
const SCENARIOS: Record<string, { body: string[]; payload: unknown }> = {
  outerAndBlock: {
    body: [
      '  a = 10',
      '  if (a > 5) {',
      '    b = 3',
      '    f = (n: <number>) => {',
      '      await sleep(1h)',
      '      return n + a + b',
      '    }',
      '    x = f(1)',
      '    write graph-[:note]-> { payload: { x: x } }',
      '  }',
    ],
    payload: { x: 14 },
  },
  map: {
    body: [
      '  k = 100',
      '  f = (n: <number>) => {',
      '    await sleep(1h)',
      '    return n + k',
      '  }',
      '  out = MAP([1, 2], f)',
      '  write graph-[:note]-> { payload: { out: out } }',
    ],
    payload: { out: [101, 102] },
  },
  arm: {
    body: [
      '  k = 7',
      '  f = () => {',
      '    await sleep(1h)',
      '    return k * 2',
      '  }',
      '  r = await parallel([',
      '    () => {',
      '      y = f()',
      '      return y + 1',
      '    }',
      '  ])',
      '  write graph-[:note]-> { payload: { r: r } }',
    ],
    payload: { r: [15] },
  },
  handle: {
    body: [
      '  a = write graph-[:note]-> { body: "one" }',
      '  f = (x: <text>) => {',
      '    await sleep(1h)',
      '    write a { body: x }',
      '    return a.body',
      '  }',
      '  y = f("two")',
      '  write graph-[:note]-> { payload: { seen: CONCAT(y, "/", a.body) } }',
    ],
    payload: { seen: 'two/two' },
  },
};

const FIXTURE = path.join(__dirname, '__fixtures__', 'body_closure_snapshot_parks.json');

/** The parked state of `n` unused body closures, as JSON. */
async function parkedWith(n: number): Promise<string> {
  const parks = makeParkSink();
  const decls = Array.from({ length: n }, (_, i) => `  c${i} = (v: <number>) => v + ${i}`);
  await start(program([...decls, '  await sleep(1h)', '  write graph-[:note]-> { payload: { x: 1 } }']), parks);
  return JSON.stringify([...parks.parks.values()][0]!.state);
}

describe('a body closure holds its scope by reference', () => {
  it('a park writes the scope once, so its size grows linearly with the closures a body declares', async () => {
    const sizes: number[] = [];
    for (const n of [2, 6, 10, 14]) sizes.push((await parkedWith(n)).length);
    // Measured by the snapshot engine: 3,246 B / 58 KB / 935 KB / 15 MB.
    // eslint-disable-next-line no-console
    console.log('parked sizes, 2 / 6 / 10 / 14 body closures:', sizes.join(' / '));
    const steps = sizes.slice(1).map((size, i) => size - sizes[i]!);
    for (const step of steps) expect(Math.abs(step - steps[0]!)).toBeLessThan(64);
    expect(sizes[3]!).toBeLessThan(12_000);
    const fourteen = await parkedWith(14);
    expect(fourteen).toContain('"scope":{"kind":"scopeRef","id":0}');
    expect(fourteen).not.toContain('"kind":"scope",');
  });

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name}: a park inside the closure's call resumes with the answer it always gave`, async () => {
      const parks = makeParkSink();
      const source = program(scenario.body);
      const first = await start(source, parks);
      expect(first.result.parked).toBe(true);
      const parked = JSON.stringify([...parks.parks.values()][0]!.state);
      // The closure names its scope; it carries no copy of it.
      expect(parked).toContain('"captured":{}');
      expect(parked).toMatch(/"scope":\{"kind":"scopeRef"/);
      const { result, kg } = await resumeAll(source, parks);
      expect(result.parked).toBeUndefined();
      expect(payloadOf(kg.creates)).toEqual(scenario.payload);
    });
  }

  it('a handle the closure and its scope both hold is written once, and is one handle after the resume', async () => {
    const parks = makeParkSink();
    const source = program(SCENARIOS.handle!.body);
    await start(source, parks);
    const parked = JSON.stringify([...parks.parks.values()][0]!.state);
    expect(parked.match(/"kind":"handle"/g)).toHaveLength(1);
    const { kg } = await resumeAll(source, parks);
    // The closure's write moved the record the scope's `a` reads.
    expect(kg.updates).toEqual([{ externalId: 'note-1', fields: { body: 'two' } }]);
    expect(payloadOf(kg.creates)).toEqual({ seen: 'two/two' });
  });

  it('a closure made in a MAP member and returned is written with its scope, and runs as a parallel arm after a park', async () => {
    const parks = makeParkSink();
    const source = program([
      '  k = 3',
      '  arms = MAP([1, 2], (n) => {',
      '    m = n * k',
      '    return () => {',
      '      await sleep(1h)',
      '      return m + 1',
      '    }',
      '  })',
      '  r = await parallel(arms)',
      '  write graph-[:note]-> { payload: { r: r } }',
    ]);
    const first = await start(source, parks);
    expect(first.result.parked).toBe(true);
    const parked = [...parks.parks.values()].map((p) => JSON.stringify(p.state)).join('');
    expect(parked).toContain('"kind":"scope",');
    const { result, kg } = await resumeAll(source, parks);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ r: [4, 7] });
  });
});

describe('a parked run sees what an unparked run sees', () => {
  // A MAP member that parks returns closures that write the outer handle; run
  // by `parallel`, they and the scope must hold ONE handle. Before, the park
  // split it, and the scope's `a` read a stale record.
  const body = (park: boolean, version: number): string[] => [
    '  a = write graph-[:note]-> { body: "one" }',
    '  fs = MAP([1, 2], (n) => {',
    ...(park ? ['    await sleep(1h)'] : []),
    '    return () => {',
    '      write a { body: CONCAT("v", n) }',
    '      return a.body',
    '    }',
    '  })',
    `  r = ${joined(version, 'fs')}`,
    '  write graph-[:note]-> { payload: { r: r, after: a.body } }',
  ];

  for (const version of [4, 5]) {
    it(`v${version}: the closures write the outer handle, and the parked run ends as the unparked one`, async () => {
      const run = (source: string, parks: Sink) => {
        const kg = makeKgFake();
        return runMovement({ ...runInput(source, parks, kg), languageVersion: version as never }).then(() => kg);
      };
      const unparkedKg = await run(program(body(false, version)), makeParkSink());
      const unparked = payloadOf(unparkedKg.creates);

      const parks = makeParkSink();
      const source = program(body(true, version));
      const kg0 = await run(source, parks);
      expect(parks.parks.size).toBeGreaterThan(0);
      expect(kg0.creates.find((c) => c.fields.payload !== undefined)).toBeUndefined();
      let last: Awaited<ReturnType<typeof resumeAt>> | undefined;
      for (let guard = 0; parks.parks.size > 0 && guard < 10; guard++) {
        const address = [...parks.parks.keys()].sort()[0]!;
        const park = parks.parks.get(address)!;
        parks.parks.delete(address);
        const kg = makeKgFake();
        const result = await resumeMovement({
          ...runInput(source, parks, kg),
          languageVersion: version as never,
          state: park.state,
          reenter: park.kind !== 'timer',
        });
        last = { result, kg };
      }
      expect(payloadOf(last!.kg.creates)).toEqual(unparked);
      // Which arm's write each arm reads back depends on how the adapter's
      // answers interleave (an extra await in the effect locks flips it), so
      // only the outer read, after both arms, is pinned.
      expect(unparked).toMatchObject({ after: 'v2' });
    });
  }
});

describe('a park written before body closures held their scope (each with its full snapshot)', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<
    string,
    Record<string, { kind: 'timer' | 'await' | 'suspension'; state: ParkedScopeState }>
  >;

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name}: resumes as it did`, async () => {
      // The run up to the park, for the join records a MAP or `parallel`
      // keeps beside it (which hold no closure); the park itself is the old.
      const parks = makeParkSink();
      const source = program(scenario.body);
      await start(source, parks);
      expect([...parks.parks.keys()]).toEqual(Object.keys(fixture[name]!));
      for (const [address, park] of Object.entries(fixture[name]!)) {
        expect(JSON.stringify(park.state)).not.toContain('"scope":');
        parks.parks.set(address, park);
      }
      const { result, kg } = await resumeAll(source, parks);
      expect(result.parked).toBeUndefined();
      expect(payloadOf(kg.creates)).toEqual(scenario.payload);
    });
  }
});

// ── Both engines ──────────────────────────────────────────────────────────────
//
// The Rust engine mirrors all of it: a park written on either engine is the
// same bytes, and resumes on either with the same answer. Under `rust` the
// fallback is `none`, so a run the Rust engine refused fails here rather
// than passing on the TypeScript engine.

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

interface Pinned {
  version?: number;
  /** Library files the program imports, by path. */
  files?: Record<string, { source: string }>;
}

function inputOn(source: string, parks: Sink, kg: ReturnType<typeof makeKgFake>, pin: Pinned) {
  return {
    ...runInput(source, parks, kg),
    ...(pin.version !== undefined ? { languageVersion: pin.version as never } : {}),
    ...(pin.files !== undefined ? { catalog: { ...catalog, files: pin.files } } : {}),
  };
}

async function startOn(engine: Engine, source: string, parks: Sink, pin: Pinned = {}) {
  const kg = makeKgFake();
  const result = await onEngine(engine, () => runMovement(inputOn(source, parks, kg, pin)));
  return { result, kg };
}

/** Resume every parked leaf, first address first, on `engine`; the last
 *  resume's run and writes, and every write made across the resumes. */
async function resumeAllOn(engine: Engine, source: string, parks: Sink, pin: Pinned = {}) {
  let last: { result: MovementRunResult; kg: ReturnType<typeof makeKgFake> } | undefined;
  const updates: Array<{ externalId: string; fields: Record<string, unknown> }> = [];
  const creates: unknown[] = [];
  const resumed: string[] = [];
  for (let guard = 0; parks.parks.size > 0 && guard < 10; guard++) {
    const address = [...parks.parks.keys()].sort()[0]!;
    const park = parks.parks.get(address)!;
    parks.parks.delete(address);
    resumed.push(JSON.stringify({ address, park }));
    const kg = makeKgFake();
    const result = await onEngine(engine, () =>
      resumeMovement({ ...inputOn(source, parks, kg, pin), state: park.state, reenter: park.kind !== 'timer' }),
    );
    updates.push(...kg.updates);
    creates.push(...kg.creates);
    last = { result, kg };
  }
  if (last === undefined) throw new Error('test: nothing parked');
  return { ...last, updates, creates, resumed };
}

/** Everything a run parked: each leaf's state and each branch's export. */
function parkedBytes(parks: Sink): string {
  return JSON.stringify({
    parks: [...parks.parks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    exports: [...parks.exports.entries()].map(([frame, rows]) => [frame, [...rows.entries()]]),
  });
}


/** Each engine parks `source`; then each parked run resumes on each engine.
 *  What was parked is the same bytes whichever engine wrote it — the first
 *  park, every park a resume wrote again, every branch's export — and every
 *  way round ends with the same writes. */
async function acrossEngines(source: string, pin: Pinned = {}) {
  const firstParks: Record<string, string> = {};
  const ends: Record<string, { payload: unknown; updates: unknown; creates: unknown; resumed: string[]; left: string }> = {};
  for (const parkOn of ENGINES) {
    for (const resumeOn of ENGINES) {
      const parks = makeParkSink();
      const first = await startOn(parkOn, source, parks, pin);
      expect(first.result.parked).toBe(true);
      firstParks[parkOn] = parkedBytes(parks);
      const end = await resumeAllOn(resumeOn, source, parks, pin);
      expect(end.result.parked).toBeUndefined();
      ends[`${parkOn}→${resumeOn}`] = { payload: payloadOf(end.kg.creates), updates: end.updates, creates: end.creates, resumed: end.resumed, left: parkedBytes(parks) };
    }
  }
  expect(firstParks.rust).toEqual(firstParks.ts);
  const reference = ends['ts→ts']!;
  for (const [way, end] of Object.entries(ends)) {
    expect({ way, ...end }).toEqual({ way, ...reference });
  }
  return { parked: firstParks.ts!, ...reference };
}

/** The review's probes (plans/…/body-closures-review.md), and what each ends
 *  with on the TypeScript engine. */
const PROBES: Record<string, { body: string[]; payload: unknown; version?: number }> = {
  deepNestTwoParks: {
    body: [
      '  a = 2',
      '  if (a > 1) {',
      '    b = 3',
      '    f = (x: <number>) => {',
      '      await sleep(1h)',
      '      g = (y: <number>) => {',
      '        await sleep(1h)',
      '        return x + y + a + b',
      '      }',
      '      return g(10)',
      '    }',
      '    r = f(1)',
      '    write graph-[:note]-> { payload: { r: r } }',
      '  }',
    ],
    payload: { r: 16 },
  },
  twoClosuresAndHandle: {
    body: [
      '  a = write graph-[:note]-> { body: "one" }',
      '  f = (x: <text>) => {',
      '    write a { body: x }',
      '    return a.body',
      '  }',
      '  g = () => {',
      '    await sleep(1h)',
      '    return a.body',
      '  }',
      '  y = f("two")',
      '  z = g()',
      '  write graph-[:note]-> { payload: { seen: CONCAT(y, "/", z, "/", a.body) } }',
    ],
    payload: { seen: 'two/two/two' },
  },
  recursionParksAtTheBase: {
    body: [
      '  k = 100',
      '  f = (n: <number>): <number> => {',
      '    if (n > 0) {',
      '      x = f(n - 1)',
      '      return x + n',
      '    }',
      '    await sleep(1h)',
      '    return k',
      '  }',
      '  r = f(2)',
      '  write graph-[:note]-> { payload: { r: r } }',
    ],
    payload: { r: 103 },
  },
  laterBindingBeforeTheCall: {
    body: [
      '  k = 1',
      '  f = () => {',
      '    await sleep(1h)',
      '    return k * 10',
      '  }',
      '  later = 2',
      '  r = f()',
      '  write graph-[:note]-> { payload: { r: r, later: later } }',
    ],
    payload: { r: 10, later: 2 },
  },
  mapMembersReturnClosures: {
    body: [
      '  k = 3',
      '  arms = MAP([1, 2], (n) => {',
      '    await sleep(1h)',
      '    m = n * k',
      '    return () => {',
      '      return m + 1',
      '    }',
      '  })',
      '  r = await parallel(arms)',
      '  write graph-[:note]-> { payload: { r: r } }',
    ],
    payload: { r: [4, 7] },
  },
};

describe('both engines: a body closure holds its scope by reference', () => {
  it('a park of 2 / 6 / 10 / 14 body closures is the same bytes on both engines', async () => {
    for (const n of [2, 6, 10, 14]) {
      const decls = Array.from({ length: n }, (_, i) => `  c${i} = (v: <number>) => v + ${i}`);
      const source = program([...decls, '  await sleep(1h)', '  write graph-[:note]-> { payload: { x: 1 } }']);
      const { parked, payload } = await acrossEngines(source);
      expect(payload).toEqual({ x: 1 });
      expect(parked).toContain('"scope":{"kind":"scopeRef","id":0}');
      expect(parked).not.toContain('"kind":"scope",');
    }
  });

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name}: parked on either engine, resumed on either, the same bytes and answer`, async () => {
      const { parked, payload } = await acrossEngines(program(scenario.body));
      expect(parked).toMatch(/"scope":\{"kind":"scopeRef"/);
      expect(payload).toEqual(scenario.payload);
    });
  }

  it('a handle the closure and its scope both hold is one handle, on both engines', async () => {
    const { parked, updates, payload } = await acrossEngines(program(SCENARIOS.handle!.body));
    expect(JSON.parse(parked).parks.map(([, p]: [string, unknown]) => JSON.stringify(p)).join('').match(/"kind":"handle"/g)).toHaveLength(1);
    expect(updates).toEqual([{ externalId: 'note-1', fields: { body: 'two' } }]);
    expect(payload).toEqual({ seen: 'two/two' });
  });

  it('a closure made in a MAP member and returned is written with its scope, and runs as a parallel arm', async () => {
    const source = program([
      '  k = 3',
      '  arms = MAP([1, 2], (n) => {',
      '    m = n * k',
      '    return () => {',
      '      await sleep(1h)',
      '      return m + 1',
      '    }',
      '  })',
      '  r = await parallel(arms)',
      '  write graph-[:note]-> { payload: { r: r } }',
    ]);
    const { parked, payload } = await acrossEngines(source);
    expect(parked).toContain('"kind":"scope",');
    expect(payload).toEqual({ r: [4, 7] });
  });

  for (const version of [4, 5]) {
    it(`v${version}: closures a parked MAP member returned write the outer handle, and every way round ends as the unparked run (M-1)`, async () => {
      const body = (park: boolean): string[] => [
        '  a = write graph-[:note]-> { body: "one" }',
        '  fs = MAP([1, 2], (n) => {',
        ...(park ? ['    await sleep(1h)'] : []),
        '    return () => {',
        '      write a { body: CONCAT("v", n) }',
        '      return a.body',
        '    }',
        '  })',
        `  r = ${joined(version, 'fs')}`,
        '  write graph-[:note]-> { payload: { r: r, after: a.body } }',
      ];
      for (const engine of ENGINES) {
        const { kg } = await startOn(engine, program(body(false)), makeParkSink(), { version });
        expect(payloadOf(kg.creates)).toEqual({ r: ['v1', 'v2'], after: 'v2' });
      }
      const { payload } = await acrossEngines(program(body(true)), { version });
      expect(payload).toEqual({ r: ['v1', 'v2'], after: 'v2' });
    });
  }

  for (const [name, probe] of Object.entries(PROBES)) {
    it(`review probe ${name}: the same bytes and answer every way round`, async () => {
      const { payload } = await acrossEngines(program(probe.body), probe.version !== undefined ? { version: probe.version } : {});
      expect(payload).toEqual(probe.payload);
    });
  }

  it('a park read back with its keys in another order resumes the same on both engines', async () => {
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
          : value;
    const source = program(SCENARIOS.outerAndBlock!.body);
    for (const engine of ENGINES) {
      const parks = makeParkSink();
      await startOn('ts', source, parks);
      for (const [address, park] of parks.parks) parks.parks.set(address, { ...park, state: reversed(park.state) as ParkedScopeState });
      const { kg } = await resumeAllOn(engine, source, parks);
      expect(payloadOf(kg.creates)).toEqual(SCENARIOS.outerAndBlock!.payload);
    }
  });
});

/** `value` with every object's keys sorted, as JSON text. */
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)]))
        : v;
  return JSON.stringify(sorted(value));
}

describe('both engines: a park written before body closures held their scope', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<
    string,
    Record<string, { kind: 'timer' | 'await' | 'suspension'; state: ParkedScopeState }>
  >;

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name}: the old full-snapshot park resumes on either engine as it did`, async () => {
      const ends: unknown[] = [];
      for (const engine of ENGINES) {
        const parks = makeParkSink();
        const source = program(scenario.body);
        await startOn(engine, source, parks);
        for (const [address, park] of Object.entries(fixture[name]!)) parks.parks.set(address, park);
        const end = await resumeAllOn(engine, source, parks);
        expect(payloadOf(end.kg.creates)).toEqual(scenario.payload);
        // The fixture's code trees carry the key order the file was saved
        // in, which a parked closure's code keeps on one engine and not the
        // other — as a jsonb column reorders any object's keys. Everything
        // else is the same, key for key.
        ends.push(canonical({ payload: payloadOf(end.kg.creates), updates: end.updates, resumed: end.resumed.map((r) => JSON.parse(r) as unknown), left: JSON.parse(parkedBytes(parks)) as unknown }));
      }
      expect(ends[1]).toEqual(ends[0]);
    });
  }
});

describe('both engines: a parallel / race arm that names a body closure, and a scope cycle', () => {
  // The Rust engine does not admit a join's receipt written into a field when
  // an arm is a NAME (admit.rs receipt_holder), so the arms write their own
  // answers and the program ends with a marker; every create is compared.
  const done = '  write graph-[:note]-> { payload: { done: 1 } }';
  const cases: Record<string, string[]> = {
    closureBesideInline: [
      '  f = () => {',
      '    await sleep(1h)',
      '    write graph-[:note]-> { body: "f woke" }',
      '    return 1',
      '  }',
      '  await parallel([f, () => { return 2 }])',
      done,
    ],
    twoClosureArms: [
      '  f = () => {',
      '    await sleep(1h)',
      '    write graph-[:note]-> { body: "f" }',
      '    return 1',
      '  }',
      '  g = () => {',
      '    await sleep(2h)',
      '    write graph-[:note]-> { body: "g" }',
      '    return 2',
      '  }',
      '  await parallel([f, g])',
      done,
    ],
    closureArmCapturingHandle: [
      '  a = write graph-[:note]-> { body: "one" }',
      '  f = () => {',
      '    await sleep(1h)',
      '    write graph-[:note]-> { body: a.body }',
      '    return 1',
      '  }',
      '  await parallel([f])',
      done,
    ],
    raceOfClosures: [
      '  f = () => {',
      '    await sleep(1h)',
      '    write graph-[:note]-> { body: "f" }',
      '    return 1',
      '  }',
      '  g = () => {',
      '    await sleep(2h)',
      '    write graph-[:note]-> { body: "g" }',
      '    return 2',
      '  }',
      '  await race([f, g])',
      done,
    ],
    scopeCycleTwo: [
      '  k = 7',
      '  fs = MAP([1], (n) => {',
      '    mk = () => {',
      '      return () => {',
      '        write graph-[:note]-> { payload: { v: n + k } }',
      '        return 0',
      '      }',
      '    }',
      '    g = mk()',
      '    return g',
      '  })',
      '  await sleep(1h)',
      '  await parallel(fs)',
      done,
    ],
    scopeCycleThree: [
      '  k = 7',
      '  fs = MAP([1], (n) => {',
      '    mk = () => {',
      '      mk2 = () => {',
      '        return () => {',
      '          write graph-[:note]-> { payload: { v: n + k } }',
      '          return 0',
      '        }',
      '      }',
      '      h = mk2()',
      '      return h',
      '    }',
      '    g = mk()',
      '    return g',
      '  })',
      '  await sleep(1h)',
      '  await parallel(fs)',
      done,
    ],
  };
  const expectedBodies: Record<string, string[]> = {
    closureBesideInline: ['f woke'],
    twoClosureArms: ['f', 'g'],
    closureArmCapturingHandle: ['one'],
    raceOfClosures: ['f'],
  };
  for (const version of [4, 5]) {
    for (const [name, body] of Object.entries(cases)) {
      it(`v${version} ${name}: the same bytes and answer every way round`, async () => {
        const end = await acrossEngines(program(body.map((line) => line.replace(/await parallel\((.*)\)$/, (_, arms: string) => joined(version, arms)))), { version });
        expect(end.payload).toEqual(name.startsWith('scopeCycle') ? { v: 8 } : { done: 1 });
        const written = (end.creates as Array<{ fields?: Record<string, unknown> }>).flatMap((c) => (c.fields?.body !== undefined ? [c.fields.body as string] : []));
        if (expectedBodies[name] !== undefined) expect(written).toEqual(expectedBodies[name]);
        else expect((end.creates as unknown[]).length).toBeGreaterThan(1);
      }, 30_000);
    }
  }
});

describe('a closure whose scope reaches back to itself resumes', () => {
  // The closure `g` returns is written in a scope whose parent holds `g`: the
  // scopes form a cycle, and building one must not await the other.
  const cycles = (version: number): Record<string, string[]> => ({
    twoScopes: [
      '  k = 7',
      '  fs = MAP([1], (n) => {',
      '    mk = () => {',
      '      return () => n + k',
      '    }',
      '    g = mk()',
      '    return g',
      '  })',
      '  await sleep(1h)',
      `  r = ${joined(version, 'fs')}`,
      '  write graph-[:note]-> { payload: { r: r } }',
    ],
    threeScopes: [
      '  k = 7',
      '  fs = MAP([1], (n) => {',
      '    mk = () => {',
      '      mk2 = () => {',
      '        return () => n + k',
      '      }',
      '      h = mk2()',
      '      return h',
      '    }',
      '    g = mk()',
      '    return g',
      '  })',
      '  await sleep(1h)',
      `  r = ${joined(version, 'fs')}`,
      '  write graph-[:note]-> { payload: { r: r } }',
    ],
  });
  for (const version of [3, 4, 5]) {
    for (const [name, body] of Object.entries(cycles(version))) {
      it(`v${version} ${name}: the resume settles with the answer`, async () => {
        const parks = makeParkSink();
        const source = program(body);
        const kg0 = makeKgFake();
        await runMovement({ ...runInput(source, parks, kg0), languageVersion: version as never });
        expect(parks.parks.size).toBeGreaterThan(0);
        let last: Awaited<ReturnType<typeof resumeAt>> | undefined;
        for (let guard = 0; parks.parks.size > 0 && guard < 10; guard++) {
          const address = [...parks.parks.keys()].sort()[0]!;
          const park = parks.parks.get(address)!;
          parks.parks.delete(address);
          const kg = makeKgFake();
          const result = await resumeMovement({
            ...runInput(source, parks, kg),
            languageVersion: version as never,
            state: park.state,
            reenter: park.kind !== 'timer',
          });
          last = { result, kg };
        }
        expect(payloadOf(last!.kg.creates)).toEqual({ r: [8] });
      }, 15_000);
    }
  }
});

describe('both engines: a receipt of text-returning NAMED arms is a plain value (admit.rs receipt_holder)', () => {
  // `parallel` is retired under 5: the MAP that replaced it, calling each arm.
  const join = (combinator: string, arms: string, version: number): string =>
    combinator === 'parallel' && version >= 5 ? `MAP(${arms}, { concurrency: 2 }, (fn) => fn())` : `await ${combinator}(${arms})`;
  const movementProgram = (combinator: string, sink: string, version: number): string =>
    program([`  r = ${join(combinator, '[one, two]', version)}`, `  write graph-[:note]-> ${sink}`]).replace(
      'movement recap',
      'movement one() {\n  return "a"\n}\nmovement two() {\n  return "b"\n}\nmovement recap',
    );
  const closureProgram = (combinator: string, sink: string, version: number): string =>
    program([
      '  f = () => {',
      '    return "a"',
      '  }',
      '  g = () => {',
      '    return "b"',
      '  }',
      `  r = ${join(combinator, '[f, g]', version)}`,
      `  write graph-[:note]-> ${sink}`,
    ]);
  // Race's winner is the first arm to finish: both finish at once, `f` first.
  const sinks: Record<string, { sink: string; parallel: (c: WriteInput) => unknown; race: (c: WriteInput) => unknown }> = {
    wholeIntoField: { sink: '{ payload: r }', parallel: (c) => c.fields.payload, race: (c) => c.fields.payload },
    inRecord: { sink: '{ payload: { x: r } }', parallel: (c) => c.fields.payload, race: (c) => c.fields.payload },
    atInRecord: { sink: '{ payload: { x: AT(r, 0) } }', parallel: (c) => c.fields.payload, race: (c) => c.fields.payload },
    atIntoBody: { sink: '{ body: COALESCE(AT(r, 0), "z") }', parallel: (c) => c.fields.body, race: (c) => c.fields.body },
  };
  for (const version of [3, 4, 5]) {
    for (const [kind, make] of [['closure', closureProgram], ['movement', movementProgram]] as const) {
      for (const combinator of ['parallel', 'race'] as const) {
        for (const [name, { sink, ...read }] of Object.entries(sinks)) {
          it(`v${version} ${combinator} of named ${kind} arms, ${name}: Rust runs whole and equals the TypeScript`, async () => {
            const wrote: Record<string, unknown> = {};
            for (const engine of ENGINES) {
              const kg = makeKgFake();
              const result = await onEngine(engine, () => runMovement(inputOn(make(combinator, sink, version), makeParkSink(), kg, { version })));
              expect(result.parked).toBeUndefined();
              expect(kg.creates.length).toBe(1);
              wrote[engine] = read[combinator](kg.creates[0]!);
            }
            expect(wrote.rust).toEqual(wrote.ts);
            expect(wrote.ts).not.toBeUndefined();
          }, 30_000);
        }
      }
    }
  }
});

describe('both engines: a closure bound from a call, then called by name (admit.rs Callees::closures_returned)', () => {
  // `h = mk(2)` binds the closure `mk`'s call hands back; `h(1)` calls it in
  // the scope it was written in (mk's call scope, by reference). `mk` is a
  // body closure, a file-level closure, a `function`, a `movement` or a
  // library's function; the closure is called with arguments, twice, in a
  // MAP, from a further call's value; each parks inside the returned
  // closure's call and resumes on either engine. The review found Rust
  // refusing it (`function_call`) where TypeScript ran it (merge 11, item 4).
  const atTop = (top: string[], body: string[]): string => program(body).replace('movement recap', `${top.join('\n')}\nmovement recap`);
  const write = (fields: string): string => `  write graph-[:note]-> { payload: { ${fields} } }`;
  const inner = (park: boolean): string[] =>
    park ? ['    return (b: <number>) => {', '      await sleep(1h)', '      return a + b', '    }'] : ['    return (b: <number>) => a + b'];
  const libraryMk = (park: boolean): Record<string, { source: string }> => ({
    'lib/mk': { source: ['export function mk(a: <number>) {', ...inner(park).map((l) => l.slice(2)), '}'].join('\n') },
  });
  const shapes: Record<
    string,
    { source: (park: boolean) => string; payload: unknown; body?: string; parks?: boolean; files?: (park: boolean) => Record<string, { source: string }> }
  > = {
    fromClosure: {
      source: (park) => program(['  mk = (a: <number>) => {', ...inner(park), '  }', '  h = mk(2)', '  r = h(1)', write('r: r')]),
      payload: { r: 3 },
    },
    fileClosureDirect: {
      source: () => atTop(['f = (b: <number>) => {', '  return b + 2', '}'], ['  r = f(1)', write('r: r')]),
      payload: { r: 3 },
      parks: false,
    },
    fromFileClosure: {
      source: (park) => atTop(['mk = (a: <number>) => {', ...inner(park).map((l) => l.slice(2)), '}'], ['  h = mk(2)', '  r = h(1)', write('r: r')]),
      payload: { r: 3 },
    },
    fromMovement: {
      source: (park) =>
        atTop(['movement mk(a: <number>) {', ...inner(park).map((l) => l.slice(2)), '}'], ['  h = mk(a: 2)', '  r = h(1)', write('r: r')]),
      payload: { r: 3 },
    },
    fromFunction: {
      source: (park) => atTop(['function mk(a: <number>) {', ...inner(park).map((l) => l.slice(2)), '}'], ['  h = mk(2)', '  r = h(1)', write('r: r')]),
      payload: { r: 3 },
    },
    fromLibraryFunction: {
      source: () => program(['  h = mk(2)', '  r = h(1)', write('r: r')]).replace('runs = manual()', 'import { mk } from "lib/mk"\nruns = manual()'),
      files: libraryMk,
      payload: { r: 3 },
    },
    calleeInAnotherCase: {
      source: (park) => program(['  mk = (a: <number>) => {', ...inner(park), '  }', '  h = MK(2)', '  r = h(1)', write('r: r')]),
      payload: { r: 3 },
    },
    intoTextField: {
      source: () => program(['  mk = (a: <number>) => {', '    return (b: <number>) => CONCAT("x", a, b)', '  }', '  h = mk(2)', '  write graph-[:note]-> { body: h(1), payload: { done: 1 } }']),
      payload: { done: 1 },
      body: 'x21',
      parks: false,
    },
    returnsBoundName: {
      source: (park) =>
        program(['  mk = (a: <number>) => {', ...inner(park).map((l) => l.replace('return (b', 'g = (b')), '    return g', '  }', '  h = mk(2)', '  r = h(1)', write('r: r')]),
      payload: { r: 3 },
    },
    chained: {
      source: (park) =>
        program([
          '  mk = (a: <number>) => {',
          '    return (b: <number>) => {',
          ...inner(park).map((l) => `  ${l.replace('(b: <number>)', '(c: <number>)').replace('a + b', 'a + b + c')}`),
          '    }',
          '  }',
          '  h = mk(1)',
          '  k = h(2)',
          '  r = k(3)',
          write('r: r'),
        ]),
      payload: { r: 6 },
    },
    namedArgsAndTwice: {
      source: (park) =>
        program(['  mk = (a: <number>) => {', ...inner(park), '  }', '  h = mk(2)', '  k = mk(a: 10)', '  r = h(b: 1)', '  s = h(5)', '  t = k(1)', write('r: r, s: s, t: t')]),
      payload: { r: 3, s: 7, t: 11 },
    },
    inMap: {
      source: (park) =>
        program(['  mk = (a: <number>) => {', ...inner(park), '  }', '  h = mk(2)', '  out = MAP([1, 2], (x) => {', '    return h(x)', '  })', write('out: out')]),
      payload: { out: [3, 4] },
    },
    namedToMap: {
      source: (park) => program(['  mk = (a: <number>) => {', ...inner(park), '  }', '  h = mk(2)', '  out = MAP([1, 2], h)', write('out: out')]),
      payload: { out: [3, 4] },
    },
    // A closure one level deeper in a library (`mk` hands back a closure that
    // hands back one): read in the library's own file, as its one-level twin.
    libChainPlain: {
      source: (park) =>
        program(['  h = mk(2)', '  k = h(1)', '  r = k(3)', write('r: r')]).replace('runs = manual()', 'import { mk } from "lib/mk"\nruns = manual()'),
      files: (park) => ({
        'lib/mk': {
          source: [
            'export function mk(a: <number>) {',
            '  return (b: <number>) => {',
            '    return (c: <number>) => {',
            ...(park ? ['      await sleep(1h)'] : []),
            '      return a + b + c',
            '    }',
            '  }',
            '}',
          ].join('\n'),
        },
      }),
      payload: { r: 6 },
    },
    fromClosureInClosure: {
      source: (park) =>
        program([
          '  outer = (c: <number>) => {',
          '    mk = (a: <number>) => {',
          ...inner(park).map((l) => `  ${l}`),
          '    }',
          '    h = mk(c)',
          '    return h(1)',
          '  }',
          '  r = outer(2)',
          write('r: r'),
        ]),
      payload: { r: 3 },
    },
  };
  for (const version of [3, 4, 5]) {
    for (const [name, shape] of Object.entries(shapes)) {
      it(`v${version} ${name}: Rust runs whole and equals the TypeScript`, async () => {
        const wrote: Record<string, WriteInput[]> = {};
        for (const engine of ENGINES) {
          const kg = makeKgFake();
          const result = await onEngine(engine, () => runMovement(inputOn(shape.source(false), makeParkSink(), kg, { version, files: shape.files?.(false) })));
          expect({ engine, parked: result.parked, error: (result as { error?: unknown }).error }).toEqual({ engine, parked: undefined, error: undefined });
          wrote[engine] = kg.creates;
        }
        expect(payloadOf(wrote.ts!)).toEqual(shape.payload);
        if (shape.body !== undefined) expect(wrote.ts![0]!.fields.body).toEqual(shape.body);
        expect(wrote.rust).toEqual(wrote.ts);
      }, 30_000);
      if (shape.parks === false) continue;
      it(`v${version} ${name}, parked inside the returned closure's call: the same bytes and answer every way round`, async () => {
        const end = await acrossEngines(shape.source(true), { version, files: shape.files?.(true) });
        expect(end.payload).toEqual(shape.payload);
      }, 60_000);
    }
  }
});

describe('both engines: a library closure two levels deep is read in the library, as one level deep (admit.rs foreign_holders)', () => {
  // `go` is a record. A library `mk` hands back `(b: <record>) => (c) => b`;
  // the main file calls it twice over (`k = h(go)`, `r = k(1)`) and writes `r`
  // into a json field. The innermost closure's `b` is the library's name, so
  // its holder is read there: a record, which the Rust engine refuses by name
  // exactly as it refuses the one-level `(b) => b`. Handing back plain data it
  // is admitted and writes what the TypeScript does.
  const lib = (inner: string[]): Record<string, { source: string }> => ({
    'lib/mk': { source: ['import { manual } from adapters', 'runs = manual()', 'export function mk(a: <number>) {', ...inner, '}'].join('\n') },
  });
  const main = (calls: string[]): string =>
    program([...calls, '  write graph-[:note]-> { payload: { r: r } }']).replace('runs = manual()', 'import { mk } from "lib/mk"\nruns = manual()');
  const chain = (innermost: string): Record<string, { source: string }> =>
    lib(['  return (b: <runs-[:Invocation]->>) => {', `    return (c: <number>) => ${innermost}`, '  }']);
  const oneLevel = (innermost: string): Record<string, { source: string }> => lib([`  return (b: <runs-[:Invocation]->>) => ${innermost}`]);
  const twoCalls = main(['  h = mk(2)', '  k = h(go)', '  r = k(1)']);
  const oneCall = main(['  h = mk(2)', '  r = h(go)']);
  for (const version of [3, 5]) {
    it(`v${version}: the chain and its one-level twin are both refused by name when the closure returns the record`, async () => {
      for (const [source, files] of [
        [twoCalls, chain('b')],
        [oneCall, oneLevel('b')],
      ] as const) {
        await expect(onEngine('rust', () => runMovement(inputOn(source, makeParkSink(), makeKgFake(), { version, files })))).rejects.toThrow('write_field_record');
      }
    }, 60_000);
    it(`v${version}: the chain and its one-level twin are both admitted, and write what the TypeScript does, when the closure returns plain data`, async () => {
      for (const [source, files, payload] of [
        [twoCalls, chain('c + a'), { r: 3 }],
        [oneCall, oneLevel('a'), { r: 2 }],
      ] as const) {
        const wrote: Record<string, WriteInput[]> = {};
        for (const engine of ENGINES) {
          const kg = makeKgFake();
          const result = await onEngine(engine, () => runMovement(inputOn(source, makeParkSink(), kg, { version, files })));
          expect({ engine, parked: result.parked, error: (result as { error?: unknown }).error }).toEqual({ engine, parked: undefined, error: undefined });
          wrote[engine] = kg.creates;
        }
        expect(payloadOf(wrote.ts!)).toEqual(payload);
        expect(wrote.rust).toEqual(wrote.ts);
      }
    }, 60_000);
  }
});
