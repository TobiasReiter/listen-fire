// Dealroom's surface as the authoring agent reads it (the agent projection
// is this app's, so this one case stays here while the adapter's own tests
// moved with the module to modules/dealroom).

import { ADAPTER_META_TYPE_ID, instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';

import { DealroomAdapter } from '@listen-fire/dealroom';
import { normaliseSchemaForAgent } from '../../../movement/agent_schema';

describe('Dealroom, as the agent reads it', () => {
  const adapter = new DealroomAdapter(async () => {
    throw new Error('this test reaches no Dealroom');
  });

  // Dealroom is READ-ONLY, and the surface an authoring agent reads has to say
  // so. Every reference here omits `writable` — which is the read-only fact,
  // not an absent opinion — so describe must report `writable: false` on all of
  // them. It used to fill the absent flag with `true`, and an agent would
  // author `write round-[:Company]-> { … }` that the checker then refused.
  it('describes NOTHING as writable, through the projection the agent reads', async () => {
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const metaDescriptor = await adapter.describe(ADAPTER_META_TYPE_ID);
    const { schema } = instanceSchemaFromDescriptors({
      adapterType: 'dealroom',
      entries,
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate: false,
    });
    const agentSchema = normaliseSchemaForAgent(schema);

    const writable = Object.entries(agentSchema.positions).flatMap(([position, p]) =>
      Object.entries(p.edges)
        .filter(([, edge]) => edge.writable !== false)
        .map(([edge]) => `${position}-[:${edge}]->`),
    );
    expect(writable).toEqual([]);
    // The three the defect was reported on, named so a regression says which.
    expect(agentSchema.positions['Funding Round']?.edges.Company?.writable).toBe(false);
    expect(agentSchema.positions['Team Member']?.edges.Person?.writable).toBe(false);
    expect(agentSchema.positions['Round Investor']?.edges.Investor?.writable).toBe(false);
    // And no write root either — nothing on Dealroom accepts a write at all.
    expect(Object.keys(agentSchema.writableRoots)).toEqual([]);
  });
});
