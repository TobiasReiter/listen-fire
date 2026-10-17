// Google Sheets TG adapter — shared types + the name → structured-identifier
// cache. Google Sheets is an APPEND target (v3-output parity). There are two
// writable row surfaces:
//   • a native Sheets Table — `"<table> (table)"` — keyed by its declared
//     columns, with `unique by` overwrite (`table-row` parity);
//   • a plain tab — `"<tab> (sheet)"` — a bare sheet with a header row, keyed
//     by that row-1 header (append-only, no addressable row to overwrite).
// A tab that CONTAINS a native Table is not surfaced as a plain tab — you
// address the Table there — so each tab has exactly one writable surface.
//
// The framework names a writable surface by its pretty `displayName` — that IS
// the `typeId`/`recordType` every entry and position carries — and the adapter
// recovers the structured id the Sheets API routes on (`{ spreadsheetId,
// tableId }` for a table, `{ spreadsheetId, sheetId }` for a tab) from that
// name through its private name → structured-identifier cache
// (`schema_catalog.loadTableCatalog`, fed by the credential's granted
// spreadsheets). There is deliberately NO `encode/decodeTypeId` magic-string
// codec: an identifier is never flattened into a string and crammed onto a
// position.

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`
 *  and the `GOOGLE_SHEETS` trigger-kind alias in the registry. */
export const GOOGLE_SHEETS_ADAPTER_TYPE = 'google_sheets';

/** The Sheets API's structured routing identifier for a writable table — what
 *  the name → structured-identifier cache yields for a table's displayName.
 *  This is the adapter's PRIVATE currency; it never appears on a position. */
export interface SheetsTableId {
  spreadsheetId: string;
  tableId: string;
}

/** The Sheets API's structured routing identifier for a writable PLAIN TAB (a
 *  bare sheet with a header row) — what the name → structured-identifier cache
 *  yields for a tab's `"<tab> (sheet)"` displayName. Like `SheetsTableId`, the
 *  adapter's PRIVATE currency; it never appears on a position. */
export interface SheetTabId {
  spreadsheetId: string;
  sheetId: number;
}

/** The one top-level type: a granted spreadsheet. */
export const SPREADSHEET_META_TYPE = 'Spreadsheet';

/** Drive's mime type for a spreadsheet: the grants Sheets reads. */
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
