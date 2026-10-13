// Airtable TG adapter — schema introspection. `listEntryPoints` enumerates
// bases → tables; `describe(typeId)` loads one table's fields + references.
// The Airtable-field-type → TG-field-shape mapping lives here, alongside the
// base/table catalog cache (LRU + TTL, keyed by base — mirrors Attio).

import { LRUCache } from 'lru-cache';

import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaFieldKind,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from '../../types';
import type { AirtableAPIClient } from '../../../../adapters/airtable/apiClient';

import {
  LINK_FIELD_TYPE,
  READ_ONLY_FIELD_TYPES,
  type AirtableTableId,
  type AirtableFieldMeta,
  type AirtableTableMeta,
} from './types';
import {
  AIRTABLE_EVENT_RECORD_EDGE,
  AIRTABLE_EVENT_RECORD_EDGE_NAME,
  AIRTABLE_EVENT_TYPE_NAME,
  AIRTABLE_SUBSCRIBABLE_EVENTS,
  AIRTABLE_WEBHOOK_RECORD_TYPE,
} from './webhook';

/**
 * Per-base table catalog, keyed by `<teamId>:<baseId>`. Populated lazily by
 * `cachedTables`; consumed by `describe`, `resolveEntity`, and the write
 * path — all of which need the table's field metadata without re-firing
 * `listTables`. 10-minute TTL matches the Attio catalog cache.
 */
const tableCatalogCache = new LRUCache<string, AirtableTableMeta[]>({
  max: 200,
  ttl: 10 * 60 * 1000,
});

/** Per-team base catalog (id → name), keyed by team. Lets `describe` resolve a
 *  base by name without a `listBases` round-trip on every call. */
const baseCatalogCache = new LRUCache<string, Map<string, string>>({
  max: 50,
  ttl: 10 * 60 * 1000,
});

function tableCacheKey(teamId: string, baseId: string): string {
  return `${teamId}:${baseId}`;
}

export async function cachedTables(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
}): Promise<AirtableTableMeta[]> {
  const key = tableCacheKey(input.teamId, input.baseId);
  const hit = tableCatalogCache.get(key);
  if (hit) return hit;
  const tables = await input.client.listTables({ baseId: input.baseId });
  tableCatalogCache.set(key, tables as AirtableTableMeta[]);
  return tables as AirtableTableMeta[];
}

async function cachedBases(input: {
  client: AirtableAPIClient;
  teamId: string;
}): Promise<Map<string, string>> {
  const hit = baseCatalogCache.get(input.teamId);
  if (hit) return hit;
  const bases = await input.client.listBases();
  const map = new Map<string, string>();
  for (const b of bases) map.set(b.id, b.name);
  baseCatalogCache.set(input.teamId, map);
  return map;
}

/** The workspace's bases, cache-backed — `id → name`. The root hop reads them
 *  through here rather than firing its own `listBases`, so walking the root
 *  right after `listEntryPoints` (the ordinary case: the cache enumerates the
 *  node list, then walks to learn its paths) costs ONE call, not two. */
export async function basesForWalk(input: {
  client: AirtableAPIClient;
  teamId: string;
}): Promise<{ id: string; name: string }[]> {
  const baseNames = await cachedBases(input);
  return [...baseNames].map(([id, name]) => ({ id, name }));
}

// ── How a table is named ─────────────────────────────────────────────────────
// By its own name. Nothing more.
//
// It used to be `"<Base> — <Table>"`, because tables were FLAT ROOTS sharing
// one namespace and needed to be globally unique in it. The drill-down removed
// that reason: a table lives behind its base, and naming one REQUIRES a base
// (by walking to it, or via `base:`). So the qualifier is a fossil — and a
// path flattened into a string, with a separator an author had to know and
// `demandSeed` had to substring-match. The path is the address now.
//
// Uniqueness still holds where it must: a POSITIONED instance sees one base's
// tables, so `Companies` is unambiguous within it; an unpositioned instance
// can't name a table at all, so there is no namespace to collide in. That is
// why the catalog below is base-scoped.

// ── Name → structured-identifier cache (the reference pattern) ───────────────
// The framework only ever names a table by its `displayName`. The Airtable API
// routes on `{ baseId, tableId }`. This catalog is the adapter's PRIVATE map
// between the two — populated from the SAME base/table introspection that lists
// entry points, so a position can carry a plain name and the adapter recovers
// the routing ids from it without parsing any magic string. The `nameByTableId`
// reverse lets the read path STAMP an emitted position (a `getRelated` landing)
// with the linked table's name rather than leaking an identifier.

export interface TableCatalog {
  /** `displayName` → `{ baseId, tableId }`. The name → identifier lookup. */
  idsByName: Map<string, AirtableTableId>;
  /** `tableId` → `displayName`. The reverse, for naming positions the adapter
   *  emits (Airtable links stay within a base, so a bare tableId is unique). */
  nameByTableId: Map<string, string>;
}

/**
 * Build the name ⇄ structured-identifier catalog (cache-backed via
 * `cachedBases` + `cachedTables`, so callers re-derive it cheaply and the
 * adapter memoizes it per instance).
 *
 * SCOPE IT with `baseId` — the instance's entry base. Table names are bare now,
 * so they are unique only WITHIN a base: two bases may each hold a `Companies`,
 * and a workspace-wide `idsByName` would silently route one to the other's
 * table. A positioned instance passes its base and the names are exact.
 *
 * Unscoped, this is best-effort and last-wins on a clash: it serves the landing
 * stamps (`nameByTableId`, keyed by the unique tableId, so unaffected) and
 * `describe`'s by-name fallback. An unpositioned instance can't name a table
 * anyway, so nothing routes a write through an ambiguous entry.
 */
export async function loadTableCatalog(input: {
  client: AirtableAPIClient;
  teamId: string;
  /** Restrict to ONE base — what makes a bare table name unambiguous. */
  baseId?: string;
}): Promise<TableCatalog> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseIds = input.baseId !== undefined ? [input.baseId] : [...baseNames.keys()];
  const idsByName = new Map<string, AirtableTableId>();
  const nameByTableId = new Map<string, string>();
  for (const baseId of baseIds) {
    const tables = await cachedTables({ client: input.client, teamId: input.teamId, baseId });
    for (const table of tables) {
      idsByName.set(table.name, { baseId, tableId: table.id });
      nameByTableId.set(table.id, table.name);
    }
  }
  return { idsByName, nameByTableId };
}

// ── Field-type → TG field shape (3_model.md) ───────────────────────────────
// `multipleRecordLinks` is handled separately (it becomes a reference, not a
// value field). Everything else maps to a scalar/array value kind here.

interface ValueShape {
  kind: SchemaFieldKind;
  cardinality: 'one' | 'many';
}

function valueShapeFor(fieldType: string | undefined): ValueShape {
  switch (fieldType) {
    case 'number':
    case 'percent':
    case 'currency':
    case 'duration':
    case 'rating':
    case 'count':
    case 'autoNumber':
      return { kind: 'number', cardinality: 'one' };
    case 'checkbox':
      return { kind: 'boolean', cardinality: 'one' };
    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return { kind: 'date', cardinality: 'one' };
    case 'multipleSelects':
    case 'multipleCollaborators':
    case 'multipleLookupValues':
      return { kind: 'string', cardinality: 'many' };
    case 'multipleAttachments':
      // A first-class File field: authors map a FileRef (an email attachment,
      // an extracted doc) and the write path hands Airtable the file's signed
      // URL to fetch. Multi — an Airtable attachment cell holds a list.
      return { kind: 'file', cardinality: 'many' };
    case 'singleSelect':
    case 'singleCollaborator':
    case 'singleLineText':
    case 'multilineText':
    case 'email':
    case 'url':
    case 'phoneNumber':
    case 'richText':
    case 'barcode':
    case 'aiText':
      return { kind: 'string', cardinality: 'one' };
    // formula / rollup / lookup carry an Airtable-computed `result` whose type
    // we don't statically know. It is a SCALAR though (Airtable computes a
    // number, a string, a date — never a document), so `string` is the honest
    // narrowing: unknown-typed but readable and renderable. `json` is for a
    // genuinely structured value, and would make these read-only fields opaque
    // — unusable in a comparison or a write, for no gain.
    case 'formula':
    case 'rollup':
    case 'lookup':
      return { kind: 'string', cardinality: 'one' };
    default:
      // Unknown / system types (createdBy, lastModifiedBy, button,
      // externalSyncSource, …) surface as string scalars; they're in the
      // read-only set so they never round-trip as writes.
      return { kind: 'string', cardinality: 'one' };
  }
}

function fieldDescriptor(field: AirtableFieldMeta): SchemaFieldDescriptor {
  const shape = valueShapeFor(field.type);
  return {
    fieldId: field.id,
    displayName: field.name,
    kind: shape.kind,
    cardinality: shape.cardinality,
    writable: !READ_ONLY_FIELD_TYPES.has(field.type ?? ''),
    required: false,
    description: field.description,
  };
}

function referenceDescriptor(input: {
  field: AirtableFieldMeta;
  baseName: string;
  tables: AirtableTableMeta[];
}): SchemaReferenceDescriptor | null {
  if (input.field.type !== LINK_FIELD_TYPE) return null;
  const linkedTableId = (input.field.options as { linkedTableId?: string } | undefined)
    ?.linkedTableId;
  if (!linkedTableId) return null;
  // A reference's target is named, like every position, by the linked table's
  // displayName — never an encoded id. Airtable links are within-base, so the
  // linked table is in this base's `tables`. Skip a link to a table the catalog
  // doesn't list (a stale/inaccessible target) rather than name it by raw id.
  const linkedTable = input.tables.find((t) => t.id === linkedTableId);
  if (!linkedTable) return null;
  return {
    fieldId: input.field.id,
    name: input.field.name,
    targetTypeId: linkedTable.name,
    cardinality: 'many',
  };
}

// ── The meta-graph vocabulary ────────────────────────────────────────────────
// The record types of TYPE nodes — the nodes a `edgesFrom` walk moves between,
// NOT nodes holding records. They are deliberately this adapter's own private
// words: a meta-graph position `{recordType: 'Table', recordId: tblXYZ}` can
// never be confused with a data-graph position `{recordType: 'Companies',
// recordId: recXYZ}` naming an actual row. The framework's name for a type
// stays its `displayName`; these only describe how the adapter gets back there.
//
// `Base` doubles as the collection the `base:` construction arg draws from: its
// members are the base NAMES the author picks between (the arg's value enum),
// materialised through `getRelated` off the meta root (see index.ts).
export const BASE_META_TYPE = 'Base';
export const TABLE_META_TYPE = 'Table';

/**
 * The POLYMORPHIC presentation of a base — the ONLY presentation. One `Base`
 * collection whose members you narrow (`-[b:Base WHERE `Name` == "CRM"]->`);
 * the per-base NAMED edges were dropped from the root (ruling 2026-07-17):
 * they added nothing the narrowable edge doesn't say, and the polymorphic
 * form reads better — it survives a rename, and an author meets "the base
 * called CRM" rather than a bare proper noun.
 *
 * Narrowing costs exactly what the named edge cost (layer 4): the members
 * still ride the root hop's `targetPositions`, so selecting one and walking
 * to it is the same single fetch.
 *
 */
export function baseMetaEntryPoint(): SchemaEntryPoint {
  return {
    typeId: BASE_META_TYPE,
    displayName: BASE_META_TYPE,
    // You traverse a base; you never create one from a movement.
    writable: false,
    readable: true,
  };
}

/**
 * The `Base` node, UNNARROWED: its own `Name`, and no tables — which tables
 * exist depends on WHICH base, and nobody has said yet. Narrowing (or `base:`)
 * answers with that base's real surface for one call. Exactly Sheets'
 * unnarrowed `Spreadsheet`, for exactly the same reason.
 */
export function describeBaseMeta(): SchemaTypeDescriptor {
  return {
    typeId: BASE_META_TYPE,
    displayName: BASE_META_TYPE,
    description:
      'One of this workspace\'s bases. Which tables it holds depends on WHICH ' +
      'base — narrow to one (`-[b:Base WHERE `Name` == "CRM"]->`, or the ' +
      '`base:` construction arg) and its tables become the edges.',
    fields: [
      // The label a narrowing predicate reads — published on every member the
      // root hop mints, so `WHERE `Name` == …` always has this to evaluate.
      { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: false, required: false },
    ],
    references: [],
  };
}

/**
 * The `Table` node, UNNARROWED — the event's `Record` edge lands here before
 * anything says WHICH table. Honestly minimal: a table's schema varies per
 * (base, table), so the unnarrowed node has no intrinsic fields; the listen's
 * `base:`/`table:` pins (or walking into a base) narrow it to a real table's
 * surface. The unnarrowed `Base`/`Spreadsheet` rule, one level down —
 * "undescribed" must mean nobody looked, not that there was nothing to say.
 */
export function describeTableMeta(): SchemaTypeDescriptor {
  return {
    typeId: TABLE_META_TYPE,
    displayName: TABLE_META_TYPE,
    description:
      'A table in one of this workspace\'s bases. Its fields depend on WHICH ' +
      '(base, table) — a listen\'s `base:`/`table:` pins narrow it, as does ' +
      'walking into a base — so the unnarrowed node carries none.',
    fields: [],
    references: [],
  };
}

/**
 * The EVENT edge off the meta node: `meta -[:Record Change]-> <the event>`.
 *
 * `readable: false`, and that is the honest statement rather than a demotion.
 * `readable` is a promise about THIS edge — "the root offers this as a starting
 * point for reads" — and nothing can enumerate the record changes that have
 * happened. An event is pushed, never pulled. The edge's promise is `fires`: a
 * listen delivers it, which is what `eventPosition` declares.
 *
 * `eventPosition` no longer needs `readable` to be honoured (the projection's
 * gate came off in `a936aa63c`), so this entry can say both true things at once
 * — which it could not before, and which is why every event-typed adapter used
 * to claim a root collection it could not serve.
 *
 */
export function recordChangeEntryPoint(): SchemaEntryPoint {
  return {
    typeId: AIRTABLE_WEBHOOK_RECORD_TYPE,
    displayName: AIRTABLE_EVENT_TYPE_NAME,
    writable: false,
    // You cannot list the changes that have happened — only be told of one.
    readable: false,
    // The event EDGE marker. THE EVENT IS JUST A NODE: the change-kind axis
    // is the node's own `action` enum field (describeRecordChange), narrowed
    // in the address alongside `base`/`table` —
    // `<at-[:`Record Change` WHERE `action` == "record.created" AND `table` == "tbl…"]->>`.
    // Named narrowed edges (`Record Created` …) are layer 4's presentation
    // choice and deliberately NOT declared: polymorphic reads better.
    fires: true,
  };
}

/**
 * The event node: the changed row's identity, and an edge to the row itself.
 *
 * The `Record` edge is the point. The event and the row are DIFFERENT NODES —
 * this adapter used to seed the row AS the event, which is why a movement could
 * declare `` <at-[:`Deals`]->> `` with nothing to check it against. The row is
 * reached, not conflated.
 *
 * `base`/`table` are the raw ids because that is what a `listen` names, so the
 * same values narrow both. The edge is polymorphic — its target is whichever
 * table fired, and which tables exist depends on WHICH base, so it is not
 * enumerated here: the valid `(base, table)` pairs are discovered by traversing
 * from the META node, as a two-hop path.
 *
 */
export function describeRecordChange(): SchemaTypeDescriptor {
  const idField = (name: string, description: string) => ({
    fieldId: name,
    displayName: name,
    kind: 'string' as const,
    writable: false,
    required: false,
    description,
  });
  return {
    typeId: AIRTABLE_WEBHOOK_RECORD_TYPE,
    displayName: AIRTABLE_EVENT_TYPE_NAME,
    fields: [
      // The change-kind axis is an ORDINARY FIELD — an enum of the listen's
      // `events:` vocabulary (ONE namespace), narrowed in the address exactly
      // like `base`/`table`: the same values narrow both.
      {
        fieldId: 'action',
        displayName: 'action',
        kind: 'enum' as const,
        enumValues: [...AIRTABLE_SUBSCRIBABLE_EVENTS],
        writable: false,
        required: false,
        description: 'Which kind of change this event is — the same values a listen\'s `events:` names.',
      },
      idField('base', "The base the change happened in — the id a `listen` names."),
      idField('table', "The table the change happened in — the id a `listen` names."),
      idField('record', 'The changed row’s id.'),
    ],
    references: [
      {
        fieldId: AIRTABLE_EVENT_RECORD_EDGE,
        name: AIRTABLE_EVENT_RECORD_EDGE_NAME,
        targetTypeId: TABLE_META_TYPE,
        cardinality: 'one' as const,
        description: 'The row that changed.',
        // THE hop from the event to what it is about (D40(b)) — declared, so a
        // listen's `fields:` names columns of the row rather than properties of
        // the event node, without anything having to recognise the name `Record`.
        subject: true,
        // Reached, never written along: a movement writes to a TABLE, not
        // through an event.
        writable: false,
      },
    ],
  };
}

/** Resolve a base's NAME to its id (first case-insensitive match), or undefined
 *  when no accessible base carries that name. Feeds the `base:` entry position;
 *  an unresolved name falls the instance back to the full-workspace walk (the
 *  author-time checker warns on the unknown name separately). */
export async function resolveBaseId(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseName: string;
}): Promise<string | undefined> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const norm = (v: string) => v.trim().toLowerCase();
  for (const [id, name] of baseNames) {
    if (norm(name) === norm(input.baseName)) return id;
  }
  return undefined;
}

// ── entry points ───────────────────────────────────────────────────────────
// The unpositioned root's entries are STATIC facts (the event edge + the
// polymorphic `Base` edge — see index.ts); only a POSITIONED instance
// enumerates anything here.

/** One base's tables as writable roots, by their own bare names — unique within
 *  the base, which is the only namespace they live in. Mirrors Sheets'
 *  `entryPointsForSpreadsheet`. */
function baseEntryPoints(input: {
  tables: AirtableTableMeta[];
}): SchemaEntryPoint[] {
  return input.tables.map((table) => {
    const displayName = table.name;
    return {
      // The framework identity IS the table's own name — the structured
      // `{ baseId, tableId }` lives only in the private cache. `externalId`
      // keeps the raw tableId for callers that key on the external table.
      typeId: displayName,
      displayName,
      externalId: table.id,
      writable: true,
      readable: true,
      labelTemplate: `{${table.primaryFieldId}}`,
    };
  });
}

/**
 * EVERY table in the workspace, as types. Costs 1 + N calls (a `listTables`
 * per base) — which is why it is no longer what the meta node publishes.
 *
 * It survives for the NAME RESOLVER, which answers a different question than
 * the root does: given a table name the engine hands it at runtime, what are
 * that table's field ids? Bases have no fields, so a resolver built from the
 * published entries would leave every table unmapped and writes would send
 * display names where Airtable expects field ids.
 */
export async function allTableEntryPoints(input: {
  client: AirtableAPIClient;
  teamId: string;
}): Promise<SchemaEntryPoint[]> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const entries: SchemaEntryPoint[] = [];
  for (const [baseId, baseName] of baseNames) {
    const tables = await cachedTables({ client: input.client, teamId: input.teamId, baseId });
    entries.push(...baseEntryPoints({ tables }));
  }
  return entries;
}

/** The writable entry points for an instance POSITIONED at one base (`base:`
 *  construction arg) — only that base's tables, so enumeration is a SINGLE base
 *  walk instead of every base in the workspace. This is the escape hatch from a
 *  large-workspace `listEntryPoints` that would otherwise walk (and can time
 *  out on) hundreds of bases. */
export async function entryPointsForBase(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
}): Promise<SchemaEntryPoint[]> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseName = baseNames.get(input.baseId) ?? input.baseId;
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId: input.baseId,
  });
  return baseEntryPoints({ tables });
}

// ── describe ───────────────────────────────────────────────────────────────

/**
 * A BASE's node: no fields of its own, one edge per table in it. ONE
 * `listTables` — the hop the whole drill-down exists to make cheap.
 *
 * The edge's `fieldId` is the raw tableId, which is what a caller keys
 * `targetPositions` by to get the path on to the table.
 *
 * Every table edge promises WRITE, and that does not depend on the standpoint.
 * Creating a row is THE Airtable operation: `createRecord` (and `updateRecord`)
 * take the table's own name, resolve it through the workspace catalog and call
 * `recordCreateRecord` — a table reached by walking to its base is exactly as
 * writable as one published by a `base:`-positioned root. The edge is also the
 * ONLY place the write can be authored when the instance is unpositioned: the
 * root then publishes only `Base`, which is read-only, so a table has no
 * writable root of its own. The projection serves precisely this case — a
 * `writable: true` edge registers its target in `createShapes` even with no
 * top-level root (message-write-unification §5.1).
 *
 * `writable` is EXPLICIT since layer 13: absent means read-only, which made
 * every walked-to table's create fail at the checker.
 *
 */
export async function describeBase(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
}): Promise<SchemaTypeDescriptor | null> {
  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseName = baseNames.get(input.baseId);
  if (baseName === undefined) return null;
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId: input.baseId,
  });
  return {
    typeId: baseName,
    displayName: baseName,
    fields: [],
    references: tables.map((table) => ({
      fieldId: table.id,
      name: table.name,
      targetTypeId: table.name,
      cardinality: 'many' as const,
      writable: true,
    })),
  };
}

/** A TABLE's node: its fields, and an edge per link field. Both `describe` (by
 *  name) and the walk (by path) land here, so the two can never state
 *  different facts about the same table. */
async function tableDescriptor(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
  tableId: string;
}): Promise<SchemaTypeDescriptor | null> {
  const tables = await cachedTables({
    client: input.client,
    teamId: input.teamId,
    baseId: input.baseId,
  });
  const table = tables.find((t) => t.id === input.tableId);
  if (!table) return null;

  const baseNames = await cachedBases({ client: input.client, teamId: input.teamId });
  const baseName = baseNames.get(input.baseId) ?? input.baseId;

  const fields = table.fields.map(fieldDescriptor);
  const references = table.fields
    .map((field) => referenceDescriptor({ field, baseName, tables }))
    .filter((r): r is SchemaReferenceDescriptor => r !== null);

  const displayName = table.name;
  return {
    // typeId == displayName: the framework's identity for this type is its name.
    typeId: displayName,
    displayName,
    labelTemplate: `{${table.primaryFieldId}}`,
    fields,
    references,
    // A table's rows are removed by `deleteRecord`.
    deletable: true,
    // P2: native uniqueness is never invented for Airtable — identity is
    // the TG layer's concern via author-defined constraints.
    uniquenessConstraints: undefined,
  };
}

/**
 * Describe a type BY NAME — the slow route, and now the last resort rather
 * than the first move. A walk (`edgesFrom`) arrives holding the routing ids,
 * so it never comes through here; this is what answers when a caller has only
 * a name and no path to it.
 *
 * Bases resolve first, off the cheap cached `listBases`. Only a table name
 * pays `loadTableCatalog`'s full workspace walk — the cost this ordering
 * exists to avoid for every base describe.
 */
export async function describe(input: {
  client: AirtableAPIClient;
  teamId: string;
  /** A base's name, or a table's own name within this instance's base. */
  typeId: string;
}): Promise<SchemaTypeDescriptor | null> {
  const baseId = await resolveBaseId({
    client: input.client,
    teamId: input.teamId,
    baseName: input.typeId,
  });
  if (baseId) return describeBase({ client: input.client, teamId: input.teamId, baseId });

  // Recover the routing ids from the name through the private cache — the same
  // first-line lookup every read/write does. An unknown name (drift) → null.
  const catalog = await loadTableCatalog({ client: input.client, teamId: input.teamId });
  const ids = catalog.idsByName.get(input.typeId);
  if (!ids) return null;
  return tableDescriptor({
    client: input.client,
    teamId: input.teamId,
    baseId: ids.baseId,
    tableId: ids.tableId,
  });
}

/** A table's node, reached BY PATH (`edgesFrom`). The position carries
 *  `{baseId, tableId}` because a table is only reachable through its base —
 *  so this costs one `listTables` (usually cached by the base's own hop) and
 *  never the workspace walk that resolving the name would. */
export async function describeTableAt(input: {
  client: AirtableAPIClient;
  teamId: string;
  baseId: string;
  tableId: string;
}): Promise<SchemaTypeDescriptor | null> {
  return tableDescriptor(input);
}

/** Drop a base's cached tables — used after the dev-loop seeds new tables,
 *  or on a stale-schema miss. Exposed for completeness; not on the hot path. */
export function invalidateTableCache(teamId: string, baseId: string): void {
  tableCatalogCache.delete(tableCacheKey(teamId, baseId));
}
