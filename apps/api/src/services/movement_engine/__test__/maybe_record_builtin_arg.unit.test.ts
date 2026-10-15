// A value that may be a record and may be a value (`COALESCE(co, 1)`), handed
// to a built-in whose argument takes a value: `ROUND(COALESCE(co, 1))`. Under
// language versions 3 and 4 the checker let it through and the built-in RAN
// on the record as it was. That is why the refusal lands from Dancing Wren (5)
// only, with an upgrade warning before it — the frozen behaviour is pinned
// here, and version 5 is refused at check.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000098');
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

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

const catalog = staticCatalogSnapshot({
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
  round: `movement recap(go: <runs-[:Invocation]->>) {
  co = write graph-[:companies]-> { name: "a" }
  x = ROUND(COALESCE(co, 1))
  write graph-[:note]-> { payload: { x: x } }
}`,
  upper: `movement recap(go: <runs-[:Invocation]->>) {
  co = write graph-[:companies]-> { name: "a" }
  x = UPPER(COALESCE(co, "b"))
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
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'manual') return manualAdapter;
          if (adapterType === KG) return kg.adapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
    }),
    dryRun: false,
    languageVersion,
  });
  return { result, kg };
}

const payloads = (kg: ReturnType<typeof makeKgFake>) => kg.creates.filter(c => c.fields.payload !== undefined).map(c => c.fields.payload);

describe('a value that may be a record, handed to a built-in that takes a value', () => {
  it.each([3, 4] as const)('ran under %i: the built-in read the record as it was', async version => {
    expect(payloads((await runUnder(CASES.round!, version)).kg)).toEqual([{ x: Number.NaN }]);
    expect(payloads((await runUnder(CASES.upper!, version)).kg)).toEqual([{ x: '[OBJECT OBJECT]' }]);
  });

  it.each(Object.keys(CASES))('%s is refused at check under Dancing Wren (5)', async name => {
    await expect(runUnder(CASES[name]!, 5)).rejects.toThrow(/MOV_CALL_ARG_MAYBE_RECORD/);
  });
});
