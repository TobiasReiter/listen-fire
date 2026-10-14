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
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ParkedScopeState } from '../serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink } from '../run';

const TEAM_ID = '00000000-0000-0000-0000-000000000079' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

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

const catalog = staticCatalogFromManifests({
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
  return { sink, parks };
}

type Sink = ReturnType<typeof makeParkSink>;

function runInput(source: string, parks: Sink, kg: ReturnType<typeof makeKgFake>) {
  return {
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return kg.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    parkSink: parks.sink,
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
  const body = (park: boolean): string[] => [
    '  a = write graph-[:note]-> { body: "one" }',
    '  fs = MAP([1, 2], (n) => {',
    ...(park ? ['    await sleep(1h)'] : []),
    '    return () => {',
    '      write a { body: CONCAT("v", n) }',
    '      return a.body',
    '    }',
    '  })',
    '  r = await parallel(fs)',
    '  write graph-[:note]-> { payload: { r: r, after: a.body } }',
  ];

  for (const version of [4, 5]) {
    it(`v${version}: the closures write the outer handle, and the parked run ends as the unparked one`, async () => {
      const run = (source: string, parks: Sink) => {
        const kg = makeKgFake();
        return runMovement({ ...runInput(source, parks, kg), languageVersion: version as never }).then(() => kg);
      };
      const unparkedKg = await run(program(body(false)), makeParkSink());
      const unparked = payloadOf(unparkedKg.creates);

      const parks = makeParkSink();
      const source = program(body(true));
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
      // The order inside `r` is the adapter's timing; the final read is not.
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

describe('a closure whose scope reaches back to itself resumes', () => {
  // The closure `g` returns is written in a scope whose parent holds `g`: the
  // scopes form a cycle, and building one must not await the other.
  const cycles: Record<string, string[]> = {
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
      '  r = await parallel(fs)',
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
      '  r = await parallel(fs)',
      '  write graph-[:note]-> { payload: { r: r } }',
    ],
  };
  for (const version of [3, 4, 5]) {
    for (const [name, body] of Object.entries(cycles)) {
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
