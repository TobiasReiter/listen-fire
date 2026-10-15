// A system's resources reference (the reserved `_resources` fieldId — the
// knowledge graph's `Resources`) projects as an ORDINARY edge, walked by its
// name: its landing is reachable type-space (a described position when the
// type was described, an undescribed one otherwise), and the edge carries
// `resources: true` so that, since language version 5, the checker's
// refusal of `x-[f:_resources]->` off a record can name it. Nothing resolves
// `_resources` to it.

import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { RESOURCES_REFERENCE_FIELD_ID } from 'movement-engine/services/translation_graph/adapter';

const entries: SchemaEntryPoint[] = [{ typeId: 'g:company', displayName: 'Company', writable: true, readable: true }];

const company: SchemaTypeDescriptor = {
  typeId: 'g:company',
  displayName: 'Company',
  fields: [{ fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, required: false }],
  references: [
    { fieldId: RESOURCES_REFERENCE_FIELD_ID, name: 'Sources', targetTypeId: 'Source', cardinality: 'many', direction: 'outgoing' },
  ],
};

const source: SchemaTypeDescriptor = {
  typeId: 'Source',
  displayName: 'Source',
  fields: [{ fieldId: 'url', displayName: 'URL', kind: 'string', writable: false, required: false }],
  references: [],
};

describe('the resources reference projects as an ordinary, named edge', () => {
  it('keyed by its name, flagged `resources`, its landing minted (undescribed until described)', () => {
    const projected = instanceSchemaFromDescriptors({
      adapterType: 'graph',
      entries,
      descriptors: new Map([['g:company', company]]),
      supportsInPlaceUpdate: false,
    });
    expect(projected.schema.positions['Company'].edges['Sources']).toEqual({ target: 'Source', resources: true });
    expect(projected.schema.positions['Company'].edges[RESOURCES_REFERENCE_FIELD_ID]).toBeUndefined();
    expect(projected.schema.positions['Source']).toMatchObject({ undescribed: true });
  });

  it('a described landing types its fields', () => {
    const projected = instanceSchemaFromDescriptors({
      adapterType: 'graph',
      entries,
      reached: [{ typeId: 'Source', displayName: 'Source', readable: true, writable: false }],
      descriptors: new Map([
        ['g:company', company],
        ['Source', source],
      ]),
      supportsInPlaceUpdate: false,
    });
    expect(projected.schema.positions['Source'].properties).toEqual({ URL: 'text' });
  });

  it("a system's own edge sharing the name holds it, in either order, and is not flagged", () => {
    const own = { fieldId: 'g:sources', name: 'Sources', targetTypeId: 'g:company', cardinality: 'many' as const, direction: 'outgoing' as const };
    for (const references of [[company.references[0], own], [own, company.references[0]]]) {
      const projected = instanceSchemaFromDescriptors({
        adapterType: 'graph',
        entries,
        descriptors: new Map([['g:company', { ...company, references }]]),
        supportsInPlaceUpdate: false,
      });
      expect(projected.schema.positions['Company'].edges['Sources']).toEqual({ target: 'Company' });
    }
  });
});
