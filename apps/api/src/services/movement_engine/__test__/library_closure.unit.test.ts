// A closure that belongs to a LIBRARY file, run and resumed.
//
//   · B13 — a closure bound at a library's top level, called inside one of
//     the library's functions: the checker sees the library's file scope from
//     inside its functions, so the run must too (it failed "'f' is not in
//     scope").
//   · B11 — a library closure that parks before `x IS <Decl>` against the
//     library's own declaration: on resume the declaration is found again in
//     the LIBRARY it was declared in, not the root program (it failed "cannot
//     re-resolve code ref").
//
// Both always failed, so neither is a version conditional.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { ParkedScopeState } from '../serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import { tenantIdOf } from 'engine-contracts';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink } from '../run';
import { makeTestHost } from '../test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000078');
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

function makeKgFake() {
  const creates: WriteInput[] = [];
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

const catalog = staticCatalogSnapshot({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-library-closure',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-13T09:00:00.000Z' },
    occurredAt: '2026-10-13T09:00:00.000Z',
  };
}

function root(imports: string, body: string): string {
  return `import { manual, kg } from adapters
import { kg_cred } from credentials
${imports}
runs = manual()
graph = kg(credentials: kg_cred)
movement recap(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire recap
`;
}

function makeParkSink() {
  const parks = new Map<string, { kind: 'timer' | 'await' | 'suspension'; state: ParkedScopeState }>();
  const keep = (kind: 'timer' | 'await' | 'suspension', address: string, state: unknown): void => {
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as ParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin() {},
    async commitTimerPark(input) {
      keep('timer', input.address, input.state);
    },
    async commitAwaitPark(input) {
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      keep('suspension', input.address, input.state);
    },
    async decrementJoin() {
      return { closed: false };
    },
    async persistBranchExport() {},
    async collectBranchExports() {
      return [];
    },
    async cancelSubtrees() {},
  };
  return { sink, parks };
}

interface Harness {
  source: string;
  library: string;
  parks: ReturnType<typeof makeParkSink>;
}

function runInput(h: Harness, kg: ReturnType<typeof makeKgFake>) {
  return {
    source: h.source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog: { ...catalog, files: { 'lib/leads': { source: h.library } } },
    movementName: 'recap',
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'manual') return manualAdapter;
          if (adapterType === KG) return kg.adapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
      park: { sink: h.parks.sink },
    }),
    dryRun: false,
  };
}

async function start(h: Harness) {
  const kg = makeKgFake();
  const result = await runMovement(runInput(h, kg));
  return { result, kg };
}

async function resumeOnly(h: Harness): Promise<{ result: MovementRunResult; kg: ReturnType<typeof makeKgFake> }> {
  const [address, park] = [...h.parks.parks.entries()][0] ?? [];
  if (address === undefined || park === undefined) throw new Error('test: nothing parked');
  h.parks.parks.delete(address);
  const kg = makeKgFake();
  const result = await resumeMovement({ ...runInput(h, kg), state: park.state, reenter: park.kind !== 'timer' });
  return { result, kg };
}

const payloadOf = (creates: WriteInput[]): unknown => creates.find((c) => c.fields.payload !== undefined)?.fields.payload;

describe("a closure bound at a library's top level (B13)", () => {
  it('is in scope inside the library’s functions', async () => {
    const h: Harness = {
      library: [
        'double = (n: <number>) => n * 2',
        'export function twice(n: <number>): <number> {',
        '  return double(n) + 1',
        '}',
      ].join('\n'),
      source: root('import { twice } from "lib/leads"', '  x = twice(n: 4)\n  write graph-[:note]-> { payload: { x: x } }'),
      parks: makeParkSink(),
    };
    const { result, kg } = await start(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: 9 });
  });

  it("and one bound at the root program's top level, inside the root's own function", async () => {
    const h: Harness = {
      library: '',
      source: root(
        'triple = (n: <number>) => n * 3\nfunction plus_one(n: <number>): <number> {\n  return triple(n) + 1\n}',
        '  x = plus_one(n: 2)\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    const { result, kg } = await start(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: 7 });
  });

  it('parks inside it and resumes', async () => {
    const h: Harness = {
      library: [
        'double = (n: <number>) => {',
        '  await sleep(1h)',
        '  return n * 2',
        '}',
        'export function twice(n: <number>): <number> {',
        '  y = double(n)',
        '  return y + 1',
        '}',
      ].join('\n'),
      source: root('import { twice } from "lib/leads"', '  x = twice(n: 4)\n  write graph-[:note]-> { payload: { x: x } }'),
      parks: makeParkSink(),
    };
    const first = await start(h);
    expect(first.result.parked).toBe(true);
    expect(first.kg.creates).toEqual([]);
    const { result, kg } = await resumeOnly(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: 9 });
  });
});

// A file-level closure holds its file scope by REFERENCE, as a JavaScript
// closure holds its module scope: it sees the file's later closures too, and a
// park writes it by the name it is declared by — a declaration of the program,
// found again in the re-parsed file, as a movement is — never its body or the
// file scope it holds. Before this a park copied every earlier file closure
// into each later one, so the state doubled with each declaration.
describe('a file-level closure holds its file scope by reference', () => {
  it('an earlier one calls a later one', async () => {
    const h: Harness = {
      library: '',
      source: root(
        'f = (n: <number>) => g(n) + 1\ng = (n: <number>) => n * 10',
        '  x = f(1)\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    const { result, kg } = await start(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: 11 });
  });

  it('and still does after a park inside the earlier one', async () => {
    const h: Harness = {
      library: '',
      source: root(
        'f = (n: <number>) => {\n  await sleep(1h)\n  return g(n) + 1\n}\ng = (n: <number>) => n * 10',
        '  x = f(1)\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    const first = await start(h);
    expect(first.result.parked).toBe(true);
    const { result, kg } = await resumeOnly(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: 11 });
  });

  const parkedSize = async (n: number): Promise<{ size: number; parked: string }> => {
    const decls = Array.from({ length: n }, (_, i) => `h${i} = (v: <number>) => v + ${i}`).join('\n');
    const h: Harness = {
      library: '',
      source: root(decls, '  await sleep(1h)\n  write graph-[:note]-> { payload: { x: 1 } }'),
      parks: makeParkSink(),
    };
    await start(h);
    const parked = JSON.stringify([...h.parks.parks.values()][0]!.state);
    return { size: parked.length, parked };
  };

  it('a park writes each by name, so its size does not compound with how many a file declares', async () => {
    const two = await parkedSize(2);
    const fourteen = await parkedSize(14);
    expect(fourteen.parked).toContain('"h13":{"kind":"fileClosure","name":"h13"}');
    expect(fourteen.parked).not.toContain('"kind":"closure"');
    // Linear in the names, a few dozen bytes each (it doubled per closure).
    expect(fourteen.size - two.size).toBeLessThan(12 * 100);
  });

  it("a body closure's capture of a library's file closure names the library, and resumes", async () => {
    const h: Harness = {
      library: [
        'double = (n: <number>) => n * 2',
        'export function twice(n: <number>): <number> {',
        '  k = (m: <number>) => double(m)',
        '  await sleep(1h)',
        '  return k(n) + 1',
        '}',
      ].join('\n'),
      source: root('import { twice } from "lib/leads"', '  x = twice(n: 4)\n  write graph-[:note]-> { payload: { x: x } }'),
      parks: makeParkSink(),
    };
    const first = await start(h);
    expect(first.result.parked).toBe(true);
    const parked = JSON.stringify([...h.parks.parks.values()][0]!.state);
    expect(parked).toContain('"double":{"kind":"fileClosure","name":"double","file":"lib/leads"}');
    const { result, kg } = await resumeOnly(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: 9 });
  });

  it('a park written before file-level closures were bound (none in its state) still resumes', async () => {
    const h: Harness = {
      library: '',
      source: root(
        'h0 = (v: <number>) => v + 100',
        '  c = (v: <number>) => v + 1\n  await sleep(1h)\n  x = c(1)\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    await start(h);
    for (const p of h.parks.parks.values()) {
      const old = JSON.stringify(p.state).replace(/,?"h0":\{"kind":"fileClosure","name":"h0"\},?/g, (m) =>
        m.startsWith(',') && m.endsWith(',') ? ',' : '',
      );
      expect(old).not.toContain('fileClosure');
      p.state = JSON.parse(old) as ParkedScopeState;
    }
    const { result, kg } = await resumeOnly(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: 2 });
  });
});

describe("a library closure parked before `IS` against the library's own declaration (B11)", () => {
  const library = [
    'export node Lead {',
    '  name: <text>',
    '}',
    'export function is_lead(name: <text>): <boolean> {',
    '  check = (who: <text>) => {',
    '    n = node { name: who }',
    '    await sleep(1h)',
    '    if n IS <Lead> {',
    '      return true',
    '    }',
    '    return false',
    '  }',
    '  return check(name)',
    '}',
  ].join('\n');

  it('resumes, finding the declaration in the library', async () => {
    const h: Harness = {
      library,
      source: root('import { is_lead } from "lib/leads"', '  x = is_lead(name: "Ada")\n  write graph-[:note]-> { payload: { x: x } }'),
      parks: makeParkSink(),
    };
    const first = await start(h);
    expect(first.result.parked).toBe(true);
    // The declaration says which file it is found again in.
    const parked = JSON.stringify([...h.parks.parks.values()][0]!.state);
    expect(parked).toContain('{"kind":"shape","name":"Lead","file":"lib/leads"}');
    const { result, kg } = await resumeOnly(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: true });
  });

  it('finds the library’s declaration even when the root program declares one by the same name', async () => {
    const h: Harness = {
      library,
      source: root(
        'import { is_lead } from "lib/leads"\nnode Lead {\n  name: <text>\n  stage: <text>\n}',
        '  x = is_lead(name: "Ada")\n  write graph-[:note]-> { payload: { x: x } }',
      ),
      parks: makeParkSink(),
    };
    await start(h);
    const { result, kg } = await resumeOnly(h);
    expect(result.parked).toBeUndefined();
    expect(payloadOf(kg.creates)).toEqual({ x: true });
  });
});

// A park names the library its declarations belong to. Resumed against a
// program that no longer links that library, it refuses rather than resuming
// silently on the library's file scope (which is chain[0], never rehydrated).
describe.each([4, 5])('a resume against a program that no longer links the parked library (v%i)', (version) => {
  const unlinked = (h: Harness): Harness => ({
    ...h,
    source: root('', '  write graph-[:note]-> { payload: { x: 1 } }'),
  });
  const libraries: Record<string, string> = {
    'a body closure capturing a library file closure': [
      'double = (n: <number>) => n * 2',
      'export function twice(n: <number>): <number> {',
      '  k = (m: <number>) => double(m)',
      '  await sleep(1h)',
      '  return k(n) + 1',
      '}',
    ].join('\n'),
    'a library shape': [
      'export node Lead {',
      '  name: <text>',
      '}',
      'export function twice(n: <number>): <number> {',
      '  check = (who: <text>) => {',
      '    await sleep(1h)',
      '    return n * 2',
      '  }',
      '  m = node { name: "a" }',
      '  if m IS <Lead> {',
      '    check(who: "a")',
      '  }',
      '  return n',
      '}',
    ].join('\n'),
  };
  it.each(Object.keys(libraries))('refuses: %s', async (name) => {
    const h: Harness = {
      library: libraries[name]!,
      source: root('import { twice } from "lib/leads"', '  x = twice(n: 4)\n  write graph-[:note]-> { payload: { x: x } }'),
      parks: makeParkSink(),
    };
    const kg0 = makeKgFake();
    const first = await runMovement({ ...runInput(h, kg0), languageVersion: version as never });
    expect(first.parked).toBe(true);
    const [address, park] = [...h.parks.parks.entries()][0]!;
    h.parks.parks.delete(address);
    await expect(
      resumeMovement({
        ...runInput(unlinked(h), makeKgFake()),
        languageVersion: version as never,
        state: park.state,
        reenter: park.kind !== 'timer',
      }),
    ).rejects.toThrow('resume: the parked state names the library "lib/leads", which the re-parsed program does not link');
  });
});
