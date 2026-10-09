// Airtable TG adapter — record-level operations: entity resolution, field
// reads, reference traversal, no-op reads, and writes. The pure field-coercion
// + linked-record-resolution helpers are lifted from the v3 output
// (`output_v3/adapters/airtable.ts`) — copied, not imported (P4), so the TG
// adapter carries its own behavioral reference.

import type { AirtableAPIClient } from '../../../../adapters/airtable/apiClient';
import type { UniquenessConstraints } from '../../uniqueness';
import type {
  ResolveEntityInput,
  ResolveEntityResult,
  ExternalRecordRef,
  FileRef,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  ReadInput,
  WriteInput,
  WriteResult,
  UpdateInput,
  UpdateResult,
  ParentAssociation,
  DeleteInput,
  DeleteResult,
  LinkedObjectCandidate,
} from '../../adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { hasFileSource, streamFileRef } from '../../engine/files/retrieve';
import { logger } from '../../../logger';
import { exposeFile } from '../../engine/files/expose';
import { UPDATE_NOT_FOUND, isHttp404 } from '../not_found';
import {
  isStablePosition,
  makeStablePosition,
  positionData,
  positionRecordId,
  type SourcePosition,
} from '../../types';
import {
  AIRTABLE_ADAPTER_TYPE,
  LINK_FIELD_TYPE,
  NUMERIC_FIELD_TYPES,
  READ_ONLY_FIELD_TYPES,
  type AirtableTableId,
  type AirtableFieldMeta,
  type AirtableTableMeta,
} from './types';
import { cachedTables } from './schema_catalog';

// ── Pure helpers (lifted verbatim from output_v3/adapters/airtable.ts) ──────

export function coerceAirtableValue(value: unknown, fieldType: string | undefined): unknown {
  if (value == null) return value;
  if (!fieldType) return value;

  if (NUMERIC_FIELD_TYPES.has(fieldType)) {
    if (typeof value === 'number') return value;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  if (fieldType === 'checkbox') {
    if (typeof value === 'boolean') return value;
    const str = String(value).trim().toLowerCase();
    if (str === 'true' || str === '1' || str === 'yes') return true;
    if (str === 'false' || str === '0' || str === 'no' || str === '') return false;
    return null;
  }

  if (fieldType === 'multipleSelects') {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(/,\s*/).filter((s) => s.length > 0);
    return value;
  }

  if (fieldType === 'date' || fieldType === 'dateTime') {
    // Airtable accepts ISO 8601 for date/dateTime fields — normalise a Date or
    // a parseable date string to ISO so the value lands as a real date; pass an
    // unparseable value through untouched (Airtable will reject/ignore it).
    if (value instanceof Date) return value.toISOString();
    const ms = Date.parse(String(value));
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }

  return value;
}

export function coerceToName(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v != null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.id === 'string') return obj.id;
  }
  const s = String(v);
  return s === '[object Object]' ? '' : s;
}

/** An already-resolved Airtable link value — a `rec…` id as a bare string or a
 *  `{ id: "rec…" }` object. Returns the id, or null when the element is a name
 *  that still needs resolving. (A `+:` append hands a MIXED list — current
 *  record ids merged with new names — so we classify element-by-element.) */
function asLinkRecordId(v: unknown): string | null {
  if (typeof v === 'string') return v.startsWith('rec') ? v : null;
  if (v != null && typeof v === 'object') {
    const id = (v as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('rec')) return id;
  }
  return null;
}

/** De-dupe preserving first-seen order. */
function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function escapeAirtableString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildAirtableUrl(baseId: string, tableId: string, recordId: string): string {
  return `https://airtable.com/${baseId}/${tableId}/${recordId}`;
}

export function buildRecordData(input: {
  record: { id: string; fields?: Record<string, unknown> };
  baseId: string;
  tableId: string;
  primaryFieldId: string | undefined;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    url: buildAirtableUrl(input.baseId, input.tableId, input.record.id),
  };
  if (input.primaryFieldId && input.record.fields) {
    const primary = input.record.fields[input.primaryFieldId];
    if (primary != null && typeof primary !== 'object') {
      data.name = String(primary);
    }
  }
  return data;
}

/**
 * Resolve `multipleRecordLinks` fields in-place: each link field's value may
 * be record-name strings (extracted upstream) rather than `rec…` ids; look
 * the names up in the linked table (exact `filterByFormula` first, fuzzy
 * `SEARCH` fallback) and replace with the matched record ids. Lifted from the
 * v3 output — same exact-then-fuzzy strategy. The TG adapter has no inline
 * LLM pick, so the fuzzy step here accepts the single best SEARCH hit per
 * name when there's exactly one candidate, and otherwise leaves it to exact
 * matching; identity arbitration for the *action target itself* is the
 * engine's job (resolveEntity), not for link sub-resolution.
 */
export async function resolveLinkedRecordFields(input: {
  client: AirtableAPIClient;
  baseId: string;
  fields: Record<string, unknown>;
  fieldMetaByKey: Map<string, AirtableFieldMeta>;
  tables: AirtableTableMeta[];
}): Promise<void> {
  const { client, baseId, fields, fieldMetaByKey, tables } = input;
  for (const [fieldId, value] of Object.entries(fields)) {
    const meta = fieldMetaByKey.get(fieldId);
    if (meta?.type !== LINK_FIELD_TYPE) continue;

    // Normalise to a flat list, then classify each element: an already-resolved
    // `rec…` id passes through; anything else is a name to look up. A `+:`/`+?:`
    // append hands a MIXED list (current ids merged with new names), so we never
    // skip the whole field based on the first element.
    const elements: unknown[] =
      typeof value === 'string'
        ? value.split(/,\s*/).filter((s) => s.length > 0)
        : Array.isArray(value)
          ? value
          : value == null
            ? []
            : [value];

    const passThroughIds: string[] = [];
    const names: string[] = [];
    for (const el of elements) {
      const id = asLinkRecordId(el);
      if (id) {
        passThroughIds.push(id);
        continue;
      }
      const name = coerceToName(el);
      if (name.length > 0) names.push(name);
    }

    // Nothing to resolve — already a (possibly empty) list of record ids.
    if (names.length === 0) {
      fields[fieldId] = uniqueIds(passThroughIds);
      continue;
    }

    const linkedTableId = (meta.options as { linkedTableId?: string } | undefined)?.linkedTableId;
    const linkedTable = linkedTableId ? tables.find((t) => t.id === linkedTableId) : undefined;
    const primaryFieldId = linkedTable?.primaryFieldId;
    const primaryFieldName = primaryFieldId
      ? linkedTable?.fields.find((f) => f.id === primaryFieldId)?.name
      : undefined;
    if (!linkedTableId || !linkedTable || !primaryFieldId || !primaryFieldName) {
      // Can't resolve names (the link's target table / primary field isn't
      // available). Write the record ids we already hold rather than silently
      // dropping the whole field — and say so loudly.
      logger.warn(
        `[AirtableAdapter] link field "${fieldId}": cannot resolve ${names.length} name(s) — ` +
          `linked table or primary field unavailable; writing only the ${passThroughIds.length} record id(s) provided`,
      );
      fields[fieldId] = uniqueIds(passThroughIds);
      continue;
    }

    const exactFormula =
      names.length === 1
        ? `{${primaryFieldName}} = "${escapeAirtableString(names[0])}"`
        : `OR(${names.map((n) => `{${primaryFieldName}} = "${escapeAirtableString(n)}"`).join(',')})`;
    const exactRecords = await client.listRecords({
      baseId,
      tableId: linkedTableId,
      fieldId: primaryFieldId,
      filterByFormula: exactFormula,
    });

    const exactByName = new Map<string, string>();
    for (const r of exactRecords) {
      const val = r.fields[primaryFieldName];
      if (typeof val === 'string') exactByName.set(val, r.id);
    }

    const resolvedIds: string[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
      const exactId = exactByName.get(name);
      if (exactId) {
        resolvedIds.push(exactId);
        continue;
      }
      const fuzzyId = await fuzzySearchRecord({
        client,
        baseId,
        tableId: linkedTableId,
        fieldId: primaryFieldId,
        primaryFieldName,
        query: name,
      });
      if (fuzzyId) resolvedIds.push(fuzzyId);
      else unresolved.push(name);
    }

    if (unresolved.length > 0) {
      // Surface the miss LOUDLY rather than silently truncating: the field is
      // written with whatever resolved (replace semantics — use `:` to replace
      // or `+:`/`+?:` to append to the existing links).
      logger.warn(
        `[AirtableAdapter] link field "${fieldId}": ${unresolved.length} of ${names.length} value(s) ` +
          `did not match a record in "${linkedTable.name}" and were dropped`,
        { unresolved },
      );
    }
    // Always write the resolved set (ids that passed through + names that
    // resolved), de-duped. The engine has already applied the author's
    // replace/append precedence to `value`; the adapter faithfully writes it.
    fields[fieldId] = uniqueIds([...passThroughIds, ...resolvedIds]);
  }
}

/**
 * SEARCH-based fuzzy candidate gather for a single name. Returns the single
 * best record id when the server-side SEARCH yields exactly one candidate;
 * null otherwise (ambiguous / empty). The v3 output used an inline LLM to
 * pick among multiple — the TG adapter intentionally does not (link
 * sub-resolution must stay deterministic and LLM-free); ambiguity is dropped
 * rather than guessed.
 */
export async function fuzzySearchRecord(input: {
  client: AirtableAPIClient;
  baseId: string;
  tableId: string;
  fieldId: string;
  primaryFieldName: string;
  query: string;
}): Promise<string | null> {
  const { client, baseId, tableId, fieldId, primaryFieldName, query } = input;
  const words = query.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return null;

  const searchClauses = words.map(
    (w) => `SEARCH(LOWER("${escapeAirtableString(w)}"), LOWER({${primaryFieldName}}))`,
  );
  const formula = searchClauses.length === 1 ? searchClauses[0] : `OR(${searchClauses.join(',')})`;

  const candidates = await client.listRecords({ baseId, tableId, fieldId, filterByFormula: formula });
  if (candidates.length !== 1) return null;
  return candidates[0].id;
}

// ── Internal: table-metadata helpers ────────────────────────────────────────

interface TableContext {
  table: AirtableTableMeta;
  fieldMetaByKey: Map<string, AirtableFieldMeta>;
  fieldNameById: Map<string, string>;
}

async function loadTableContext(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
  tableId: string;
}): Promise<TableContext | null> {
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId: input.baseId,
  });
  const table = tables.find((t) => t.id === input.tableId);
  if (!table) return null;
  const fieldMetaByKey = new Map<string, AirtableFieldMeta>();
  const fieldNameById = new Map<string, string>();
  for (const f of table.fields) {
    fieldMetaByKey.set(f.id, f);
    fieldMetaByKey.set(f.name, f);
    fieldNameById.set(f.id, f.name);
  }
  return { table, fieldMetaByKey, fieldNameById };
}

// ── resolveEntity ────────────────────────────────────────────────────────
// Two stages, lowest-cost first (mirrors Attio):
//   1. Bridge: surface any linked_object already mapping this record type.
//   2. Constraint search: translate the engine-supplied uniqueness
//      constraints into a `filterByFormula` over the designated identity
//      fields (NOT primary-by-default), exact-equality. Fuzzy entries mark
//      the branch `allEntriesExact:false` so the engine's judge arbitrates.

export async function resolveEntity(input: {
  client: AirtableAPIClient;
  teamId: string;
  /** The recordType's routing ids, resolved from its name by the caller. May
   *  be undefined for an unknown type — the bridge stage still runs (it matches
   *  on the persisted `external_object_type` label, which needs no ids); the
   *  constraint search then yields no candidates. */
  ids: AirtableTableId | undefined;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const bridge = resolveByBridge(input.resolve);
  if (bridge) return bridge;
  return resolveByConstraints(input);
}

function resolveByBridge(resolve: ResolveEntityInput): ResolveEntityResult | null {
  if (resolve.candidates.length === 0) return null;
  const matching = resolve.candidates
    .filter((c: LinkedObjectCandidate) => c.external_object_type === resolve.recordType)
    .sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    );
  if (matching.length === 0) return null;
  return {
    candidates: [
      {
        adapterType: AIRTABLE_ADAPTER_TYPE,
        externalId: matching[0].external_id,
        data: {},
      },
    ],
  };
}

type ScalarEntry = { fieldId: string; value: string; fuzzy: boolean };
type Branch = { entries: ScalarEntry[] };

/**
 * Translate the opaque `constraints` (OR-of-AND of `{ field, fuzzy? }`) + the
 * asserted `record` into branches of scalar field=value tuples, then build one
 * `filterByFormula` per branch (AND within a branch, OR across branches), run
 * it via `listRecords`, and return flat candidates. The engine arbitrates
 * exactness (3b §3.2); the adapter only builds the search.
 */
async function resolveByConstraints(input: {
  client: AirtableAPIClient;
  teamId: string;
  ids: AirtableTableId | undefined;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const { resolve, ids } = input;
  if (resolve.constraints.any.length === 0) return { candidates: [] };
  if (!ids) return { candidates: [] };

  const ctx = await loadTableContext({
    client: input.client,
    teamId: input.teamId,
    baseId: ids.baseId,
    tableId: ids.tableId,
  });
  if (!ctx) return { candidates: [] };

  const branches = buildBranches({ constraints: resolve.constraints, record: resolve.record });
  if (branches.length === 0) return { candidates: [] };

  const branchFormulas = branches
    .map((b) => buildBranchFormula({ branch: b, fieldNameById: ctx.fieldNameById }))
    .filter((f): f is string => f !== null);
  if (branchFormulas.length === 0) return { candidates: [] };

  const filterByFormula =
    branchFormulas.length === 1 ? branchFormulas[0] : `OR(${branchFormulas.join(',')})`;

  let records: { id: string; fields: Record<string, unknown> }[];
  try {
    records = await input.client.listRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      filterByFormula,
    });
  } catch (err) {
    logger.warn('[AirtableAdapter.resolveByConstraints] filter query failed', {
      recordType: resolve.recordType,
      error: err instanceof Error ? err.message : String(err),
    });
    return { candidates: [] };
  }

  if (records.length === 0) return { candidates: [] };

  // Flat-currency candidates — the engine arbitrates exactness over the
  // held constraints in T2 (no per-candidate flag on the currency).
  const candidates: ExternalRecordRef[] = records.map((rec) => {
    const data: Record<string, unknown> = {};
    for (const [fid, raw] of Object.entries(rec.fields)) {
      if (raw === null || raw === undefined || raw === '') continue;
      data[ctx.fieldNameById.get(fid) ?? fid] = raw;
    }
    return { adapterType: AIRTABLE_ADAPTER_TYPE, externalId: rec.id, data };
  });

  return { candidates };
}

function buildBranches(input: {
  constraints: UniquenessConstraints;
  record: Record<string, unknown>;
}): Branch[] {
  const branches: Branch[] = [];
  for (const branch of input.constraints.any) {
    let usable = true;
    let expanded: ScalarEntry[][] = [[]];
    for (const entry of branch.all) {
      const fieldId = entry.field;
      const raw = input.record[fieldId];
      if (raw === null || raw === undefined || raw === '') {
        usable = false;
        break;
      }
      const values = (Array.isArray(raw) ? raw : [raw]).filter(
        (v) => v !== null && v !== undefined && v !== '',
      );
      if (values.length === 0) {
        usable = false;
        break;
      }
      const next: ScalarEntry[][] = [];
      for (const partial of expanded) {
        for (const v of values) {
          next.push([...partial, { fieldId, value: String(v), fuzzy: !!entry.fuzzy }]);
        }
      }
      expanded = next;
    }
    if (!usable) continue;
    for (const entries of expanded) {
      if (entries.length > 0) branches.push({ entries });
    }
  }
  return branches;
}

function buildBranchFormula(input: {
  branch: Branch;
  fieldNameById: Map<string, string>;
}): string | null {
  const clauses: string[] = [];
  for (const entry of input.branch.entries) {
    const fieldName = input.fieldNameById.get(entry.fieldId);
    // A constraint may reference a field id that isn't on this table
    // (mis-authored / stale). Skip the whole branch rather than emit a
    // malformed formula.
    if (!fieldName) return null;
    clauses.push(`{${fieldName}} = "${escapeAirtableString(entry.value)}"`);
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `AND(${clauses.join(',')})`;
}

// ── getFieldValue ──────────────────────────────────────────────────────────
// Airtable record positions store the record's flat `fields` map on
// `position.data`. Reads are a direct lookup by field id.

export async function getFieldValue(input: {
  adapterType: string;
  get: GetFieldValueInput;
}): Promise<unknown> {
  if (input.get.position.adapterType !== input.adapterType) {
    throw new Error(
      `AirtableAdapter.getFieldValue expects ${input.adapterType} positions; got ${input.get.position.adapterType}`,
    );
  }
  const data = positionData(input.get.position) as Record<string, unknown> | null | undefined;
  if (!data) return null;
  return data[input.get.fieldId] ?? null;
}

/**
 * A COLLECTION hop — the records IN a table, as positions.
 *
 * The read a movement makes when it starts from a container rather than from a
 * record: the root of a base-positioned instance (`at-[c:`Deals`]->`), or a
 * base reached by traversal (`-[b:Base WHERE `Name` == "CRM"]->-[c:`Deals`]->`).
 * Both were published as READABLE and neither worked — the first threw (a meta
 * position isn't a record), the second silently returned nothing. An adapter
 * that says `readable: true` and then can't read is the lie this closes.
 */
export async function listCollection(input: {
  client: AirtableAPIClient;
  adapterType: string;
  baseId: string;
  tableId: string;
  /** The table's own name — what the emitted positions are typed by. */
  tableName: string;
}): Promise<RelatedResult[]> {
  const records = await input.client.listRecords({
    baseId: input.baseId,
    tableId: input.tableId,
  });
  return records.map((record) => ({
    position: makeStablePosition({
      adapterType: input.adapterType,
      recordType: input.tableName,
      recordId: record.id,
      data: record.fields ?? {},
    }),
  }));
}

// ── getRelated ─────────────────────────────────────────────────────────────
// `multipleRecordLinks` references: the field value on the source record is a
// `string[]` of linked record ids. Fetch each via `getRecord` and yield one
// position per linked record, typed to the linked table.

export async function getRelated(input: {
  client: AirtableAPIClient;
  teamId: string;
  adapterType: string;
  /** The source position's routing ids, resolved from its recordType name.
   *  Undefined when the name isn't a known table — an empty traversal (the
   *  graceful path the old decode-miss took). */
  ids: AirtableTableId | undefined;
  /** `tableId` → displayName, so a landing position is stamped with the linked
   *  table's NAME (never an encoded id). From the same private catalog. */
  nameByTableId: Map<string, string>;
  get: GetRelatedInput;
}): Promise<RelatedResult[]> {
  if (input.get.direction !== 'outgoing') {
    throw new Error(
      'AirtableAdapter.getRelated only supports outgoing direction (Airtable links are unidirectional from the holder).',
    );
  }
  const position = input.get.position;
  if (position.adapterType !== input.adapterType) {
    throw new Error(
      `AirtableAdapter.getRelated expects ${input.adapterType} positions; got ${position.adapterType}`,
    );
  }
  if (!isStablePosition(position) || position.recordType === null) {
    throw new Error(
      'AirtableAdapter.getRelated expects a stable Airtable record position with a known type.',
    );
  }

  const { ids } = input;
  if (!ids) return [];
  const ctx = await loadTableContext({
    client: input.client,
    teamId: input.teamId,
    baseId: ids.baseId,
    tableId: ids.tableId,
  });
  if (!ctx) return [];

  const meta = ctx.fieldMetaByKey.get(input.get.fieldId);
  if (meta?.type !== LINK_FIELD_TYPE) {
    throw new Error(
      `AirtableAdapter.getRelated: field "${input.get.fieldId}" is not a multipleRecordLinks reference on ${position.recordType}.`,
    );
  }
  const linkedTableId = (meta.options as { linkedTableId?: string } | undefined)?.linkedTableId;
  if (!linkedTableId) return [];
  // Stamp the emitted landings with the linked table's NAME — the framework
  // identity. A chained `getRelated` resolves it straight back to its ids.
  const linkedTypeName = input.nameByTableId.get(linkedTableId);
  if (!linkedTypeName) {
    logger.warn('[AirtableAdapter.getRelated] linked table not in catalog — cannot name landings', {
      linkedTableId,
    });
    return [];
  }

  const data = positionData(position) as Record<string, unknown> | null | undefined;
  const raw = data?.[input.get.fieldId];
  const linkedIds = Array.isArray(raw)
    ? raw
        .map((v) =>
          typeof v === 'string'
            ? v
            : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string'
              ? (v as { id: string }).id
              : null,
        )
        .filter((v): v is string => v !== null)
    : [];

  if (linkedIds.length === 0) return [];

  // Batch-fetch the linked records — one filtered `listRecords` per chunk
  // (`OR(RECORD_ID()=…)`) instead of an N+1 per-record GET. Chunked so the
  // formula stays within Airtable's request-URL bound; `listRecords` pages
  // internally.
  const RECORD_ID_CHUNK = 50;
  const recordById = new Map<string, { id: string; fields?: Record<string, unknown> }>();
  for (let i = 0; i < linkedIds.length; i += RECORD_ID_CHUNK) {
    const chunk = linkedIds.slice(i, i + RECORD_ID_CHUNK);
    const formula = `OR(${chunk.map((id) => `RECORD_ID()="${id}"`).join(',')})`;
    try {
      const records = await input.client.listRecords({
        baseId: ids.baseId,
        tableId: linkedTableId,
        filterByFormula: formula,
      });
      for (const r of records) recordById.set(r.id, r);
    } catch (err) {
      logger.warn('[AirtableAdapter.getRelated] batch fetch of linked records failed', {
        linkedTableId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Emit in the link field's own order; drop any id the batch didn't return
  // (deleted/inaccessible record).
  const results: RelatedResult[] = [];
  for (const recordId of linkedIds) {
    const record = recordById.get(recordId);
    if (!record) continue;
    results.push({
      position: makeStablePosition({
        adapterType: input.adapterType,
        recordType: linkedTypeName,
        recordId: record.id,
        data: record.fields ?? {},
      }),
    });
  }
  return results;
}

// ── readRecord ─────────────────────────────────────────────────────────────

export async function readRecord(input: {
  client: AirtableAPIClient;
  ids: AirtableTableId;
  read: ReadInput;
}): Promise<Record<string, unknown> | null> {
  try {
    const record = await input.client.getRecord({
      baseId: input.ids.baseId,
      tableId: input.ids.tableId,
      recordId: input.read.externalId,
    });
    return record.fields ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('404')) return null;
    throw err;
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * Build the Airtable write payload from the engine-supplied `fields`:
 * drop nulls, filter read-only field types (debug-logged, not warned),
 * coerce each value to its field type, resolve `multipleRecordLinks` (names
 * → record ids), and honor each `parentLink` by setting the matching link
 * field (a linked write is the 1-element case of the general N-parent list).
 */
async function buildWritePayload(input: {
  client: AirtableAPIClient;
  teamId: TeamId;
  ctx: TableContext;
  baseId: string;
  tables: AirtableTableMeta[];
  fields: Record<string, unknown>;
  parentLinks: WriteInput['parentLinks'];
}): Promise<{ fields: Record<string, unknown>; association: ParentAssociation }> {
  const { ctx } = input;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (value == null) continue;
    const meta = ctx.fieldMetaByKey.get(key);
    if (meta && READ_ONLY_FIELD_TYPES.has(meta.type ?? '')) {
      logger.debug('[AirtableAdapter] skipping read-only field on write', {
        fieldId: key,
        fieldType: meta.type,
      });
      continue;
    }
    const coerced = coerceAirtableValue(value, meta?.type);
    if (coerced == null) continue;
    fields[key] = coerced;
  }

  await resolveLinkedRecordFields({
    client: input.client,
    baseId: input.baseId,
    fields,
    fieldMetaByKey: ctx.fieldMetaByKey,
    tables: input.tables,
  });

  await resolveAttachmentFields({ teamId: input.teamId, fields, fieldMetaByKey: ctx.fieldMetaByKey });

  // Parent linking: each edge name resolves to a multipleRecordLinks field on
  // this (child) table; set it to the parent's external record id. A linked
  // write carries one parent, a tuple write N — each lands its own link field.
  //
  // A parent whose edge names no link field on this table cannot be wired at
  // all. On a create that only cost the edge; on an UPDATE the write reports
  // itself as an attach, so the fact has to travel: `unsupported`, and the
  // engine fails the write rather than claiming a link nobody made.
  let association: ParentAssociation = 'none';
  for (const parentLink of input.parentLinks ?? []) {
    const linkField = resolveParentLinkField({ ctx, edgeName: parentLink.edgeName });
    if (linkField) {
      fields[linkField] = [parentLink.externalId];
      if (association !== 'unsupported') association = 'made';
    } else {
      association = 'unsupported';
      logger.warn('[AirtableAdapter] parentLink edge did not resolve to a link field', {
        edgeName: parentLink.edgeName,
      });
    }
  }

  return { fields, association };
}

/** One Airtable attachment cell entry built from a FileRef. Airtable fetches
 *  `url` server-side, so we redeem the FileRef for its bytes and expose them
 *  at a short-lived Listen-Fire URL (`exposeFile`). A value that carries only a
 *  plain display `url` (no source) is used directly. Returns null when
 *  neither is available. */
async function toAttachmentObject(
  ref: unknown,
  teamId: TeamId,
): Promise<{ url: string; filename?: string } | null> {
  if (ref == null || typeof ref !== 'object') return null;
  const fileRef = ref as FileRef & { url?: unknown };

  let url: string | null = null;
  if (hasFileSource(fileRef)) {
    const resolved = await streamFileRef(fileRef, { teamId });
    const exposed = await exposeFile({
      stream: resolved.stream,
      filename: fileRef.name,
      contentType: resolved.contentType ?? fileRef.contentType,
    });
    url = exposed.url;
  } else if (typeof fileRef.url === 'string') {
    url = fileRef.url;
  }
  if (!url) return null;

  return typeof fileRef.name === 'string' && fileRef.name.length > 0
    ? { url, filename: fileRef.name }
    : { url };
}

/**
 * Convert File-typed (`multipleAttachments`) field values from FileRefs into
 * Airtable's `[{ url, filename }]` attachment shape. Airtable fetches the URL
 * server-side, so each FileRef's bytes are exposed at a short-lived Listen-Fire URL
 * (`exposeFile`). An unresolvable ref (no byte channel, no display URL) is
 * dropped loudly; a field with no resolvable attachment is left unwritten rather
 * than cleared (files are not re-creatable from here — append/replace precedence
 * still applies via the operators).
 */
async function resolveAttachmentFields(input: {
  teamId: TeamId;
  fields: Record<string, unknown>;
  fieldMetaByKey: Map<string, AirtableFieldMeta>;
}): Promise<void> {
  for (const [fieldId, value] of Object.entries(input.fields)) {
    if (input.fieldMetaByKey.get(fieldId)?.type !== 'multipleAttachments') continue;
    const refs = Array.isArray(value) ? value : [value];
    const resolved = await Promise.all(refs.map((ref) => toAttachmentObject(ref, input.teamId)));
    const attachments = resolved.filter(
      (a): a is { url: string; filename?: string } => a !== null,
    );
    if (attachments.length < refs.length) {
      logger.warn(
        `[AirtableAdapter] attachment field "${fieldId}": ${refs.length - attachments.length} of ${refs.length} file(s) had no resolvable URL and were dropped`,
      );
    }
    if (attachments.length > 0) input.fields[fieldId] = attachments;
    else delete input.fields[fieldId];
  }
}

/** Resolve a parentLink edge name to a `multipleRecordLinks` field id. The
 *  editor stores the reference's `fieldId` (= Airtable field id) as the edge
 *  name; tolerate the display name too. */
function resolveParentLinkField(input: { ctx: TableContext; edgeName: string }): string | null {
  const direct = input.ctx.fieldMetaByKey.get(input.edgeName);
  if (direct && direct.type === LINK_FIELD_TYPE) return direct.id;
  return null;
}

export async function createRecord(input: {
  client: AirtableAPIClient;
  teamId: TeamId;
  ids: AirtableTableId;
  write: WriteInput;
}): Promise<WriteResult> {
  const { baseId, tableId } = input.ids;
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId,
  });
  const ctx = await loadTableContext({
    client: input.client,
    teamId: input.teamId,
    baseId,
    tableId,
  });
  if (!ctx) {
    throw new Error(`AirtableAdapter.createRecord: table "${tableId}" not found in base "${baseId}".`);
  }

  const { fields } = await buildWritePayload({
    client: input.client,
    teamId: input.teamId,
    ctx,
    baseId,
    tables,
    fields: input.write.fields,
    parentLinks: input.write.parentLinks,
  });

  const result = await input.client.createRecord({
    baseId,
    tableId,
    fields,
  });
  return {
    adapterType: AIRTABLE_ADAPTER_TYPE,
    externalId: result.id,
    data: buildRecordData({
      record: result,
      baseId,
      tableId,
      primaryFieldId: ctx.table.primaryFieldId,
    }),
  };
}

export async function updateRecord(input: {
  client: AirtableAPIClient;
  teamId: TeamId;
  ids: AirtableTableId;
  update: UpdateInput;
}): Promise<UpdateResult> {
  const { baseId, tableId } = input.ids;
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId,
  });
  const ctx = await loadTableContext({
    client: input.client,
    teamId: input.teamId,
    baseId,
    tableId,
  });
  if (!ctx) {
    throw new Error(`AirtableAdapter.updateRecord: table "${tableId}" not found in base "${baseId}".`);
  }

  const { fields, association } = await buildWritePayload({
    client: input.client,
    teamId: input.teamId,
    ctx,
    baseId,
    tables,
    fields: input.update.fields,
    parentLinks: input.update.parentLinks,
  });

  // NOT-FOUND contract (3b): a PATCH to a record id Airtable no longer has
  // returns 404. The client surfaces it as `Error("Airtable Error: 404 ...")`,
  // so the shared message-token detector maps it to the typed signal — letting
  // the engine's bind self-heal re-mint instead of failing opaquely.
  //
  // An empty payload means there is nothing to change: a matched record whose
  // fields already hold the written values, and whose parent links (if any)
  // resolved to no link field on this table. Patching an empty bag would be a
  // write that changes nothing; read the record instead, so the handle keeps
  // the target's computed values and a deleted record still 404s.
  let result: Awaited<ReturnType<typeof input.client.updateRecord>>;
  try {
    result =
      Object.keys(fields).length === 0
        ? await input.client.getRecord({ baseId, tableId, recordId: input.update.externalId })
        : await input.client.updateRecord({
            baseId,
            tableId,
            recordId: input.update.externalId,
            fields,
          });
  } catch (e) {
    if (isHttp404(e)) return UPDATE_NOT_FOUND;
    throw e;
  }
  return {
    adapterType: AIRTABLE_ADAPTER_TYPE,
    externalId: input.update.externalId,
    data: buildRecordData({
      record: result,
      baseId,
      tableId,
      primaryFieldId: ctx.table.primaryFieldId,
    }),
    // Airtable's link cell is REPLACED, not read first, so a wired parent can
    // only report the write it performed.
    association,
  };
}

export async function deleteRecord(input: {
  client: AirtableAPIClient;
  ids: AirtableTableId;
  del: DeleteInput;
}): Promise<DeleteResult> {
  await input.client.deleteRecord({
    baseId: input.ids.baseId,
    tableId: input.ids.tableId,
    recordId: input.del.externalId,
  });
  return {};
}

export { AIRTABLE_ADAPTER_TYPE };
