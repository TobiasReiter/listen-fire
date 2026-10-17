// Airtable TG adapter — shared types and the Airtable-field-type constant
// sets. A TG type is an Airtable *table*; the framework names it by its own
// name within its base (bases are the instance's entry position, so the
// namespace is one base — see 5_paths_as_addresses.md), and the adapter recovers the
// `{ baseId, tableId }` the Airtable API routes on from that name through its
// private name → structured-identifier cache (`schema_catalog.loadTableCatalog`).
// There is deliberately NO `encode/decodeTypeId` magic-string codec: an
// identifier is never flattened into a string and crammed onto a position.

import { z } from 'zod';

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const AIRTABLE_ADAPTER_TYPE = 'airtable';

/** Airtable field type whose value is a `string[]` of linked record ids —
 *  modeled as a TG `reference` (non-polymorphic) to the linked table. */
export const LINK_FIELD_TYPE = 'multipleRecordLinks';

/**
 * Airtable field types that require numeric values. Lifted verbatim from
 * the v3 output (`output_v3/adapters/airtable.ts`) — the behavioral
 * reference for coercion. `coerceAirtableValue` runs `Number()` over these.
 */
export const NUMERIC_FIELD_TYPES = new Set<string>([
  'number',
  'percent',
  'currency',
  'duration',
  'rating',
  'count',
  'autoNumber',
]);

/**
 * Read-only Airtable field types (P2). These are surfaced in `describe`
 * with `writable: false` and silently-but-visibly filtered from writes
 * (a `logger.debug`, not a buried warning). The set mirrors the model
 * table in `3_model.md`: computed / system-stamped / derived fields.
 */
export const READ_ONLY_FIELD_TYPES = new Set<string>([
  'formula',
  'lookup',
  'multipleLookupValues',
  'rollup',
  'autoNumber',
  'count',
  'button',
  'barcode',
  'createdBy',
  'createdTime',
  'lastModifiedBy',
  'lastModifiedTime',
  'externalSyncSource',
  'aiText',
]);

/** The Airtable API's structured routing identifier for a table — the value
 *  the name → structured-identifier cache yields for a table's displayName.
 *  This is the adapter's PRIVATE currency; it never appears on a position. */
export interface AirtableTableId {
  baseId: string;
  tableId: string;
}

// ── Credential parser ──────────────────────────────────────────────────────
// Mirrors `airtableCredsParser` from the apiClient; re-declared here so the
// adapter validates the decrypted payload at its own boundary (same shape).

export const airtableAdapterCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshTokenExpiresAt: z.string(),
  baseUrl: z.string().url().optional(),
});

export type AirtableAdapterCreds = z.infer<typeof airtableAdapterCredsParser>;

// ── Airtable schema shapes (subset the adapter consumes) ───────────────────
// The apiClient's `listTables` returns richer rows; the adapter only reads
// these fields. Kept structural so the apiClient's parsed shape is assignable.

export interface AirtableFieldMeta {
  id: string;
  name: string;
  type?: string;
  options?: unknown;
  description?: string;
}

export interface AirtableTableMeta {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: AirtableFieldMeta[];
  description?: string;
}

/** The meta types a walk lands on: a base, and a table within it. */
export const BASE_META_TYPE = 'Base';
export const TABLE_META_TYPE = 'Table';
