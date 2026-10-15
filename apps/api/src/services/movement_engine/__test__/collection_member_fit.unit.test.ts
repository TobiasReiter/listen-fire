// A collection op's function whose parameter is typed, handed members of
// another type: `MAP(["a"], (n: <number>) => n + 1)`, and REDUCE's starting
// value against its accumulator. Under language versions 3 and 4 nothing
// compared them and the op RAN, handing the function each member as it was:
// text where a number was typed, a record where a number was typed. That is
// why the refusals land from Dancing Wren (5) only, with upgrade warnings
// before it — the frozen behaviour is pinned here, and version 5 is refused
// at check.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { runMovement } from '../run';

const TEAM_ID = '00000000-0000-0000-0000-000000000098' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function makeKgFake() {
  const creates: WriteInput[] = [];
  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: (): RuntimeCapabilities => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
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
      return { adapterType: KG, externalId: `rec-${creates.length}`, data: {} };
    },
    async updateRecord() {
      throw new Error('test: no updates');
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const kgSchema: InstanceSchema = {
  positions: {
    note: { properties: { payload: 'json' }, edges: {} },
    company: { properties: { name: 'text' }, edges: {} },
  },
  collections: { note: { target: 'note' }, companies: { target: 'company' } },
  writableRoots: {
    note: { fields: { payload: 'json' }, resultShape: { externalId: 'text' } },
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

const event: TriggerEvent = {
  pipelineInputId: 'trigger:manual-maybe-record',
  adapterType: 'manual',
  triggerType: 'webhook',
  payload: { firedAt: '2026-10-15T09:00:00.000Z' },
  occurredAt: '2026-10-15T09:00:00.000Z',
};


const PRE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
`;
const CASES: Record<string, string> = {
  textMember: `movement recap(go: <runs-[:Invocation]->>) {
  x = MAP(["a"], (n: <number>) => n + 1)
  write graph-[:note]-> { payload: { x: x } }
}`,
  textStart: `movement recap(go: <runs-[:Invocation]->>) {
  x = REDUCE([1, 2], "s", (acc: <number>, n: <number>) => acc + n)
  write graph-[:note]-> { payload: { x: x } }
}`,
  recordMember: `movement recap(go: <runs-[:Invocation]->>) {
  co = write graph-[:companies]-> { name: "a" }
  x = MAP([COALESCE(co, 1)], (n: <number>) => n + 1)
  write graph-[:note]-> { payload: { x: x } }
}`,
};

async function runUnder(source: string, languageVersion: 3 | 4 | 5) {
  const kg = makeKgFake();
  const result = await runMovement({
    source: `${PRE}${source}\nlisten to runs {} fire recap\n`,
    event,
    teamId: TEAM_ID,
    catalog,
    movementName: 'recap',
    resolveAdapter: ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'manual') return manualAdapter;
      if (adapterType === KG) return kg.adapter;
      throw new Error(`test: no fake adapter for '${adapterType}'`);
    },
    dryRun: false,
    languageVersion,
  });
  return { result, kg };
}

const payloads = (kg: ReturnType<typeof makeKgFake>) => kg.creates.filter(c => c.fields.payload !== undefined).map(c => c.fields.payload);

describe('a collection op\'s typed function, handed members of another type', () => {
  it.each([3, 4] as const)('ran under %i: text or a record reached a number parameter, and the sum came out NaN', async version => {
    expect(payloads((await runUnder(CASES.textMember!, version)).kg)).toEqual([{ x: [Number.NaN] }]);
    expect(payloads((await runUnder(CASES.recordMember!, version)).kg)).toEqual([{ x: [Number.NaN] }]);
  });

  it.each([3, 4] as const)('ran under %i: REDUCE\'s text starting value reached a number accumulator', async version => {
    expect(payloads((await runUnder(CASES.textStart!, version)).kg)).toEqual([{ x: Number.NaN }]);
  });

  it.each(Object.keys(CASES))('%s is refused at check under Dancing Wren (5)', async name => {
    await expect(runUnder(CASES[name]!, 5)).rejects.toThrow(/MOV_CALL_ARG_(TYPE|MAYBE_RECORD)/);
  });
});
