// Airtable TG adapter — implements the translation-graph `Adapter` contract
// for Airtable as a write target plus the reads that support it (P-parity:
// Airtable has a v3 OUTPUT only, so parity = the target/write side). The
// source-trigger side (snapshot/poll) is deferred; the adapter declares no
// triggers and leaves `webhookEventTypeId` undefined.
//
// Lazy-loads team credentials from external_service_credentials and
// constructs the API client on first use, redirecting to fake-channels for
// the dev-loop test-harness team (mirrors Attio).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type {
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  DiscriminableEvent,
  EdgesFromResult,
  EnsureEventSubscriptionInput,
  EventSubscriptionRegistration,
  EventType,
  GetFieldValueInput,
  GetRelatedInput,
  ParentLink,
  RelatedResult,
  ReadInput,
  RemoveEventSubscriptionInput,
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

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { logger } from 'movement-engine/services/logger';
import {
  AirtableAPIClient,
  getAirtableClient,
} from '../../../../adapters/airtable/apiClient';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import {
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
} from 'movement-engine/services/translation_graph/types';
import { BaseAdapter } from '../base';
import { hydrateTargets, targetStubs } from '../hop';
import { stubTargetOf } from 'movement-engine/services/translation_graph/adapter';
import { memoizedResolver, naturalName, type ScopedResolver } from '../name_resolution';
import {
  AIRTABLE_ADAPTER_TYPE,
  airtableAdapterCredsParser,
  type AirtableTableId,
} from './types';
import {
  allTableEntryPoints,
  basesForWalk,
  entryPointsForBase,
  resolveBaseId,
  BASE_META_TYPE,
  TABLE_META_TYPE,
  baseMetaEntryPoint,
  describeBaseMeta,
  describeTableMeta,
  describeRecordChange,
  recordChangeEntryPoint,
  describe as catalogDescribe,
  describeBase,
  describeTableAt,
  cachedTables,
  loadTableCatalog,
  type TableCatalog,
} from './schema_catalog';
import {
  AIRTABLE_EVENT_RECORD_EDGE,
  AIRTABLE_EVENT_RECORD_EDGE_NAME,
  AIRTABLE_EVENT_TYPE_NAME,
  AIRTABLE_SUBSCRIBABLE_EVENTS,
  AIRTABLE_WEBHOOK_RECORD_TYPE,
  airtableChangeTypes,
  airtableEventTypes,
  airtablePingSchema,
  airtableScope,
  eventRecordRef,
  eventsFromPayload,
  type FieldNamesByTable,
} from './webhook';
import {
  resolveEntity as recordResolveEntity,
  getFieldValue as recordGetFieldValue,
  getRelated as recordGetRelated,
  listCollection,
  readRecord as recordReadRecord,
  createRecord as recordCreateRecord,
  updateRecord as recordUpdateRecord,
  deleteRecord as recordDeleteRecord,
} from './record';

export { AIRTABLE_ADAPTER_TYPE } from './types';

/**
 * Static manifest. A full create/update/delete write surface makes it writable;
 * `webhook` triggers light up the source side — a movement fires when records
 * change in a watched (base, table).
 *
 */
export const AIRTABLE_MANIFEST: AdapterManifest = {
  adapterType: AIRTABLE_ADAPTER_TYPE,
  displayName: 'Airtable',
  website: 'https://airtable.com',
  category: 'Spreadsheets',
  description:
    'Airtable. Read your bases, create, update, or delete rows from your ' +
    'movements, and run movements when records change in a table.',
  authoringHints:
    'Each Airtable base holds its own tables, so this connection publishes ' +
    'ONE `Base` collection, not the tables. Reach a base by narrowing it — ' +
    '`-[b:Base WHERE `Name` == "Sales CRM"]->` — or describe it by name ' +
    '(`types: ["Sales CRM"]`); its tables come back as that base\'s edges. To ' +
    'write to a table, start the instance at its base — ' +
    '`airtable(credentials: acme, base: "Sales CRM")` — and the base\'s tables ' +
    'become the types you name, by their own names (`Companies`) — the base is ' +
    'already the instance, so it is not repeated in the name. Without `base:` ' +
    'the instance sits at the whole workspace, where no table is nameable. ' +
    'One base per instance: to reach a second base, construct a second ' +
    'instance.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'resolveEntity', 'getFieldValue',
    'getRelated', 'createRecord', 'updateRecord', 'deleteRecord', 'readRecord',
    'preprocessInbound', 'listEventTypes', 'ensureEventSubscription', 'removeEventSubscription',
  ],
  requiredCredentialType: ExternalServiceType.AIRTABLE,
  triggerKinds: ['AIRTABLE'],
  introspectedSchema: true,
  vocabulary: {
    icon: {
      d: 'M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z',
      fill: true,
    },
  },
  // The change kinds a `listen to <airtable> { events: [...] }` can subscribe
  // to — projected as the `events` listen-config value vocabulary and folded
  // into the external webhook registration's `changeTypes`.
  subscribableEvents: [...AIRTABLE_SUBSCRIBABLE_EVENTS],
  // Airtable webhooks are per-(base, table): two listens on different tables
  // need distinct registrations, so (base, table) joins (adapter, credential)
  // as the subscription-channel identity.
  subscriptionScopeKeys: ['base', 'table'],
  // Entry position: `airtable(credentials: X, base: "MASTER")` starts the
  // instance AT that base, so its tables are the types a movement names. This
  // is the auto-traversal that makes a table nameable — omitted, the instance
  // sits at the workspace root, where the types are the BASES and no table is
  // nameable (naming a table needs a base: by walking to it, or by this).
  // Value enum = the base names, drawn from the `Base` collection off the meta
  // node.
  positionArgs: [{ name: 'base', optionsFrom: BASE_META_TYPE, label: 'Base' }],
  // `base` + `table` are required routing config — a listen must name the
  // watched table; `events` (optional) defaults to all change kinds.
  //
  // They are also the ADDRESS of the table the event's `Record` edge lands on:
  // a listen is shorthand for a WHERE, so naming the table here is what narrows
  // the edge, and the author never restates it in the movement. A two-hop path
  // (base first, then only THAT base's tables) — never a fanout across bases.
  // Both match on `Id` because a listen names by id while type-space addresses
  // by name; `rootHop`/`baseHop` publish `Id` on the members for exactly this.
  listenConfig: [
    { key: 'base', required: true, narrows: { collection: BASE_META_TYPE, matchField: 'Id' } },
    { key: 'table', required: true, narrows: { collection: TABLE_META_TYPE, matchField: 'Id' } },
  ],
  triggerExpectation:
    'A listener watches ONE Airtable table — the base + table named on the ' +
    'listen — with the webhook managed automatically. Airtable notifies that ' +
    'something changed and Listen-Fire pulls the actual changes, so events arrive ' +
    'as record created/updated/deleted for that table, usually within ' +
    'seconds but coalesced by Airtable (rapid edits can land as one batch). ' +
    'Do not promise cross-table or whole-base capture from one listener — ' +
    'each watched table is its own listen.',
};

export class AirtableAdapter extends BaseAdapter {
  readonly adapterType = AIRTABLE_ADAPTER_TYPE;
  /** Bases hold tables: describing every published entry means a `listTables` per base.
   *  So a full-surface describe is refused and the author walks in instead. */
  readonly walksContainers = true;

  readonly supportedTriggers = AIRTABLE_MANIFEST.supportedTriggers;

  /** No synthetic event positions — unstable positions never resolve here. */
  readonly webhookEventTypeId = undefined;

  private apiClient: AirtableAPIClient | null = null;
  private readonly teamId: TeamId;
  private readonly credentialsId: string;
  /** Optional entry position — the `base:` construction arg (a base's name).
   *  When set, the instance enumerates ONLY that base, so introspection is a
   *  single base walk rather than the whole workspace. An unrecognised name
   *  falls back to the full walk (mirrors the catalog's positioned-miss
   *  fallback; the checker warns on the unknown name at author time). */
  private readonly entryBaseName?: string;

  constructor(input: { teamId: TeamId; credentialsId: string; base?: string }) {
    super();
    this.teamId = input.teamId;
    this.credentialsId = input.credentialsId;
    this.entryBaseName = input.base?.trim() || undefined;
  }

  /** Resolve the configured entry-position base name → its id (first match), or
   *  undefined when no `base:` was configured or the name is unknown. */
  private async entryBaseId(): Promise<string | undefined> {
    if (!this.entryBaseName) return undefined;
    const client = await this.getApiClient();
    return resolveBaseId({ client, teamId: this.teamId, baseName: this.entryBaseName });
  }

  // ── Name → structured-identifier cache (THE reference pattern) ───────────
  // The framework names a table only by its pretty `displayName`; the Airtable
  // API routes on `{ baseId, tableId }`. This private catalog is the map
  // between them, memoized per instance from the SAME base/table introspection
  // that lists entry points. Every method that needs to hit the API recovers
  // its ids from the recordType NAME here, on its first line — never by parsing
  // a magic string. Mirrors `resolver()`'s lazy-memoize-and-evict-on-failure.

  private tableCatalogCache?: Promise<TableCatalog>;

  private catalog(): Promise<TableCatalog> {
    if (this.tableCatalogCache === undefined) {
      this.tableCatalogCache = (async () => {
        const client = await this.getApiClient();
        // SCOPED to the entry base when positioned: table names are bare now,
        // so they're unique only within a base. This instance can only name
        // its own base's tables, and this is what makes those names exact.
        const baseId = await this.entryBaseId();
        return loadTableCatalog({
          client,
          teamId: this.teamId,
          ...(baseId !== undefined ? { baseId } : {}),
        });
      })();
      // A failed introspection mustn't poison the instance — drop the cache so
      // the next call retries (mirrors the resolver's eviction policy).
      this.tableCatalogCache.catch(() => {
        this.tableCatalogCache = undefined;
      });
    }
    return this.tableCatalogCache;
  }

  /** Resolve a table's pretty NAME to its `{ baseId, tableId }`, or undefined
   *  when the name isn't a known table (an unknown type — the caller decides
   *  whether that's a graceful empty or a hard error). */
  private async structuredIdFor(name: string): Promise<AirtableTableId | undefined> {
    return (await this.catalog()).idsByName.get(name);
  }

  /** The write/read variant: a name that doesn't resolve is a hard error (the
   *  movement targets a table this connection can't see — drift). */
  private async requireStructuredId(name: string, method: string): Promise<AirtableTableId> {
    const ids = await this.structuredIdFor(name);
    if (!ids) {
      throw new Error(`AirtableAdapter.${method}: unrecognised recordType "${name}".`);
    }
    return ids;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // Positioned at a base (`base:` arg) → that base's tables: the construction
    // already walked the cursor there, so the root's edges ARE its tables.
    // Unpositioned → the polymorphic `Base` edge; naming a table needs a base
    // either way — by walking to it, or by this auto-traversal.
    //
    // The EVENT edge is on both, and behind neither: a listen HANDS you the
    // event position, so naming it must not require having walked to a
    // container. That is the whole of 6_event_positions.md's complaint — the
    // author used to say the base twice (once to construct, once to listen)
    // because the event type was a table, and a table lives behind its base.
    const baseId = await this.entryBaseId();
    if (baseId) {
      const client = await this.getApiClient();
      return [
        recordChangeEntryPoint(),
        ...(await entryPointsForBase({ client, teamId: this.teamId, baseId })),
      ];
    }
    // ONE presentation (4_polymorphic_edges.md, narrowed 2026-07-17): the
    // polymorphic `Base` edge, narrowed by WHERE. The named per-base edges
    // were dropped — they said nothing the narrowable edge doesn't, and a
    // movement should meet "the base called CRM", not a bare proper noun.
    // Costs NOTHING: both entries are static facts, so the unpositioned root
    // no longer even pays its `listBases` here (the walk pays it, once, when
    // someone follows the edge).
    return [recordChangeEntryPoint(), baseMetaEntryPoint()];
  }

  /**
   * The name resolver's type surface: every TABLE this instance may be asked
   * to read or write, by name.
   *
   * Deliberately NOT `listEntryPoints`. The root publishes the author-facing
   * entrance to type-space (the bases); the resolver answers a different
   * question — the engine hands it a table NAME at runtime and it must produce
   * that table's field ids. A base has no fields, so a resolver built from the
   * published entries would map nothing and every write would send display
   * names where Airtable expects field ids.
   *
   * So this is the pre-existing full walk, unchanged and equally cached. The
   * drill-down's win is on the AUTHOR-TIME path (describe), which is where the
   * timeout was; a movement that actually runs against a table was always
   * going to need that table's fields.
   */
  private async tableEntryPoints(): Promise<SchemaEntryPoint[]> {
    const client = await this.getApiClient();
    const baseId = await this.entryBaseId();
    const tables = baseId
      ? await entryPointsForBase({ client, teamId: this.teamId, baseId })
      : await allTableEntryPoints({ client, teamId: this.teamId });
    // The EVENT node rides along. The tables are here because the resolver's
    // real job is name → field id for reads and writes, which a base cannot
    // answer (see the note above) — but the event node is a type the engine
    // ALSO hands this resolver at runtime, when a movement walks the `Record`
    // edge off a `Record Change` position. Leaving it out meant that edge
    // resolved to nothing and was reported as workspace DRIFT, which is a lie:
    // the type is a static fact about the adapter, and describing it costs no
    // call.
    return [recordChangeEntryPoint(), ...tables];
  }

  protected override readonly resolver: ScopedResolver = memoizedResolver({
    listEntryPoints: () => this.tableEntryPoints(),
    describe: (typeRef: string) => this.describe(typeRef),
  });

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // The type is named by its displayName (a base's name, or a table's own
    // name within it), which IS the entry `typeId` — `resolveTypeRef` is a
    // pass-through for a known name and a no-op for anything else; the catalog
    // resolves the name to its ids.
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === BASE_META_TYPE) return describeBaseMeta();
    // The event's `Record` edge lands here before anything says WHICH table —
    // free, like every unnarrowed meta node: its shape is a fact about the
    // adapter, not the workspace.
    if (typeId === TABLE_META_TYPE) return describeTableMeta();
    // The event node, by either name — the entry's typeId or its display name.
    // Costs nothing: an event's shape is a fact about the adapter, not about
    // the workspace, so there is no call to make.
    if (typeId === AIRTABLE_WEBHOOK_RECORD_TYPE || typeId === AIRTABLE_EVENT_TYPE_NAME) {
      return describeRecordChange();
    }
    const client = await this.getApiClient();
    return catalogDescribe({ client, teamId: this.teamId, typeId });
  }

  /**
   * The meta-graph walk: meta → a base → a table → its fields.
   *
   * This is the drill-down. Each hop is ONE upstream call answering exactly
   * what was asked, because the position carries the route: a `Table` position
   * holds its `baseId`, so describing a table never re-walks the workspace to
   * map its name back to `{baseId, tableId}`. That re-derivation — 1 + N calls
   * to describe ONE table — is what `describe` still pays when a caller has
   * only a name, and what a walker never pays.
   *
   * Airtable is the case the model was built for: two bases hold different
   * tables, so they are two TYPES rather than two instances of one, and each
   * gets its own type-edge off the root.
   *
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    const client = await this.getApiClient();

    if (position.recordType === META_RECORD_TYPE) {
      // Positioned at a base (`base:` arg) — the construction already walked
      // us there, so the root's edges ARE that base's tables. Unpositioned,
      // the root's edges are the bases. Same model, different cursor.
      //
      // The EVENT edge rides both, because it belongs to the META node and to
      // no base: a listen hands you the event, so reaching it must not require
      // having walked to a container. `listEntryPoints` publishes it on both
      // branches too — the entry list and the walk are the same node's edges,
      // and must not disagree.
      const baseId = await this.entryBaseId();
      const hop = baseId ? await this.baseHop(baseId) : await this.rootHop();
      return hop ? await this.withTargets(this.withEventEdge(hop)) : hop;
    }

    if (position.recordType === BASE_META_TYPE && position.identity.kind === 'stable') {
      // Mid-walk, a base's tables are traversed AND written: `createRecord`
      // resolves a table by its own name anywhere in the workspace, so the
      // write path is the same one the positioned root offers. For an
      // UNPOSITIONED instance this edge is the only place a row create can be
      // authored at all — the root publishes only the read-only `Base`.
      return this.withTargets(await this.baseHop(position.identity.recordId));
    }

    if (position.recordType === TABLE_META_TYPE && position.identity.kind === 'stable') {
      const baseId = (position.identity.data as { baseId?: string } | undefined)?.baseId;
      if (baseId === undefined) return null;
      const descriptor = await describeTableAt({
        client,
        teamId: this.teamId,
        baseId,
        tableId: position.identity.recordId,
      });
      // A table is a leaf of the META-graph: its link edges lead to other
      // TYPES, but reaching those is `describe`/traversal's business, not a
      // deeper container hop — so no paths on from here. The link targets are
      // STUBBED: naming one means a `getTableColumns` against Airtable, and a
      // wide table links to many.
      return descriptor ? { descriptor, ...targetStubs(descriptor) } : null;
    }

    return null;
  }

  /** The root's edges: the ONE polymorphic `Base` edge, its members riding
   *  `targetPositions` with the path on to each. The named per-base spellings
   *  were dropped from the root (entries and walk agree); narrowing selects a
   *  member and follows its path — same landing, same single fetch. */
  private async rootHop(): Promise<EdgesFromResult> {
    const client = await this.getApiClient();
    const bases = await basesForWalk({ client, teamId: this.teamId });
    return {
      descriptor: {
        typeId: META_RECORD_TYPE,
        displayName: META_RECORD_TYPE,
        fields: [],
        references: [
          // You traverse a base; you never write one. `listEntryPoints`
          // publishes this same edge with the same promises — the entry list
          // and the walk are the same node's edges, and an absent flag here
          // would default to a write claim the entry list denies.
          {
            fieldId: BASE_META_TYPE,
            name: BASE_META_TYPE,
            targetTypeId: BASE_META_TYPE,
            cardinality: 'many' as const,
            writable: false,
          },
        ],
      },
      // The polymorphic edge's MEMBERS — paths without presentation rows
      // (`EdgesFromResult.targetPositions`): each member's `recordType` names
      // the edge it belongs to, its `Name` label names the member.
      targetPositions: Object.fromEntries(
        bases.map((base) => [
          base.id,
          makeStablePosition({
            adapterType: this.adapterType,
            recordType: BASE_META_TYPE,
            recordId: base.id,
            // `Name` addresses it the way a movement does; `Id` addresses it the
            // way a LISTEN does (`base: "appDevLoop"`). Both are published
            // because narrowing evaluates a predicate over this data, and the
            // two surfaces name the same base differently.
            data: { Name: base.name, Id: base.id },
          }),
        ]),
      ),
    };
  }

  /**
   * Add the meta node's EVENT edge to a root hop.
   *
   * It carries no `targetPositions` entry, and that is not an omission: a path
   * is a route to a node that EXISTS, and an event doesn't exist until it
   * fires. So the event node is reached by naming it (`describe('Record
   * Change')`, which costs nothing — an event's shape is a fact about the
   * adapter, not the workspace), never by following a path to an instance.
   *
   */
  /**
   * What each of this hop's edges LANDS ON.
   *
   * Bases and tables are STUBBED: naming one means a `listTables` or a
   * `getTableColumns` against Airtable, and a hop has an edge per container —
   * hydrating would fetch the workspace to answer "what is in here".
   *
   * The EVENT edge is hydrated, because its descriptor is static (no call) and
   * its fields — which base, which table, which action — are exactly what an
   * author needs to write a listener. Stub what is expensive, not everything.
   *
   */
  private async withTargets(hop: EdgesFromResult | null): Promise<EdgesFromResult | null> {
    if (!hop) return null;
    const targetNodes = await hydrateTargets({
      descriptor: hop.descriptor,
      describe: (typeId) => this.describe(typeId),
      stubTarget: (reference) =>
        reference.targetTypeId === AIRTABLE_WEBHOOK_RECORD_TYPE
          ? undefined
          : stubTargetOf({ typeId: reference.targetTypeId }),
    });
    return { ...hop, ...(targetNodes !== undefined ? { targetNodes } : {}) };
  }

  private withEventEdge(hop: EdgesFromResult): EdgesFromResult {
    return {
      ...hop,
      descriptor: {
        ...hop.descriptor,
        references: [
          {
            fieldId: AIRTABLE_WEBHOOK_RECORD_TYPE,
            name: AIRTABLE_EVENT_TYPE_NAME,
            targetTypeId: AIRTABLE_WEBHOOK_RECORD_TYPE,
            cardinality: 'many' as const,
            // You are TOLD of a change; you cannot list the ones that happened,
            // and you cannot write one.
            readable: false,
            writable: false,
            // `fires` IS this edge's promise, and it has to be stated HERE.
            // The entry point declares it (`recordChangeEntryPoint`), but the
            // walk is a separate statement of the same edge — and read/write
            // both being false left the walk saying "no promises", i.e. a dead
            // edge, for the one thing a listener author is looking for.
            fires: true,
          },
          ...hop.descriptor.references,
        ],
      },
    };
  }

  /** One base's edges: its tables, each pathed by `{baseId, tableId}` — the
   *  route a table can't be reached without. Every table edge promises write
   *  (see `describeBase`): creating a row is THE Airtable operation, and it
   *  resolves the table by name however the caller got there. */
  private async baseHop(baseId: string): Promise<EdgesFromResult | null> {
    const client = await this.getApiClient();
    const descriptor = await describeBase({ client, teamId: this.teamId, baseId });
    if (!descriptor) return null;
    return {
      descriptor,
      targetPositions: Object.fromEntries(
        // `describeBase` keys each table edge by its raw tableId — the fieldId
        // the caller looks the path up under.
        descriptor.references.map((reference) => [
          reference.fieldId,
          makeStablePosition({
            adapterType: this.adapterType,
            recordType: TABLE_META_TYPE,
            recordId: reference.fieldId,
            // `baseId` is the ROUTE on (a table can't be fetched without its
            // base — `edgesFrom` reads it back). `Id`/`Name` are how the table
            // is ADDRESSED: by id from a listen (`table: "tblDeals"`), by name
            // from a movement.
            data: { baseId, Id: reference.fieldId, Name: reference.name ?? reference.fieldId },
          }),
        ]),
      ),
    };
  }

  // ── 2. Entity resolution ───────────────────────────────────────────────

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // The engine names the record type / `record` keys / constraint fields by
    // this adapter's NATURAL names. Two first-line translations: (a) the type
    // NAME → its `{ baseId, tableId }` via the structured-id cache (the
    // constraint search needs the routing ids); (b) each `record` key +
    // constraint `field` property-first (`tryFieldId`), else link/edge
    // (`tryEdgeWriteName`), else leave as-is. `recordType` itself STAYS the
    // natural name — the bridge stage matches it against the persisted
    // `external_object_type` label, which is also a name now. Candidate `data`
    // returned by the record layer is already keyed by field display names, so
    // no internal→natural pass is needed on the way out.
    const resolver = await this.resolver({ types: [input.recordType] });
    const naturalTypeName = input.recordType;
    const ids = await this.structuredIdFor(naturalTypeName);

    const renameKey = (field: string): string =>
      resolver.tryFieldId(naturalName(naturalTypeName), naturalName(field)) ??
      resolver.tryEdgeWriteName(naturalName(naturalTypeName), naturalName(field)) ??
      field;

    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.record)) record[renameKey(k)] = v;

    const constraints = {
      any: input.constraints.any.map((branch) => ({
        all: branch.all.map((entry) => ({ ...entry, field: renameKey(entry.field) })),
      })),
    };

    const client = await this.getApiClient();
    return recordResolveEntity({
      client,
      teamId: this.teamId,
      ids,
      resolve: { ...input, record, constraints },
    });
  }

  // ── 3. Field-level access ──────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    // `fieldId` is the NATURAL field name (the field displayName). Airtable's
    // read API returns each record's `fields` keyed by field NAME (the client
    // never sets `returnFieldsByFieldId`), so the position `data` is itself
    // name-keyed — the natural field name IS the lookup key, and no
    // natural→internal-id translation is needed (resolving to a `fld…` id here
    // would miss the name-keyed payload).
    return recordGetFieldValue({ adapterType: this.adapterType, get: input });
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    // The event node's `Record` edge: the row that changed. The event carries
    // the row's id, its table's name and its changed fields, so hydration is a
    // MINT and not a fetch — Attio pays an API call here; Airtable's payload
    // already said everything.
    //
    // Two things used to make this branch dead, and the row that fired a
    // listener was unreachable because of them:
    //
    //   - it compared the RAW `input.fieldId`, which arrives as the edge's
    //     natural name (`Record`) while this dispatches on the id (`record`),
    //     so the names never met. Every other adapter's getRelated resolves
    //     first; this one didn't.
    //   - it required `!isStablePosition`. Event positions are ADDRESSED, and
    //     therefore stable, since `8_event_edges.md` — the guard encoded the
    //     pre-address assumption and rejected every real event.
    //
    // What identifies an event position is that it CARRIES AN EVENT REF, so ask
    // that first: it costs nothing, and it scopes the name resolution to
    // positions whose type genuinely IS the event node. Resolving at the top of
    // `getRelated` instead would drag every other hop — the meta `Base`
    // collection especially — through a type-scoped lookup it was never meant
    // for, and report the miss as drift.
    const event = eventRecordRef(positionData(input.position));
    // The edge arrives under EITHER currency: its natural name (`Record`) from
    // a movement's traversal, or the id (`record`) from a caller that already
    // resolved. Accept both and never throw for a miss — a position carrying an
    // event ref is ours, and the honest answer for anything else is an empty
    // traversal, not drift.
    const namesEventRecordEdge =
      input.fieldId === AIRTABLE_EVENT_RECORD_EDGE ||
      input.fieldId === AIRTABLE_EVENT_RECORD_EDGE_NAME;
    if (input.direction === 'outgoing' && namesEventRecordEdge) {
      // Not one of our event positions — yield nothing rather than guess. An
      // empty traversal is the framework's clean no-op.
      if (!event) return [];
      return [
        {
          position: makeStablePosition({
            adapterType: this.adapterType,
            // The TABLE's name, so field reads resolve against the right table.
            recordType: event.tableName,
            recordId: event.record,
            data: event.fields,
          }),
        },
      ];
    }

    // The `Base` collection off the meta root — the `base:` entry-position
    // options. Each base projects as a stable position labelled by its name, so
    // the catalog can enumerate/validate the `base:` arg (and the author gets a
    // base picker). Intercept before the table-traversal path, which would
    // resolve the meta recordType to no ids and degrade to empty.
    if (
      input.direction === 'outgoing' &&
      input.position.recordType === META_RECORD_TYPE &&
      input.fieldId === BASE_META_TYPE
    ) {
      const client = await this.getApiClient();
      const bases = await client.listBases();
      return bases.map((b) => ({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: BASE_META_TYPE,
          recordId: b.id,
          data: { Name: b.name },
        }),
      }));
    }
    // A COLLECTION hop — the records in a table, reached from a CONTAINER
    // rather than from a record: the root of a base-positioned instance
    // (`at-[c:`Deals`]->`), or a base you traversed to
    // (`-[b:Base WHERE `Name` == "CRM"]->-[c:`Deals`]->`). Both surfaces are
    // published readable, so both must read; before this the first threw (a
    // meta position isn't a record) and the second silently returned nothing.
    // The container supplies the base, which is what makes the bare table name
    // exact — the same rule the whole model runs on.
    const containerBaseId =
      input.position.recordType === META_RECORD_TYPE
        ? await this.entryBaseId()
        : input.position.recordType === BASE_META_TYPE && input.position.identity.kind === 'stable'
          ? input.position.identity.recordId
          : undefined;
    if (input.direction === 'outgoing' && containerBaseId !== undefined) {
      const client = await this.getApiClient();
      const tables = await cachedTables({
        client,
        teamId: this.teamId,
        baseId: containerBaseId,
      });
      const table = tables.find((t) => t.name === input.fieldId);
      // An unknown collection degrades to empty, like every other unresolved
      // name here — the checker owns the author's diagnostic.
      if (!table) return [];
      return listCollection({
        client,
        adapterType: this.adapterType,
        baseId: containerBaseId,
        tableId: table.id,
        tableName: table.name,
      });
    }

    // The UNPOSITIONED root has exactly one collection — `Base`, handled
    // above. Anything else off the meta node is unknown: empty, like every
    // other unresolved name (and never the record path, whose fallback would
    // pay a workspace walk to answer nothing).
    if (input.position.recordType === META_RECORD_TYPE) return [];

    // The position's `recordType` is a NATURAL table name on every hop (the
    // landings this adapter emits stamp the linked table's name too). Recover
    // its `{ baseId, tableId }` from the structured-id cache; an unknown name
    // yields undefined and the record layer degrades to an empty traversal.
    // The catalog's `nameByTableId` lets the record layer NAME the landings it
    // emits. The NATURAL edge name (`fieldId`) resolves directly against the
    // record layer's `fieldMetaByKey` (indexed by both id and name).
    const recordType = input.position.recordType;
    const ids = recordType !== null ? await this.structuredIdFor(recordType) : undefined;
    const catalog = await this.catalog();
    const client = await this.getApiClient();
    return recordGetRelated({
      client,
      teamId: this.teamId,
      adapterType: this.adapterType,
      ids,
      nameByTableId: catalog.nameByTableId,
      get: input,
    });
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  /**
   * Translate a write/update's FIELD names from the engine's NATURAL currency
   * to this adapter's internal `fld…` ids, on the first line of each write
   * method: each `fields` / `evidence` key (field displayName) → internal field
   * id; each parent slot's `edgeName` (the link field's displayName) → its
   * write currency (the link field's id). `recordType` itself STAYS the natural
   * table name — the record layer routes via the structured-id cache, not by
   * decoding a string. (Airtable accepts id-keyed fields, matching the
   * parent-link field the record layer sets by id.)
   */
  private async translateWrite<T extends WriteInput>(input: T): Promise<T> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const naturalTypeName = input.recordType;

    const renameFieldKey = (field: string): string =>
      resolver.tryFieldId(naturalName(naturalTypeName), naturalName(field)) ??
      resolver.tryEdgeWriteName(naturalName(naturalTypeName), naturalName(field)) ??
      field;

    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.fields)) fields[renameFieldKey(k)] = v;

    const evidence = input.evidence
      ? Object.fromEntries(
          Object.entries(input.evidence).map(([k, v]) => [renameFieldKey(k), v]),
        )
      : input.evidence;

    const translateParent = (parent: ParentLink): ParentLink => {
      // The edge name belongs to the FROM (child) side's type — the link field
      // on this record. Resolve against the write's own type. `recordType`
      // stays the parent's natural name (the record layer reads only edgeName +
      // externalId from a parentLink).
      const edgeName =
        resolver.tryEdgeWriteName(naturalName(naturalTypeName), naturalName(parent.edgeName)) ??
        parent.edgeName;
      return { ...parent, edgeName };
    };

    return {
      ...input,
      fields,
      ...(evidence !== undefined ? { evidence } : {}),
      ...(input.parentLinks
        ? { parentLinks: input.parentLinks.map(translateParent) }
        : {}),
    };
  }

  async createRecord(rawInput: WriteInput): Promise<WriteResult> {
    const input = await this.translateWrite(rawInput);
    const ids = await this.requireStructuredId(rawInput.recordType, 'createRecord');
    const client = await this.getApiClient();
    return recordCreateRecord({ client, teamId: this.teamId, ids, write: input });
  }

  async updateRecord(rawInput: UpdateInput): Promise<UpdateResult> {
    const input = await this.translateWrite(rawInput);
    const ids = await this.requireStructuredId(rawInput.recordType, 'updateRecord');
    const client = await this.getApiClient();
    return recordUpdateRecord({ client, teamId: this.teamId, ids, update: input });
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    // `recordType` is the NATURAL table name — recover its routing ids from the
    // structured-id cache; an unknown table is a hard error.
    const ids = await this.requireStructuredId(input.recordType, 'deleteRecord');
    const client = await this.getApiClient();
    return recordDeleteRecord({ client, ids, del: input });
  }

  // ── 6. No-op detection read ─────────────────────────────────────────────

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    // `recordType` is the NATURAL table name — recover its routing ids from the
    // structured-id cache. An unknown table reads as "nothing here" (null).
    const ids = await this.structuredIdFor(input.recordType);
    if (!ids) return null;
    const client = await this.getApiClient();
    return recordReadRecord({ client, ids, read: input });
  }

  // ── 7. Inbound webhook triggers (notify-then-pull) ───────────────────────
  // Airtable pings us with only ids (`{ base, webhook }`); the actual changes
  // are PULLED from the webhook's payload feed. `preprocessInbound` is the I/O
  // half of the shared inbound seam — drain the feed from the persisted cursor,
  // split each payload into per-record events, return the advanced cursor as the
  // checkpoint the handler persists. The registration + signature halves live on
  // `ensureEventSubscription`/`removeEventSubscription` + the webhook_sync
  // provider; pure parsing lives in `./webhook`.

  async preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }> {
    const ping = airtablePingSchema.safeParse(input.raw);
    if (!ping.success) return { events: [] };
    const { base, webhook } = ping.data;
    const client = await this.getApiClient();

    // The base's `fieldId → name` maps, so changed cell values (Airtable keys
    // them by field id) become name-keyed record data the movement reads by
    // natural field name. A metadata failure degrades to id-keyed data rather
    // than dropping the delivery.
    const fieldNamesByTable: FieldNamesByTable = new Map();
    // …and each table's display NAME, off the same metadata — the row position's
    // type, so the event's `Record` edge names the row without a second lookup.
    const tableNamesById = new Map<string, string>();
    try {
      const tables = await cachedTables({ client, teamId: this.teamId, baseId: base.id });
      for (const table of tables) {
        const byId = new Map<string, string>();
        for (const f of table.fields) byId.set(f.id, f.name);
        fieldNamesByTable.set(table.id, byId);
        tableNamesById.set(table.id, table.name);
      }
    } catch (err) {
      logger.warn('[AirtableAdapter.preprocessInbound] table metadata unavailable — emitting id-keyed fields', {
        teamId: this.teamId,
        baseId: base.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Drain from the persisted cursor (default 1 = from the webhook's start).
    // The page loop is bounded so a misbehaving feed can't spin forever; the
    // handler persists the returned cursor only after the batch dispatches.
    let cursor = typeof input.checkpoint === 'number' ? input.checkpoint : 1;
    const events: DiscriminableEvent[] = [];
    const MAX_PAGES = 1000;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.listPayloads({ baseId: base.id, webhookId: webhook.id, cursor });
      for (const payload of result.payloads) {
        events.push(
          ...eventsFromPayload({ payload, fieldNamesByTable, baseId: base.id, tableNamesById }),
        );
      }
      cursor = result.cursor;
      if (!result.mightHaveMore) break;
    }
    return { events, checkpoint: cursor };
  }

  async listEventTypes(): Promise<EventType[]> {
    return airtableEventTypes();
  }

  // ── Event subscriptions (the listen-reconciliation seam) ─────────────────
  // REAL provisioning against Airtable's per-base webhook API, scoped to one
  // table via `recordChangeScope`. Airtable has no PATCH for a webhook's
  // filters, so a changed event set is a delete-then-recreate (the secret is
  // re-issued, which is fine — the reconciler persists whatever comes back).

  async ensureEventSubscription(
    input: EnsureEventSubscriptionInput,
  ): Promise<EventSubscriptionRegistration | undefined> {
    const scope = airtableScope(input.scope);
    if (!scope) return undefined;
    const client = await this.getApiClient();
    const changeTypes = airtableChangeTypes(input.events);

    if (input.current?.externalId !== undefined) {
      const unchanged =
        input.current.events.length === input.events.length &&
        input.current.events.every((e) => input.events.includes(e));
      if (unchanged) return undefined;
      // Recreate with the new selection — drop the superseded webhook first so
      // we don't leak registrations (best-effort; a stale one expires anyway).
      await client.deleteWebhook({ baseId: scope.base, webhookId: input.current.externalId }).catch((err) => {
        logger.warn('[AirtableAdapter] failed to delete superseded webhook before recreate', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const created = await client.createWebhook({
      baseId: scope.base,
      notificationUrl: input.callbackUrl,
      tableId: scope.table,
      changeTypes,
    });
    // macSecretBase64 is issued ONLY here — persist it as the inbound HMAC key.
    return { externalId: created.webhookId, secret: created.macSecretBase64 };
  }

  async removeEventSubscription(input: RemoveEventSubscriptionInput): Promise<void> {
    if (input.externalId === undefined) return;
    const scope = airtableScope(input.scope);
    if (!scope) return;
    const client = await this.getApiClient();
    await client.deleteWebhook({ baseId: scope.base, webhookId: input.externalId });
  }

  /**
   * Extend a registered webhook's 7-day expiry. Airtable disables inactive
   * webhooks after 7 days; an inbound delivery (which pulls payloads) already
   * extends the window, so only quiet webhooks need this — driven by the
   * airtable_webhook_refresh worker. Not on the `Adapter` interface (Airtable
   * is the only source that expires); the worker calls it on the concrete type.
   */
  async refreshEventSubscription(input: {
    externalId: string;
    scope: Record<string, string>;
  }): Promise<void> {
    const scope = airtableScope(input.scope);
    if (!scope) return;
    const client = await this.getApiClient();
    await client.refreshWebhook({ baseId: scope.base, webhookId: input.externalId });
  }

  // ── Internal: lazy API client construction ──────────────────────────────

  private async getApiClient(): Promise<AirtableAPIClient> {
    if (this.apiClient) return this.apiClient;

    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', this.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', this.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Airtable credentials ${this.credentialsId} not found for team ${this.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
      );
    }

    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch (err) {
      logger.error('[AirtableAdapter] credential payload is not valid JSON', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Airtable credentials ${row.id} are malformed (not valid JSON).`);
    }

    // Route dev-loop team traffic to fake-channels (mirrors Attio). Without
    // this branch the adapter hits real Airtable and 401s on the seeded
    // stub token.
    const rawPayload = isTestHarnessTeam(this.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'AIRTABLE')
      : payload;

    const parsed = airtableAdapterCredsParser.safeParse(rawPayload);
    if (!parsed.success) {
      logger.error('[AirtableAdapter] credential payload failed validation', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: parsed.error.message,
      });
      throw new Error(`Airtable credentials ${row.id} are malformed (${parsed.error.message}).`);
    }

    this.apiClient = getAirtableClient(row.id, parsed.data);
    return this.apiClient;
  }
}

export function createAirtableAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
  /** The `base:` construction arg — a base's name to scope the instance to
   *  (optional; default is the full workspace). */
  base?: string;
}): AirtableAdapter {
  if (!input.credentialsId) {
    throw new Error(
      'Airtable adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  return new AirtableAdapter({
    teamId: input.teamId,
    credentialsId: input.credentialsId,
    ...(input.base !== undefined ? { base: input.base } : {}),
  });
}
