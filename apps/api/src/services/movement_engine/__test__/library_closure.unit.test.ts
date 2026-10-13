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
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ParkedScopeState } from '../serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { resumeMovement, runMovement, type MovementRunResult, type ParkSink } from '../run';

const TEAM_ID = '00000000-0000-0000-0000-000000000078' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

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

const catalog = staticCatalogFromManifests({
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
      await input.correlate('run-1');
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
    catalog,
    movementName: 'recap',
    resolveFile: (path: string) => (path === 'lib/leads' ? { source: h.library } : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return kg.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    parkSink: h.parks.sink,
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
