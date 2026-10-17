import { z } from 'zod';

import type { AirtableAPIClient } from '../../../../adapters/airtable/apiClient';
import type { V3Adapter, V3AdapterExecuteInput, AdapterResult } from './types';

import { anthropicChat } from '../../../../lib/anthropic';
import { logger } from 'movement-engine/public/log';
import { StaleLinkedObjectError } from './types';

function createAirtableV3Adapter(client: AirtableAPIClient): V3Adapter {
  return {
    async execute(input: V3AdapterExecuteInput): Promise<AdapterResult> {
      const [, actionType] = input.type.split(':');

      if (actionType === 'record') {
        return executeRecord(client, input);
      }

      logger.warn(`Airtable v3 adapter: unknown action type "${actionType}"`);
      return {};
    },
  };
}

// Airtable field types that require numeric values
const NUMERIC_FIELD_TYPES = new Set([
  'number',
  'percent',
  'currency',
  'duration',
  'rating',
  'count',
  'autoNumber',
]);

function coerceAirtableValue(value: unknown, fieldType: string | undefined): unknown {
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

  return value;
}

function coerceToName(v: unknown): string {
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

function escapeAirtableString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function fuzzySearchRecord(
  client: AirtableAPIClient,
  {
    baseId,
    tableId,
    fieldId,
    primaryFieldName,
    query,
  }: {
    baseId: string;
    tableId: string;
    fieldId: string;
    primaryFieldName: string;
    query: string;
  },
): Promise<{ id: string; fields: Record<string, unknown> } | null> {
  // Use each word as a SEARCH term to find candidates server-side
  const words = query.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return null;

  const searchClauses = words.map(
    (w) => `SEARCH(LOWER("${escapeAirtableString(w)}"), LOWER({${primaryFieldName}}))`
  );
  const formula = searchClauses.length === 1
    ? searchClauses[0]
    : `OR(${searchClauses.join(',')})`;

  const candidates = await client.listRecords({
    baseId,
    tableId,
    fieldId,
    filterByFormula: formula,
  });

  if (candidates.length === 0) return null;

  // Single candidate — accept if reasonably close
  // Multiple candidates — use LLM to pick
  const candidateEntries = candidates
    .filter((r) => typeof r.fields[primaryFieldName] === 'string')
    .map((r) => ({ id: r.id, name: r.fields[primaryFieldName] as string }))
    .slice(0, 200);

  if (candidateEntries.length === 0) return null;

  const response = await anthropicChat({
    model: 'claude-sonnet-5',
    temperature: 0,
    label: 'airtable_linked_record_match',
    system: `You match a query name against a list of candidate record names. Return the matching record's id ONLY if you are confident it refers to the same entity. Common variations to accept: abbreviations, suffixes like "Inc"/"Ltd"/"Networks", minor spelling differences. Prefer returning null over a wrong match.

Output: Strictly JSON: either a string (the id) or null. No extra text.`,
    userMessage: JSON.stringify({ query, candidates: candidateEntries }),
  });

  const matchedId = z.string().nullable().parse(JSON.parse(response));
  if (!matchedId) return null;

  return candidates.find((r) => r.id === matchedId) ?? null;
}

async function resolveLinkedRecordFields(
  client: AirtableAPIClient,
  baseId: string,
  fields: Record<string, unknown>,
  fieldMetaByKey: Map<string, { type?: string; options?: unknown }>,
  tables: { id: string; name: string; primaryFieldId: string; fields: { id: string; name: string; type?: string; options?: unknown }[] }[],
): Promise<void> {
  for (const [fieldId, value] of Object.entries(fields)) {
    const meta = fieldMetaByKey.get(fieldId);
    if (meta?.type !== 'multipleRecordLinks') continue;
    // Already resolved to record IDs — skip if array of "rec..." strings or {id: "rec..."} objects
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      (
        (typeof value[0] === 'string' && value[0].startsWith('rec')) ||
        (typeof value[0] === 'object' && value[0] !== null &&
          typeof (value[0] as { id?: unknown }).id === 'string' &&
          ((value[0] as { id: string }).id).startsWith('rec'))
      )
    ) continue;

    const linkedTableId = (meta.options as { linkedTableId?: string })?.linkedTableId;
    if (!linkedTableId) {
      logger.warn(`[AirtableV3] multipleRecordLinks field "${fieldId}" missing linkedTableId in options`);
      delete fields[fieldId];
      continue;
    }

    const linkedTable = tables.find((t) => t.id === linkedTableId);
    const primaryFieldId = linkedTable?.primaryFieldId;
    if (!primaryFieldId) {
      logger.warn(`[AirtableV3] Could not find primary field for linked table "${linkedTableId}"`);
      delete fields[fieldId];
      continue;
    }

    const names = typeof value === 'string'
      ? value.split(/,\s*/).filter((s) => s.length > 0)
      : Array.isArray(value) ? value.map(coerceToName).filter((s) => s.length > 0) : [coerceToName(value)].filter((s) => s.length > 0);

    const primaryFieldName = linkedTable.fields.find((f) => f.id === primaryFieldId)?.name;
    if (!primaryFieldName) {
      logger.warn(`[AirtableV3] Could not resolve primary field name for table "${linkedTable.name}"`);
      delete fields[fieldId];
      continue;
    }

    // Batch exact match via filterByFormula
    const exactFormula = names.length === 1
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

    const matched: string[] = [];
    for (const name of names) {
      const exactId = exactByName.get(name);
      if (exactId) {
        matched.push(exactId);
        continue;
      }

      // Fuzzy: use SEARCH to find candidates server-side, then LLM to pick
      const fuzzyMatch = await fuzzySearchRecord(client, {
        baseId,
        tableId: linkedTableId,
        fieldId: primaryFieldId,
        primaryFieldName,
        query: name,
      });
      if (fuzzyMatch) {
        logger.info(`[AirtableV3] Fuzzy matched "${name}" → "${fuzzyMatch.fields[primaryFieldName]}" in table "${linkedTable.name}"`);
        matched.push(fuzzyMatch.id);
      } else {
        logger.warn(`[AirtableV3] No record found matching "${name}" in table "${linkedTable.name}"`);
      }
    }

    if (matched.length > 0) {
      fields[fieldId] = matched;
    } else {
      delete fields[fieldId];
    }
  }
}

function buildAirtableUrl(baseId: string, tableId: string, recordId: string): string {
  return `https://airtable.com/${baseId}/${tableId}/${recordId}`;
}

function buildRecordData(
  record: { id: string; fields?: Record<string, unknown> },
  baseId: string,
  tableId: string,
  primaryFieldId: string | undefined,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    url: buildAirtableUrl(baseId, tableId, record.id),
  };
  if (primaryFieldId && record.fields) {
    const primary = record.fields[primaryFieldId];
    if (primary != null && typeof primary !== 'object') {
      data.name = String(primary);
    }
  }
  return data;
}

function is404(err: unknown): boolean {
  return err instanceof Error && err.message.includes('404');
}

async function executeRecord(
  client: AirtableAPIClient,
  input: V3AdapterExecuteInput,
): Promise<AdapterResult> {
  const config = input.adapterConfig as {
    baseId: string;
    tableId: string;
    linkToParentField?: string;
  };

  if (!config.baseId || !config.tableId) {
    return { skipped: true, skipReason: 'Missing baseId or tableId' };
  }

  // Fetch table schema so we can coerce values to each field's Airtable type
  // and extract primary-field names for the result display
  const tables = await client.listTables({ baseId: config.baseId });
  const table = tables.find((t) => t.id === config.tableId);
  const fieldTypeByKey = new Map<string, string | undefined>();
  if (table) {
    for (const f of table.fields) {
      fieldTypeByKey.set(f.id, f.type);
      fieldTypeByKey.set(f.name, f.type);
    }
  }
  const primaryFieldId = table?.primaryFieldId;
  const externalObjectType = table?.name ?? 'Record';

  // Build a field-metadata lookup so we can access type + options by field ID or name
  const fieldMetaByKey = new Map<string, { type?: string; options?: unknown }>();
  if (table) {
    for (const f of table.fields) {
      const meta = { type: f.type, options: f.options };
      fieldMetaByKey.set(f.id, meta);
      fieldMetaByKey.set(f.name, meta);
    }
  }

  // Build fields from pre-resolved values, filtering out nulls and coercing to field type
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.fieldValues)) {
    if (value == null) continue;
    const fieldType = fieldTypeByKey.get(key);
    if (typeof value === 'object') {
      logger.info(`[AirtableV3] Field "${key}" (type=${fieldType ?? 'unknown'}) has object value before coercion: ${JSON.stringify(value)}`);
    }
    const coerced = coerceAirtableValue(value, fieldType);
    if (coerced == null) continue;
    fields[key] = coerced;
  }

  // Resolve multipleRecordLinks fields: look up record names in the linked table
  await resolveLinkedRecordFields(client, config.baseId, fields, fieldMetaByKey, tables);

  // Sanitize: ensure no raw objects leak to Airtable's API.
  // After linked record resolution, the only valid object values are arrays of {id: "rec..."}.
  // Anything else would cause INVALID_RECORD_ID or similar errors.
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      // Array of {id: "rec..."} is valid (linked records); array of strings/numbers is valid (multipleSelects)
      if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        const first = value[0] as Record<string, unknown>;
        if (typeof first.id !== 'string' || !first.id.startsWith('rec')) {
          // Array of non-record objects — extract names
          logger.warn(`[AirtableV3] Sanitizing array field "${key}": ${JSON.stringify(value)}`);
          const names = value.map(coerceToName).filter((s) => s.length > 0);
          fields[key] = names.length > 0 ? names.join(', ') : undefined;
          if (!fields[key]) delete fields[key];
        }
      }
    } else {
      // Plain object — extract a meaningful string value
      logger.warn(`[AirtableV3] Sanitizing object field "${key}": ${JSON.stringify(value)}`);
      const name = coerceToName(value);
      if (name) {
        fields[key] = name;
      } else {
        delete fields[key];
      }
    }
  }

  // Log final field payload before sending to Airtable
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'object') {
      logger.info(`[AirtableV3] Final field "${key}" is object: ${JSON.stringify(value)}`);
    }
  }

  // Link to parent record if configured
  if (config.linkToParentField && input.parentResult?.parentRecord) {
    fields[config.linkToParentField] = [input.parentResult.parentRecord.recordId];
  }

  // Tier 0: linked object — update existing record instead of creating a new one
  const tier0Link = input.linkedObjects[0];
  const existingRecordId = tier0Link?.externalId;
  if (existingRecordId != null) {
    logger.info(`[AirtableV3] existingRecordId: type=${typeof existingRecordId}, value=${JSON.stringify(existingRecordId)}`);
  }

  // Read-only mode: look up only, never create or update
  if (input.readOnly) {
    if (!existingRecordId) {
      return { skipped: true, skipReason: 'Record not found (read-only)' };
    }
    try {
      const record = await client.getRecord({
        baseId: config.baseId,
        tableId: config.tableId,
        recordId: existingRecordId,
      });
      return {
        externalId: record.id,
        created: false,
        externalObjectType,
        data: buildRecordData(record, config.baseId, config.tableId, primaryFieldId),
        parentRecord: { objectId: config.tableId, recordId: record.id },
      };
    } catch (err) {
      if (is404(err)) throw new StaleLinkedObjectError(existingRecordId);
      throw err;
    }
  }

  if (Object.keys(fields).length === 0) {
    return { skipped: true, skipReason: 'No fields to write' };
  }

  // Log the COMPLETE call args right before the API call
  logger.info(`[AirtableV3] API call: ${existingRecordId ? 'UPDATE' : 'CREATE'} baseId=${config.baseId} tableId=${config.tableId} recordId=${existingRecordId ?? 'N/A'} body=${JSON.stringify({ fields })}`);

  try {
    const result = existingRecordId
      ? await client.updateRecord({
          baseId: config.baseId,
          tableId: config.tableId,
          recordId: existingRecordId,
          fields,
        })
      : await client.createRecord({
          baseId: config.baseId,
          tableId: config.tableId,
          fields,
        });

    return {
      externalId: result.id,
      created: !existingRecordId,
      externalObjectType,
      data: buildRecordData(result, config.baseId, config.tableId, primaryFieldId),
      parentRecord: { objectId: config.tableId, recordId: result.id },
    };
  } catch (err) {
    if (existingRecordId && is404(err)) {
      throw new StaleLinkedObjectError(existingRecordId);
    }
    logger.error(`[AirtableV3] Failed to ${existingRecordId ? 'update' : 'create'} record in table "${config.tableId}". Fields payload: ${JSON.stringify(fields)}`);
    throw err;
  }
}

export { createAirtableV3Adapter };
