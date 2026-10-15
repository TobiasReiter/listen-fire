// Google Sheets TG adapter — the write/append path plus the bridge-only
// entity resolution that supports it. The value-mapping logic mirrors the v3
// output (`output_v3/adapters/google_sheets.ts`) `executeTableRow` — copied,
// not imported (P4), so the TG adapter carries its own behavioral reference.
//
// Google Sheets is an APPEND target: there is no native-key upsert in v3, so
// `resolveEntity` is bridge-only (surface any prior linked_object, else 0
// candidates → the engine appends a fresh row). `updateRecord` / `deleteRecord`
// throw — a sheet append has no addressable row to mutate.

import type { GoogleSheetsApiClient } from '../../../../adapters/googleSheets/apiClient';
import type {
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  DeleteInput,
  DeleteResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/services/translation_graph/adapter';

import { logger } from 'movement-engine/services/logger';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition } from 'movement-engine/services/translation_graph/types';
import {
  GOOGLE_SHEETS_ADAPTER_TYPE,
  type SheetsTableId,
  type SheetTabId,
} from './types';

// Value coercion now lives in the api client's `sheetCellValue` (cells.ts):
// the write path hands `addTableRow` the raw value + the column's Sheets type,
// and the client builds a TYPED `userEnteredValue` (date → serial, number →
// numberValue, …) rather than stringifying.

// ── Display URL ──────────────────────────────────────────────────────────────

function buildSpreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

// ── createRecord (append) ────────────────────────────────────────────────────

export async function createRecord(input: {
  client: GoogleSheetsApiClient;
  ids: SheetsTableId;
  fields: Record<string, unknown>;
}): Promise<WriteResult> {
  // `ids` is the resolved structured identifier — the adapter recovered it from
  // the write's pretty type NAME via the name cache before calling here.
  return appendTableRow({
    client: input.client,
    spreadsheetId: input.ids.spreadsheetId,
    tableId: input.ids.tableId,
    fields: input.fields,
  });
}

// ── createSheetRow (bare-tab append) ─────────────────────────────────────────

/** Append a row to a PLAIN TAB (a bare sheet with a header row). The client's
 *  `addRow` reads row 1 and maps each field by header name into column order —
 *  so the write is keyed by the header, no native Table required. Append-only:
 *  a bare sheet has no addressable row identity, so the externalId is an
 *  informational record key (spreadsheet + sheet), never a recordType. */
export async function createSheetRow(input: {
  client: GoogleSheetsApiClient;
  ids: SheetTabId;
  fields: Record<string, unknown>;
}): Promise<WriteResult> {
  const { spreadsheetId, sheetId } = input.ids;
  const row: Record<string, string | number | boolean | Date> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (value == null) continue;
    row[key] =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value instanceof Date
        ? value
        : String(value);
  }
  if (Object.keys(row).length > 0) {
    await input.client.addRow({ spreadsheetId, sheetId, row });
  } else {
    logger.debug('[GoogleSheetsAdapter] no values to append to sheet tab', {
      spreadsheetId,
      sheetId,
    });
  }
  return {
    adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
    externalId: `${spreadsheetId}:sheet:${sheetId}`,
    data: {
      name: `Row appended to sheet ${sheetId}`,
      url: buildSpreadsheetUrl(spreadsheetId),
    },
  };
}

/** Column-mapped append — mirror v3 `executeTableRow`. Resolve each field id
 *  (column name) to a column index via `getTableColumns`, then `addTableRow`. */
async function appendTableRow(input: {
  client: GoogleSheetsApiClient;
  spreadsheetId: string;
  tableId: string;
  fields: Record<string, unknown>;
}): Promise<WriteResult> {
  const columns = await input.client.getTableColumns({
    spreadsheetId: input.spreadsheetId,
    tableId: input.tableId,
  });
  const columnByName = new Map(columns.map((c) => [c.columnName, c]));

  // Pass the raw value + the column's Sheets type; the api client builds a
  // TYPED cell (date → serial, number → numberValue, …) rather than
  // stringifying — so a date column stays a date and a number stays a number.
  const valuesByColumn: { columnIndex: number; value: unknown; columnType: string }[] = [];
  for (const [key, value] of Object.entries(input.fields)) {
    if (value == null) continue;
    const col = columnByName.get(key);
    if (!col) {
      logger.debug('[GoogleSheetsAdapter] field has no matching table column — skipped', {
        tableId: input.tableId,
        fieldId: key,
      });
      continue;
    }
    valuesByColumn.push({ columnIndex: col.columnIndex, value, columnType: col.columnType });
  }

  if (valuesByColumn.length > 0) {
    await input.client.addTableRow({
      spreadsheetId: input.spreadsheetId,
      tableId: input.tableId,
      valuesByColumn,
    });
  } else {
    logger.debug('[GoogleSheetsAdapter] no column values to append to table', {
      spreadsheetId: input.spreadsheetId,
      tableId: input.tableId,
    });
  }

  return {
    adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
    // A sheet append has no addressable row identity (resolveEntity returns no
    // candidates), so the externalId is an informational record key, not a
    // recordType — the spreadsheet + table the row landed in.
    externalId: `${input.spreadsheetId}:${input.tableId}`,
    data: {
      name: `Row appended to table ${input.tableId}`,
      url: buildSpreadsheetUrl(input.spreadsheetId),
    },
  };
}

// ── listCollection — the rows IN a table, as positions ──────────────────────

/**
 * A COLLECTION hop — the read a movement makes when it starts from the
 * table's container rather than from a row: the root of a
 * spreadsheet-positioned instance (`sheets-[c:\`Companies (table)\`]->`), or a
 * spreadsheet reached by traversal
 * (`-[s:Spreadsheet WHERE \`Title\` == "Foo"]->-[c:\`Companies (table)\`]->`).
 * The table entry was published READABLE and no read existed — the lie layer
 * 7 closes. Each row's address is its CURRENT row number (`rowAddress`) —
 * positional under concurrent sorts, same trade `resolveEntity` documents —
 * and its data is keyed by column names, the same currency `readRecord`
 * returns.
 */
export async function listCollection(input: {
  client: GoogleSheetsApiClient;
  ids: SheetsTableId;
  /** The table's pretty type name (`"<table> (table)"`) — what the emitted
   *  positions are typed by. */
  tableName: string;
}): Promise<RelatedResult[]> {
  const { spreadsheetId, tableId } = input.ids;
  const [columns, rows] = await Promise.all([
    input.client.getTableColumns({ spreadsheetId, tableId }),
    input.client.getTableRows({ spreadsheetId, tableId }),
  ]);
  return rows.map((row) => {
    const data: Record<string, unknown> = {};
    for (const col of columns) data[col.columnName] = row.values[col.columnIndex] ?? null;
    return {
      position: makeStablePosition({
        adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
        recordType: input.tableName,
        recordId: rowAddress({ spreadsheetId, tableId, rowNumber: row.rowNumber }),
        data,
      }),
    };
  });
}

// ── Row identity: unique-by resolution over live table rows ─────────────────
// A sheet row has no stable native id — row numbers shift under sorts and
// inserts. So identity is DERIVED at write time: `resolveEntity` scans the
// table's current rows against the author's `unique by` constraints and the
// matching row's CURRENT number becomes the write address
// (`<spreadsheetId>:<tableId>:<rowNumber>`). Authors opt into overwriting via
// `unique by (\`Column\`)` — raw row numbers are never the authoring surface.
// The resolve→update window is a small race (a concurrent manual sort can
// shift rows between the scan and the write) — acceptable for the
// movement-owned report sheets this targets.

export function rowAddress(input: {
  spreadsheetId: string;
  tableId: string;
  rowNumber: number;
}): string {
  return `${input.spreadsheetId}:${input.tableId}:${input.rowNumber}`;
}

export function parseRowAddress(
  externalId: string,
): { spreadsheetId: string; tableId: string; rowNumber: number } | null {
  const parts = externalId.split(':');
  if (parts.length < 3) return null;
  const rowNumber = Number(parts[parts.length - 1]);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) return null;
  return {
    spreadsheetId: parts[0],
    tableId: parts.slice(1, -1).join(':'),
    rowNumber,
  };
}

/** Case/whitespace-insensitive cell equality — Sheets has no fuzzy search
 *  primitive, so `FUZZY` degrades to the same normalized comparison. */
function cellMatches(cell: unknown, value: unknown): boolean {
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  return norm(cell) === norm(value);
}

export async function resolveEntity(input: {
  client: GoogleSheetsApiClient;
  ids: SheetsTableId;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const conjuncts = input.resolve.constraints.any.filter((c) => c.all.length > 0);
  if (conjuncts.length === 0) return { candidates: [] };

  const { spreadsheetId, tableId } = input.ids;
  const [columns, rows] = await Promise.all([
    input.client.getTableColumns({ spreadsheetId, tableId }),
    input.client.getTableRows({ spreadsheetId, tableId }),
  ]);
  const columnByName = new Map(columns.map((c) => [c.columnName, c]));

  const candidates = [];
  for (const row of rows) {
    const matches = conjuncts.some((conjunct) =>
      conjunct.all.every((entry) => {
        const col = columnByName.get(entry.field);
        if (!col) return false;
        return cellMatches(row.values[col.columnIndex], input.resolve.record[entry.field]);
      }),
    );
    if (!matches) continue;
    const data: Record<string, unknown> = {};
    for (const col of columns) data[col.columnName] = row.values[col.columnIndex] ?? null;
    candidates.push({
      adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
      externalId: rowAddress({ spreadsheetId, tableId, rowNumber: row.rowNumber }),
      data,
    });
  }
  return { candidates };
}

// ── updateRecord — overwrite the resolved row's mapped columns ──────────────

export async function updateRecord(input: {
  client: GoogleSheetsApiClient;
  update: UpdateInput;
}): Promise<UpdateResult> {
  const address = parseRowAddress(input.update.externalId);
  if (!address) {
    throw new Error(
      `GoogleSheetsAdapter.updateRecord: "${input.update.externalId}" is not a row address — ` +
        'only rows resolved through `unique by` are updatable (a bare table id has no row to mutate).',
    );
  }
  const columns = await input.client.getTableColumns({
    spreadsheetId: address.spreadsheetId,
    tableId: address.tableId,
  });
  const columnByName = new Map(columns.map((c) => [c.columnName, c]));
  const valuesByColumn: { columnIndex: number; value: unknown; columnType: string }[] = [];
  for (const [key, value] of Object.entries(input.update.fields)) {
    const col = columnByName.get(key);
    if (!col) continue;
    valuesByColumn.push({ columnIndex: col.columnIndex, value, columnType: col.columnType });
  }
  if (valuesByColumn.length > 0) {
    await input.client.updateTableRow({
      spreadsheetId: address.spreadsheetId,
      tableId: address.tableId,
      rowNumber: address.rowNumber,
      valuesByColumn,
    });
  }
  return {
    adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
    externalId: input.update.externalId,
    data: { url: buildSpreadsheetUrl(address.spreadsheetId) },
    // A row's parent is the tab it lives in — a container it cannot leave, so
    // the row we matched is already where the write says it belongs.
    association: containerAssociation(input.update),
  };
}

/** Read one resolved row back (no-op detection) — keyed by column names. */
export async function readRecord(input: {
  client: GoogleSheetsApiClient;
  externalId: string;
}): Promise<Record<string, unknown> | null> {
  const address = parseRowAddress(input.externalId);
  if (!address) return null;
  const [columns, rows] = await Promise.all([
    input.client.getTableColumns(address),
    input.client.getTableRows(address),
  ]);
  const row = rows.find((r) => r.rowNumber === address.rowNumber);
  if (!row) return null;
  const data: Record<string, unknown> = {};
  for (const col of columns) data[col.columnName] = row.values[col.columnIndex] ?? null;
  return data;
}

export async function deleteRecord(_input: { del: DeleteInput }): Promise<DeleteResult> {
  throw new Error(
    'Google Sheets rows cannot be deleted through this adapter — appends and unique-by ' +
      'overwrites only. Remove rows in the sheet itself.',
  );
}
