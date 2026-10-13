import type { InstanceSchema } from 'movement-lang';
import { runMovement } from '../run';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import type {
  Adapter,
  RuntimeCapabilities,
  GetRelatedInput,
  RelatedResult,
  WriteInput,
} from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import {
  makeStablePosition,
  positionData,
  positionRecordId,
} from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { containerAssociation } from '../../translation_graph/adapter';

const TEAM_ID = '00000000-0000-0000-0000-000000000031' as TeamId;
const KG = 'kg';
const manualAdapter = createManualAdapter({ teamId: TEAM_ID });

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

// A KG fake: `company` records carry a `contacts` edge; `getRelated` from a
// company position yields one contact; every createRecord is captured so the
// test can read what the traversal fed into the sink `log` write.
//
// `company` also carries an `ids` edge that reads `positionData` off the
// START position and yields one `idrecord` per id in `data.ids` — the
// fixture Part A's test uses to prove the write's `resultData` reaches
// `getRelated` when it's read straight off the handle (no intervening hop).
function makeKgFake() {
  const creates: WriteInput[] = [];
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
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const id = positionRecordId(position);
      if (fieldId === 'name' && id === 'ct-1') return 'Ada';
      if (fieldId === 'value') {
        const data = positionData(position) as { value?: string } | null | undefined;
        return data?.value ?? null;
      }
      return null;
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      if (read.position.recordType === 'company' && read.fieldId === 'contacts') {
        return [{ position: makeStablePosition({ adapterType: KG, recordType: 'contact', recordId: 'ct-1' }) }];
      }
      if (read.position.recordType === 'company' && read.fieldId === 'ids') {
        const data = positionData(read.position) as { ids?: string[] } | null | undefined;
        return (data?.ids ?? []).map((id) => ({
          position: makeStablePosition({ adapterType: KG, recordType: 'idrecord', recordId: id, data: { value: id } }),
        }));
      }
      return [];
    },
    async createRecord(write) {
      creates.push(write);
      const externalId = write.recordType === 'company' ? 'co-1' : `log-${creates.length}`;
      const data = write.recordType === 'company' ? { ids: ['x-1', 'x-2'] } : {};
      return { adapterType: KG, externalId, data };
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
  positions: {
    company: {
      properties: { name: 'text' },
      edges: { contacts: { target: 'contact' }, ids: { target: 'idrecord' } },
    },
    contact: { properties: { name: 'text' }, edges: {} },
    idrecord: { properties: { value: 'text' }, edges: {} },
    log: { properties: { text: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' }, contact: { target: 'contact' }, idrecord: { target: 'idrecord' }, log: { target: 'log' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    log: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
};

const catalog = staticCatalogFromManifests({
  credentials: { kg_cred: { adapters: ['kg'] } },
  instanceSchemas: { kg: kgSchema },
});

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-ht',
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

describe('a write handle is a block-head traversal head', () => {
  const SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement m(go: <runs-[:Invocation]->>) {
  co = write graph-[:company]-> { name: "Acme" }
  co-[c:contacts]-> {
    write graph-[:log]-> { text: c.name }
  }
}
listen to runs {} fire m
`;

  it('traverses from the handle record id and feeds the related field into the sink', async () => {
    const kg = makeKgFake();
    await run(SOURCE, kg);
    const logWrites = kg.creates.filter((w) => w.recordType === 'log');
    expect(logWrites).toHaveLength(1);
    expect(logWrites[0].fields).toEqual({ text: 'Ada' });
  });

  it("the write's resultData reaches getRelated off the handle's own start position", async () => {
    const RESULT_DATA_SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement m(go: <runs-[:Invocation]->>) {
  co = write graph-[:company]-> { name: "Acme" }
  co-[e:ids]-> {
    write graph-[:log]-> { text: e.value }
  }
}
listen to runs {} fire m
`;
    const kg = makeKgFake();
    await run(RESULT_DATA_SOURCE, kg);
    const logWrites = kg.creates.filter((w) => w.recordType === 'log');
    expect(logWrites).toHaveLength(2);
    expect(logWrites.map((w) => w.fields)).toEqual([{ text: 'x-1' }, { text: 'x-2' }]);
  });
});

describe('a write handle is an expression traversal head', () => {
  const SOURCE = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement m(go: <runs-[:Invocation]->>) {
  co = write graph-[:company]-> { name: "Acme" }
  write graph-[:log]-> { text: "contact: \${co-[:contacts]->.name}" }
}
listen to runs {} fire m
`;

  it('reads a related field off the handle inside a string interpolation', async () => {
    const kg = makeKgFake();
    await run(SOURCE, kg);
    const logWrites = kg.creates.filter((w) => w.recordType === 'log');
    expect(logWrites).toHaveLength(1);
    expect(logWrites[0].fields).toEqual({ text: 'contact: Ada' });
  });

  it('a zero-step handle read still reads the handle field directly', async () => {
    const SRC = `import { manual, kg } from adapters
import { kg_cred } from credentials
runs = manual()
graph = kg(credentials: kg_cred)
movement m(go: <runs-[:Invocation]->>) {
  co = write graph-[:company]-> { name: "Acme" }
  write graph-[:log]-> { text: "id: \${co.externalId}" }
}
listen to runs {} fire m
`;
    const kg = makeKgFake();
    await run(SRC, kg);
    const logWrites = kg.creates.filter((w) => w.recordType === 'log');
    expect(logWrites[0].fields).toEqual({ text: 'id: co-1' });
  });
});
