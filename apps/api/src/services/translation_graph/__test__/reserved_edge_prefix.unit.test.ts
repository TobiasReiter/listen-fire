// `@` names an edge the ENGINE makes (`-[:@old]->`, a write handle's record as
// it stood before the write). The checker never looks such a name up among a
// system's declared edges, so a system that declared one would publish an edge
// no author could reach. The projection leaves one out with a note, and this
// file proves no registered adapter declares one today.

import type { SchemaEntryPoint, SchemaTypeDescriptor } from '../types';
import { instanceSchemaFromDescriptors } from '../movement/schema_projection';
import { staticCatalogFromManifests } from '../movement/catalog';
import { listAdapterTypes } from '../adapters/registry';
import adapterSchemas from '../../../lib/knowledge/movement_handbook/__test__/adapter_schemas.fixture.json';

/** Every edge name a schema publishes, wherever it sits: root collections,
 *  every position's edges, the relationship tables write shapes (and their
 *  discriminated variants) carry. Walked structurally, so the captured JSON and
 *  a projected schema are read the same way without asserting either's type. */
function edgeNamesOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...((key === 'edges' || key === 'collections') && typeof child === 'object' && child !== null
      ? Object.keys(child)
      : []),
    ...edgeNamesOf(child),
  ]);
}

describe('the reserved @ edge prefix', () => {
  it('no edge of any registered adapter as the live catalog projects it starts with @', () => {
    // The fixture is the real catalog's projected output for every registered
    // adapter the dev stack connects (see handbook.unit.test.ts for how it is
    // captured); it is the one offline record of the live describe.
    expect(Object.keys(adapterSchemas.schemas).length).toBeGreaterThan(0);
    const reserved = Object.entries(adapterSchemas.schemas).flatMap(([system, schema]) =>
      edgeNamesOf(schema).filter((edge) => edge.startsWith('@')).map((edge) => `${system}: ${edge}`),
    );
    expect(reserved).toEqual([]);
  });

  it('no edge of any registered adapter as the static catalog projects it starts with @', () => {
    const catalog = staticCatalogFromManifests();
    const reserved = listAdapterTypes().flatMap((slug) => {
      const schema = catalog.instantiate(slug, {});
      return schema === undefined
        ? []
        : edgeNamesOf(schema).filter((edge) => edge.startsWith('@')).map((edge) => `${slug}: ${edge}`);
    });
    expect(reserved).toEqual([]);
  });

  // A second shape, not an Attio copy: a calendar whose event references a
  // venue, so the refusal is proved on whatever a reference is named.
  const entries: SchemaEntryPoint[] = [
    { typeId: 'cal:event', displayName: 'Event', writable: true, readable: true },
    { typeId: 'cal:venue', displayName: 'Venue', writable: false, readable: true },
  ];
  const descriptors = (referenceName: string) =>
    new Map<string, SchemaTypeDescriptor>([
      [
        'cal:event',
        {
          typeId: 'cal:event',
          displayName: 'Event',
          fields: [{ fieldId: 'summary', displayName: 'Summary', kind: 'string', writable: true, required: false }],
          references: [{ fieldId: 'venue_ref', name: referenceName, targetTypeId: 'cal:venue', cardinality: 'one' }],
        },
      ],
      [
        'cal:venue',
        {
          typeId: 'cal:venue',
          displayName: 'Venue',
          fields: [{ fieldId: 'address', displayName: 'Address', kind: 'string', writable: false, required: false }],
          references: [],
        },
      ],
    ]);

  it('an adapter edge starting with @ is left out of the projection, with a note naming the prefix', () => {
    const projected = instanceSchemaFromDescriptors({
      adapterType: 'calendar',
      entries,
      descriptors: descriptors('@old'),
      supportsInPlaceUpdate: false,
    });
    expect(projected.schema.positions['Event'].edges).toEqual({});
    expect(projected.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/'@old'.*'@'.*left out/)]),
    );
    // The same reference named plainly projects, so the leaving-out is the prefix's doing.
    expect(Object.keys(instanceSchemaFromDescriptors({
      adapterType: 'calendar',
      entries,
      descriptors: descriptors('Venue'),
      supportsInPlaceUpdate: false,
    }).schema.positions['Event'].edges)).toEqual(['Venue']);
  });

  it('a root collection starting with @ is left out too — a root collection is an edge', () => {
    const projected = instanceSchemaFromDescriptors({
      adapterType: 'calendar',
      entries: [{ ...entries[0], collectionName: '@events' }, entries[1]],
      descriptors: descriptors('Venue'),
      supportsInPlaceUpdate: false,
    });
    expect(projected.schema.collections['@events']).toBeUndefined();
    expect(projected.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/'@events'.*'@'.*left out/)]),
    );
  });
});
