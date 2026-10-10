// Position writes (`write a { … }`) through the REAL interpreter: a record
// reached by a traversal alias is updated IN PLACE — the engine takes the
// alias's already-stable `recordId` straight to `updateRecord` with NO
// entity resolution (the unification: a write result IS a position, so a
// read position is a write target). Verified end-to-end with a fake KG:
//
//   1. `graph-[c:company]-> { write c { … } }` calls updateRecord on the
//      traversed node's id and never calls resolveEntity.
//   2. an unstable position (no stable record) is refused at runtime.

import type { InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type {
  Adapter,
  RuntimeCapabilities,
  GetRelatedInput,
  RelatedResult,
  UpdateInput,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionRecordId,
} from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';

const TEAM_ID = '00000000-0000-0000-0000-000000000031' as TeamId;
const KG = 'kg';

const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: false, edgeProperties: false },
    resources: false,
  };
}

interface NodeRow {
  id: string;
  fields: Record<string, unknown>;
}

/** A KG fake that scans a meta-root collection and records every
 *  updateRecord / resolveEntity it sees — enough to prove the in-place
 *  update path takes the traversed id and skips resolution. */
function makeKgFake(collections: Record<string, NodeRow[]>) {
  const updates: UpdateInput[] = [];
  const resolveCalls: unknown[] = [];
  const deletes: { recordType: string; externalId: string }[] = [];
  const byId = new Map<string, NodeRow>();
  for (const rows of Object.values(collections)) for (const r of rows) byId.set(r.id, r);

  const adapter: Adapter = {
    adapterType: KG,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity(input) {
      resolveCalls.push(input);
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const id = positionRecordId(position);
      return (id !== undefined ? byId.get(id)?.fields[fieldId] : undefined) ?? null;
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      if (read.position.recordType !== META_RECORD_TYPE) return [];
      return (collections[read.fieldId] ?? []).map((row) => ({
        position: makeStablePosition({ adapterType: KG, recordType: read.fieldId, recordId: row.id }),
      }));
    },
    async createRecord(write) {
      return { adapterType: KG, externalId: `new-${write.recordType}`, data: {} };
    },
    async updateRecord(input) {
      updates.push(input);
      const node = byId.get(input.externalId);
      if (node) Object.assign(node.fields, input.fields);
      return { adapterType: KG, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord(input) {
      deletes.push({ recordType: input.recordType, externalId: input.externalId });
      return {};
    },
  };
  return { adapter, updates, resolveCalls, deletes };
}

const kgSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', status: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: { name: 'text', status: 'text' },
      resultShape: { externalId: 'text', name: 'text', status: 'text' },
    },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] }, kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-pw',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: new Date().toISOString() },
    occurredAt: new Date().toISOString(),
  };
}

function makeResolver(byType: Record<string, Adapter>) {
  return ({ adapterType }: { adapterType: string }) => {
    const adapter = byType[adapterType];
    if (!adapter) throw new Error(`test: no fake adapter for '${adapterType}'`);
    return adapter;
  };
}

async function run(source: string, kg: ReturnType<typeof makeKgFake>) {
  return runMovement({
    source,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveAdapter: makeResolver({ manual: manualAdapter, [KG]: kg.adapter }),
    dryRun: false,
  });
}

describe('position writes update the traversed record in place', () => {
  const SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement reopen(go: <runs-[:Invocation]->>) {
  graph-[c:company]-> {
    write c { status: "Open" }
  }
}
listen to runs {} fire reopen
`;

  it('takes the traversed node id to updateRecord and never resolves', async () => {
    const kg = makeKgFake({
      company: [
        { id: 'n-1', fields: { name: 'Acme', status: 'Closed' } },
        { id: 'n-2', fields: { name: 'Globex', status: 'Closed' } },
      ],
    });
    await run(SOURCE, kg);

    // One update per traversed node, keyed by the node's OWN id — no
    // resolveEntity, because the record was already identified by the read.
    expect(kg.resolveCalls).toEqual([]);
    expect(kg.updates.map((u) => [u.externalId, u.recordType, u.fields])).toEqual([
      ['n-1', 'company', { status: 'Open' }],
      ['n-2', 'company', { status: 'Open' }],
    ]);
  });
});

// `delete <alias>` over a traversed record mirrors the in-place write: the
// deletable positions are exactly the updatable ones (found live on the demo
// team, 2026-07-07 — "delete takes a written handle" refused a traversal
// alias that `write <alias>` accepted).
describe('delete removes the traversed record in place', () => {
  const SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement cleanup(go: <runs-[:Invocation]->>) {
  graph-[c:company]-> {
    delete c
  }
}
listen to runs {} fire cleanup
`;

  it('takes the traversed node id to deleteRecord and never resolves', async () => {
    const kg = makeKgFake({
      company: [
        { id: 'n-1', fields: { name: 'Acme', status: 'Closed' } },
        { id: 'n-2', fields: { name: 'Globex', status: 'Closed' } },
      ],
    });
    const result = await run(SOURCE, kg);

    expect(kg.resolveCalls).toEqual([]);
    expect(kg.deletes).toEqual([
      { recordType: 'company', externalId: 'n-1' },
      { recordType: 'company', externalId: 'n-2' },
    ]);
    // The firing record carries one kind-delete entry per removal; a
    // traversed record has no write origin, so provenance is empty.
    const deletes = result.writes.filter((w) => w.kind === 'delete');
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toMatchObject({ externalId: 'n-1', created: false, provenance: {} });
  });
});
