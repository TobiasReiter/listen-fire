// A read off one of two records of one type — `COALESCE(pick, org).name`, two
// Companies a write returned. Under language versions 3 and 4 the checker gave
// it no type and the read RAN: a field the type has read its value, one it has
// not read null without a word, and text plus one was NaN. From
// Dancing Wren (5) the value is a Company, as TypeScript's `A | A` is `A`, so
// those reads are refused at check — and only from 5, with an upgrade warning
// before. The frozen behaviour is pinned here.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { tenantIdOf } from 'engine-contracts';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000097');
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
  pipelineInputId: 'trigger:manual-records-of-one-type',
  adapterType: 'manual',
  triggerType: 'webhook',
  payload: { firedAt: '2026-10-15T09:00:00.000Z' },
  occurredAt: '2026-10-15T09:00:00.000Z',
};


const SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement recap(go: <runs-[:Invocation]->>) {
  org = write graph-[:companies]-> { name: "a" }
  pick = write graph-[:companies]-> { name: "b" }
  name = COALESCE(pick, org).name
  nope = COALESCE(pick, org).nope
  sum = name + 1
  write graph-[:note]-> { payload: { name: name, nope: nope, sum: sum } }
}
listen to runs {} fire recap
`;

async function runUnder(languageVersion: 4 | 5) {
  const kg = makeKgFake();
  const result = await runMovement({
    source: SOURCE,
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

describe('a read off one of two records of one type', () => {
  it('ran under Luminous Owl (4): a field it has read its value, one it has not read null, and text plus one is NaN', async () => {
    const { kg } = await runUnder(4);
    expect(kg.creates.find((c) => c.fields.payload !== undefined)?.fields.payload).toEqual({ name: 'b', nope: null, sum: Number.NaN });
  });

  it('is refused at check under Dancing Wren (5)', async () => {
    await expect(runUnder(5)).rejects.toThrow(/MOV_UNKNOWN_PROPERTY/);
  });
});
