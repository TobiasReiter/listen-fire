// Sheets row identity — unique-by resolution + row-addressed overwrite.
// Row numbers are POSITIONAL (sorts/inserts shift them), so identity is
// derived per write: resolveEntity scans live rows, the match's current row
// number becomes the update address, and updateRecord rewrites ONLY mapped
// columns. Authors opt in via `unique by (`Column`)` — raw row numbers are
// never the authoring surface.

import type { GoogleSheetsApiClient } from '../api_client';

import {
  resolveEntity,
  updateRecord,
  readRecord,
  parseRowAddress,
  rowAddress,
} from '../row';
import { loadTableCatalog, tableTypeNamesOf, resolveTable } from '../schema_catalog';
import { parseA1Cell } from '../cells';

const COLUMNS = [
  { columnIndex: 0, columnName: 'Name', columnType: 'TEXT' },
  { columnIndex: 1, columnName: 'Stage', columnType: 'TEXT' },
  { columnIndex: 2, columnName: 'Domain', columnType: 'TEXT' },
];
const ROWS = [
  { rowNumber: 2, values: ['Acme Corp', 'Screening', 'acme.dev'] },
  { rowNumber: 3, values: ['Globex', 'Diligence', 'globex.io'] },
];

const getTableColumns = jest.fn(async () => COLUMNS);
const getTableRows = jest.fn(async () => ROWS);
const updateTableRow = jest.fn(async () => undefined);
const client = { getTableColumns, getTableRows, updateTableRow } as unknown as GoogleSheetsApiClient;
const ids = { spreadsheetId: 'ss1', tableId: 't1' };
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => jest.clearAllMocks());

describe('rowAddress / parseRowAddress', () => {
  it('round-trips and rejects non-row addresses (bare table ids, header rows)', () => {
    const addr = rowAddress({ spreadsheetId: 'ss1', tableId: 't1', rowNumber: 3 });
    expect(parseRowAddress(addr)).toEqual({ spreadsheetId: 'ss1', tableId: 't1', rowNumber: 3 });
    expect(parseRowAddress('ss1:t1')).toBeNull(); // legacy table-level externalId
    expect(parseRowAddress('ss1:t1:1')).toBeNull(); // header row is not addressable
  });
});

describe('resolveEntity — unique-by scan', () => {
  it('matches case/whitespace-insensitively and returns a row-addressed candidate', async () => {
    const result = await resolveEntity({
      client,
      ids,
      resolve: {
        record: { Name: '  acme corp ' },
        recordType: 'Companies',
        candidates: [],
        constraints: { any: [{ all: [{ field: 'Name' }] }] },
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].externalId).toBe('ss1:t1:2');
    expect(result.candidates[0].data).toMatchObject({ Name: 'Acme Corp', Stage: 'Screening' });
  });

  it('AND-tuples within a conjunct; no constraints → no candidates (plain append)', async () => {
    const both = await resolveEntity({
      client,
      ids,
      resolve: {
        record: { Name: 'Acme Corp', Domain: 'other.com' },
        recordType: 'Companies',
        candidates: [],
        constraints: { any: [{ all: [{ field: 'Name' }, { field: 'Domain' }] }] },
      },
    });
    expect(both.candidates).toEqual([]);

    const none = await resolveEntity({
      client,
      ids,
      resolve: { record: { Name: 'Acme Corp' }, recordType: 'Companies', candidates: [], constraints: { any: [] } },
    });
    expect(none.candidates).toEqual([]);
    expect(getTableRows).toHaveBeenCalledTimes(1); // the empty-constraint path never scans
  });
});

describe('updateRecord — row-addressed overwrite', () => {
  it('rewrites only mapped columns at the addressed row', async () => {
    await updateRecord({
      client,
      update: {
        recordType: 'Companies',
        externalId: 'ss1:t1:2',
        fields: { Stage: 'Diligence' },
        mutationContext: { source: { type: 'structured_input' }, occurredAt: new Date(0).toISOString() },
      } as never,
    });
    expect(updateTableRow).toHaveBeenCalledWith({
      spreadsheetId: 'ss1',
      tableId: 't1',
      rowNumber: 2,
      valuesByColumn: [{ columnIndex: 1, value: 'Diligence', columnType: 'TEXT' }],
    });
  });

  it('rejects a non-row externalId with a unique-by pointer', async () => {
    await expect(
      updateRecord({
        client,
        update: { recordType: 'Companies', externalId: 'ss1:t1', fields: {}, mutationContext: {} } as never,
      }),
    ).rejects.toThrow(/unique by/);
    expect(updateTableRow).not.toHaveBeenCalled();
  });
});

describe('readRecord', () => {
  it('reads a resolved row back keyed by column names (no-op detection)', async () => {
    const data = await readRecord({ client, externalId: 'ss1:t1:3' });
    expect(data).toEqual({ Name: 'Globex', Stage: 'Diligence', Domain: 'globex.io' });
    expect(await readRecord({ client, externalId: 'ss1:t1:9' })).toBeNull();
  });
});

describe('loadTableCatalog — same-named tables across spreadsheets', () => {
  it('keeps each in its own spreadsheet; one deduped edge name, resolved by the parent', async () => {
    const listTables = jest.fn(async ({ spreadsheetId }: { spreadsheetId: string }) => [
      { tableId: `t-${spreadsheetId}`, name: 'Companies', sheetId: 0, sheetName: 'S', range: { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }, columns: [] },
    ]);
    // The per-grant surface enumerates tabs + named ranges too.
    const listSheets = jest.fn(async () => [{ sheetId: 0, title: 'S' }]);
    const listNamedRanges = jest.fn(async () => []);
    const catalog = await loadTableCatalog({
      client: { listTables, listSheets, listNamedRanges } as never,
      grants: [
        { spreadsheetId: 'ss-a', name: 'Pipeline Sheet' },
        { spreadsheetId: 'ss-b', name: 'Portfolio Tracker' },
      ],
      log: quiet,
    });
    // One deduped edge name off the Spreadsheet node — no cross-spreadsheet
    // qualification…
    expect(tableTypeNamesOf(catalog)).toEqual(['Companies (table)']);
    // …resolved to the RIGHT table by the parent spreadsheet.
    expect(resolveTable(catalog, { name: 'Companies (table)', spreadsheetId: 'ss-a' })).toEqual({ spreadsheetId: 'ss-a', tableId: 't-ss-a' });
    expect(resolveTable(catalog, { name: 'Companies (table)', spreadsheetId: 'ss-b' })).toEqual({ spreadsheetId: 'ss-b', tableId: 't-ss-b' });
    // A bare resolve (no parent) takes the first match — the type's shape.
    expect(resolveTable(catalog, { name: 'Companies (table)' })).toEqual({ spreadsheetId: 'ss-a', tableId: 't-ss-a' });
  });

  it('a table resolves within its granted spreadsheet', async () => {
    const listTables = jest.fn(async () => [
      { tableId: 't1', name: 'Deals', sheetId: 0, sheetName: 'S', range: { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }, columns: [] },
    ]);
    const catalog = await loadTableCatalog({
      client: {
        listTables,
        listSheets: async () => [{ sheetId: 0, title: 'S' }],
        listNamedRanges: async () => [],
      } as never,
      grants: [{ spreadsheetId: 'ss-a', name: 'Pipeline Sheet' }],
      log: quiet,
    });
    expect(resolveTable(catalog, { name: 'Deals (table)', spreadsheetId: 'ss-a' })).toEqual({ spreadsheetId: 'ss-a', tableId: 't1' });
  });
});

describe('parseA1Cell', () => {
  it('parses bare and sheet-qualified single cells (quoted titles too)', () => {
    expect(parseA1Cell('B2')).toEqual({ rowIndex: 1, columnIndex: 1 });
    expect(parseA1Cell('Dashboard!B2')).toEqual({ sheetTitle: 'Dashboard', rowIndex: 1, columnIndex: 1 });
    expect(parseA1Cell("'My Tab'!AA10")).toEqual({ sheetTitle: 'My Tab', rowIndex: 9, columnIndex: 26 });
  });

  it('rejects ranges and junk — single cells only', () => {
    expect(parseA1Cell('A1:B2')).toBeNull();
    expect(parseA1Cell('Dashboard!')).toBeNull();
    expect(parseA1Cell('2B')).toBeNull();
    expect(parseA1Cell('B0')).toBeNull();
  });
});
