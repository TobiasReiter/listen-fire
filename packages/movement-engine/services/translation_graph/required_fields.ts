// Required-field satisfaction — the single source of truth for "does this
// action populate every field its target system demands?"
//
// Certain target systems reject a write when a required field is unset (Attio
// `is_required` attributes, a KG node type's identity/unique property, …). The
// adapter contract already surfaces this per field (`SchemaFieldDescriptor.
// required`). This module turns that flag + an action's field mappings into a
// satisfaction verdict, consumed by:
//   - the save gate (reject a TG whose action leaves a required field unset),
//   - the write-time backstop (fail loud if a required value resolves empty),
//   - the editor (seed + lock required rows, mirror the gate inline).
//
// "Satisfied" here means *the author provided a value expression*. Whether that
// expression evaluates to a non-empty value at runtime is the write-time
// backstop's concern, not something we can know at author/save time.

import type { SchemaFieldDescriptor } from './types';
import type { TGFieldMapping } from './types';

export interface RequiredFieldStatus {
  /** The required target field descriptor. */
  field: SchemaFieldDescriptor;
  /** True when a field mapping for it carries a value expression. */
  satisfied: boolean;
}

/**
 * The required fields that *apply* to an action in this position — writable
 * (an author can't satisfy a non-writable field) and not hidden in this
 * root/child context (a field the editor won't render can't be required of the
 * author here). A system-populated required field that is non-writable is not
 * the author's to satisfy, so it is excluded.
 */
export function applicableRequiredFields(input: {
  descriptorFields: SchemaFieldDescriptor[];
  isRoot: boolean;
}): SchemaFieldDescriptor[] {
  return input.descriptorFields.filter((f) => {
    if (!f.required || !f.writable) return false;
    if (f.hideOn === 'root' && input.isRoot) return false;
    if (f.hideOn === 'child' && !input.isRoot) return false;
    return true;
  });
}

/**
 * Per-required-field satisfaction for one action. A required field is satisfied
 * iff some field mapping targets it with a (present) value expression.
 */
export function requiredFieldStatuses(input: {
  descriptorFields: SchemaFieldDescriptor[];
  fieldMappings: TGFieldMapping[];
  isRoot: boolean;
}): RequiredFieldStatus[] {
  const satisfiedTargets = new Set(
    input.fieldMappings
      .filter((m) => m.expression !== undefined)
      .map((m) => m.targetField),
  );
  return applicableRequiredFields(input).map((field) => ({
    field,
    satisfied: satisfiedTargets.has(field.fieldId),
  }));
}

/** The applicable required fields an action leaves unsatisfied (no mapping, or
 *  a mapping with no value expression). Empty when the action is complete. */
export function unsatisfiedRequiredFields(input: {
  descriptorFields: SchemaFieldDescriptor[];
  fieldMappings: TGFieldMapping[];
  isRoot: boolean;
}): SchemaFieldDescriptor[] {
  return requiredFieldStatuses(input)
    .filter((s) => !s.satisfied)
    .map((s) => s.field);
}

/**
 * Field mappings to seed onto a freshly-added action so its required fields are
 * present (target set, value expression intentionally absent) — the locked
 * "you must fill these" checklist. Skips any the existing mappings already
 * cover so re-seeding is idempotent. New rows default to `overwrite` semantics,
 * matching the editor's blank-row default.
 */
export function seedRequiredFieldMappings(input: {
  descriptorFields: SchemaFieldDescriptor[];
  existingMappings: TGFieldMapping[];
  isRoot: boolean;
}): TGFieldMapping[] {
  const existingTargets = new Set(input.existingMappings.map((m) => m.targetField));
  const seeded: TGFieldMapping[] = applicableRequiredFields(input)
    .filter((f) => !existingTargets.has(f.fieldId))
    .map((f) => ({ targetField: f.fieldId, semantics: 'overwrite' as const }));
  return [...input.existingMappings, ...seeded];
}
