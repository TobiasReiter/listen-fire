// The write door's value layer: one gate, one coercion, one vocabulary for
// "what a property write is". Every caller that used to own a private copy of
// these rules (the kg adapter, the graph editor, the agent CRUD) now shares
// this one.

import { sql } from 'kysely';

import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';

import EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import PropertyCardinality from '../../../generated/kysely/knowledge/PropertyCardinality';
import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import { isWritableBy } from '../writable_by';
import { coerceNumeric, unionTextSet } from '../property_policies';

/** Everything the door needs to know about a property type to write it. */
export interface PropertyTypeFacts {
  id: PropertyTypeId;
  name: string;
  description: string;
  value_type: PropertyValueType;
  cardinality: PropertyCardinality;
  evaluation_strategy: EvaluationStrategy;
  writable_by: EvidenceType[] | string | null;
  edge_type_id: EdgeTypeId | null;
}

/**
 * A write the ontology forbids. Thrown — never logged-and-skipped (D37c): a
 * movement writing a field its property type refuses should fail its run where
 * the author can see it, and a UI edit should say so out loud. If a legitimate
 * flow hits this, the property type's `writable_by` DATA is what needs fixing.
 */
export class KnowledgeWriteRefused extends Error {
  readonly propertyTypeId: string;
  readonly propertyName: string;
  readonly evidenceType: EvidenceType;
  readonly writableBy: readonly string[] | null;

  constructor(input: {
    propertyTypeId: string;
    propertyName: string;
    evidenceType: EvidenceType;
    writableBy: readonly string[] | null;
  }) {
    super(
      `Property "${input.propertyName}" does not accept ${input.evidenceType} writes` +
        (input.writableBy ? ` (it accepts: ${input.writableBy.join(', ')})` : ''),
    );
    this.name = 'KnowledgeWriteRefused';
    this.propertyTypeId = input.propertyTypeId;
    this.propertyName = input.propertyName;
    this.evidenceType = input.evidenceType;
    this.writableBy = input.writableBy;
  }
}

function normalizeWritableBy(raw: EvidenceType[] | string | null): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  const inner = raw.replace(/^\{|\}$/g, '');
  return inner ? inner.split(',') : [];
}

/**
 * The uniform gate (D37b). Every property write on every path passes here.
 *
 * An arbitration ruling passes unconditionally, because the gate answers "may
 * this SOURCE assert a value here" and a ruling is not a source — it is the
 * conclusion drawn from sources this same gate already admitted (D42). Gating it
 * would refuse every `evaluation_strategy: llm` property whose `writable_by`
 * names the source types it arbitrates, which is all of them.
 */
export function assertWritable(pt: PropertyTypeFacts, evidenceType: EvidenceType): void {
  if (evidenceType === EvidenceType.arbitration) return;
  if (isWritableBy(pt.writable_by, evidenceType)) return;
  throw new KnowledgeWriteRefused({
    propertyTypeId: pt.id,
    propertyName: pt.name,
    evidenceType,
    writableBy: normalizeWritableBy(pt.writable_by),
  });
}

/** The six value columns, always written together so a type change leaves no stale column behind. */
export interface ValueColumns {
  value_text: string | null;
  value_text_array: string[] | null;
  value_number: string | null;
  value_date: Date | string | null;
  value_boolean: boolean | null;
  value_json: unknown;
}

const CLEARED: ValueColumns = {
  value_text: null,
  value_text_array: null,
  value_number: null,
  value_date: null,
  value_boolean: null,
  value_json: null,
};

/** A `null` write is a CLEAR: the row and its evidence history survive (D37a). */
export function clearedColumns(): ValueColumns {
  return { ...CLEARED };
}

/**
 * The one coercion (D37d). The adapter's numeric handling wins — extraction
 * output arrives as "$5M" / "5,000" / "5%" and must land as a number — and the
 * json branch is real: an object becomes jsonb rather than the agent's
 * `"[object Object]"` or a shape pg turns into an array literal.
 *
 * Multi-cardinality text unions case-insensitively against what is already
 * stored; `value_text` mirrors the first element so single-value read paths
 * (display names, retrieval) still answer.
 */
export function coerceValue(
  pt: PropertyTypeFacts,
  value: unknown,
  existingArray?: readonly string[] | null,
): ValueColumns {
  if (value === null || value === undefined) return clearedColumns();

  if (pt.cardinality === PropertyCardinality.multi) {
    if (pt.value_type !== PropertyValueType.text) {
      throw new Error(
        `Knowledge graph multi-cardinality is only supported for text properties (property_type ${pt.id} has value_type=${pt.value_type}). Add value_${pt.value_type}_array storage before declaring this property multi.`,
      );
    }
    const incoming = Array.isArray(value) ? value.map((v) => String(v)) : [String(value)];
    const merged = unionTextSet(existingArray ?? null, incoming);
    return { ...CLEARED, value_text_array: merged, value_text: merged[0] ?? null };
  }

  switch (pt.value_type) {
    case PropertyValueType.text:
      return { ...CLEARED, value_text: String(value) };
    case PropertyValueType.number:
      return { ...CLEARED, value_number: coerceNumeric(value) };
    case PropertyValueType.date:
      // A Date rides as a Date; a string rides verbatim, so pg parses the
      // timestamp text rather than us round-tripping it through a timezone.
      return { ...CLEARED, value_date: value instanceof Date ? value : String(value) };
    case PropertyValueType.boolean:
      return { ...CLEARED, value_boolean: Boolean(value) };
    case PropertyValueType.json:
      return { ...CLEARED, value_json: jsonbValue(value) };
  }
}

/** jsonb the one way that survives objects, arrays and scalars alike. */
export function jsonbValue(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb`;
}

export { EvidenceType, PropertyCardinality, PropertyValueType };
