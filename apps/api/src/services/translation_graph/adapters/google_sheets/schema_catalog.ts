// Google Sheets TG adapter — schema introspection. `listEntryPoints`
// enumerates a spreadsheet's writable surfaces (each native Table as a
// column-mapped type); `describe(typeId)` loads one table's columns as
// writable fields.
//
// Column discovery: table types → `client.getTableColumns` (the table's
// declared columns). A native table always introspects its columns, so drift
// detection works uniformly across surfaces.
//
// Spreadsheet discovery is per-credential config, not an enumerable API: the
// Sheets REST surface has no "list all spreadsheets the token can see"
// endpoint (that lives in Drive). The adapter therefore reads the configured
// spreadsheet ids from its construction input — `listEntryPoints` fans out
// over those, and an empty config yields an empty catalog (the editor still
// lets the author paste a spreadsheet id, which `describe` resolves directly).

import type { GoogleSheetsApiClient } from '../../../../adapters/googleSheets/apiClient';
import type { Expression } from '#shared/expression/types';
import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaTypeDescriptor,
} from '../../types';

import { writableColumnNames } from '../../../../adapters/googleSheets/columns';
import { logger } from '../../../logger';
import {
  GOOGLE_SHEETS_ADAPTER_TYPE,
  type SheetsTableId,
  type SheetTabId,
} from './types';

export { GOOGLE_SHEETS_ADAPTER_TYPE };

/** A table's pretty type name — the framework identity a position's
 *  `recordType` / an entry's `typeId` carries. Exported so the collection
 *  read can match an edge name against a container's live `listTables`
 *  without rebuilding the whole catalog. */
export function tableDisplayName(tableName: string): string {
  return `${tableName} (table)`;
}

/** A plain tab's pretty type name — parallel to `tableDisplayName`, for a bare
 *  sheet with a header row (append-only). */
function sheetTabDisplayName(tabName: string): string {
  return `${tabName} (sheet)`;
}

/** Each native-table column becomes a writable field. The `fieldId` is the
 *  column NAME (v3's `table-row` write looks up `columnIndex` by name via
 *  `getTableColumns`), the kind is inferred from the Sheets column type. */
function columnFieldDescriptor(column: {
  columnName: string;
  columnType: string;
}): SchemaFieldDescriptor {
  return {
    fieldId: column.columnName,
    displayName: column.columnName,
    kind: tgKindForColumnType(column.columnType),
    cardinality: 'one',
    writable: true,
    required: false,
  };
}

/** Map a Sheets column type to a TG field kind. Sheets column types are a
 *  small closed set (TEXT, DOUBLE, PERCENT, CURRENCY, DATE, TIME,
 *  DATE_TIME, BOOLEAN, …); anything unrecognised falls back to string. */
function tgKindForColumnType(columnType: string): SchemaFieldDescriptor['kind'] {
  switch (columnType) {
    case 'DOUBLE':
    case 'PERCENT':
    case 'CURRENCY':
      return 'number';
    case 'BOOLEAN':
      return 'boolean';
    case 'DATE':
    case 'TIME':
    case 'DATE_TIME':
      return 'date';
    default:
      return 'string';
  }
}

// ── Name → structured-identifier cache ─────────────────────────────────────

/** The adapter's private name → structured-identifier cache for one credential:
 *  a table's pretty `displayName` → its `{ spreadsheetId, tableId }`, plus the
 *  entry points to publish (same fan-out, built once). The Sheets REST surface
 *  has no "list all spreadsheets" endpoint, so the fan-out is over the
 *  credential's granted spreadsheets (`google_granted_item`). */
export interface SheetsNamedRangeId {
  spreadsheetId: string;
  namedRangeId: string;
  rangeName: string;
}

/** The writable leaves across the credential's granted spreadsheets. There are
 *  NO top-level leaf roots: a table / tab / named cell is reached ONLY by
 *  traversing a resolved `Spreadsheet` node (`ss-[:\`X (table)\`]-> …`). So a
 *  leaf's pretty `name` need only be unique WITHIN its spreadsheet (Google
 *  guarantees that) — the parent spreadsheet disambiguates on write, and there
 *  is deliberately no cross-spreadsheet name qualification. */
export interface SheetsTableCatalog {
  tables: { spreadsheetId: string; name: string; tableId: string }[];
  /** Plain tabs (a sheet with a header row and NO native Table on it). */
  tabs: { spreadsheetId: string; name: string; sheetId: number }[];
  /** Single-cell named ranges — stable "<name> (cell)" Value targets. */
  ranges: { spreadsheetId: string; name: string; namedRangeId: string; rangeName: string }[];
}

/** The distinct leaf type names across all grants — the Spreadsheet node's edge
 *  set (deduped; a name shared by two spreadsheets is one edge, resolved to the
 *  right sheet by the parent spreadsheet at write time). */
export function tableTypeNamesOf(c: SheetsTableCatalog): string[] {
  return [...new Set(c.tables.map((t) => t.name))];
}
export function tabTypeNamesOf(c: SheetsTableCatalog): string[] {
  return [...new Set(c.tabs.map((t) => t.name))];
}
export function rangeTypeNamesOf(c: SheetsTableCatalog): string[] {
  return [...new Set(c.ranges.map((r) => r.name))];
}

/** The writable entry points for an instance POSITIONED at one spreadsheet: its
 *  own tabs / tables / named cells become the writable roots (scoped to that
 *  spreadsheet, so nothing clashes with another grant), plus the A1 cell escape
 *  hatches. This is the `spreadsheet:` construction-arg surface — "start me at
 *  this sheet so I can write its leaves directly", the convenience the default
 *  (meta-node) position trades for cross-grant safety. */
export function entryPointsForSpreadsheet(
  c: SheetsTableCatalog,
  spreadsheetId: string,
): SchemaEntryPoint[] {
  const leaves: SchemaEntryPoint[] = [];
  for (const t of c.tables) {
    if (t.spreadsheetId === spreadsheetId) {
      leaves.push({ typeId: t.name, displayName: t.name, externalId: t.tableId, writable: true, readable: true });
    }
  }
  for (const t of c.tabs) {
    if (t.spreadsheetId === spreadsheetId) {
      leaves.push({ typeId: t.name, displayName: t.name, writable: true, readable: false });
    }
  }
  for (const r of c.ranges) {
    if (r.spreadsheetId === spreadsheetId) {
      leaves.push({ typeId: r.name, displayName: r.name, externalId: r.namedRangeId, writable: true, readable: false });
    }
  }
  leaves.push({ typeId: NAMED_CELL_META_TYPE, displayName: NAMED_CELL_META_TYPE, writable: true, readable: false });
  leaves.push({ typeId: CELL_META_TYPE, displayName: CELL_META_TYPE, writable: true, readable: false });
  return leaves;
}

/** Resolve a leaf by name, SCOPED to its parent spreadsheet when known (the
 *  write path always knows it — the Spreadsheet parent link). With no
 *  spreadsheet (a bare describe for the type's shape) the first match wins —
 *  same-named leaves in different spreadsheets share a shape closely enough for
 *  the editor, and a decidable write narrows to the exact one. */
export function resolveTable(
  c: SheetsTableCatalog,
  q: { name: string; spreadsheetId?: string },
): SheetsTableId | undefined {
  const hit = c.tables.find(
    (t) => t.name === q.name && (q.spreadsheetId === undefined || t.spreadsheetId === q.spreadsheetId),
  );
  return hit ? { spreadsheetId: hit.spreadsheetId, tableId: hit.tableId } : undefined;
}
export function resolveTab(
  c: SheetsTableCatalog,
  q: { name: string; spreadsheetId?: string },
): SheetTabId | undefined {
  const hit = c.tabs.find(
    (t) => t.name === q.name && (q.spreadsheetId === undefined || t.spreadsheetId === q.spreadsheetId),
  );
  return hit ? { spreadsheetId: hit.spreadsheetId, sheetId: hit.sheetId } : undefined;
}
export function resolveRange(
  c: SheetsTableCatalog,
  q: { name: string; spreadsheetId?: string },
): SheetsNamedRangeId | undefined {
  const hit = c.ranges.find(
    (r) => r.name === q.name && (q.spreadsheetId === undefined || r.spreadsheetId === q.spreadsheetId),
  );
  return hit
    ? { spreadsheetId: hit.spreadsheetId, namedRangeId: hit.namedRangeId, rangeName: hit.rangeName }
    : undefined;
}

/** The writable "create a new spreadsheet" meta type. Under drive.file the
 *  app owns files it creates, so an agent/movement can make a report sheet
 *  with NO picker step — the create auto-grants (see index.ts). Also the ONE
 *  word for a spreadsheet everywhere: the polymorphic root edge, the walk's
 *  member positions, and the collection's data landings all say `Spreadsheet`
 *  — the narrowing machinery gates members on the edge's own type
 *  (`-[s:Spreadsheet WHERE …]->`), so a second word for the same node
 *  (`GrantedSpreadsheet`, retired 2026-07-17) made every WHERE match nothing. */
export const SPREADSHEET_META_TYPE = 'Spreadsheet';

export function spreadsheetMetaEntryPoint(): SchemaEntryPoint {
  return {
    typeId: SPREADSHEET_META_TYPE,
    displayName: SPREADSHEET_META_TYPE,
    writable: true,
    // Readable: the grants project as a collection off the meta root, so the
    // positions-and-edges selection form works with no language changes:
    //   sheets-[s:Spreadsheet WHERE Title == "Foo"]-> { write s-[:Cells]-> … }
    readable: true,
  };
}

/**
 * The `Spreadsheet` node.
 *
 * Called with NO leaf names it is the UNNARROWED spreadsheet: its own `Title`
 * plus the universal `Cells` / `Named Cells` edges, and no leaves — because
 * which tabs and tables exist depends on WHICH spreadsheet, and nobody has
 * said yet. It used to answer with the union across every grant, which was
 * both a fanout (a fetch per grant just to list names) and a lie (it typed
 * ``s-[:`X (table)`]->`` against sheets holding no `X`). Naming a leaf needs a
 * spreadsheet — narrow one (`WHERE `Title` == "Foo"`) or position the instance
 * at one (`spreadsheet:`) — exactly as naming an Airtable table needs a base.
 *
 * Called WITH leaf names (the narrowed / positioned callers, which know the
 * one spreadsheet) it is that sheet's real surface.
 *
 */
export function describeSpreadsheetMeta(input?: {
  /** ONE spreadsheet's table types — each a DIVERSIFIED edge off the
   *  Spreadsheet node (one edge per table TYPE, per the positions-and-edges
   *  model: heterogeneous-by-schema targets get one edge each, so
   *  `s-[:\`Companies (table)\`]-> { … }` types against THAT table's
   *  columns). */
  tableTypeNames?: readonly string[];
  /** The catalog's plain-tab types — each a DIVERSIFIED edge off the
   *  Spreadsheet node, parallel to the table edges, so
   *  `s-[:\`Sheet1 (sheet)\`]-> { … }` types against THAT tab's header row. */
  sheetTabTypeNames?: readonly string[];
  /** The catalog's single-cell named-range types — each a "<name> (cell)" edge
   *  off the Spreadsheet node (a stable Value target). */
  namedRangeTypeNames?: readonly string[];
}): SchemaTypeDescriptor {
  return {
    typeId: SPREADSHEET_META_TYPE,
    displayName: SPREADSHEET_META_TYPE,
    description:
      'One of this connection\'s granted spreadsheets. Which tabs, tables and ' +
      'named cells it holds depends on WHICH spreadsheet — narrow to one ' +
      '(`-[s:Spreadsheet WHERE `Title` == "…"]->`, or the `spreadsheet:` ' +
      'construction arg) and its leaves become the edges. Writing one creates ' +
      'a new spreadsheet; `unique by (`Title`)` reuses an existing grant.',
    fields: [
      { fieldId: 'Title', displayName: 'Title', kind: 'string', writable: true, required: true },
    ],
    // Cell writes hang off the spreadsheet NODE (`ss-[:Cells]->`) — the
    // spreadsheet is graph-addressed, never named by a string field on the
    // leaf write. Every leaf edge is a CREATE edge: sheets writes leaves
    // through their spreadsheet (the parent link scopes the write), so the
    // create promise rides the edge (message-write-unification §5.1) — from
    // every standpoint, positioned root, narrowed handle or written handle
    // alike. Read promises are per-kind honesty: table rows enumerate
    // (`listCollection`); named cells enumerate; an A1 cell is readable only
    // once ADDRESSED (see `Cells` below); a plain tab has no read behind it,
    // so its edge says so instead of defaulting to a claim nothing serves.
    references: [
      {
        // Read + create (rule 3). "The cells" of a spreadsheet is not an
        // enumerable set — a grid has no meaningful membership — but a cell
        // NAMED BY ITS ADDRESS is one `values.get`, the same call a named
        // cell's Value read makes. So the read is ADDRESSED: the hop WHERE
        // supplies `Cell` (`-[c:Cells WHERE `Cell` == "Dashboard!B2"]->`) and
        // the adapter fetches exactly those cells; no address, no cells.
        fieldId: CELLS_EDGE,
        name: CELLS_EDGE_NAME,
        targetTypeId: CELL_META_TYPE,
        cardinality: 'many' as const,
        writable: true,
        description:
          'A cell of the spreadsheet, by A1 address. Reading needs the address in the hop WHERE (`WHERE `Cell` == "Dashboard!B2"`); writing overwrites that cell.',
        capability: { filter: 'native' as const, supportsLimit: false },
      },
      {
        // Read + create (rule 3/6): the spreadsheet's named cells enumerate
        // (`listNamedRanges` + a `values.get` per range — the read counterpart
        // the sheets rule-3 pass recorded as missing), and creating one names a
        // cell. `WHERE `Name` == …` narrows the read engine-side.
        fieldId: NAMED_CELLS_EDGE,
        name: NAMED_CELLS_EDGE_NAME,
        targetTypeId: NAMED_CELL_META_TYPE,
        cardinality: 'many' as const,
        writable: true,
      },
      ...(input?.tableTypeNames ?? []).map((name) => ({
        fieldId: name,
        targetTypeId: name,
        cardinality: 'many' as const,
        writable: true,
        // A table's rows come back in SHEET order: the read is one `values.get`
        // over the table's contiguous A1 range, and each row is stamped with
        // its own `rowNumber` as the response is walked.
        sequenced: 'document' as const,
      })),
      ...(input?.sheetTabTypeNames ?? []).map((name) => ({
        fieldId: name,
        targetTypeId: name,
        cardinality: 'many' as const,
        readable: false,
        writable: true,
      })),
      ...(input?.namedRangeTypeNames ?? []).map((name) => ({
        fieldId: name,
        targetTypeId: name,
        cardinality: 'one' as const,
        readable: false,
        writable: true,
      })),
    ],
    // `unique by (\`Title\`)` resolves an EXISTING granted spreadsheet (a
    // grants-table lookup, no API call) — so one write form covers "use
    // Pipeline Sheet" AND "create it if it isn't there".
    uniquenessAuthorable: true,
  };
}

/** "Named cell" — the agent-performed naming step: creating one promotes a
 *  positional cell to a stable Value target ('<Name> (cell)') that appears on
 *  the next catalog load. The user points at a cell in plain language; the
 *  name exists purely as the durable anchor. */
export const NAMED_CELL_META_TYPE = 'Named cell';

/** The edge fieldId a spreadsheet publishes for its named cells (read + create). */
export const NAMED_CELLS_EDGE = 'named cells';
/** Its NATURAL name — Title Case, the one convention across every adapter
 *  surface. The fieldId above stays the internal `getRelated` / targetPositions
 *  key; THIS is what a movement writes (`Named Cells`). */
export const NAMED_CELLS_EDGE_NAME = 'Named Cells';

/** "Cell" — the EXPLICIT A1 escape hatch. Positional: an inserted row/column
 *  silently shifts what the address points at, so this is for sheets the
 *  author deliberately wants position-addressed (fixed templates). Prefer
 *  creating a Named cell. */
export const CELL_META_TYPE = 'Cell';

/** The edge fieldId a spreadsheet publishes for its A1 cells (read + create). */
export const CELLS_EDGE = 'cells';
export const CELLS_EDGE_NAME = 'Cells';

/**
 * The A1 addresses a `Cells` hop's WHERE names — every `` `Cell` == "…" ``
 * literal in it, walking `and`/`or` (both narrow to a set of addresses; the
 * engine re-checks the predicate over what comes back, so over-fetching an
 * `or` branch stays correct). Anything else contributes no address: a `Cells`
 * read is ADDRESSED, and an unaddressed one has nothing to fetch.
 */
export function cellAddressesInWhere(where: Expression | undefined): string[] {
  if (!where) return [];
  const found: string[] = [];
  const visit = (e: Expression): void => {
    if (e.type === 'logical' && (e.op === 'and' || e.op === 'or')) {
      e.operands.forEach(visit);
      return;
    }
    if (e.type !== 'compare' || e.op !== 'eq') return;
    const property = [e.left, e.right].find((s) => s.type === 'property');
    const literal = [e.left, e.right].find((s) => s.type === 'static');
    if (property?.type !== 'property' || property.propertyTypeId !== 'Cell') return;
    if (literal?.type !== 'static' || typeof literal.value !== 'string') return;
    const address = literal.value.trim();
    if (address !== '' && !found.includes(address)) found.push(address);
  };
  visit(where);
  return found;
}


export function describeNamedCellMeta(): SchemaTypeDescriptor {
  return {
    typeId: NAMED_CELL_META_TYPE,
    displayName: NAMED_CELL_META_TYPE,
    description:
      'A named cell — a stable "<Name>" handle for a single cell that survives ' +
      'inserted rows and columns. Read the spreadsheet\'s `Named Cells` for the ' +
      'current names and values (narrow with `WHERE `Name` == …`); create one ' +
      'along the `Named Cells` edge to name a cell.',
    fields: [
      {
        // Read (the range name) + write (the durable name to give on create).
        fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true,
        description: 'The durable name for the cell (e.g. FX_Rate). It becomes the writable "<Name> (cell)" target.',
      },
      {
        // The current value of the named cell — read-only here (set a value by
        // writing to the cell, not by naming it).
        fieldId: 'Value', displayName: 'Value', kind: 'string', writable: false, required: false,
        description: 'The cell\'s current value.',
      },
      {
        // Write-only create input: WHICH cell to name. Not a read-back fact
        // (a read surfaces the Name + Value), so `readable: false`.
        fieldId: 'Cell', displayName: 'Cell', kind: 'string', writable: true, readable: false, required: true,
        description: "Which cell to name, as A1 — e.g. Dashboard!B2 (sheet optional when the spreadsheet has one tab).",
      },
    ],
    references: [],
    uniquenessAuthorable: false,
  };
}

export function describeCellMeta(): SchemaTypeDescriptor {
  return {
    typeId: CELL_META_TYPE,
    displayName: CELL_META_TYPE,
    description:
      'The explicit A1 escape hatch: read or overwrite any cell of the ' +
      'spreadsheet by address, along the spreadsheet\'s `Cells` edge. ' +
      'POSITIONAL — an inserted row or column shifts what the address points ' +
      'at; prefer creating a Named cell for anything recurring. A read is ' +
      'ADDRESSED, never enumerated: name the cell in the hop WHERE ' +
      '(`-[c:Cells WHERE `Cell` == "Dashboard!B2"]->`), because a grid has no ' +
      'enumerable set of "the cells".',
    fields: [
      {
        fieldId: 'Cell', displayName: 'Cell', kind: 'string', writable: true, required: true,
        description:
          'The A1 address — e.g. Dashboard!B2. Names WHICH cell to read (in the hop WHERE) or overwrite. POSITIONAL: inserting rows/columns shifts what this points at. Prefer creating a Named cell for anything recurring.',
        // `eq` only: the read turns each `Cell` == "…" in the WHERE into one
        // `values.get`. Anything else has no address to fetch.
        capability: { filterOperators: ['eq'] },
      },
      { fieldId: 'Value', displayName: 'Value', kind: 'string', writable: true, required: true },
    ],
    references: [],
    uniquenessAuthorable: false,
  };
}

/**
 * ONE spreadsheet's leaf surface — tables, plain tabs, single-cell named
 * ranges — enumerated STRICTLY: a failed fetch propagates. This is the grant
 * HOP's loader (and the positioned root's): "no leaves" and "the spreadsheet
 * is gone" are different facts, and swallowing the second into the first is
 * the silent-degradation class. A stale grant (deleted / access revoked)
 * surfaces as this error instead of a leafless node.
 */
export async function loadSpreadsheetSurface(input: {
  client: GoogleSheetsApiClient;
  spreadsheetId: string;
}): Promise<SheetsTableCatalog> {
  const { client, spreadsheetId } = input;
  try {
    const tables = await client.listTables({ spreadsheetId });
    const tabs = await client.listSheets({ spreadsheetId });
    const ranges = await client.listNamedRanges({ spreadsheetId });

    // Plain tabs: every sheet that DOESN'T host a native Table becomes a bare
    // "<tab> (sheet)" append surface. A tab with a Table is excluded — the
    // Table is its writable surface, so each tab publishes exactly one.
    const sheetIdsWithTables = new Set(tables.map((t) => t.sheetId));
    return {
      tables: tables.map((t) => ({
        spreadsheetId,
        name: tableDisplayName(t.name),
        tableId: t.tableId,
      })),
      tabs: (tabs as { sheetId: number; title: string }[])
        .filter((tab) => !sheetIdsWithTables.has(tab.sheetId))
        .map((tab) => ({ spreadsheetId, name: sheetTabDisplayName(tab.title), sheetId: tab.sheetId })),
      ranges: ranges
        .filter(
          // v1: single-cell ranges only — a multi-cell named range has no
          // one-Value shape yet (deferred in the topology plan).
          (r) =>
            r.range.endRowIndex - r.range.startRowIndex === 1 &&
            r.range.endColumnIndex - r.range.startColumnIndex === 1,
        )
        .map((r) => ({
          spreadsheetId,
          name: `${r.name} (cell)`,
          namedRangeId: r.namedRangeId,
          rangeName: r.name,
        })),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Google Sheets: spreadsheet ${spreadsheetId} could not be introspected — ${reason}. ` +
        'If it was deleted or access was revoked, the grant is stale: re-pick the spreadsheet or revoke it.',
    );
  }
}

/**
 * The cross-grant catalog: every grant's surface, merged. TOLERANT per grant —
 * this feeds the name→id cache the WRITE path resolves through, and one stale
 * grant must not take down writes to every healthy spreadsheet; the failure is
 * logged, and the honest per-spreadsheet error lives on the grant hop
 * (`loadSpreadsheetSurface`), which is where a single sheet is actually asked
 * about.
 */
export async function loadTableCatalog(input: {
  client: GoogleSheetsApiClient;
  /** The credential's granted spreadsheets (ids + remembered names). */
  grants: readonly { spreadsheetId: string; name: string | null }[];
}): Promise<SheetsTableCatalog> {
  const merged: SheetsTableCatalog = { tables: [], tabs: [], ranges: [] };
  for (const grant of input.grants) {
    try {
      const surface = await loadSpreadsheetSurface({
        client: input.client,
        spreadsheetId: grant.spreadsheetId,
      });
      merged.tables.push(...surface.tables);
      merged.tabs.push(...surface.tabs);
      merged.ranges.push(...surface.ranges);
    } catch (err) {
      logger.warn('[GoogleSheetsAdapter.loadTableCatalog] failed to enumerate spreadsheet', {
        spreadsheetId: grant.spreadsheetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return merged;
}

/** A plain tab's writable fields — its header row (row 1) as string columns.
 *  Appended values are text/USER_ENTERED (a bare sheet declares no column
 *  types), so every field is a string; the header IS the schema. An empty
 *  header yields a field-less descriptor — the editor still renders the append,
 *  it just has nothing to map. */
export async function describeSheetTab(input: {
  client: GoogleSheetsApiClient;
  ids: SheetTabId;
  displayName: string;
}): Promise<SchemaTypeDescriptor> {
  const layout = await input.client.getSheetLayout(input.ids);
  const columns = writableColumnNames(layout);
  const hasHeaders = layout.headers.some((h) => h.length > 0);
  return {
    typeId: input.displayName,
    displayName: input.displayName,
    description:
      'A bare sheet tab. Write to a column by its LETTER (`A`, `B`, `C`…) or, ' +
      'where row 1 names one, by that header. Rows append only — no ' +
      'addressable row to overwrite, so no `unique by`.' +
      (hasHeaders ? '' : ' Row 1 is blank here, so the columns are letters only.'),
    fields: columns.map((name) => ({
      fieldId: name,
      displayName: name,
      kind: 'string' as const,
      cardinality: 'one' as const,
      writable: true,
      required: false,
    })),
    references: [],
    // Append-only: a bare sheet has no addressable row to overwrite, so
    // `unique by` is not offered (the checker then blocks the update path).
    uniquenessAuthorable: false,
  };
}

export function describeNamedRange(input: {
  displayName: string;
}): SchemaTypeDescriptor {
  return {
    typeId: input.displayName,
    displayName: input.displayName,
    description:
      'A named single cell — a stable Value target. Every write overwrites ' +
      'the one cell it names; the name IS the identity.',
    fields: [
      // The one writable slot — the cell's value. Every write overwrites it
      // (a named range IS the stable identity, so there is nothing to dedup).
      { fieldId: 'Value', displayName: 'Value', kind: 'string', writable: true, required: true },
    ],
    references: [],
    uniquenessAuthorable: false,
  };
}

// ── describe ───────────────────────────────────────────────────────────────

/** A native table's descriptor from its columns — shared by the by-name
 *  describe below and the WALK's leaf hop (which already knows the display
 *  name from its position, so it never re-lists tables to recover it). */
export function tableDescriptorFromColumns(input: {
  displayName: string;
  columns: readonly { columnName: string; columnType: string }[];
}): SchemaTypeDescriptor {
  return {
    typeId: input.displayName,
    displayName: input.displayName,
    description:
      'A native Sheets table: rows append, and `unique by` overwrites the ' +
      'matching row (the author\'s explicit opt-in to overwriting).',
    fields: input.columns.map(columnFieldDescriptor),
    references: [],
    uniquenessConstraints: undefined,
    // Row identity is DERIVED per write: `unique by (\`Column\`)` scans the
    // table's live rows and a match's current row number becomes the update
    // address (row.ts).
    uniquenessAuthorable: true,
  };
}

export async function describe(input: {
  client: GoogleSheetsApiClient;
  ids: SheetsTableId;
}): Promise<SchemaTypeDescriptor | null> {
  // `ids` is the resolved structured identifier — the adapter recovered it from
  // the position's pretty type NAME via the name cache before calling here.
  const { spreadsheetId, tableId } = input.ids;
  const columns = await input.client.getTableColumns({ spreadsheetId, tableId });
  // An empty / missing table yields no columns; surface a descriptor with
  // no fields rather than null so the editor can still render the action.
  const tables = await input.client.listTables({ spreadsheetId }).catch(() => []);
  const table = tables.find((t) => t.tableId === tableId);
  if (!table && columns.length === 0) return null;
  const displayName = table ? tableDisplayName(table.name) : `Table ${tableId}`;
  return tableDescriptorFromColumns({ displayName, columns });
}
