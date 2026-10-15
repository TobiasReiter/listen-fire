// A value that may be a record and may be a value (`COALESCE(co, 1)`), handed
// to a parameter typed `<number>`. Under language versions 3 and 4 the checker
// let it through and the call RAN: the record arrived where a number was typed
// (and a sum over it was NaN, written without a word). That is why the refusal lands from
// Dancing Wren (5) only, with an upgrade warning before it — the frozen
// behaviour is pinned here, and version 5 is refused at check.

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

const SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
function f(n: <number>) {
  return n
}
movement recap(go: <runs-[:Invocation]->>) {
  co = write graph-[:companies]-> { name: "a" }
  x = f(COALESCE(co, 1))
  y = x + 1
  write graph-[:note]-> { payload: { y: y } }
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

describe('a value that may be a record, handed to a <number> parameter', () => {
  it('ran under Luminous Owl (4): the record arrived as the number, and the sum over it is NaN', async () => {
    const { kg } = await runUnder(4);
    expect(kg.creates.find((c) => c.fields.payload !== undefined)?.fields.payload).toEqual({ y: Number.NaN });
  });

  it('is refused at check under Dancing Wren (5)', async () => {
    await expect(runUnder(5)).rejects.toThrow(/MOV_CALL_ARG_MAYBE_RECORD/);
  });
});
