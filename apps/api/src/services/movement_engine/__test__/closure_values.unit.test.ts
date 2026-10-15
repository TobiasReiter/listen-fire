// Closures are values (language version 5, Dancing Wren): a closure may be
// written as an element of a list literal, and a name, parameter or member
// whose value is a closure may be called — as TypeScript allows
// (`[() => a, (x) => x + 1]`, `fs.map(f => f())`). The TypeScript engine is the
// reference the Rust engine is compared against, so it runs the new forms:
// a list element closure holds the scope it is written in by REFERENCE, as a
// closure bound to a name does, and a park inside one resumes.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ParkedScopeState } from '../serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink } from '../run';

const TEAM_ID = '00000000-0000-0000-0000-000000000097' as TeamId;
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

describe('a closure written as a list element', () => {
  it('is a value: the list holds the closures, and a MAP calls them', async () => {
    expect(
      await finalPayload([
        '  k = 7',
        '  fs = [() => { return k }, () => { return k * 2 }]',
        '  r = MAP(fs, (f) => f())',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: [7, 14] });
  });

  it('a park inside a list element closure resumes', async () => {
    expect(
      await finalPayload([
        '  k = 3',
        '  fs = [() => {',
        '    await sleep(1h)',
        '    return k + 1',
        '  }, () => { return 10 }]',
        '  r = MAP(fs, (f) => f())',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: [4, 10] });
  });

  it('a parked list element closure names its scope; it carries no copy of it', async () => {
    const parks = makeParkSink();
    await start(program(['  k = 3', '  fs = [() => {', '    await sleep(1h)', '    return k', '  }]', '  r = MAP(fs, (f) => f())']), parks);
    const parked = JSON.stringify([...parks.parks.values()][0]!.state);
    expect(parked).toContain('"captured":{}');
    expect(parked).toMatch(/"scope":\{"kind":"scopeRef"/);
  });
});

describe('a value that is a closure is called', () => {
  it('MAP(fs, (f) => f()) over a named list of closures', async () => {
    expect(
      await finalPayload([
        '  a = () => { return 1 }',
        '  b = () => { return 2 }',
        '  fs = [a, b]',
        '  out = MAP(fs, (f) => f())',
        '  write graph-[:note]-> { payload: { out: out } }',
      ]),
    ).toEqual({ out: [1, 2] });
  });

  it('MAP over an inline list, with a block-bodied member and an argument', async () => {
    expect(
      await finalPayload([
        '  k = 10',
        '  out = MAP([(n: <number>) => n + k, (n: <number>) => { return n * k }], (f) => { return f(2) })',
        '  write graph-[:note]-> { payload: { out: out } }',
      ]),
    ).toEqual({ out: [12, 20] });
  });

  it('a function declared with a name is a member like a closure', async () => {
    const source = program(['  out = MAP([twice, twice], (f) => f(4))', '  write graph-[:note]-> { payload: { out: out } }'])
      .replace('movement recap', 'function twice(n: <number>) {\n  return n * 2\n}\nmovement recap');
    const parks = makeParkSink();
    const { kg } = await start(source, parks);
    expect(payloadOf(kg.creates)).toEqual({ out: [8, 8] });
  });

  it('a member read with AT is called', async () => {
    expect(
      await finalPayload([
        '  fs = [() => { return "first" }, () => { return "second" }]',
        '  g = AT(fs, 1)',
        '  x = g()',
        '  write graph-[:note]-> { payload: { x: x } }',
      ]),
    ).toEqual({ x: 'second' });
  });

  it('a park inside a member\'s call resumes, the closure\'s scope by reference', async () => {
    expect(
      await finalPayload([
        '  k = 5',
        '  fs = [() => {',
        '    await sleep(1h)',
        '    return k + 1',
        '  }, () => { return k }]',
        '  out = MAP(fs, (f) => { return f() })',
        '  write graph-[:note]-> { payload: { out: out } }',
      ]),
    ).toEqual({ out: [6, 5] });
  });

  it('race over arms built at run time (FILTER keeps the closures)', async () => {
    expect(
      await finalPayload([
        '  all = [() => { return "a" }, () => {',
        '    await sleep(1h)',
        '    return "b"',
        '  }]',
        '  arms = FILTER(all, (f) => TRUE)',
        '  r = await race(arms)',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: ['a', null] });
  });
});

// `parallel` is retired under 5; its rewrite is a MAP over the arms, calling
// each. It answers what the receipt did, slot by slot, and a park inside an
// arm parks and resumes the run.
describe('the MAP that replaces parallel', () => {
  it('answers what parallel answered, in the arms\' order', async () => {
    const arms = ['() => { return 1 }', '() => {\n    await sleep(1h)\n    return "two"\n  }', '() => 3'];
    expect(
      await finalPayload([`  r = MAP([${arms.join(', ')}], { concurrency: 3 }, (f) => f())`, '  write graph-[:note]-> { payload: { r: r, second: AT(r, 1) } }']),
    ).toEqual({ r: [1, 'two', 3], second: 'two' });
  });

  it('every arm waiting, at once', async () => {
    expect(
      await finalPayload([
        '  k = 2',
        '  r = MAP([() => {',
        '    await sleep(1h)',
        '    return k',
        '  }, () => {',
        '    await sleep(2h)',
        '    return k * 10',
        '  }], { concurrency: 2 }, (f) => f())',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: [2, 20] });
  });

  it('run unbound, for the arms\' effects', async () => {
    const parks = makeParkSink();
    const { kg } = await start(program([
      '  MAP([() => {',
      '    write graph-[:note]-> { body: "a" }',
      '  }, () => {',
      '    write graph-[:note]-> { body: "b" }',
      '  }], { concurrency: 2 }, (f) => f())',
    ]), parks);
    expect(kg.creates.map((c) => c.fields.body).sort()).toEqual(['a', 'b']);
  });
});

describe('a closure made in a MAP member that parked, called after the resume', () => {
  // The member's function is written in place, so its scope is a flat capture
  // of the movement's; a closure the member returns holds that by reference,
  // and the answer kept across the member's park must carry it, not take it
  // for the file's scope (which holds none of the movement's bindings).
  it('reads the movement scope it was written under', async () => {
    expect(
      await finalPayload([
        '  a = 3',
        '  fs = MAP([1, 2], (n) => {',
        '    await sleep(1h)',
        '    return () => { return a + n }',
        '  })',
        '  r = MAP(fs, (f) => f())',
        '  write graph-[:note]-> { payload: { r: r } }',
      ]),
    ).toEqual({ r: [4, 5] });
  });
});

describe('a closure\'s value flows through every value position, and a call through it runs', () => {
  const FNS = ['function one() {', '  return "one"', '}', 'function pickOne() {', '  return one', '}'].join('\n');
  async function payloadWith(body: string[]): Promise<unknown> {
    const source = program([...body, '  write graph-[:note]-> { payload: { x: x } }']).replace('movement recap', `${FNS}\nmovement recap`);
    const parks = makeParkSink();
    const { kg } = await start(source, parks);
    return payloadOf(kg.creates);
  }

  it.each<[string, string[]]>([
    ['a named function bound to a name', ['  g = one', '  x = g()']],
    ['a named function a concise closure returns', ['  mk = () => one', '  h = mk()', '  x = h()']],
    ['a named function a declared function returns', ['  h = pickOne()', '  x = h()']],
    ['IF … THEN … ELSE … END over closures', ['  a = () => "a"', '  c = TRUE', '  g = IF c THEN one ELSE a END', '  x = g()']],
    ['COALESCE over closures', ['  a = () => "a"', '  g = COALESCE(one, a)', '  x = g()']],
  ])('%s', async (_label, body) => {
    expect(await payloadWith(body)).toEqual({ x: 'one' });
  });
});

describe('a parameter of closure type (<(params) => <return>>)', () => {
  const FNS = [
    'function callAll(fs: <() => <text>>[]) {',
    '  return MAP(fs, (f) => f())',
    '}',
    'function run(h: <(n: <number>) => <number>>) {',
    '  return h(20)',
    '}',
  ].join('\n');
  async function payloadWith(body: string[]): Promise<unknown> {
    const source = program([...body, '  write graph-[:note]-> { payload: { x: x } }']).replace('movement recap', `${FNS}\nmovement recap`);
    const parks = makeParkSink();
    const { kg } = await start(source, parks);
    return payloadOf(kg.creates);
  }

  it('a list of closures is passed, and each member is called', async () => {
    expect(await payloadWith(['  k = "b"', '  x = callAll([() => "a", () => k])'])).toEqual({ x: ['a', 'b'] });
  });

  it('a closure written in place is the argument, holding its scope', async () => {
    expect(await payloadWith(['  k = 2', '  x = run((n) => n + k)'])).toEqual({ x: 22 });
  });

  it('a closure taking fewer parameters than the type supplies is called, the extra argument dropped', async () => {
    expect(await payloadWith(['  x = run(() => 5)'])).toEqual({ x: 5 });
  });
});

describe('an arrow body that awaits (language version 5)', () => {
  it('is `{ return await … }`: the race runs, and the closure hands back its receipt', async () => {
    expect(
      await finalPayload(['  g = () => await race([() => "first"])', '  r = g()', '  write graph-[:note]-> { payload: { r: r } }']),
    ).toEqual({ r: ['first'] });
  });
});
