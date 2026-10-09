import { OAuth2Client } from 'google-auth-library';
import { backOff } from 'exponential-backoff';
import z from 'zod';

import { googleCredsParser } from '../google/authClient';
import { services } from '../registry';
import { logger } from '../../services/logger';
import { sheetCellValue } from './cells';
import {
  columnLetter,
  DEFAULT_COLUMN_COUNT,
  resolveColumnIndex,
  type SheetLayout,
} from './columns';

export interface TableRange {
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

export interface TableInfo {
  tableId: string;
  name: string;
  sheetId: number;
  sheetName: string;
  range: TableRange;
  columns: TableColumnInfo[];
}

export interface TableColumnInfo {
  columnIndex: number;
  columnName: string;
  columnType: string;
}

/** A retryable Sheets upstream failure (5xx / 429) — thrown inside the
 *  backoff loop; surfaces to callers only once the attempts are spent. */
class TransientSheetsError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Google Sheets ${status} (transient, retries exhausted): ${body.slice(0, 500)}`);
    this.name = 'TransientSheetsError';
  }
}

/**
 * `fetch` with exponential backoff on TRANSIENT upstream failures — the
 * Sheets API 503s ("The service is currently unavailable") routinely, and
 * 429 is its quota sibling. Retries 5xx / 429 / network errors with full
 * jitter (~0.5s, 1.5s, 4.5s, 13.5s caps); anything else (2xx, 4xx) returns
 * to the caller's own handling. Once the attempts are spent the transient
 * error surfaces with its status + body, so run errors stay informative.
 * Exported for tests; `retryOptions` lets them collapse the delays.
 */
export async function sheetsFetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  retryOptions?: { numOfAttempts?: number; startingDelay?: number },
): Promise<Response> {
  return backOff(
    async () => {
      const response = await fetch(url, init);
      if (response.status >= 500 || response.status === 429) {
        let text = '';
        try {
          text = await response.text();
        } catch {
          // unreadable body — the status carries the signal
        }
        throw new TransientSheetsError(response.status, text);
      }
      return response;
    },
    {
      numOfAttempts: retryOptions?.numOfAttempts ?? 5,
      startingDelay: retryOptions?.startingDelay ?? 500,
      timeMultiple: 3,
      jitter: 'full',
      retry: (e) => e instanceof TransientSheetsError || e instanceof TypeError,
    },
  );
}

class GoogleSheetsApiClient {
  private oauth2Client: OAuth2Client;
  private baseUrl: string;
  private driveBaseUrl: string;

  constructor(id: string, creds: z.infer<typeof googleCredsParser> & { baseUrl?: string }) {
    if (!services.google) {
      throw new Error('Google integrations not configured');
    }

    this.oauth2Client = services.google.authClient.getGoogleClient(id, creds);
    this.baseUrl = creds.baseUrl ?? 'https://sheets.googleapis.com';
    // Sharing goes through the Drive permissions API; the fake serves it
    // from the same base as the sheets routes.
    this.driveBaseUrl = creds.baseUrl ?? 'https://www.googleapis.com';

    // Verify credentials were actually set on the client
    const clientCreds = this.oauth2Client.credentials;
    logger.info(`[GOOGLE_SHEETS] Client created for ${id}`, {
      hasAccessToken: !!clientCreds.access_token,
      hasRefreshToken: !!clientCreds.refresh_token,
      refreshTokenType: typeof clientCreds.refresh_token,
      expiryDate: clientCreds.expiry_date,
    });
  }

  private fetchWithRetry(url: string | URL, init?: RequestInit): Promise<Response> {
    return sheetsFetchWithRetry(url, init);
  }

  async listSheets({ spreadsheetId }: { spreadsheetId: string }) {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }

    const url = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`;
    const response = await this.fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken.token}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch spreadsheet: ${errorText}`);
    }

    const data = await response.json();
    return (data.sheets ?? []).map((s: { properties: { sheetId: number; title: string } }) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
    }));
  }

  /** Create a NEW spreadsheet. Under drive.file the app owns files it
   *  creates, so no picker grant is needed — the caller records the id in
   *  google_granted_item and the tables surface like any grant. */
  /** Grant a person writer access to a spreadsheet (Drive permissions API —
   *  allowed under drive.file for files this app created). */
  async addWriterPermission({
    spreadsheetId,
    email,
  }: {
    spreadsheetId: string;
    email: string;
  }): Promise<void> {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const url = `${this.driveBaseUrl}/drive/v3/files/${spreadsheetId}/permissions?sendNotificationEmail=false`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
    });
    if (!response.ok) {
      throw new Error(`Failed to share spreadsheet: ${await response.text()}`);
    }
  }

  async createSpreadsheet({ title }: { title: string }): Promise<{ spreadsheetId: string }> {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const response = await this.fetchWithRetry(`${this.baseUrl}/v4/spreadsheets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: { title } }),
    });
    if (!response.ok) {
      throw new Error(`Failed to create spreadsheet: ${await response.text()}`);
    }
    const data = (await response.json()) as { spreadsheetId?: string };
    if (!data.spreadsheetId) throw new Error('Spreadsheet create returned no id');
    return { spreadsheetId: data.spreadsheetId };
  }

  async listTables({ spreadsheetId }: { spreadsheetId: string }): Promise<TableInfo[]> {
    // Get access token from OAuth2Client
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }

    // Fetch spreadsheet data with tables using the REST API directly
    const url = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title),tables(tableId,name,range,columnProperties))`;
    const response = await this.fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch spreadsheet: ${errorText}`);
    }

    const data = await response.json();
    const tables: TableInfo[] = [];

    for (const sheet of data.sheets ?? []) {
      const sheetId = sheet.properties?.sheetId;
      const sheetName = sheet.properties?.title;
      if (sheetId === undefined || sheetId === null || !sheetName) continue;

      for (const table of sheet.tables ?? []) {
        if (!table.tableId || !table.name || !table.range) continue;

        // columnProperties contains one entry per table column. Each entry should have
        // a columnIndex indicating its position. If columnIndex is missing, fall back
        // to array index (adding table's startColumnIndex to get absolute position).
        const tableStartCol = table.range?.startColumnIndex ?? 0;
        const columns: TableColumnInfo[] = (table.columnProperties ?? []).map(
          (
            col: { columnIndex?: number; columnName?: string; columnType?: string },
            arrayIndex: number,
          ) => {
            const columnIndex =
              typeof col.columnIndex === 'number' ? col.columnIndex : tableStartCol + arrayIndex;
            return {
              columnIndex,
              columnName: col.columnName ?? `Column ${columnIndex + 1}`,
              columnType: col.columnType ?? 'TEXT',
            };
          },
        );

        tables.push({
          tableId: table.tableId,
          name: table.name,
          sheetId,
          sheetName,
          range: {
            startRowIndex: table.range.startRowIndex ?? 0,
            endRowIndex: table.range.endRowIndex ?? 0,
            startColumnIndex: table.range.startColumnIndex ?? 0,
            endColumnIndex: table.range.endColumnIndex ?? 0,
          },
          columns,
        });
      }
    }

    return tables;
  }

  /** The spreadsheet's named ranges — the stable "cell with a durable id"
   *  aliases the adapter surfaces as writable Value targets. */
  async listNamedRanges({ spreadsheetId }: { spreadsheetId: string }): Promise<
    { namedRangeId: string; name: string; range: TableRange & { sheetId?: number } }[]
  > {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const url = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}?fields=namedRanges(namedRangeId,name,range)`;
    const response = await this.fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken.token}` },
    });
    if (!response.ok) {
      throw new Error(`Failed to list named ranges: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      namedRanges?: {
        namedRangeId?: string;
        name?: string;
        range?: { sheetId?: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number };
      }[];
    };
    return (data.namedRanges ?? [])
      .filter((r) => r.namedRangeId && r.name && r.range)
      .map((r) => ({
        namedRangeId: r.namedRangeId as string,
        name: r.name as string,
        range: {
          sheetId: r.range?.sheetId,
          startRowIndex: r.range?.startRowIndex ?? 0,
          endRowIndex: r.range?.endRowIndex ?? (r.range?.startRowIndex ?? 0) + 1,
          startColumnIndex: r.range?.startColumnIndex ?? 0,
          endColumnIndex: r.range?.endColumnIndex ?? (r.range?.startColumnIndex ?? 0) + 1,
        },
      }));
  }

  /** Read the values of a range — `spreadsheets.values.get`. `range` may be an
   *  A1 range OR a named range's NAME (the Sheets API resolves a named range as
   *  a range verbatim), which is how a named cell's Value is read back. Returns
   *  the raw value grid (`[[cell]]`); an empty range comes back `[]`. */
  async getRangeValues({
    spreadsheetId,
    range,
  }: {
    spreadsheetId: string;
    range: string;
  }): Promise<unknown[][]> {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const url = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const response = await this.fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken.token}` },
    });
    if (!response.ok) {
      throw new Error(`Failed to read range values: ${await response.text()}`);
    }
    const data = (await response.json()) as { values?: unknown[][] };
    return data.values ?? [];
  }

  /** Overwrite a named range's FIRST cell (v1 surfaces single-cell named
   *  ranges as Value targets). The range is re-resolved per write, so a
   *  moved range stays correct — that's the point of the alias. */
  async setNamedRangeValue({
    spreadsheetId,
    namedRangeId,
    value,
  }: {
    spreadsheetId: string;
    namedRangeId: string;
    value: unknown;
  }) {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const ranges = await this.listNamedRanges({ spreadsheetId });
    const named = ranges.find((r) => r.namedRangeId === namedRangeId);
    if (!named) {
      throw new Error(`Named range not found: ${namedRangeId}`);
    }
    const response = await this.fetchWithRetry(`${this.baseUrl}/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            updateCells: {
              start: {
                sheetId: named.range.sheetId ?? 0,
                rowIndex: named.range.startRowIndex,
                columnIndex: named.range.startColumnIndex,
              },
              rows: [{ values: [{ userEnteredValue: sheetCellValue(value, undefined) }] }],
              fields: 'userEnteredValue',
            },
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set named range value: ${await response.text()}`);
    }
  }

  /** Create a named range (the agent-performed naming that makes a cell a
   *  stable write target — the user never touches the Sheets UI). Returns the
   *  source-issued namedRangeId. */
  async addNamedRange({
    spreadsheetId,
    name,
    range,
  }: {
    spreadsheetId: string;
    name: string;
    range: { sheetId: number; rowIndex: number; columnIndex: number };
  }): Promise<{ namedRangeId: string }> {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const response = await this.fetchWithRetry(`${this.baseUrl}/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            addNamedRange: {
              namedRange: {
                name,
                range: {
                  sheetId: range.sheetId,
                  startRowIndex: range.rowIndex,
                  endRowIndex: range.rowIndex + 1,
                  startColumnIndex: range.columnIndex,
                  endColumnIndex: range.columnIndex + 1,
                },
              },
            },
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to add named range: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      replies?: { addNamedRange?: { namedRange?: { namedRangeId?: string } } }[];
    };
    const id = data.replies?.[0]?.addNamedRange?.namedRange?.namedRangeId;
    if (!id) throw new Error('addNamedRange returned no namedRangeId');
    return { namedRangeId: id };
  }

  /** Overwrite ONE cell at explicit grid coords — the A1 escape hatch's
   *  transport. Positional by definition; the adapter documents the drift
   *  hazard on the authoring surface. */
  async setCellValue({
    spreadsheetId,
    sheetId,
    rowIndex,
    columnIndex,
    value,
  }: {
    spreadsheetId: string;
    sheetId: number;
    rowIndex: number;
    columnIndex: number;
    value: unknown;
  }) {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const response = await this.fetchWithRetry(`${this.baseUrl}/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            updateCells: {
              start: { sheetId, rowIndex, columnIndex },
              rows: [{ values: [{ userEnteredValue: sheetCellValue(value, undefined) }] }],
              fields: 'userEnteredValue',
            },
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set cell value: ${await response.text()}`);
    }
  }

  async getTableColumns({
    spreadsheetId,
    tableId,
  }: {
    spreadsheetId: string;
    tableId: string;
  }): Promise<TableColumnInfo[]> {
    const tables = await this.listTables({ spreadsheetId });
    const table = tables.find((t) => t.tableId === tableId);
    return table?.columns ?? [];
  }

  /**
   * A plain tab's COLUMN LAYOUT: row 1 positionally (`''` where a column has no
   * header) plus the grid's column count.
   *
   * Positional, not compacted — a header at column C must resolve to C even if
   * A and B are blank, and the old compacted list couldn't say that. And ONE
   * read, shared by the describe and the append: `addRow` used to repeat this
   * fetch with its own slightly different handling, which is two readings of
   * one row that can disagree about where a field lands.
   */
  async getSheetLayout({
    spreadsheetId,
    sheetId,
  }: {
    spreadsheetId: string;
    sheetId: number;
  }): Promise<SheetLayout> {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const authHeaders = { Authorization: `Bearer ${accessToken.token}` };

    const metaUrl = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title,gridProperties.columnCount)`;
    const metaResp = await this.fetchWithRetry(metaUrl, { headers: authHeaders });
    if (!metaResp.ok) {
      throw new Error(`Failed to fetch spreadsheet metadata: ${await metaResp.text()}`);
    }
    const meta = await metaResp.json();
    const sheetMeta = (meta.sheets ?? []).find(
      (s: { properties: { sheetId: number } }) => s.properties.sheetId === sheetId,
    );
    if (!sheetMeta) {
      throw new Error('Sheet not found');
    }
    const sheetName = sheetMeta.properties.title;
    const columnCount: number =
      sheetMeta.properties?.gridProperties?.columnCount ?? DEFAULT_COLUMN_COUNT;

    const headerUrl = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${sheetName}'!1:1`)}`;
    const headerResp = await this.fetchWithRetry(headerUrl, { headers: authHeaders });
    if (!headerResp.ok) {
      throw new Error(`Failed to read header row: ${await headerResp.text()}`);
    }
    const headerData = await headerResp.json();
    const raw: unknown[] = headerData.values?.[0] ?? [];
    return {
      headers: raw.map((h) => String(h ?? '').trim()),
      columnCount: Math.max(columnCount, raw.length),
    };
  }

  async addRow({
    spreadsheetId,
    sheetId,
    row,
  }: {
    spreadsheetId: string;
    sheetId: number;
    row: Record<string, string | number | boolean | Date>;
  }) {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }

    const authHeaders = { Authorization: `Bearer ${accessToken.token}` };

    // Resolve sheet name from sheetId
    const metaUrl = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`;
    const metaResp = await this.fetchWithRetry(metaUrl, { headers: authHeaders });
    if (!metaResp.ok) {
      throw new Error(`Failed to fetch spreadsheet metadata: ${await metaResp.text()}`);
    }
    const meta = await metaResp.json();
    const sheetMeta = (meta.sheets ?? []).find(
      (s: { properties: { sheetId: number } }) => s.properties.sheetId === sheetId,
    );
    if (!sheetMeta) {
      throw new Error('Sheet not found');
    }
    const sheetName = sheetMeta.properties.title;

    // Place each field at the column it names — a header at that header's
    // position, or a column letter at its own. Both vocabularies resolve
    // through `resolveColumnIndex`, the same function the describe published
    // them from, so a field can't be offered under a name the append then
    // fails to place.
    const layout = await this.getSheetLayout({ spreadsheetId, sheetId });
    const cells: (string | number | boolean)[] = [];
    const placed = new Map<number, string>();
    for (const [name, value] of Object.entries(row)) {
      const index = resolveColumnIndex(layout, name);
      if (index === undefined) {
        throw new Error(
          `Google Sheets: '${sheetName}' has no column '${name}'. Write to a header name from row 1, or a column letter (A, B, C…).`,
        );
      }
      const already = placed.get(index);
      if (already !== undefined) {
        // Two names, one cell — a header and its own column letter. Silently
        // letting one win would drop a value the author asked to write.
        throw new Error(
          `Google Sheets: '${already}' and '${name}' are the same column of '${sheetName}' (${columnLetter(index)}) — write one of them, not both.`,
        );
      }
      placed.set(index, name);
      if (value === undefined || value === null) continue;
      cells[index] = value instanceof Date ? value.toISOString() : value;
    }
    const width = Math.max(0, ...[...placed.keys()].map((i) => i + 1));
    const values = Array.from({ length: width }, (_, i) => cells[i] ?? '');

    // Append row
    const appendUrl = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${sheetName}'`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const appendResp = await this.fetchWithRetry(appendUrl, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    });

    if (!appendResp.ok) {
      throw new Error(`Failed to append row: ${await appendResp.text()}`);
    }
  }

  /**
   * Read a table's data rows (header excluded). Each row carries its 1-based
   * absolute SHEET row number — the address `updateTableRow` writes to. Row
   * numbers are positional (sorts/inserts shift them), so callers resolve
   * fresh rather than storing them.
   */
  async getTableRows({
    spreadsheetId,
    tableId,
  }: {
    spreadsheetId: string;
    tableId: string;
  }): Promise<{ rowNumber: number; values: unknown[] }[]> {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const tables = await this.listTables({ spreadsheetId });
    const table = tables.find((t) => t.tableId === tableId);
    if (!table) {
      throw new Error(`Table not found: ${tableId}`);
    }
    const { startRowIndex, endRowIndex, startColumnIndex, endColumnIndex } = table.range;
    // Data rows start one past the header row. Range indices are 0-based
    // half-open grid coords; A1 rows/cols are 1-based inclusive.
    const firstDataRow = startRowIndex + 2; // 1-based, skipping the header
    const lastRow = endRowIndex; // 1-based inclusive == 0-based exclusive end
    if (firstDataRow > lastRow) return [];
    // `columnLetter` is 0-BASED (columns.ts), matching the API's own grid
    // indices — so the start index passes straight through, and the exclusive
    // end index steps back one to become an inclusive A1 column.
    const colA = columnLetter(startColumnIndex);
    const colB = columnLetter(endColumnIndex - 1);
    const a1 = `'${table.sheetName}'!${colA}${firstDataRow}:${colB}${lastRow}`;
    const url = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1)}`;
    const response = await this.fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken.token}` },
    });
    if (!response.ok) {
      throw new Error(`Failed to read table rows: ${await response.text()}`);
    }
    const data = (await response.json()) as { values?: unknown[][] };
    return (data.values ?? []).map((values, i) => ({
      rowNumber: firstDataRow + i,
      values,
    }));
  }

  /**
   * Overwrite ONLY the given columns of one existing row (1-based absolute
   * sheet row). Unmapped columns keep their current values — one updateCells
   * request per written column, batched.
   */
  async updateTableRow({
    spreadsheetId,
    tableId,
    rowNumber,
    valuesByColumn,
  }: {
    spreadsheetId: string;
    tableId: string;
    rowNumber: number;
    valuesByColumn: { columnIndex: number; value: unknown; columnType?: string }[];
  }) {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }
    const tables = await this.listTables({ spreadsheetId });
    const table = tables.find((t) => t.tableId === tableId);
    if (!table) {
      throw new Error(`Table not found: ${tableId}`);
    }
    const requests = valuesByColumn.map((v) => ({
      updateCells: {
        start: {
          sheetId: table.sheetId,
          rowIndex: rowNumber - 1,
          columnIndex: table.range.startColumnIndex + v.columnIndex,
        },
        rows: [{ values: [{ userEnteredValue: sheetCellValue(v.value, v.columnType) }] }],
        fields: 'userEnteredValue',
      },
    }));
    const url = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
      throw new Error(`Failed to update table row: ${await response.text()}`);
    }
  }

  async addTableRow({
    spreadsheetId,
    tableId,
    valuesByColumn,
  }: {
    spreadsheetId: string;
    tableId: string;
    valuesByColumn: { columnIndex: number; value: unknown; columnType?: string }[];
  }) {
    const accessToken = await this.oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Failed to get access token');
    }

    // Look up the table to get its sheetId
    const tables = await this.listTables({ spreadsheetId });
    const table = tables.find((t) => t.tableId === tableId);
    if (!table) {
      throw new Error(`Table not found: ${tableId}`);
    }

    // Build row values array with values at correct column positions
    const maxColumnIndex = Math.max(...valuesByColumn.map((v) => v.columnIndex));
    const rowValues: {
      userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean };
    }[] = [];

    for (let i = 0; i <= maxColumnIndex; i++) {
      const columnValue = valuesByColumn.find((v) => v.columnIndex === i);
      rowValues.push(
        columnValue
          ? { userEnteredValue: sheetCellValue(columnValue.value, columnValue.columnType) }
          : {},
      );
    }

    const url = `${this.baseUrl}/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            appendCells: {
              sheetId: table.sheetId,
              tableId: tableId,
              rows: [{ values: rowValues }],
              fields: 'userEnteredValue',
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to add table row: ${errorText}`);
    }
  }
}

export { GoogleSheetsApiClient };
