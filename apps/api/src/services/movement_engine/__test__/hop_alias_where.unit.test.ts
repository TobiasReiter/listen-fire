// A hop's WHERE reads the landed record through the hop's OWN alias as well as
// through a bare field: `graph-[e:entity WHERE e.\`Flag\` == true]->` keeps
// exactly the flagged records, like `WHERE \`Flag\` == true` does. The alias
// used to be bound only after the filter ran, so `e.Flag` read as absent and
// the filter silently matched nothing.
//
// Pinned through the REAL interpreter on every walker that evaluates a hop
// WHERE: a block head, an expression hop, and an EXISTS hop.

import type { InstanceSchema } from 'movement-lang';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import type { CapturedWrite } from 'movement-engine/services/translation_graph/engine/dry_run_adapter';
import type { Adapter, GetRelatedInput, RelatedResult } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionRecordId,
} from 'movement-engine/services/translation_graph/types';
import { tenantIdOf } from 'engine-contracts';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000031');
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

const schema: InstanceSchema = {
  positions: {
    entity: {
      properties: { Name: 'text', Flag: 'boolean' },
      edges: { Branches: { target: 'branch' } },
    },
    branch: { properties: { City: 'text' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { entity: { target: 'entity' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
};

const ROWS: Record<string, { recordType: string; fields: Record<string, unknown> }> = {
  'ent-1': { recordType: 'entity', fields: { Name: 'Alder Holdings', Flag: true } },
  'ent-2': { recordType: 'entity', fields: { Name: 'Birch Partners', Flag: false } },
  'ent-3': { recordType: 'entity', fields: { Name: 'Cedar Group', Flag: true } },
  'br-1': { recordType: 'branch', fields: { City: 'Lisbon' } },
  'br-2': { recordType: 'branch', fields: { City: 'Oslo' } },
};

function makeFake(): Adapter {
  const position = (id: string) =>
    makeStablePosition({ adapterType: KG, recordType: ROWS[id]!.recordType, recordId: id });
  return {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => ({
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
    async getFieldValue({ position: at, fieldId }) {
      const id = positionRecordId(at);
      return (id !== undefined ? ROWS[id]?.fields[fieldId] : undefined) ?? null;
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      if (read.position.recordType === META_RECORD_TYPE) {
        if (read.fieldId !== 'entity') return [];
        return ['ent-1', 'ent-2', 'ent-3'].map((id) => ({ position: position(id) }));
      }
      if (read.fieldId === 'Branches') return ['br-1', 'br-2'].map((id) => ({ position: position(id) }));
      return [];
    },
    async createRecord() {
      return { adapterType: KG, externalId: 'new', data: {} };
    },
    async updateRecord(update) {
      return { adapterType: KG, externalId: update.externalId, data: {}, association: containerAssociation(update) };
    },
    async deleteRecord() {
      return {};
    },
  };
}

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-hop-alias',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

async function namesWritten(body: string): Promise<unknown[]> {
  const source = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = connect manual
graph = connect kg using kg_cred
function sweep(go: <runs-[:Invocation]->>) {
${body}
}
listen to runs {} fire sweep
`;
  const writes: CapturedWrite[] = [];
  const fake = makeFake();
  await runMovement({
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog: staticCatalogSnapshot({
      credentials: { kg_cred: { adapters: [KG] } },
      instanceSchemas: { [KG]: schema },
    }),
    host: makeTestHost({
      writeSink: (w) => writes.push(w),
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'manual') return manualAdapter;
          if (adapterType === KG) return fake;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
    }),
    dryRun: true,
  });
  return writes.map((w) => w.fields?.text);
}

describe("a hop's WHERE reads the landed record through the hop's own alias", () => {
  it('a BLOCK HEAD hop keeps exactly the flagged records', async () => {
    expect(
      await namesWritten(`  graph-[e:entity WHERE e.\`Flag\` == true]-> {
    write graph-[:note]-> { text: e.\`Name\` }
  }`),
    ).toEqual(['Alder Holdings', 'Cedar Group']);
  });

  it('the bare form agrees', async () => {
    expect(
      await namesWritten(`  graph-[e:entity WHERE e.\`Flag\` == true]-> {
    write graph-[:note]-> { text: e.\`Name\` }
  }`),
    ).toEqual(['Alder Holdings', 'Cedar Group']);
  });

  it('an EXPRESSION hop keeps exactly the flagged records', async () => {
    expect(
      await namesWritten(
        '  write graph-[:note]-> { text: "${Text.join(graph-[e:entity WHERE e.`Flag` == true ORDER BY e.`Name`]->.`Name`, ", ")}" }',
      ),
    ).toEqual(['Alder Holdings, Cedar Group']);
  });

  it('an EXISTS hop sees the alias too', async () => {
    expect(
      await namesWritten(`  graph-[e:entity]-> {
    if (exists(e-[b:Branches WHERE b.\`City\` == "Oslo"]->)) {
      write graph-[:note]-> { text: e.\`Name\` }
    }
  }`),
    ).toEqual(['Alder Holdings', 'Birch Partners', 'Cedar Group']);
  });

  it('an EXISTS hop whose alias-qualified WHERE matches nothing finds nothing', async () => {
    expect(
      await namesWritten(`  graph-[e:entity]-> {
    if (exists(e-[b:Branches WHERE b.\`City\` == "Nowhere"]->)) {
      write graph-[:note]-> { text: e.\`Name\` }
    }
  }`),
    ).toEqual([]);
  });
});
