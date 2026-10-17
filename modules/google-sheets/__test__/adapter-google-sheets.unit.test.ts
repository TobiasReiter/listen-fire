// Unit tests for the Google Sheets TG adapter — pure helpers + mocked-client
// paths only (no network, no LLM). Covers:
//   1. name → structured-id cache — a granted table's pretty name resolves;
//      an unknown/foreign name does not.
//   2. describe — column mapping for a table type against a mocked
//      getTableColumns; null for foreign ids.
//   3. createRecord — column-mapped `addTableRow` append, with value coercion
//      + null-drop.
//   4. updateRecord guards non-row addresses; deleteRecord throws.
//   5. resolveEntity — bridge-only (linked_object match, else 0 candidates).
//
// The API client is mocked by overriding the adapter's private getApiClient,
// and the grants are a kv the test holds; fake-channels is never hit.

import type { Expression } from '#shared/expression/types';
import type { ModuleKv } from 'module-kit';
import type {
  ResolveEntityInput,
  WriteInput,
  UpdateInput,
  DeleteInput,
} from 'movement-engine/public/adapter';

import { GoogleSheetsAdapter } from '../adapter';
import { SPREADSHEET_META_TYPE, cellAddressesInWhere } from '../schema_catalog';
import {
  makeMetaPosition,
  makeStablePosition,
  positionData,
  positionRecordId,
} from 'movement-engine/public/catalog';
import { sheetCellValue } from '../cells';

// The install's grants, as the host's kv holds them: the fixture spreadsheets
// the tests grant, each named `Sheet <id>`. The adapter feeds them into the
// name → structured-id cache (listEntryPoints + describe).
const grantedSpreadsheetIds: string[] = [];
const grantsKv: ModuleKv = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  list: async (prefix) =>
    grantedSpreadsheetIds
      .map((id) => ({ key: `granted/${id}`, value: { mimeType: 'application/vnd.google-apps.spreadsheet', name: `Sheet ${id}` } }))
      .filter((entry) => entry.key.startsWith(prefix)),
};
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** An adapter whose client the test swaps in (`getApiClient`). */
function sheetsAdapter(opts?: { spreadsheet?: string }): GoogleSheetsAdapter {
  return new GoogleSheetsAdapter({
    client: async () => {
      throw new Error('no client: the test swaps getApiClient');
    },
    kv: grantsKv,
    log: quiet,
    tenant: 'team-sheets',
    ...(opts?.spreadsheet !== undefined ? { spreadsheet: opts.spreadsheet } : {}),
  });
}


// ---------------------------------------------------------------------------
// Fixtures + fake client
// ---------------------------------------------------------------------------

const SPREADSHEET_ID = 'sprSHEET01';
const SHEET_ID = 42;
const TABLE_ID = 'tblTASKS01';
// The table's pretty type name is the framework identity now — a position's
// `recordType` / an entry's `typeId`.
const TABLE_TYPE = 'Tasks (table)';

function tableColumns() {
  return [
    { columnIndex: 0, columnName: 'Name', columnType: 'TEXT' },
    { columnIndex: 1, columnName: 'Amount', columnType: 'CURRENCY' },
    { columnIndex: 2, columnName: 'Done', columnType: 'BOOLEAN' },
    { columnIndex: 3, columnName: 'Due', columnType: 'DATE' },
  ];
}

interface FakeClientCalls {
  /** Which spreadsheets got enumerated — the fanout the walk must not pay. */
  listTables: string[];
  addTableRow: Array<{
    spreadsheetId: string;
    tableId: string;
    valuesByColumn: { columnIndex: number; value: unknown; columnType?: string }[];
  }>;
}

function makeAdapter(opts?: { spreadsheet?: string }): { adapter: GoogleSheetsAdapter; calls: FakeClientCalls } {
  const adapter = sheetsAdapter(opts);
  const calls: FakeClientCalls = { listTables: [], addTableRow: [] };
  const fakeClient = {
    listTables: async ({ spreadsheetId }: { spreadsheetId: string }) => {
      calls.listTables.push(spreadsheetId);
      return spreadsheetId === SPREADSHEET_ID
        ? [{ tableId: TABLE_ID, name: 'Tasks', sheetId: SHEET_ID, sheetName: 'Leads', range: {}, columns: tableColumns() }]
        : [];
    },
    // The strict single-sheet surface (`loadSpreadsheetSurface`) enumerates
    // tabs + named ranges alongside tables. The fixture's one tab hosts the
    // table, so no plain-tab type surfaces.
    listSheets: async ({ spreadsheetId }: { spreadsheetId: string }) =>
      spreadsheetId === SPREADSHEET_ID ? [{ sheetId: SHEET_ID, title: 'Leads' }] : [],
    listNamedRanges: async () => [],
    getTableColumns: async ({ tableId }: { tableId: string }) =>
      tableId === TABLE_ID ? tableColumns() : [],
    // Root-collection reads (layer 7 category 3): the rows the readable table
    // edge promises.
    getTableRows: async ({ tableId }: { tableId: string }) =>
      tableId === TABLE_ID
        ? [
            { rowNumber: 2, values: ['Write memo', 250, true, '2026-07-01'] },
            { rowNumber: 3, values: ['Call Acme', 100, false, '2026-07-02'] },
          ]
        : [],
    addTableRow: async (args: {
      spreadsheetId: string;
      tableId: string;
      valuesByColumn: { columnIndex: number; value: unknown; columnType?: string }[];
    }) => {
      calls.addTableRow.push(args);
    },
  };
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () =>
    fakeClient;
  return { adapter, calls };
}

beforeEach(() => {
  // Default: the fixture spreadsheet is granted, so the name → structured-id
  // cache can enumerate its tables. Individual tests override as needed.
  grantedSpreadsheetIds.length = 0;
  grantedSpreadsheetIds.push(SPREADSHEET_ID);
});

// ---------------------------------------------------------------------------
// 1. Name → structured-identifier cache (via the public surface)
// ---------------------------------------------------------------------------

describe('Google Sheets name → structured-id cache', () => {
  it('the only top-level entry is the polymorphic Spreadsheet; a table is reached via traversal', async () => {
    const { adapter } = makeAdapter();
    // ONE presentation (mirrors Airtable's `:Base`-only root): the named
    // per-grant entries were dropped — narrowing (`WHERE `Title` == …`)
    // replaces naming a grant as a type. `listEntryPoints` IS
    // `edgesFrom(meta)`, so it publishes exactly what the walk does.
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId)).toEqual(['Spreadsheet']);
    // A grant still describes BY NAME — the call narrowing resolves to.
    const named = await adapter.describe(`Sheet ${SPREADSHEET_ID}`);
    expect(named?.references?.map((r) => r.fieldId)).toContain(TABLE_TYPE);
    expect(await adapter.describe(TABLE_TYPE)).not.toBeNull();
  });

  it('does not resolve an unknown / foreign name', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.describe('airtable:app:tbl')).toBeNull();
    expect(await adapter.describe('Missing (table)')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. coercion helpers
// ---------------------------------------------------------------------------

describe('sheetCellValue — typed cells per column', () => {
  it('a DATE column → a serial-date numberValue (not a stringified JS date)', () => {
    // 2026-06-18 UTC = 46191 days after the Sheets epoch (1899-12-30).
    expect(sheetCellValue('2026-06-18', 'DATE')).toEqual({ numberValue: 46191 });
    expect(sheetCellValue(new Date('2026-06-18T00:00:00Z'), 'DATE')).toEqual({
      numberValue: 46191,
    });
  });

  it('a numeric column coerces a numeric string → numberValue', () => {
    expect(sheetCellValue('250', 'CURRENCY')).toEqual({ numberValue: 250 });
    expect(sheetCellValue(7, 'DOUBLE')).toEqual({ numberValue: 7 });
  });

  it('a BOOLEAN column coerces truthy strings → boolValue', () => {
    expect(sheetCellValue('yes', 'BOOLEAN')).toEqual({ boolValue: true });
    expect(sheetCellValue(false, 'BOOLEAN')).toEqual({ boolValue: false });
  });

  it('TEXT / unparseable values fall back to a string', () => {
    expect(sheetCellValue('hi', 'TEXT')).toEqual({ stringValue: 'hi' });
    expect(sheetCellValue('not-a-date', 'DATE')).toEqual({ stringValue: 'not-a-date' });
  });
});

// ---------------------------------------------------------------------------
// 3. describe
// ---------------------------------------------------------------------------

describe('GoogleSheetsAdapter.describe', () => {
  it('maps native-table columns to writable fields with inferred kinds', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe(TABLE_TYPE);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.displayName).toBe('Tasks (table)');
    expect(descriptor!.references).toEqual([]);
    expect(descriptor!.uniquenessConstraints).toBeUndefined();

    const byId = new Map(descriptor!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('Name')!.kind).toBe('string');
    expect(byId.get('Name')!.writable).toBe(true);
    expect(byId.get('Amount')!.kind).toBe('number');
    expect(byId.get('Done')!.kind).toBe('boolean');
    expect(byId.get('Due')!.kind).toBe('date');
  });

  it('returns null for a foreign / unknown name', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.describe('airtable:app:tbl')).toBeNull();
    expect(await adapter.describe('Missing (table)')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3b. listEntryPoints — fed by the credential's granted-spreadsheets set
// ---------------------------------------------------------------------------

describe('GoogleSheetsAdapter.listEntryPoints', () => {
  it('exposes no flat leaf roots; the granted tables surface as a spreadsheet\'s edges', async () => {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    // ONE root edge: the narrowable `Spreadsheet`. No flat leaf roots, no
    // named per-grant entries.
    expect(entries.map((e) => e.typeId)).toEqual(['Spreadsheet']);
    expect(entries[0]).toMatchObject({ typeId: 'Spreadsheet', writable: true, readable: true });
    // Cells hang off any spreadsheet; TABLES depend on WHICH one, so the
    // unnarrowed node doesn't claim them (4_polymorphic_edges.md). The Title
    // field is what a narrowing predicate reads; the node says so.
    const spreadsheet = await adapter.describe('Spreadsheet');
    expect(spreadsheet?.references?.map((r) => r.fieldId)).toEqual(['cells', 'named cells']);
    expect(spreadsheet?.description).toContain('narrow');
    // Name the sheet and its tables appear — one fetch, no cross-grant union.
    const named = await adapter.describe(`Sheet ${SPREADSHEET_ID}`);
    expect(named?.references?.map((r) => r.fieldId)).toEqual(
      expect.arrayContaining(['cells', 'named cells', TABLE_TYPE]),
    );
  });

  it('the entry list and the walk agree on the root\'s edges AND their promises', async () => {
    // `listEntryPoints` IS `edgesFrom(meta)` — the same node's edges, so they
    // must publish the same EDGES with the same PROMISES (the airtable
    // agreement test, mirrored). `Spreadsheet` is readable (the grants
    // project as a collection) AND writable (a movement creates one —
    // `createRecord` on the Spreadsheet type calls `client.createSpreadsheet`).
    //
    // The walk's `writable` is read as `=== true`, NOT `!== false`: since layer
    // 13 an edge's write promise is EXPLICIT and absent means read-only. Read
    // with the retired default-true, this assertion passed while the root edge
    // declared nothing — which is exactly how the missing flag hid.
    const { adapter } = makeAdapter();
    const entries = (await adapter.listEntryPoints()).map((e) => ({
      name: e.displayName,
      readable: e.readable === true,
      writable: e.writable === true,
    }));
    const hop = await adapter.edgesFrom(makeMetaPosition('google_sheets'));
    const walk = (hop?.descriptor.references ?? []).map((r) => ({
      name: r.name ?? r.fieldId,
      readable: r.readable !== false,
      writable: r.writable === true,
    }));
    expect(walk).toEqual(entries);
    expect(entries).toEqual([{ name: 'Spreadsheet', readable: true, writable: true }]);
  });

  it('offers only the Spreadsheet root when no spreadsheet is granted', async () => {
    grantedSpreadsheetIds.length = 0;
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId)).toEqual(['Spreadsheet']);
  });

  // The walk replaces describeSelected: narrowing a polymorphic edge is
  // procedurally identical to taking the named one — same landing, same
  // minimal fanout. plans/2026-07-10-adapter-entry-positions/4_polymorphic_edges.md
  it('describes ONE grant by name — the route narrowing resolves to', async () => {
    const { adapter } = makeAdapter();
    const named = await adapter.describe(`Sheet ${SPREADSHEET_ID}`);
    expect(named).not.toBeNull();
    const edgeNames = (named!.references ?? []).map((r) => r.fieldId);
    // That grant's tables + the cell edges — NOT a cross-grant union.
    expect(edgeNames).toContain('Tasks (table)');
    expect(edgeNames).toContain('cells');
    // An unknown title is simply not a type here.
    expect(await adapter.describe('Nope')).toBeNull();
  });

  it('unnarrowed Spreadsheet carries no leaves, and costs no upstream call', async () => {
    const { adapter, calls } = makeAdapter();
    const spreadsheet = await adapter.describe('Spreadsheet');
    const edgeNames = (spreadsheet!.references ?? []).map((r) => r.fieldId);
    // Which tabs/tables exist depends on WHICH spreadsheet — nobody has said
    // yet. The union it used to answer with was a fetch per grant AND an edge
    // set no single sheet had.
    expect(edgeNames).toEqual(['cells', 'named cells']);
    expect(spreadsheet!.fields.map((f) => f.fieldId)).toContain('Title');
    expect(calls.listTables).toEqual([]);
  });

  it('the root hop is ONE polymorphic edge whose members carry the paths on — no upstream call', async () => {
    const { adapter, calls } = makeAdapter();
    const hop = await adapter.edgesFrom({
      adapterType: 'google_sheets',
      recordType: 'meta',
      identity: { kind: 'unstable', data: null },
    });
    // The named per-grant edges are gone from the presentation; the members
    // ride `targetPositions` with no reference row each.
    expect(hop?.descriptor.references.map((r) => r.targetTypeId)).toEqual(['Spreadsheet']);
    const path = hop?.targetPositions?.[SPREADSHEET_ID];
    // ONE word for one node: the member's recordType names the polymorphic
    // edge it belongs to — the gate `stepTo`/`membersOf` apply, so a
    // `-[s:Spreadsheet WHERE …]->` finds it. (`GrantedSpreadsheet` retired:
    // a second word made every WHERE match nothing.)
    expect(path?.recordType).toBe('Spreadsheet');
    expect(path?.identity.kind === 'stable' && path.identity.recordId).toBe(SPREADSHEET_ID);
    // The Title label is what the predicate evaluates AND what names the member.
    expect(path?.identity.kind === 'stable' && path.identity.data).toEqual({
      Title: `Sheet ${SPREADSHEET_ID}`,
    });
    // Grants are a DB read; listing what you can reach costs Google nothing.
    expect(calls.listTables).toEqual([]);
  });

  it('walking to a grant describes only that sheet, with a path per leaf', async () => {
    const { adapter } = makeAdapter();
    const hop = await adapter.edgesFrom({
      adapterType: 'google_sheets',
      recordType: 'Spreadsheet',
      identity: { kind: 'stable', recordId: SPREADSHEET_ID, data: { Title: `Sheet ${SPREADSHEET_ID}` } },
    });
    expect((hop?.descriptor.references ?? []).map((r) => r.fieldId)).toContain('Tasks (table)');
    // Every leaf edge hands over its path — the route the next hop rides.
    expect(Object.keys(hop?.targetPositions ?? {})).toEqual(
      expect.arrayContaining(['cells', 'named cells', TABLE_TYPE]),
    );
    const leaf = hop?.targetPositions?.[TABLE_TYPE];
    expect(leaf?.recordType).toBe(TABLE_TYPE);
    expect(leaf?.identity.kind === 'stable' && leaf.identity.data).toMatchObject({
      spreadsheetId: SPREADSHEET_ID,
      tableId: TABLE_ID,
    });
  });

  it('a table leaf hop describes its columns from the route it carries — no catalog rebuild', async () => {
    const { adapter, calls } = makeAdapter();
    const hop = await adapter.edgesFrom({
      adapterType: 'google_sheets',
      recordType: TABLE_TYPE,
      identity: {
        kind: 'stable',
        recordId: TABLE_ID,
        data: { spreadsheetId: SPREADSHEET_ID, tableId: TABLE_ID, Name: TABLE_TYPE },
      },
    });
    expect(hop?.descriptor.displayName).toBe(TABLE_TYPE);
    expect(hop?.descriptor.fields.map((f) => f.fieldId)).toEqual(['Name', 'Amount', 'Done', 'Due']);
    // One scoped fetch (getTableColumns); the workspace is never re-walked.
    expect(calls.listTables).toEqual([]);
  });

  it('the universal cell leaves describe from their meta descriptors, free', async () => {
    const { adapter } = makeAdapter();
    const cells = await adapter.edgesFrom({
      adapterType: 'google_sheets',
      recordType: 'Cell',
      identity: { kind: 'stable', recordId: `${SPREADSHEET_ID}:cells`, data: { spreadsheetId: SPREADSHEET_ID } },
    });
    expect(cells?.descriptor.fields.map((f) => f.fieldId)).toEqual(['Cell', 'Value']);
    const named = await adapter.edgesFrom({
      adapterType: 'google_sheets',
      recordType: 'Named cell',
      identity: { kind: 'stable', recordId: `${SPREADSHEET_ID}:named cells`, data: { spreadsheetId: SPREADSHEET_ID } },
    });
    // Read + create: Name (read+write), Value (read-only, the cell's value),
    // Cell (write-only create input — WHICH cell to name).
    expect(named?.descriptor.fields.map((f) => f.fieldId)).toEqual(['Name', 'Value', 'Cell']);
  });

  it('a stale grant hop errors honestly instead of walking to a leafless node', async () => {
    // "No leaves" and "the spreadsheet is gone" are different facts. The
    // grant hop is STRICT: a failed introspection propagates with the
    // stale-grant hint, never degrades to an empty surface.
    grantedSpreadsheetIds.push('spr-GONE');
    const { adapter } = makeAdapter();
    const failing = {
      listTables: async ({ spreadsheetId }: { spreadsheetId: string }) => {
        if (spreadsheetId === 'spr-GONE') throw new Error('Failed to fetch spreadsheet: 404');
        return [];
      },
      listSheets: async () => [],
      listNamedRanges: async () => [],
    };
    (adapter as unknown as { getApiClient: () => Promise<typeof failing> }).getApiClient =
      async () => failing;
    await expect(
      adapter.edgesFrom({
        adapterType: 'google_sheets',
        recordType: 'Spreadsheet',
        identity: { kind: 'stable', recordId: 'spr-GONE', data: { Title: 'Sheet spr-GONE' } },
      }),
    ).rejects.toThrow(/stale/);
  });


  it('projects the grants as stable Spreadsheet positions off the meta root', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({
      position: { adapterType: 'google_sheets', recordType: 'meta', identity: { kind: 'unstable', data: null } },
      fieldId: 'Spreadsheet',
      direction: 'outgoing',
    } as never);
    expect(related).toHaveLength(1);
    expect(related[0].position).toMatchObject({
      recordType: 'Spreadsheet',
      identity: { kind: 'stable', recordId: SPREADSHEET_ID },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. createRecord — append paths
// ---------------------------------------------------------------------------

describe('GoogleSheetsAdapter.createRecord', () => {
  it('appends a column-mapped row via addTableRow, resolving column indices by name', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: TABLE_TYPE,
      fields: { Name: 'Task1', Amount: 99, Unknown: 'x', Skip: null },
      mutationContext: {} as never,
    } as WriteInput);

    expect(calls.addTableRow).toHaveLength(1);
    expect(calls.addTableRow[0].spreadsheetId).toBe(SPREADSHEET_ID);
    expect(calls.addTableRow[0].tableId).toBe(TABLE_ID);
    // 'Unknown' has no matching column → skipped; null 'Skip' → dropped. The
    // raw value + the column's Sheets type flow to the client, which builds the
    // typed cell (sheetCellValue).
    expect(calls.addTableRow[0].valuesByColumn).toEqual([
      { columnIndex: 0, value: 'Task1', columnType: 'TEXT' },
      { columnIndex: 1, value: 99, columnType: 'CURRENCY' },
    ]);

    expect(result.externalId).toBe(`${SPREADSHEET_ID}:${TABLE_ID}`);
    expect(result.data!.url).toBe(
      `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
    );
  });

  it('throws on an unrecognised recordType', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: 'airtable:app:tbl',
        fields: { x: 1 },
        mutationContext: {} as never,
      } as WriteInput),
    ).rejects.toThrow(/unrecognised recordType/);
  });
});

// ---------------------------------------------------------------------------
// 5. update guards / delete throws
// ---------------------------------------------------------------------------

describe('GoogleSheetsAdapter write guards', () => {
  it('updateRecord rejects a non-row externalId with a unique-by pointer', async () => {
    // Only rows resolved through `unique by` carry a row address — a bare
    // table id (the legacy create externalId) has no row to mutate.
    const { adapter } = makeAdapter();
    await expect(
      adapter.updateRecord({
        recordType: TABLE_TYPE,
        externalId: 'whatever',
        fields: {},
        mutationContext: {} as never,
      } as UpdateInput),
    ).rejects.toThrow(/unique by/);
  });

  it('deleteRecord throws — appends and overwrites only', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.deleteRecord({
        recordType: TABLE_TYPE,
        externalId: 'whatever',
        mutationContext: {} as never,
      } as DeleteInput),
    ).rejects.toThrow(/cannot be deleted/);
  });
});

// ---------------------------------------------------------------------------
// 6. resolveEntity — empty constraints stay a plain append
// ---------------------------------------------------------------------------

describe('GoogleSheetsAdapter.resolveEntity', () => {
  it('returns 0 candidates when no unique-by constraints are authored (plain append)', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.resolveEntity({
      record: { Name: 'Acme' },
      recordType: TABLE_TYPE,
      candidates: [],
      constraints: { any: [] },
    } as unknown as ResolveEntityInput);
    expect(result.candidates).toEqual([]);
  });

  it('a prior linked_object bridge alone still yields 0 candidates — only a live unique-by scan can address a row', async () => {
    const { adapter } = makeAdapter();
    const recordType = TABLE_TYPE;
    const result = await adapter.resolveEntity({
      record: { Name: 'Acme' },
      recordType,
      candidates: [
        {
          node_id: 'node-1',
          external_id: recordType,
          external_object_type: recordType,
          created_at: new Date(),
        } as unknown as ResolveEntityInput['candidates'][number],
      ],
      constraints: { any: [] },
    } as unknown as ResolveEntityInput);
    expect(result.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Plain-tab (bare sheet) append — "<tab> (sheet)"
// ---------------------------------------------------------------------------

const PLAIN_SPREADSHEET_ID = 'sprPLAIN02';
const PLAIN_TAB_TYPE = 'Sheet1 (sheet)';

interface TabClientCalls {
  addRow: Array<{ spreadsheetId: string; sheetId: number; row: Record<string, unknown> }>;
}

/** An adapter over a spreadsheet with a plain tab "Sheet1" (no native Table)
 *  whose header row is Timestamp/Sender/Message/Company — the reporter's case. */
function makeTabAdapter(options?: { headers?: string[] }): { adapter: GoogleSheetsAdapter; calls: TabClientCalls } {
  const adapter = sheetsAdapter();
  const calls: TabClientCalls = { addRow: [] };
  const header = options?.headers ?? ['Timestamp', 'Sender', 'Message', 'Company'];
  const fakeClient = {
    // The plain-tab spreadsheet hosts no native Tables.
    listTables: async () => [],
    listSheets: async ({ spreadsheetId }: { spreadsheetId: string }) =>
      spreadsheetId === PLAIN_SPREADSHEET_ID ? [{ sheetId: 0, title: 'Sheet1' }] : [],
    getSheetLayout: async ({ spreadsheetId, sheetId }: { spreadsheetId: string; sheetId: number }) =>
      spreadsheetId === PLAIN_SPREADSHEET_ID && sheetId === 0
        // Grid width: as wide as the headers when there are any, else the
        // default 26 a blank sheet ships with.
        ? { headers: header, columnCount: header.length || 26 }
        : { headers: [], columnCount: 26 },
    addRow: async (args: { spreadsheetId: string; sheetId: number; row: Record<string, unknown> }) => {
      calls.addRow.push(args);
    },
    listNamedRanges: async () => [],
  };
  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () =>
    fakeClient;
  return { adapter, calls };
}

describe('GoogleSheetsAdapter — plain-tab (bare sheet) append', () => {
  beforeEach(() => {
    grantedSpreadsheetIds.length = 0;
    grantedSpreadsheetIds.push(PLAIN_SPREADSHEET_ID);
  });

  it('surfaces a plain tab as a "<tab> (sheet)" edge off a described grant', async () => {
    const { adapter } = makeTabAdapter();
    // Not a flat root — reached only by traversing a resolved Spreadsheet.
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId)).toEqual(['Spreadsheet']);
    const spreadsheet = await adapter.describe(`Sheet ${PLAIN_SPREADSHEET_ID}`);
    expect(spreadsheet?.references?.map((r) => r.fieldId)).toContain(PLAIN_TAB_TYPE);
  });

  it('describe returns column LETTERS and the header row — the union', async () => {
    // Headers only was the old contract, and it made a tab with a blank row 1
    // field-less: no writable fields ⇒ no write shape ⇒ the meta edge lost its
    // writable promise and the checker called an append-only sheet "read-only".
    // Every grid column has a letter whether or not anyone named it, so the
    // letters are always offered and headers ride alongside them.
    const { adapter } = makeTabAdapter();
    const desc = await adapter.describe(PLAIN_TAB_TYPE);
    expect(desc).not.toBeNull();
    expect(desc?.fields.map((f) => f.fieldId)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'Timestamp',
      'Sender',
      'Message',
      'Company',
    ]);
    expect(desc?.fields.every((f) => f.kind === 'string' && f.writable)).toBe(true);
    // Append-only: no unique-by offered.
    expect(desc?.uniquenessAuthorable).toBe(false);
  });

  it('a tab with a BLANK row 1 is still writable — by letter', async () => {
    // The original report: `Sheet1 (sheet)` reported read-only. A brand-new
    // spreadsheet's first tab has no headers, so this is the first thing
    // anyone tries to append to.
    const { adapter } = makeTabAdapter({ headers: [] });
    const desc = await adapter.describe(PLAIN_TAB_TYPE);
    expect(desc?.fields.length).toBeGreaterThan(0);
    expect(desc?.fields.map((f) => f.fieldId).slice(0, 3)).toEqual(['A', 'B', 'C']);
    expect(desc?.fields.every((f) => f.writable)).toBe(true);
  });

  it('createRecord appends the mapped row via addRow', async () => {
    const { adapter, calls } = makeTabAdapter();
    const result = await adapter.createRecord({
      recordType: PLAIN_TAB_TYPE,
      fields: {
        Timestamp: '2026-07-10T12:00:00Z',
        Sender: 'alice@example.com',
        Message: 'hello',
        Company: 'Acme',
      },
      parentLinks: [],
    } as unknown as WriteInput);
    expect(calls.addRow).toHaveLength(1);
    expect(calls.addRow[0]).toMatchObject({
      spreadsheetId: PLAIN_SPREADSHEET_ID,
      sheetId: 0,
      row: { Sender: 'alice@example.com', Company: 'Acme' },
    });
    expect(result.adapterType).toBe('google_sheets');
  });

  it('resolveEntity yields 0 candidates — a plain tab is append-only', async () => {
    const { adapter } = makeTabAdapter();
    const result = await adapter.resolveEntity({
      record: { Company: 'Acme' },
      recordType: PLAIN_TAB_TYPE,
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Company' }] }] },
    } as unknown as ResolveEntityInput);
    expect(result.candidates).toEqual([]);
  });

  it('a named spreadsheet carries the tab as a writable edge', async () => {
    const { adapter } = makeTabAdapter();
    const desc = await adapter.describe(`Sheet ${PLAIN_SPREADSHEET_ID}`);
    expect(desc?.references?.map((r) => r.fieldId)).toContain(PLAIN_TAB_TYPE);
  });
});

// ---------------------------------------------------------------------------
// 8. Entry position — `spreadsheet:` construction arg pins the instance
// ---------------------------------------------------------------------------

describe('GoogleSheetsAdapter — entry position (spreadsheet: arg)', () => {
  // The makeAdapter fixture grants SPREADSHEET_ID under the name `Sheet <id>`.
  const ENTRY_NAME = `Sheet ${SPREADSHEET_ID}`;

  it('positioned: the sheet\'s leaves ARE the writable roots (not Spreadsheet)', async () => {
    const { adapter } = makeAdapter({ spreadsheet: ENTRY_NAME });
    const entries = await adapter.listEntryPoints();
    const ids = entries.map((e) => e.typeId);
    // The table surfaces as a top-level root, scoped to the entry sheet; the
    // meta `Spreadsheet` root is gone (you're already at one).
    expect(ids).toContain(TABLE_TYPE);
    expect(ids).toContain('Cell');
    expect(ids).not.toContain('Spreadsheet');
  });

  it('positioned: a leaf write needs no parent link — the entry sheet scopes it', async () => {
    const { adapter, calls } = makeAdapter({ spreadsheet: ENTRY_NAME });
    await adapter.createRecord({
      recordType: TABLE_TYPE,
      fields: { Name: 'Acme' },
      parentLinks: [],
    } as unknown as WriteInput);
    expect(calls.addTableRow).toHaveLength(1);
    expect(calls.addTableRow[0].spreadsheetId).toBe(SPREADSHEET_ID);
    expect(calls.addTableRow[0].tableId).toBe(TABLE_ID);
  });

  it('unpositioned (default): the root is the one narrowable Spreadsheet edge', async () => {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId)).toEqual(['Spreadsheet']);
  });

  it('an unknown spreadsheet name leaves the instance unpositioned (falls back to meta root)', async () => {
    const { adapter } = makeAdapter({ spreadsheet: 'No Such Sheet' });
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId)).toEqual(['Spreadsheet']);
  });
});

// ---------------------------------------------------------------------------
// Root collection reads (layer 7 category 3) — a table's rows enumerate from
// every container that publishes the table readable: a traversed spreadsheet
// node (either spelling) and the root of a positioned instance. `row.ts` had
// no listCollection at all, so the readable table edge was a lie.
// ---------------------------------------------------------------------------

describe('GoogleSheetsAdapter.getRelated — table rows from a container', () => {
  const expectTaskRows = (rows: Awaited<ReturnType<GoogleSheetsAdapter['getRelated']>>) => {
    expect(rows).toHaveLength(2);
    expect(rows[0].position.recordType).toBe(TABLE_TYPE);
    // The address is the CURRENT row number — the same currency resolveEntity
    // mints and updateRecord consumes.
    expect(positionRecordId(rows[0].position)).toBe(`${SPREADSHEET_ID}:${TABLE_ID}:2`);
    const data = positionData(rows[0].position) as Record<string, unknown>;
    expect(data).toEqual({ Name: 'Write memo', Amount: 250, Done: true, Due: '2026-07-01' });
  };

  it('reads rows from a walked Spreadsheet member position (the position carries its route)', async () => {
    const { adapter, calls } = makeAdapter();
    const rows = await adapter.getRelated({
      position: makeStablePosition({
        adapterType: 'google_sheets',
        recordType: SPREADSHEET_META_TYPE,
        recordId: SPREADSHEET_ID,
        data: { Title: `Sheet ${SPREADSHEET_ID}` },
      }),
      fieldId: TABLE_TYPE,
      direction: 'outgoing',
    });
    expectTaskRows(rows);
    // ONE spreadsheet enumerated — never a catalog rebuild across grants.
    expect(calls.listTables).toEqual([SPREADSHEET_ID]);
  });

  it('an unknown name off the UNPOSITIONED meta root is empty — never a fallback walk', async () => {
    // The named per-grant getRelated branch died with the entries it served.
    const { adapter, calls } = makeAdapter();
    const rows = await adapter.getRelated({
      position: makeMetaPosition('google_sheets'),
      fieldId: `Sheet ${SPREADSHEET_ID}`,
      direction: 'outgoing',
    });
    expect(rows).toEqual([]);
    expect(calls.listTables).toEqual([]);
  });

  it('reads rows from a Spreadsheet-collection landing (the other spelling of the hop)', async () => {
    const { adapter } = makeAdapter();
    const [landing] = await adapter.getRelated({
      position: makeMetaPosition('google_sheets'),
      fieldId: SPREADSHEET_META_TYPE,
      direction: 'outgoing',
    });
    const rows = await adapter.getRelated({
      position: landing.position,
      fieldId: TABLE_TYPE,
      direction: 'outgoing',
    });
    expectTaskRows(rows);
  });

  it('reads rows from the ROOT of a spreadsheet-positioned instance', async () => {
    const { adapter } = makeAdapter({ spreadsheet: `Sheet ${SPREADSHEET_ID}` });
    const rows = await adapter.getRelated({
      position: makeMetaPosition('google_sheets'),
      fieldId: TABLE_TYPE,
      direction: 'outgoing',
    });
    expectTaskRows(rows);
  });

  it('reads rows from a named-grant landing the engine restamped with the grant Title', async () => {
    // `surfaceReadAdapter` re-types a meta-root landing to the collection's
    // target — a named grant hop lands typed by the grant's own Title, so the
    // container check keys on the position's recordId against the GRANTS,
    // never on which spelling produced the position.
    const { adapter } = makeAdapter();
    const rows = await adapter.getRelated({
      position: makeStablePosition({
        adapterType: 'google_sheets',
        recordType: `Sheet ${SPREADSHEET_ID}`,
        recordId: SPREADSHEET_ID,
        data: { Title: `Sheet ${SPREADSHEET_ID}` },
      }),
      fieldId: TABLE_TYPE,
      direction: 'outgoing',
    });
    expectTaskRows(rows);
  });

  it('a stable position whose recordId is not a granted spreadsheet reads empty', async () => {
    const { adapter } = makeAdapter();
    const rows = await adapter.getRelated({
      position: makeStablePosition({
        adapterType: 'google_sheets',
        recordType: TABLE_TYPE,
        recordId: `${SPREADSHEET_ID}:${TABLE_ID}:2`,
        data: { Name: 'Write memo' },
      }),
      fieldId: TABLE_TYPE,
      direction: 'outgoing',
    });
    expect(rows).toEqual([]);
  });

  it('an unknown edge name degrades to empty (tabs and cells stay write-only)', async () => {
    const { adapter } = makeAdapter();
    const rows = await adapter.getRelated({
      position: makeStablePosition({
        adapterType: 'google_sheets',
        recordType: SPREADSHEET_META_TYPE,
        recordId: SPREADSHEET_ID,
        data: { Title: `Sheet ${SPREADSHEET_ID}` },
      }),
      fieldId: 'Missing (table)',
      direction: 'outgoing',
    });
    expect(rows).toEqual([]);
  });

  it('reads the `named cells` edge — each named cell carries its Name + current Value', async () => {
    // The rule-3 read counterpart: named cells enumerate (`listNamedRanges`),
    // each value read by `values.get` on the range name. `WHERE `Name` == …`
    // narrows engine-side.
    const { adapter } = makeAdapter();
    const rangeReads: string[] = [];
    const client = {
      listNamedRanges: async ({ spreadsheetId }: { spreadsheetId: string }) =>
        spreadsheetId === SPREADSHEET_ID
          ? [
              { namedRangeId: 'nr-1', name: 'FX_Rate', range: {} },
              { namedRangeId: 'nr-2', name: 'AsOf', range: {} },
            ]
          : [],
      getRangeValues: async ({ range }: { spreadsheetId: string; range: string }) => {
        rangeReads.push(range);
        return range === 'FX_Rate' ? [[1.27]] : [['2026-07-17']];
      },
    };
    (adapter as unknown as { getApiClient: () => Promise<typeof client> }).getApiClient =
      async () => client;
    const rows = await adapter.getRelated({
      position: makeStablePosition({
        adapterType: 'google_sheets',
        recordType: SPREADSHEET_META_TYPE,
        recordId: SPREADSHEET_ID,
        data: { Title: `Sheet ${SPREADSHEET_ID}` },
      }),
      fieldId: 'named cells',
      direction: 'outgoing',
    });
    expect(rows.map((r) => r.position.recordType)).toEqual(['Named cell', 'Named cell']);
    expect(rows.map((r) => positionData(r.position))).toEqual([
      { Name: 'FX_Rate', Value: 1.27 },
      { Name: 'AsOf', Value: '2026-07-17' },
    ]);
    // One value read per named range, by the range NAME (a named range resolves
    // as a range verbatim in values.get).
    expect(rangeReads).toEqual(['FX_Rate', 'AsOf']);
  });
});

// ---------------------------------------------------------------------------
// The `cells` edge — read by ADDRESS (rule 3: a one-way edge is usually a
// missing capability). Reading a cell is one `values.get`, the same call the
// named-cell read makes; what a grid genuinely lacks is an ENUMERABLE set of
// cells, so the address comes from the hop WHERE.
// ---------------------------------------------------------------------------

const eqCell = (address: string): Expression => ({
  type: 'compare',
  op: 'eq',
  left: { type: 'property', propertyTypeId: 'Cell' },
  right: { type: 'static', value: address },
});

describe('GoogleSheetsAdapter `cells` read', () => {
  const cellClient = (values: Record<string, unknown>) => ({
    listSheets: async () => [
      { sheetId: SHEET_ID, title: 'Dashboard' },
      { sheetId: 7, title: 'Other' },
    ],
    getRangeValues: async ({ range }: { spreadsheetId: string; range: string }) =>
      range in values ? [[values[range]]] : [],
  });

  const spreadsheetNode = () =>
    makeStablePosition({
      adapterType: 'google_sheets',
      recordType: SPREADSHEET_META_TYPE,
      recordId: SPREADSHEET_ID,
      data: { Title: `Sheet ${SPREADSHEET_ID}` },
    });

  it('publishes `cells` read + create, with the WHERE-pushed filter capability', async () => {
    const { adapter } = makeAdapter();
    const spreadsheet = await adapter.describe('Spreadsheet');
    const cells = spreadsheet?.references?.find((r) => r.fieldId === 'cells');
    // Absent `readable` ⇒ readable: the edge no longer disclaims a read it can serve.
    expect(cells?.readable).toBeUndefined();
    expect(cells?.writable).toBe(true);
    expect(cells?.capability).toEqual({ filter: 'native', supportsLimit: false });
    // …and the Cell field advertises the ONE operator the read translates.
    const cell = (await adapter.describe('Cell'))?.fields?.find((f) => f.fieldId === 'Cell');
    expect(cell?.capability?.filterOperators).toEqual(['eq']);
  });

  it('reads the addressed cell — one values.get per `Cell` == … in the WHERE', async () => {
    const { adapter } = makeAdapter();
    const client = cellClient({ 'Dashboard!B2': 1.27, 'Dashboard!C3': 'ok' });
    (adapter as unknown as { getApiClient: () => Promise<typeof client> }).getApiClient =
      async () => client;
    const rows = await adapter.getRelated({
      position: spreadsheetNode(),
      fieldId: 'cells',
      direction: 'outgoing',
      where: { type: 'logical', op: 'or', operands: [eqCell('Dashboard!B2'), eqCell('Dashboard!C3')] },
    });
    expect(rows.map((r) => r.position.recordType)).toEqual(['Cell', 'Cell']);
    expect(rows.map((r) => positionData(r.position))).toEqual([
      { Cell: 'Dashboard!B2', Value: 1.27 },
      { Cell: 'Dashboard!C3', Value: 'ok' },
    ]);
    // Identity matches the WRITE's externalId shape (spreadsheet:cell:sheet:row:col),
    // so reading and writing one address address the same cell.
    expect(positionRecordId(rows[0].position)).toBe(`${SPREADSHEET_ID}:cell:${SHEET_ID}:1:1`);
  });

  it('an empty cell reads as null, not as a missing row', async () => {
    const { adapter } = makeAdapter();
    const client = cellClient({});
    (adapter as unknown as { getApiClient: () => Promise<typeof client> }).getApiClient =
      async () => client;
    const rows = await adapter.getRelated({
      position: spreadsheetNode(),
      fieldId: 'cells',
      direction: 'outgoing',
      where: eqCell('Dashboard!B2'),
    });
    expect(rows.map((r) => positionData(r.position))).toEqual([{ Cell: 'Dashboard!B2', Value: null }]);
  });

  it('no address in the WHERE ⇒ empty, and no API call (a grid has no enumerable cells)', async () => {
    const { adapter } = makeAdapter();
    let calls = 0;
    (adapter as unknown as { getApiClient: () => Promise<unknown> }).getApiClient = async () => {
      calls += 1;
      return cellClient({});
    };
    for (const where of [undefined, eqCell('   ')]) {
      const rows = await adapter.getRelated({
        position: spreadsheetNode(),
        fieldId: 'cells',
        direction: 'outgoing',
        ...(where ? { where } : {}),
      });
      expect(rows).toEqual([]);
    }
    expect(calls).toBe(0);
  });

  it('a bad address errors instead of reading blank', async () => {
    const { adapter } = makeAdapter();
    const client = cellClient({});
    (adapter as unknown as { getApiClient: () => Promise<typeof client> }).getApiClient =
      async () => client;
    // An unqualified ref on a MULTI-tab spreadsheet is ambiguous — the same
    // guard the write applies, so a read and a write agree on what resolves.
    await expect(
      adapter.getRelated({
        position: spreadsheetNode(),
        fieldId: 'cells',
        direction: 'outgoing',
        where: eqCell('B2'),
      }),
    ).rejects.toThrow(/several tabs/);
    await expect(
      adapter.getRelated({
        position: spreadsheetNode(),
        fieldId: 'cells',
        direction: 'outgoing',
        where: eqCell('Dashboard!B2:C4'),
      }),
    ).rejects.toThrow(/single-cell A1 reference/);
  });
});

describe('cellAddressesInWhere', () => {
  it('collects every `Cell` == literal, either operand order, through and/or', () => {
    expect(cellAddressesInWhere(eqCell('Dashboard!B2'))).toEqual(['Dashboard!B2']);
    expect(
      cellAddressesInWhere({
        type: 'logical',
        op: 'or',
        operands: [
          eqCell('A1'),
          { type: 'compare', op: 'eq', left: { type: 'static', value: 'B2' }, right: { type: 'property', propertyTypeId: 'Cell' } },
          { type: 'logical', op: 'and', operands: [eqCell('A1'), eqCell('C3')] },
        ],
      }),
    ).toEqual(['A1', 'B2', 'C3']); // deduped
  });

  it('ignores a WHERE that names no address', () => {
    expect(cellAddressesInWhere(undefined)).toEqual([]);
    // another property, a non-eq operator, a non-literal comparand
    expect(cellAddressesInWhere({ type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Value' }, right: { type: 'static', value: 'A1' } })).toEqual([]);
    expect(cellAddressesInWhere({ type: 'compare', op: 'contains', left: { type: 'property', propertyTypeId: 'Cell' }, right: { type: 'static', value: 'A1' } })).toEqual([]);
    expect(cellAddressesInWhere({ type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Cell' }, right: { type: 'property', propertyTypeId: 'Cell' } })).toEqual([]);
  });
});
