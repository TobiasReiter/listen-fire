// Airtable through the platform's own narrowing pass (the module's unit tests
// cover the adapter; this pass is the host's). The fake Airtable is the
// module's own test double.

import { scanInstanceChains } from 'movement-lang';

import type { AirtableAdapter } from '@listen-fire/airtable';

import { dealsTable, makeMultiBaseAdapter, tasksTable } from '@listen-fire/airtable/__test__/fake_adapter';
import { instanceSchemaFromDescriptors, makeMetaPosition, positionData } from 'movement-engine/public/catalog';
import { refineInstanceSchema } from '../../../movement/refinements';

describe('the table write promise reaches the CHECKER projection, through the host refinement', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });

  /** The unpositioned instance's schema exactly as the catalog assembles it:
   *  the published entries, each described, through the real projection. */
  async function projectUnpositioned(adapter: AirtableAdapter) {
    const entries = await adapter.listEntryPoints();
    const described = await Promise.all(
      entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
    );
    const projection = instanceSchemaFromDescriptors({
      adapterType: 'airtable',
      entries,
      descriptors: new Map(described.flatMap(([id, d]) => (d ? [[id, d] as const] : []))),
      supportsInPlaceUpdate: false,
    });
    return { entries, projection };
  }

  const source = `import { airtable } from adapters
import { airtable_cred } from credentials
air = airtable(credentials: airtable_cred)
movement m(x: <air-[:\`Record Change\`]->>) {
  air-[b:Base WHERE \`Name\` == "CRM"]-> {
    write b-[:\`Deals\`]-> { Name: "X" }
  }
}`;

  it('a narrowed base\'s table edge is writable at the checker', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-write',
      bases: [crm(), ops()],
    });
    const { entries, projection } = await projectUnpositioned(adapter);

    // The refined position the checker looks up — produced by the same
    // `refineInstanceSchema` the catalog runs, off the real `describe('CRM')`.
    const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));
    const { schema } = await refineInstanceSchema({
      instance: {
        adapterType: 'airtable',
        schema: projection.schema,
        entryPoints: entries.map((e) => ({
          typeId: e.typeId,
          displayName: e.displayName,
          writable: e.writable === true,
          readable: e.readable === true,
        })),
        describeType: (typeName: string) => adapter.describe(typeName),
        membersOf: async () =>
          Object.values(hop?.targetPositions ?? {}).map((position) => {
            const data = positionData(position) as { Name: string };
            return { name: data.Name, data };
          }),
      },
      chains: scanInstanceChains(source),
    });

    const refined = schema.positions['Base "CRM"'];
    expect(refined).toBeDefined();
    expect(refined!.edges.Deals).toMatchObject({ target: 'Deals', writable: true });
  });

});
