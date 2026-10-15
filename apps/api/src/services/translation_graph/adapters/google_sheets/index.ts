// Google Sheets TG adapter — implements the translation-graph `Adapter`
// contract for Google Sheets as an APPEND target (v3-output parity: Sheets has
// a v3 OUTPUT only, so parity = the target/write side). The source-trigger
// side (snapshot/poll) is deferred; the adapter declares no triggers and
// leaves `webhookEventTypeId` undefined.
//
// Two writable row surfaces: a native Sheets Table (`"<table> (table)"` —
// column-mapped append via `getTableColumns` + `addTableRow`, with `unique by`
// overwrite), and a plain tab (`"<tab> (sheet)"` — a bare sheet whose row-1
// header is the schema, appended via `addRow`). A tab that hosts a Table is
// surfaced only as its Table. Both introspect their columns up front, so drift
// detection works uniformly across surfaces.
//
// Plain-tab append is one-directional: no native-key upsert and no addressable
// row to mutate, so it declares no `unique by` and its update/delete path is
// never reached. Table rows additionally support unique-by overwrite.
//
// Lazy-loads team credentials from external_service_credentials and constructs
// the API client on first use, redirecting to fake-channels for the dev-loop
// test-harness team (mirrors Attio / Airtable).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type {
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/services/translation_graph/adapter';
import type { TriggerType } from 'movement-engine/services/translation_graph/triggers/types';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/services/translation_graph/types';
import type { Expression } from '#shared/expression/types';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { logger } from 'movement-engine/services/logger';
import { GoogleSheetsApiClient } from '../../../../adapters/googleSheets/apiClient';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { writeParentLinks, unsupportedAssociation } from 'movement-engine/services/translation_graph/adapter';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
} from 'movement-engine/services/translation_graph/types';
import { BaseAdapter } from '../base';
import { targetStubs } from '../hop';
import {
  GOOGLE_SHEETS_ADAPTER_TYPE,
  googleSheetsAdapterCredsParser,
  type SheetsTableId,
} from './types';
import {
  loadTableCatalog,
  loadSpreadsheetSurface,
  describe as catalogDescribe,
  describeSheetTab,
  describeNamedRange,
  spreadsheetMetaEntryPoint,
  describeSpreadsheetMeta,
  SPREADSHEET_META_TYPE,
  NAMED_CELL_META_TYPE,
  NAMED_CELLS_EDGE,
  CELL_META_TYPE,
  CELLS_EDGE,
  cellAddressesInWhere,
  describeNamedCellMeta,
  describeCellMeta,
  tableDescriptorFromColumns,
  tableTypeNamesOf,
  tabTypeNamesOf,
  rangeTypeNamesOf,
  resolveTable,
  resolveTab,
  resolveRange,
  entryPointsForSpreadsheet,
  tableDisplayName,
  type SheetsTableCatalog,
} from './schema_catalog';
import { parseA1Cell } from '../../../../adapters/googleSheets/cells';
import { grantSpreadsheet, listGrantedSpreadsheets } from './grants';
import {
  createRecord as rowCreateRecord,
  createSheetRow as rowCreateSheetRow,
  updateRecord as rowUpdateRecord,
  deleteRecord as rowDeleteRecord,
  resolveEntity as rowResolveEntity,
  readRecord as rowReadRecord,
  listCollection as rowListCollection,
} from './row';

export { GOOGLE_SHEETS_ADAPTER_TYPE } from './types';

/**
 * Static manifest. Append target only (no v3 input → no `supportedTriggers`);
 * `createRecord` is a real append. `updateRecord` overwrites a row resolved
 * through `unique by` (row identity is derived per write — see row.ts);
 * `deleteRecord` stays unlisted (rows are never deleted through movements).
 *
 */
export const GOOGLE_SHEETS_MANIFEST: AdapterManifest = {
  adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
  displayName: 'Google Sheets',
  website: 'https://www.google.com/sheets/about/',
  category: 'Spreadsheets',
  description: 'Google Sheets. Append rows to a spreadsheet from your movements.',
  authoringHints:
    'Each Google spreadsheet holds its own tables, tabs and named cells, so ' +
    'this connection publishes ONE `Spreadsheet` collection, not the leaves. ' +
    'Reach a spreadsheet by narrowing it — ' +
    '`-[s:Spreadsheet WHERE `Title` == "Pipeline Sheet"]->` — or describe it ' +
    'by name (`types: ["Pipeline Sheet"]`); its leaves come back as that ' +
    'spreadsheet\'s edges (`Companies (table)`, `Sheet1 (sheet)`, ' +
    '`FX_Rate (cell)`). To name a leaf as a top-level type, start the ' +
    'instance at its spreadsheet — ' +
    '`google_sheets(credentials: acme, spreadsheet: "Pipeline Sheet")`. ' +
    'Writing `Spreadsheet` creates a new spreadsheet (`unique by (`Title`)` ' +
    'reuses an existing one), and cell writes hang off the spreadsheet ' +
    'handle: `write ss-[:Cells]->` / `write ss-[:`Named Cells`]->`. One ' +
    'spreadsheet per instance: to reach a second one, narrow to it or ' +
    'construct a second instance.',
  supportedTriggers: [],
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'resolveEntity', 'createRecord', 'updateRecord', 'readRecord', 'getFieldValue', 'getRelated'],
  requiredCredentialType: ExternalServiceType.GOOGLE,
  vocabulary: {
    icon: {
      d: 'M11.318 12.545H7.91v-1.909h3.41v1.91zM14.728 0v6h6l-6-6zm1.363 10.636h-3.41v1.91h3.41v-1.91zm0 3.273h-3.41v1.91h3.41v-1.91zM20.727 6.5v15.864c0 .904-.732 1.636-1.636 1.636H4.909a1.636 1.636 0 0 1-1.636-1.636V1.636C3.273.732 4.005 0 4.909 0h9.318v6.5h6.5zm-3.273 2.773H6.545v7.909h10.91v-7.91zm-6.136 4.636H7.91v1.91h3.41v-1.91z',
      fill: true,
    },
  },
  triggerKinds: ['GOOGLE_SHEETS'],
  introspectedSchema: true,
  // Optional entry position: `google_sheets(credentials: X, spreadsheet: "Y")`
  // starts the cursor at that granted spreadsheet, so its tabs/tables/cells are
  // the writable roots. Value enum + landed node come from the `Spreadsheet`
  // collection off the meta node.
  positionArgs: [{ name: 'spreadsheet', optionsFrom: SPREADSHEET_META_TYPE, label: 'Spreadsheet' }],
  // Under `drive.file` scope the Drive Picker is the only way to grant
  // per-file access (and the only discovery mechanism — there's no
  // list-all API). The `google-sheets-picker` handler runs the Drive Picker,
  // persists the picked spreadsheet against this credential, and the granted
  // set then feeds `listEntryPoints` so its tables surface.
  // Declared as an ACTION BLOCK in the construction surface — the connect
  // affordance is, in the limit, an interactive block (config-blocks Phase 3).
  construction: [
    {
      kind: 'action',
      actionKind: 'google-sheets-picker',
      label: 'Connect a Google Sheet',
      help: 'Pick spreadsheets to make their tables available here.',
    },
  ],
};

export class GoogleSheetsAdapter extends BaseAdapter {
  readonly adapterType = GOOGLE_SHEETS_ADAPTER_TYPE;
  /** Spreadsheets hold sheets, tables and named ranges — one fetch per grant.
   *  So a full-surface describe is refused and the author walks in instead. */
  readonly walksContainers = true;

  readonly supportedTriggers = GOOGLE_SHEETS_MANIFEST.supportedTriggers;

  /** No synthetic event positions — unstable positions never resolve here. */
  readonly webhookEventTypeId = undefined;

  private apiClient: GoogleSheetsApiClient | null = null;
  private readonly teamId: TeamId;
  private readonly credentialsId: string;
  /** Optional entry position — the `spreadsheet:` construction arg (a granted
   *  spreadsheet's Title). When set, the instance starts AT that spreadsheet:
   *  its tabs/tables/cells are the writable roots, so a leaf is written
   *  directly (`write sheets-[:\`Sheet1 (sheet)\`]->`) instead of traversed. */
  private readonly entrySpreadsheetName?: string;

  constructor(input: { teamId: TeamId; credentialsId: string; spreadsheet?: string }) {
    super();
    this.teamId = input.teamId;
    this.credentialsId = input.credentialsId;
    this.entrySpreadsheetName = input.spreadsheet?.trim() || undefined;
  }

  /** Resolve the configured entry-position spreadsheet Title → its id (first
   *  match, decision 3), or undefined when no `spreadsheet:` was configured. */
  private async entrySpreadsheetId(): Promise<string | undefined> {
    if (!this.entrySpreadsheetName) return undefined;
    const grants = await listGrantedSpreadsheets(this.credentialsId);
    const norm = (v: string) => v.trim().toLowerCase();
    const grant = grants.find((g) => g.name !== null && norm(g.name) === norm(this.entrySpreadsheetName!));
    return grant?.spreadsheetId;
  }

  // ── Name → structured-identifier cache ───────────────────────────────────
  // The framework names a table only by its pretty `displayName` (`"<table>
  // (table)"`) — that IS the `recordType` every position carries and the
  // `typeId` `listEntryPoints`/`describe` publish. The Sheets API routes on the
  // table's `{ spreadsheetId, tableId }`. This memoized catalog is the map
  // between them, fanned out over the credential's granted spreadsheets (the
  // Sheets REST surface has no "list all spreadsheets" endpoint, and under
  // `drive.file` scope a token can only see files granted through the Drive
  // Picker — recorded in `google_granted_item`). Mirrors the Airtable
  // adapter's `catalog()`; a failed introspection drops the cache so the next
  // call retries.

  private tableCatalogCache?: Promise<SheetsTableCatalog>;

  private catalog(): Promise<SheetsTableCatalog> {
    if (this.tableCatalogCache === undefined) {
      this.tableCatalogCache = (async () => {
        const client = await this.getApiClient();
        const grants = await listGrantedSpreadsheets(this.credentialsId);
        return loadTableCatalog({ client, grants });
      })();
      this.tableCatalogCache.catch(() => {
        this.tableCatalogCache = undefined;
      });
    }
    return this.tableCatalogCache;
  }

  // Leaf resolution is SPREADSHEET-SCOPED. Tables / tabs / named cells are
  // reached only by traversing a resolved Spreadsheet node, so the write path
  // always carries the parent spreadsheet id — it disambiguates same-named
  // leaves across grants. A bare describe (no parent) takes the first match:
  // the type's shape, not a specific instance.

  /** The write variant: resolve a table within its parent spreadsheet; an
   *  unresolved name is drift (the movement targets a table this connection
   *  can't see) — a hard throw. */
  private async requireStructuredId(
    name: string,
    method: string,
    spreadsheetId?: string,
  ): Promise<SheetsTableId> {
    const ids = resolveTable(await this.catalog(), { name, spreadsheetId });
    if (ids) return ids;
    throw new Error(`GoogleSheetsAdapter.${method}: unrecognised recordType "${name}".`);
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  /**
   * The granted spreadsheets' tables, surfaced by their pretty names. With no
   * grants yet the catalog is empty — the "+ Connect a Google Sheet" affordance
   * (an `action` block in the manifest's `construction` block list) is how the
   * author grants the first one.
   */
  /**
   * The ONLY top-level writable root is `Spreadsheet`. Tables, tabs, named
   * cells and cells are reached by traversing a resolved Spreadsheet node
   * (`ss-[:\`X (table)\`]-> …`), never as flat roots — so identically-named
   * tabs across granted spreadsheets never collide in one namespace, and the
   * described shape tells the author to resolve the spreadsheet first.
   */
  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // Positioned at a spreadsheet (`spreadsheet:` arg) → its leaves ARE the
    // writable roots. STRICT single-sheet introspection: a stale grant errors
    // honestly instead of surfacing a leafless instance.
    const entryId = await this.entrySpreadsheetId();
    if (entryId) {
      const client = await this.getApiClient();
      const surface = await loadSpreadsheetSurface({ client, spreadsheetId: entryId });
      return entryPointsForSpreadsheet(surface, entryId);
    }
    // ONE presentation (4_polymorphic_edges.md, narrowed 2026-07-17, following
    // Airtable): the polymorphic `Spreadsheet` edge, narrowed by WHERE. The
    // named per-grant entries were dropped — they said nothing the narrowable
    // edge doesn't, and a movement should meet "the spreadsheet titled Foo",
    // not a bare proper noun. `listEntryPoints` IS `edgesFrom(meta)`, so the
    // walk publishes the same single edge; the grants survive as the root
    // hop's MEMBERS (`targetPositions`), which is what a WHERE narrows over.
    return [spreadsheetMetaEntryPoint()];
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    if (typeRef === SPREADSHEET_META_TYPE) {
      // Unnarrowed: Title + the universal cell edges, no leaves, NO upstream
      // calls. Which tabs/tables exist depends on WHICH spreadsheet — say
      // that by narrowing (`WHERE `Title` == "Foo"`) or by `spreadsheet:`,
      // and the walk answers with that sheet's real surface for one fetch.
      // This used to build the union across every grant: a fetch per grant,
      // and an edge set no single spreadsheet actually had.
      return describeSpreadsheetMeta();
    }
    // A granted spreadsheet BY NAME — the call narrowing resolves to
    // (`refineInstanceSchema` describes the member its predicate selected).
    // Same landing, same minimal fanout as walking the member's path
    // (4_polymorphic_edges.md). Not a root EDGE any more — narrowing replaces
    // naming a grant as a type.
    const grant = await this.grantByTitle(typeRef);
    if (grant) return (await this.grantHop(grant.spreadsheetId)).descriptor;
    if (typeRef === NAMED_CELL_META_TYPE) return describeNamedCellMeta();
    if (typeRef === CELL_META_TYPE) return describeCellMeta();
    const catalog = await this.catalog();
    // Scope leaf shape to the entry spreadsheet when positioned (else first match).
    const entryId = await this.entrySpreadsheetId();
    if (resolveRange(catalog, { name: typeRef, spreadsheetId: entryId })) {
      return describeNamedRange({ displayName: typeRef });
    }
    // A plain tab: its header row (row 1) is the writable schema.
    const tabIds = resolveTab(catalog, { name: typeRef, spreadsheetId: entryId });
    if (tabIds) {
      const client = await this.getApiClient();
      return describeSheetTab({ client, ids: tabIds, displayName: typeRef });
    }
    // A native table: its declared columns.
    const ids = resolveTable(catalog, { name: typeRef, spreadsheetId: entryId });
    if (!ids) return null;
    const client = await this.getApiClient();
    return catalogDescribe({ client, ids });
  }

  // ── Reads: the Spreadsheet collection off the meta root ─────────────────

  /** Position field reads — spreadsheet positions (and any position whose
   *  data is keyed by field names) read directly off their payload. */
  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const data = positionData(input.position) as Record<string, unknown> | null | undefined;
    return data?.[input.fieldId] ?? null;
  }

  /**
   * The meta-graph walk: meta → one granted spreadsheet → its leaves.
   *
   * The root hop costs NO upstream call — the grants are a DB read — and each
   * grant's path carries its spreadsheetId, so describing one costs a single
   * fetch for that sheet. `Spreadsheet` stays POLYMORPHIC at the language
   * surface (`-[s:Spreadsheet WHERE `Title` == "Foo"]->` reads better than a
   * bare proper noun, and survives a rename); the walk is what makes that
   * presentation free.
   *
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    if (position.recordType === META_RECORD_TYPE) {
      const entryId = await this.entrySpreadsheetId();
      // Positioned at a spreadsheet (`spreadsheet:`) — construction already
      // walked the cursor there, so the root IS that sheet.
      if (entryId) return this.grantHop(entryId);
      return this.rootHop();
    }

    if (position.identity.kind !== 'stable') return null;
    const recordId = position.identity.recordId;

    // A spreadsheet node — the member a root hop handed over, or the same node
    // named by the `Spreadsheet` collection's landings (one word for one node;
    // `GrantedSpreadsheet` is retired). Only a GRANT walks: an id that isn't
    // granted is not a place this connection can stand.
    if (position.recordType === SPREADSHEET_META_TYPE) {
      const grants = await listGrantedSpreadsheets(this.credentialsId);
      const grant = grants.find((g) => g.spreadsheetId === recordId);
      if (!grant) return null;
      return this.grantHop(grant.spreadsheetId);
    }

    // A LEAF of the meta graph — the paths a spreadsheet hop handed over. Each
    // position carries its route (`spreadsheetId` + its own structured id), so
    // describing one is at most a single scoped fetch and never a catalog
    // rebuild. Leaves publish no paths on — the walk ends here.
    if (position.recordType === CELL_META_TYPE) {
      return { descriptor: describeCellMeta() };
    }
    if (position.recordType === NAMED_CELL_META_TYPE) {
      return { descriptor: describeNamedCellMeta() };
    }
    const leaf = positionData(position) as
      | { spreadsheetId?: string; tableId?: string; sheetId?: number; namedRangeId?: string }
      | null
      | undefined;
    if (position.recordType !== null && typeof leaf?.spreadsheetId === 'string') {
      if (typeof leaf.tableId === 'string') {
        const client = await this.getApiClient();
        const columns = await client.getTableColumns({
          spreadsheetId: leaf.spreadsheetId,
          tableId: leaf.tableId,
        });
        const descriptor = tableDescriptorFromColumns({ displayName: position.recordType, columns });
        return { descriptor, ...targetStubs(descriptor) };
      }
      if (typeof leaf.sheetId === 'number') {
        const client = await this.getApiClient();
        const descriptor = await describeSheetTab({
          client,
          ids: { spreadsheetId: leaf.spreadsheetId, sheetId: leaf.sheetId },
          displayName: position.recordType,
        });
        return { descriptor, ...targetStubs(descriptor) };
      }
      if (typeof leaf.namedRangeId === 'string') {
        return { descriptor: describeNamedRange({ displayName: position.recordType }) };
      }
    }

    return null;
  }

  /** The root's edges: the ONE polymorphic `Spreadsheet` edge, its members
   *  (the grants) riding `targetPositions` with no reference row each. A
   *  grants-table read — no Sheets API call at all. Narrowing selects a
   *  member and follows its path; the named per-grant spellings were dropped
   *  (entries and walk agree). */
  private async rootHop(): Promise<EdgesFromResult> {
    const grants = await listGrantedSpreadsheets(this.credentialsId);
    // `Spreadsheet` is STUBBED: describing it means fetching a granted
    // spreadsheet's sheets and columns, and the root has one member per grant.
    // The members below carry what an author actually picks between.
    const root: EdgesFromResult = {
      descriptor: {
        typeId: META_RECORD_TYPE,
        displayName: META_RECORD_TYPE,
        fields: [],
        references: [
          // Readable (the grants project as a collection) AND writable (a
          // movement creates a spreadsheet — `createRecord` on
          // SPREADSHEET_META_TYPE calls `client.createSpreadsheet` and records
          // the grant) — exactly what the entry list says; the two are the same
          // node's edges and must not disagree. `writable` is EXPLICIT since
          // layer 13: absent would silently make the root read-only and fail
          // every spreadsheet create at the checker.
          {
            fieldId: SPREADSHEET_META_TYPE,
            name: SPREADSHEET_META_TYPE,
            targetTypeId: SPREADSHEET_META_TYPE,
            cardinality: 'many' as const,
            writable: true,
            // Nothing orders spreadsheets themselves — but these are the ones
            // GRANTED to this connection, and the grants table is read
            // `.orderBy('created_at', 'asc')`, so they arrive in the order
            // someone granted them.
            sequenced: 'arrival',
          },
        ],
      },
      // The polymorphic edge's MEMBERS — paths without presentation rows.
      // Each member's `recordType` names the edge it belongs to (the same
      // gate `stepTo`/`membersOf` apply), its `Title` label names the member
      // — what `WHERE \`Title\` == …` evaluates, and what the `spreadsheet:`
      // arg enum shows.
      targetPositions: Object.fromEntries(
        grants.map((g) => [
          g.spreadsheetId,
          makeStablePosition({
            adapterType: this.adapterType,
            recordType: SPREADSHEET_META_TYPE,
            recordId: g.spreadsheetId,
            ...(g.name !== null ? { data: { Title: g.name } } : {}),
          }),
        ]),
      ),
    };
    return { ...root, ...targetStubs(root.descriptor) };
  }

  /** ONE spreadsheet's hop: its own tabs / tables / named cells as edges,
   *  each with the path on to it. Scoped to a single grant, so it costs one
   *  sheet's introspection — never the workspace's — and STRICT: a stale
   *  grant (deleted / access revoked) errors honestly instead of walking to
   *  a leafless node. */
  private async grantHop(spreadsheetId: string): Promise<EdgesFromResult> {
    const client = await this.getApiClient();
    const surface = await loadSpreadsheetSurface({ client, spreadsheetId });
    const leafPosition = (input: { recordType: string; recordId: string; data: unknown }) =>
      makeStablePosition({ adapterType: this.adapterType, ...input });
    return {
      descriptor: describeSpreadsheetMeta({
        tableTypeNames: tableTypeNamesOf(surface),
        sheetTabTypeNames: tabTypeNamesOf(surface),
        namedRangeTypeNames: rangeTypeNamesOf(surface),
      }),
      // A path per leaf, keyed by its edge's fieldId (the leaf's own name;
      // `Cells`/`Named Cells` for the universal pair). Each carries its route
      // — the spreadsheetId plus its own structured id — so the next hop is
      // one scoped fetch, and `describeType(leafName)` after a walk never
      // pays the cross-grant catalog.
      targetPositions: {
        cells: leafPosition({
          recordType: CELL_META_TYPE,
          recordId: `${spreadsheetId}:cells`,
          data: { spreadsheetId },
        }),
        'named cells': leafPosition({
          recordType: NAMED_CELL_META_TYPE,
          recordId: `${spreadsheetId}:named cells`,
          data: { spreadsheetId },
        }),
        ...Object.fromEntries(
          surface.tables.map((t) => [
            t.name,
            leafPosition({
              recordType: t.name,
              recordId: t.tableId,
              data: { spreadsheetId, tableId: t.tableId, Name: t.name },
            }),
          ]),
        ),
        ...Object.fromEntries(
          surface.tabs.map((t) => [
            t.name,
            leafPosition({
              recordType: t.name,
              recordId: String(t.sheetId),
              data: { spreadsheetId, sheetId: t.sheetId, Name: t.name },
            }),
          ]),
        ),
        ...Object.fromEntries(
          surface.ranges.map((r) => [
            r.name,
            leafPosition({
              recordType: r.name,
              recordId: r.namedRangeId,
              data: { spreadsheetId, namedRangeId: r.namedRangeId, Name: r.name },
            }),
          ]),
        ),
      },
    };
  }

  /** One granted spreadsheet as a data position — the node BOTH spellings of
   *  the root hop land on. */
  private grantLanding(grant: { spreadsheetId: string; name: string | null }): RelatedResult {
    return {
      position: makeStablePosition({
        adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
        recordType: SPREADSHEET_META_TYPE,
        recordId: grant.spreadsheetId,
        data: { Title: grant.name ?? grant.spreadsheetId },
      }),
    };
  }

  /** Resolve a granted spreadsheet by Title (first case-insensitive match —
   *  name clashes are the author's to resolve). A grants read, no API call. */
  private async grantByTitle(title: string) {
    const grants = await listGrantedSpreadsheets(this.credentialsId);
    const norm = (v: string) => v.trim().toLowerCase();
    return grants.find((g) => g.name !== null && norm(g.name) === norm(title));
  }


  /** `sheets-[s:Spreadsheet WHERE …]-> { … }` — the grants project as a
   *  collection off the meta root (one STABLE position per grant, recordId =
   *  the spreadsheetId, so writes through the bound handle parent-link
   *  correctly). The engine post-filters WHERE / ORDER BY / LIMIT. */
  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.direction !== 'outgoing') return [];
    if (input.position.recordType === META_RECORD_TYPE) {
      if (input.fieldId === SPREADSHEET_META_TYPE) {
        const grants = await listGrantedSpreadsheets(this.credentialsId);
        return grants.map((g) => this.grantLanding(g));
      }
      // Positioned at a spreadsheet (`spreadsheet:` arg) — the construction
      // already walked the cursor there, so the root's edges are that sheet's
      // OWN leaves and `sheets-[c:`Companies (table)`]->` is a table read.
      // Unpositioned, `Spreadsheet` (above) is the root's ONE collection: the
      // named per-grant edges died with the entry-list drop, so an unknown
      // name off the unpositioned root is a clean empty — never a fallback.
      const entryId = await this.entrySpreadsheetId();
      if (entryId === undefined) return [];
      if (input.fieldId === NAMED_CELLS_EDGE) return this.namedCellReads(entryId);
      if (input.fieldId === CELLS_EDGE) return this.cellReads(entryId, input.where);
      return this.tableRows(entryId, input.fieldId);
    }
    // A table read from a SPREADSHEET node — `s-[c:`Companies (table)`]-> …`,
    // whichever spelling of the hop landed there: the `Spreadsheet` collection
    // (recordType `Spreadsheet`), the walk (`GrantedSpreadsheet`), or a NAMED
    // grant hop whose landing the engine restamps with the grant's own Title
    // (`surfaceReadAdapter` re-types a meta-root landing to the collection's
    // target). Every spelling mints recordId = the spreadsheetId, so
    // container-ness is decided against the GRANTS — a DB read — never by
    // which spelling produced the position; and the position carrying its
    // route means reading a named table never re-walks the workspace (mirrors
    // Airtable's `{baseId, tableId}` paths).
    if (input.position.identity.kind !== 'stable') return [];
    const spreadsheetId = input.position.identity.recordId;
    const grants = await listGrantedSpreadsheets(this.credentialsId);
    if (!grants.some((g) => g.spreadsheetId === spreadsheetId)) return [];
    if (input.fieldId === NAMED_CELLS_EDGE) return this.namedCellReads(spreadsheetId);
    if (input.fieldId === CELLS_EDGE) return this.cellReads(spreadsheetId, input.where);
    return this.tableRows(spreadsheetId, input.fieldId);
  }

  /**
   * The `Named Cells` edge READ — the spreadsheet's named cells enumerate, each
   * carrying its `Name` and current `Value` (`listNamedRanges` names them, one
   * `values.get` per range reads the value — a named range resolves as a range
   * verbatim). `WHERE `Name` == …` narrows engine-side, like every other read
   * here. Its sibling `Cells` reads the same way but ADDRESSED — see
   * `cellReads`.
   */
  private async namedCellReads(spreadsheetId: string): Promise<RelatedResult[]> {
    const client = await this.getApiClient();
    const ranges = await client.listNamedRanges({ spreadsheetId });
    return Promise.all(
      ranges.map(async (r) => {
        const grid = await client.getRangeValues({ spreadsheetId, range: r.name });
        const value = grid[0]?.[0] ?? null;
        return {
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: NAMED_CELL_META_TYPE,
            recordId: `${spreadsheetId}:namedrange:${r.namedRangeId}`,
            data: { Name: r.name, Value: value },
          }),
        };
      }),
    );
  }

  /**
   * The `Cells` edge READ — ADDRESSED, not enumerated. A grid has no
   * meaningful set of "the cells", but a cell the author NAMES is one
   * `values.get` (the same call a named cell's Value read makes), so the hop's
   * WHERE supplies the address(es) and each becomes one fetch. No address in
   * the WHERE ⇒ nothing to read: an empty set, the same shape the checker's
   * `capability.filter: 'native'` gate teaches the author to avoid.
   *
   * Each address resolves through the SAME `resolveA1` the write uses, so a
   * read and a write of one address hit the same cell — an unqualified "B2"
   * only resolves on a single-tab spreadsheet (where `values.get`'s default
   * sheet IS that tab), and a bad address errors instead of reading blank.
   */
  private async cellReads(
    spreadsheetId: string,
    where: Expression | undefined,
  ): Promise<RelatedResult[]> {
    const addresses = cellAddressesInWhere(where);
    if (addresses.length === 0) return [];
    const client = await this.getApiClient();
    return Promise.all(
      addresses.map(async (address) => {
        const pos = await this.resolveA1(client, spreadsheetId, address, 'getRelated(cells)');
        const grid = await client.getRangeValues({ spreadsheetId, range: address });
        const value = grid[0]?.[0] ?? null;
        return {
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: CELL_META_TYPE,
            recordId: `${spreadsheetId}:cell:${pos.sheetId}:${pos.rowIndex}:${pos.columnIndex}`,
            data: { Cell: address, Value: value },
          }),
        };
      }),
    );
  }

  /**
   * A COLLECTION hop — the rows in a native table, reached from its container.
   * Both container surfaces (the root of a positioned instance, a traversed
   * spreadsheet node) publish the table READABLE, so both must read; before
   * this neither did (`row.ts` had no `listCollection`). One `listTables` on
   * the ONE spreadsheet the container names — never a catalog rebuild across
   * grants — then the shared row read. An unknown edge name degrades to
   * empty, like every other unresolved name here (a plain tab stays
   * write-only; the checker owns the author's diagnostic).
   */
  private async tableRows(spreadsheetId: string, edgeName: string): Promise<RelatedResult[]> {
    const client = await this.getApiClient();
    const tables = await client.listTables({ spreadsheetId });
    const table = tables.find((t) => tableDisplayName(t.name) === edgeName);
    if (!table) return [];
    return rowListCollection({
      client,
      ids: { spreadsheetId, tableId: table.tableId },
      tableName: tableDisplayName(table.name),
    });
  }

  // ── 2. Entity resolution — unique-by scan over live table rows ─────────

  // Row identity is DERIVED at write time: scan the table's current rows
  // against the author's `unique by` constraints; a match's CURRENT row
  // number becomes the update address (see row.ts).

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // The Spreadsheet meta type has no identity to resolve — every write
    // creates a fresh spreadsheet (uniquenessAuthorable is false there).
    if (input.recordType === SPREADSHEET_META_TYPE) {
      // `unique by (\`Title\`)` resolves an EXISTING granted spreadsheet — a
      // grants-table lookup, no external call. No constraints → always create.
      const wantsTitle = input.constraints.any.some((c) =>
        c.all.some((e) => e.field === 'Title'),
      );
      const title = typeof input.record['Title'] === 'string' ? (input.record['Title'] as string).trim() : '';
      if (!wantsTitle || title === '') return { candidates: [] };
      const grants = await listGrantedSpreadsheets(this.credentialsId);
      const norm = (v: string) => v.trim().toLowerCase();
      return {
        candidates: grants
          .filter((g) => g.name !== null && norm(g.name) === norm(title))
          .map((g) => ({
            adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
            externalId: g.spreadsheetId,
            data: { Title: g.name },
          })),
      };
    }
    if (input.recordType === NAMED_CELL_META_TYPE || input.recordType === CELL_META_TYPE) {
      return { candidates: [] };
    }
    const catalog = await this.catalog();
    // Scope by the entry position when positioned (a positioned instance has no
    // parent link, so the entry sheet is the only scoping — mirror createRecord).
    const entryId = await this.entrySpreadsheetId();
    // A named range IS its own identity: nothing to search, every write
    // overwrites the one cell (uniquenessAuthorable is false there too).
    if (resolveRange(catalog, { name: input.recordType, spreadsheetId: entryId })) {
      return { candidates: [] };
    }
    // A plain tab is append-only — no unique-by row identity to resolve.
    if (resolveTab(catalog, { name: input.recordType, spreadsheetId: entryId })) {
      return { candidates: [] };
    }
    // A native table. Resolve within the entry sheet when positioned; otherwise
    // (default position) `resolveEntity` carries no parent link, so a table name
    // shared by two granted spreadsheets resolves first-match here — the WRITE
    // (`createRecord`) is parent-scoped, so the row still lands correctly.
    const client = await this.getApiClient();
    const ids = await this.requireStructuredId(input.recordType, 'resolveEntity', entryId);
    return rowResolveEntity({ client, ids, resolve: input });
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const client = await this.getApiClient();
    // Create-a-new-spreadsheet: drive.file auto-owns app-created files, so the
    // create IS the grant — record it and the new sheet's tables surface on
    // the next catalog load (no picker step).
    if (input.recordType === SPREADSHEET_META_TYPE) {
      const rawTitle = input.fields['Title'];
      const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
      if (title === '') {
        throw new Error('GoogleSheetsAdapter.createRecord(Spreadsheet): "Title" is required.');
      }
      const created = await client.createSpreadsheet({ title });
      await grantSpreadsheet({
        credentialsId: this.credentialsId,
        spreadsheetId: created.spreadsheetId,
        name: title,
      });
      // Best-effort: an app-created sheet is owned by the CONNECTED Google
      // account — share it with the rest of the team so it isn't invisible
      // to everyone else. A share failure never fails the write.
      await this.shareWithTeam(client, created.spreadsheetId);
      return {
        adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
        externalId: created.spreadsheetId,
        data: {
          Title: title,
          url: `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
        },
      };
    }
    if (input.recordType === NAMED_CELL_META_TYPE) {
      return this.createNamedCell(client, input);
    }
    if (input.recordType === CELL_META_TYPE) {
      return this.writeCellDirect(client, input);
    }
    // Every leaf below is reached by traversing a resolved Spreadsheet node,
    // so the parent link names which spreadsheet it lives in — that SCOPES
    // resolution, keeping identically-named leaves across grants distinct (and
    // making the old "wrong spreadsheet" guard intrinsic: a leaf that isn't in
    // the parent simply doesn't resolve).
    const parentSpreadsheetId =
      writeParentLinks(input).find((p) => p.recordType === SPREADSHEET_META_TYPE)?.externalId ??
      (await this.entrySpreadsheetId());
    const catalog = await this.catalog();

    // Named-range Value write: overwrite the aliased cell.
    const named = resolveRange(catalog, { name: input.recordType, spreadsheetId: parentSpreadsheetId });
    if (named) {
      const value = input.fields['Value'];
      if (value === undefined || value === null || value === '') {
        throw new Error(
          `GoogleSheetsAdapter.createRecord(${input.recordType}): "Value" is required.`,
        );
      }
      await client.setNamedRangeValue({
        spreadsheetId: named.spreadsheetId,
        namedRangeId: named.namedRangeId,
        value,
      });
      return {
        adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
        externalId: `${named.spreadsheetId}:namedrange:${named.namedRangeId}`,
        data: {
          Value: value,
          url: `https://docs.google.com/spreadsheets/d/${named.spreadsheetId}/edit`,
        },
      };
    }
    // A plain-tab append (`"<tab> (sheet)"`): the tab's header row is the
    // schema; `addRow` maps fields by header name. Append-only.
    const tabIds = resolveTab(catalog, { name: input.recordType, spreadsheetId: parentSpreadsheetId });
    if (tabIds) {
      return rowCreateSheetRow({ client, ids: tabIds, fields: input.fields });
    }
    // A native table row append.
    const ids = await this.requireStructuredId(input.recordType, 'createRecord', parentSpreadsheetId);
    return rowCreateRecord({ client, ids, fields: input.fields });
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    // A resolved-existing Spreadsheet node (unique by Title matched a grant):
    // nothing to change — Title equality is what matched it — so the "update"
    // no-ops and returns the node so child cell writes hang off the handle.
    if (input.recordType === SPREADSHEET_META_TYPE) {
      const grants = await listGrantedSpreadsheets(this.credentialsId);
      const grant = grants.find((g) => g.spreadsheetId === input.externalId);
      if (grant) {
        return {
          adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
          externalId: grant.spreadsheetId,
          data: {
            Title: grant.name,
            url: `https://docs.google.com/spreadsheets/d/${grant.spreadsheetId}/edit`,
          },
          // A granted spreadsheet is the root of its own tree — nothing hangs
          // it off a parent, so a write that named one asked for something
          // Sheets has no way to make.
          association: unsupportedAssociation(input),
        };
      }
    }
    const client = await this.getApiClient();
    return rowUpdateRecord({ client, update: input });
  }

  /** Read a record back (no-op detection): a granted spreadsheet by id, or a
   *  table row by row address. */
  async readRecord(input: import('movement-engine/services/translation_graph/adapter').ReadInput): Promise<Record<string, unknown> | null> {
    if (input.recordType === SPREADSHEET_META_TYPE) {
      const grants = await listGrantedSpreadsheets(this.credentialsId);
      const grant = grants.find((g) => g.spreadsheetId === input.externalId);
      return grant ? { Title: grant.name } : null;
    }
    const client = await this.getApiClient();
    return rowReadRecord({ client, externalId: input.externalId });
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    return rowDeleteRecord({ del: input });
  }

  /** Resolve which spreadsheet a cell-addressed write targets: GRAPH-first —
   *  the parent link when the write hangs off a Spreadsheet node
   *  (`ss-[:Cells]->`, existing-or-created via unique by Title) — else the
   *  team's single grant, else guidance to compose through the node. The
   *  spreadsheet is never named by a string field on the leaf write. */
  /** Writer access for every team member's primary email (skipping the
   *  connected account's own address is unnecessary — Drive treats sharing
   *  with the owner as a no-op). Best-effort per address. */
  private async shareWithTeam(client: GoogleSheetsApiClient, spreadsheetId: string): Promise<void> {
    let emails: string[] = [];
    try {
      const rows = await getCoreQb(['user', 'user_email'])
        .selectFrom('user as u')
        .innerJoin('user_email as ue', (j) =>
          j.onRef('ue.user_id', '=', 'u.id').on('ue.is_primary', '=', true),
        )
        .where('u.default_team_id', '=', this.teamId)
        .select(['ue.email'])
        .execute();
      emails = rows.map((r) => String(r.email)).filter((e) => e.includes('@'));
    } catch (err) {
      logger.warn('[GoogleSheetsAdapter] team-email lookup for sharing failed', {
        teamId: this.teamId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const email of emails) {
      try {
        await client.addWriterPermission({ spreadsheetId, email });
      } catch (err) {
        logger.warn('[GoogleSheetsAdapter] sharing created spreadsheet failed', {
          teamId: this.teamId,
          spreadsheetId,
          email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async resolveTargetSpreadsheet(
    input: WriteInput,
    method: string,
  ): Promise<{ spreadsheetId: string; name: string | null }> {
    const parent = writeParentLinks(input).find(
      (p) => p.recordType === SPREADSHEET_META_TYPE,
    );
    if (parent) {
      return { spreadsheetId: parent.externalId, name: null };
    }
    // Positioned instance (`spreadsheet:` arg): the entry sheet is the target.
    const entryId = await this.entrySpreadsheetId();
    if (entryId) return { spreadsheetId: entryId, name: this.entrySpreadsheetName ?? null };
    const grants = await listGrantedSpreadsheets(this.credentialsId);
    if (grants.length === 1) return grants[0];
    throw new Error(
      grants.length === 0
        ? `GoogleSheetsAdapter.${method}: no spreadsheet granted — pick one (grantAccess) or create one (write Spreadsheet) first.`
        : `GoogleSheetsAdapter.${method}: several spreadsheets granted — write through the spreadsheet node: ss = write <sheets>.Spreadsheet { unique by (\`Title\`) Title: "…" } then ${method.includes('Named') ? 'write ss-[:\`Named Cells\`]->' : 'write ss-[:Cells]->'} { … }.`,
    );
  }

  /** Resolve an A1 ref's sheet tab to its sheetId (defaulting to the sole tab
   *  when the ref names none). */
  private async resolveA1(
    client: GoogleSheetsApiClient,
    spreadsheetId: string,
    cellRef: string,
    method: string,
  ): Promise<{ sheetId: number; rowIndex: number; columnIndex: number }> {
    const parsed = parseA1Cell(cellRef);
    if (!parsed) {
      throw new Error(
        `GoogleSheetsAdapter.${method}: "${cellRef}" is not a single-cell A1 reference (expected e.g. "Dashboard!B2").`,
      );
    }
    // listSheets returns the FLAT `{ sheetId, title }[]` shape.
    const tabs = (await client.listSheets({ spreadsheetId })) as {
      sheetId: number;
      title: string;
    }[];
    const tab = parsed.sheetTitle
      ? tabs.find((t) => t.title === parsed.sheetTitle)
      : tabs.length === 1
        ? tabs[0]
        : undefined;
    if (!tab) {
      throw new Error(
        parsed.sheetTitle
          ? `GoogleSheetsAdapter.${method}: no tab named "${parsed.sheetTitle}" — tabs: ${tabs.map((t) => `"${t.title}"`).join(', ')}.`
          : `GoogleSheetsAdapter.${method}: the spreadsheet has several tabs — qualify the cell (e.g. "Dashboard!${cellRef}").`,
      );
    }
    return { sheetId: tab.sheetId, rowIndex: parsed.rowIndex, columnIndex: parsed.columnIndex };
  }

  /** `write sheet-[:\`Named cell\`]-> { Name, Cell }` — the agent-performed naming
   *  step: promotes a positional cell to a stable '<Name> (cell)' target. */
  private async createNamedCell(
    client: GoogleSheetsApiClient,
    input: WriteInput,
  ): Promise<WriteResult> {
    const name = typeof input.fields['Name'] === 'string' ? (input.fields['Name'] as string).trim() : '';
    const cellRef = typeof input.fields['Cell'] === 'string' ? (input.fields['Cell'] as string).trim() : '';
    if (name === '' || cellRef === '') {
      throw new Error('GoogleSheetsAdapter.createRecord(Named cell): "Name" and "Cell" are required.');
    }
    const target = await this.resolveTargetSpreadsheet(input, 'createRecord(Named cell)');
    const range = await this.resolveA1(client, target.spreadsheetId, cellRef, 'createRecord(Named cell)');
    const created = await client.addNamedRange({
      spreadsheetId: target.spreadsheetId,
      name,
      range,
    });
    return {
      adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
      externalId: `${target.spreadsheetId}:namedrange:${created.namedRangeId}`,
      data: {
        Name: name,
        Cell: cellRef,
        url: `https://docs.google.com/spreadsheets/d/${target.spreadsheetId}/edit`,
      },
    };
  }

  /** `write sheet-[:Cell]-> { Cell, Value }` — the EXPLICIT A1 escape hatch. */
  private async writeCellDirect(
    client: GoogleSheetsApiClient,
    input: WriteInput,
  ): Promise<WriteResult> {
    const cellRef = typeof input.fields['Cell'] === 'string' ? (input.fields['Cell'] as string).trim() : '';
    const value = input.fields['Value'];
    if (cellRef === '' || value === undefined || value === null || value === '') {
      throw new Error('GoogleSheetsAdapter.createRecord(Cell): "Cell" and "Value" are required.');
    }
    const target = await this.resolveTargetSpreadsheet(input, 'createRecord(Cell)');
    const pos = await this.resolveA1(client, target.spreadsheetId, cellRef, 'createRecord(Cell)');
    await client.setCellValue({
      spreadsheetId: target.spreadsheetId,
      sheetId: pos.sheetId,
      rowIndex: pos.rowIndex,
      columnIndex: pos.columnIndex,
      value,
    });
    return {
      adapterType: GOOGLE_SHEETS_ADAPTER_TYPE,
      externalId: `${target.spreadsheetId}:cell:${pos.sheetId}:${pos.rowIndex}:${pos.columnIndex}`,
      data: {
        Cell: cellRef,
        Value: value,
        url: `https://docs.google.com/spreadsheets/d/${target.spreadsheetId}/edit`,
      },
    };
  }

  // ── Internal: lazy API client construction ──────────────────────────────

  private async getApiClient(): Promise<GoogleSheetsApiClient> {
    if (this.apiClient) return this.apiClient;

    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', this.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', this.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Google Sheets credentials ${this.credentialsId} not found for team ${this.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
      );
    }

    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch (err) {
      logger.error('[GoogleSheetsAdapter] credential payload is not valid JSON', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Google Sheets credentials ${row.id} are malformed (not valid JSON).`);
    }

    // Route dev-loop team traffic to fake-channels (mirrors Attio / Airtable).
    // Without this branch the adapter hits real Sheets and 401s on the seeded
    // stub token.
    const rawPayload = isTestHarnessTeam(this.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'GOOGLE_SHEETS')
      : payload;

    const parsed = googleSheetsAdapterCredsParser.safeParse(rawPayload);
    if (!parsed.success) {
      logger.error('[GoogleSheetsAdapter] credential payload failed validation', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: parsed.error.message,
      });
      throw new Error(`Google Sheets credentials ${row.id} are malformed (${parsed.error.message}).`);
    }

    this.apiClient = new GoogleSheetsApiClient(row.id, parsed.data);
    return this.apiClient;
  }
}

export function createGoogleSheetsAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
  /** The `spreadsheet:` construction arg — a granted spreadsheet's Title to
   *  start the instance at (optional; default position is the meta node). */
  spreadsheet?: string;
}): GoogleSheetsAdapter {
  if (!input.credentialsId) {
    throw new Error(
      'Google Sheets adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  return new GoogleSheetsAdapter({
    teamId: input.teamId,
    credentialsId: input.credentialsId,
    spreadsheet: input.spreadsheet,
  });
}
