import type { FieldMapping } from 'movement-engine/public/output-v3';

interface IdentityField {
  targetField: string;
  value: unknown;
  identity: 'unique' | 'fuzzy';
}

function classifyFieldValues(
  fieldMappings: FieldMapping[],
  fieldValues: Record<string, unknown>,
): IdentityField[] {
  const result: IdentityField[] = [];

  for (const mapping of fieldMappings) {
    const identity = mapping.identity ?? 'none';
    if (identity === 'none') continue;

    const targetField = String(mapping.targetField);
    const value = fieldValues[targetField];
    if (value == null || (typeof value === 'string' && !value.trim())) continue;

    result.push({ targetField, value, identity });
  }

  return result;
}

function getUniqueFields(fields: IdentityField[]): IdentityField[] {
  return fields.filter((f) => f.identity === 'unique');
}

function getFuzzyFields(fields: IdentityField[]): IdentityField[] {
  return fields.filter((f) => f.identity === 'fuzzy');
}

export { classifyFieldValues, getUniqueFields, getFuzzyFields };
export type { IdentityField };
