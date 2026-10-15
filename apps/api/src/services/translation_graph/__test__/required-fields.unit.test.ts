import type { SchemaFieldDescriptor, TGFieldMapping } from 'movement-engine/services/translation_graph/types';

import {
  requiredFieldStatuses,
  unsatisfiedRequiredFields,
  seedRequiredFieldMappings,
} from 'movement-engine/services/translation_graph/required_fields';

function field(over: Partial<SchemaFieldDescriptor> & { fieldId: string }): SchemaFieldDescriptor {
  return {
    displayName: over.fieldId,
    kind: 'string',
    writable: true,
    required: false,
    ...over,
  };
}

function mapping(targetField: string, withExpression: boolean): TGFieldMapping {
  return {
    targetField,
    semantics: 'overwrite',
    ...(withExpression ? { expression: { type: 'static', value: 'x' } } : {}),
  };
}

describe('requiredFieldStatuses', () => {
  const fields = [
    field({ fieldId: 'name', required: true }),
    field({ fieldId: 'stage', required: true }),
    field({ fieldId: 'notes', required: false }),
  ];

  it('marks a required field satisfied only when a mapping carries an expression', () => {
    const statuses = requiredFieldStatuses({
      descriptorFields: fields,
      fieldMappings: [mapping('name', true), mapping('stage', false)],
      isRoot: true,
    });
    const byId = new Map(statuses.map((s) => [s.field.fieldId, s.satisfied]));
    expect(byId.get('name')).toBe(true); // has expression
    expect(byId.get('stage')).toBe(false); // mapping present but no expression
    expect(byId.has('notes')).toBe(false); // not required → not tracked
  });

  it('excludes non-writable required fields (author cannot satisfy them)', () => {
    const statuses = requiredFieldStatuses({
      descriptorFields: [field({ fieldId: 'system_id', required: true, writable: false })],
      fieldMappings: [],
      isRoot: true,
    });
    expect(statuses).toHaveLength(0);
  });

  it('respects hideOn — a root-hidden required field is not required on root actions', () => {
    const fs = [field({ fieldId: 'connection', required: true, hideOn: 'child' })];
    expect(
      requiredFieldStatuses({ descriptorFields: fs, fieldMappings: [], isRoot: true }),
    ).toHaveLength(1); // visible on root
    expect(
      requiredFieldStatuses({ descriptorFields: fs, fieldMappings: [], isRoot: false }),
    ).toHaveLength(0); // hidden on child
  });
});

describe('unsatisfiedRequiredFields', () => {
  it('returns the required fields with no value, empty when complete', () => {
    const fields = [
      field({ fieldId: 'name', required: true }),
      field({ fieldId: 'stage', required: true }),
    ];
    expect(
      unsatisfiedRequiredFields({
        descriptorFields: fields,
        fieldMappings: [mapping('name', true)],
        isRoot: true,
      }).map((f) => f.fieldId),
    ).toEqual(['stage']);

    expect(
      unsatisfiedRequiredFields({
        descriptorFields: fields,
        fieldMappings: [mapping('name', true), mapping('stage', true)],
        isRoot: true,
      }),
    ).toHaveLength(0);
  });
});

describe('seedRequiredFieldMappings', () => {
  it('appends value-less mappings for required fields not already mapped (idempotent)', () => {
    const fields = [
      field({ fieldId: 'name', required: true }),
      field({ fieldId: 'stage', required: true }),
    ];
    const seeded = seedRequiredFieldMappings({
      descriptorFields: fields,
      existingMappings: [mapping('name', true)],
      isRoot: true,
    });
    expect(seeded.map((m) => m.targetField)).toEqual(['name', 'stage']);
    const stage = seeded.find((m) => m.targetField === 'stage')!;
    expect(stage.expression).toBeUndefined(); // seeded without a value
    expect(stage.semantics).toBe('overwrite');

    // Re-seeding the result adds nothing new.
    const reseeded = seedRequiredFieldMappings({
      descriptorFields: fields,
      existingMappings: seeded,
      isRoot: true,
    });
    expect(reseeded).toHaveLength(seeded.length);
  });
});
