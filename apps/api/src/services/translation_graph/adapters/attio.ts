// Attio adapter — implements the translation-graph Adapter contract for Attio
// as both source and target. Lazy-loads team credentials from
// external_service_credentials and constructs the API client on first use.
//
// Scope (v0): introspection (listEntryPoints + describe), entity resolution against
// linked_objects, record reads/writes. Snapshot/poll/changes-feed and
// getRelated are deferred — declared in their absence so the engine fails
// loudly when something not-yet-built is invoked.

import { Readable } from 'node:stream';

import { LRUCache } from 'lru-cache';
import { z } from 'zod';

import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type { AttioRecord } from '../../../adapters/attio/apiClient';
import type { AttioAttribute } from '../../../adapters/attio/interface';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { SnapshotInput } from 'movement-engine/services/translation_graph/adapter';
import type {
  ActorCandidate,
  ActorIdentity,
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  DiscriminableEvent,
  EnsureEventSubscriptionInput,
  EventSubscriptionRegistration,
  EventType,
  RemoveEventSubscriptionInput,
  FilterTranslationResult,
  GetFieldValueInput,
  FileRef,
  GetRelatedInput,
  LinkRecordsInput,
  LinkRecordsResult,
  UnlinkRecordsInput,
  UnlinkRecordsResult,
  RelatedPage,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  ReadInput,
  ResolveFileRefResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
  LinkedObjectCandidate,
} from 'movement-engine/services/translation_graph/adapter';
import type { UniquenessConstraints } from 'movement-engine/services/translation_graph/uniqueness';

import type { Expression } from '#shared/expression/types';
import { decryptToken } from '../../../lib/credentials';
import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from 'movement-engine/services/logger';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../lib/recording';
import { streamFileRef } from '../engine/files/retrieve';

import {
  attioCredsParser,
  getAttioClient,
} from '../../../adapters/attio/apiClient';


import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';


import { fileHandle, isFileValue, iterateRelatedPages, ownedFileSource, writeParentLinks, type ParentAssociation } from 'movement-engine/services/translation_graph/adapter';
import { BaseAdapter } from './base';
import { stubTargetOf, type EdgesFromResult } from 'movement-engine/services/translation_graph/adapter';
import { uniformWalk } from './hop';
import { UPDATE_NOT_FOUND, isHttp404 } from './not_found';
import { naturalName } from './name_resolution';


import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  isStablePosition,
  makeStablePosition,
  makeUnstablePosition,
  positionData,
  positionRecordId,
  type SchemaEntryPoint,
  type SchemaFieldDescriptor,
  type SchemaFieldKind,
  type SchemaReferenceDescriptor,
  type SchemaTypeDescriptor,
  type SourcePosition,
} from 'movement-engine/services/translation_graph/types';

import type { EdgeCapability, FieldCapability } from '#shared/expression/types';

// ── Inbound webhook envelope (consumed by `preprocessInbound`) ──────────────
// Attio represents actors as `{ id, type }` (workspace-member | api-token |
// system); we normalize into the framework's uniform actor shape. The signature
// + registration halves of the webhook contract stay on the webhook_sync
// provider; only event EXTRACTION lives here.
const attioWebhookActorSchema = z
  .object({
    id: z.string().nullable(),
    type: z.enum(['workspace-member', 'api-token', 'system']),
  })
  .optional();

const attioWebhookBodySchema = z.object({
  webhook_id: z.string(),
  events: z.array(
    z.object({
      event_type: z.string(),
      id: z.object({
        workspace_id: z.string(),
        object_id: z.string(),
        record_id: z.string(),
        attribute_id: z.string().optional(),
      }),
      actor: attioWebhookActorSchema,
    }),
  ),
});

function normalizeAttioActor(
  raw: z.infer<typeof attioWebhookActorSchema>,
): { type: 'user' | 'api-token' | 'system'; id: string | null } | undefined {
  if (!raw) return undefined;
  const type = raw.type === 'workspace-member' ? 'user' : raw.type;
  return { type, id: raw.id };
}

function attioChangeType(eventType: string): 'create' | 'update' | 'delete' | undefined {
  if (eventType.includes('created')) return 'create';
  if (eventType.includes('updated')) return 'update';
  if (eventType.includes('deleted')) return 'delete';
  return undefined;
}

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const ATTIO_ADAPTER_TYPE = 'attio';

/**
 * Synthetic schema constants for modeling Attio lists as first-class
 * entities in the source graph. Lists are the natural way to scope
 * snapshots ("all companies in this list"); modeling them as nodes with a
 * record→list edge lets that scope be expressed via the uniform expression
 * language (`EXISTS(-[__list_membership where list.name = 'X']->)`)
 * instead of a canned adapter-specific predicate.
 */
export const ATTIO_LIST_TYPE_ID = 'attio:list';
export const ATTIO_LIST_MEMBERSHIP_FIELD = '__list_membership';
/** The REQUIRED body field that names the target list on a
 *  `write <record>-[:Lists]->`. Published as a write-only `enum` whose options
 *  are the workspace's list names (from the warm `/v2/lists` catalog), so a
 *  typo'd list dies at the checker (`MOV_ENUM_UNKNOWN_VALUE` + did-you-mean)
 *  and a missing value is the checker's required-field error — a create NAMES
 *  its target (it doesn't filter it with a WHERE, which the engine drops before
 *  the adapter runs). */
export const ATTIO_LIST_NAME_FIELD = 'listName';

/** The polymorphic edge from a record to the lists it can join. Its NAME is
 *  what its members are addressed by (`membersOf` matches a member position's
 *  `recordType` against the edge name), so it is a constant rather than a
 *  literal repeated at both ends. */
export const ATTIO_LISTS_EDGE = 'Lists';

/**
 * Per-object list-membership write target. Each object's `Lists` edge lands on
 * ITS OWN membership type, so the `listName` enum + discriminated variants are
 * filtered to the lists THAT object can join (layer 12: honest by construction —
 * a list a record can't join is not representable, never a filter step that can
 * be skipped). The generic `ATTIO_LIST_TYPE_ID` stays for the event edge only.
 * The id carries the object's slug (the key `parentObjectSlugs` are stated in);
 * the display name mirrors Affinity's `<Thing> List`.
 */
export const ATTIO_LIST_MEMBERSHIP_PREFIX = 'attio:list-membership:';
function listMembershipTypeId(obj: { slug: string | null; id: string }): string {
  return ATTIO_LIST_MEMBERSHIP_PREFIX + (obj.slug ?? obj.id);
}
function listMembershipDisplayName(obj: { name: string }): string {
  return `${obj.name} List`;
}

/**
 * Synthetic schema constants for the webhook event source position. The
 * trigger router constructs `webhook-event` SourcePositions when
 * dispatching inbound events; the TG body operates over the event's
 * payload via these field paths.
 *
 * Per-target meta-edges: `attio:webhook_event` exposes one outgoing
 * reference per Attio object, named after the object's display name
 * (`Companies`, `People`, …) and targeted at the matching record type.
 * Traversal `-[:Companies]->.HQ` resolves the underlying record by
 * fetching from `companies` when `id.object_id` agrees; on a mismatch
 * the edge yields no related positions (the event isn't for that type).
 * Replaces the earlier single polymorphic `record_for_event` ref —
 * polymorphism collapses to "which edge you traverse."
 *
 */
export const ATTIO_WEBHOOK_EVENT_TYPE_ID = 'attio:webhook_event';

/**
 * Edge ids on `attio:webhook_event` for non-record meta types. The
 * outboundName matches one of these constants; the runtime dispatcher
 * and the editor agree on the canonical strings here so the cascade
 * stays stable across renames.
 *
 *   - `List`  : list-entry events → the parent list (read-only props
 *               of the list itself, e.g. its name)
 *   - `Entry` : list-entry events → the entry within the list, with
 *               its parent record id and per-attribute values
 *   - `Task`  : task events → the task with its content + deadline
 *   - `Note`  : note events → the note with title + content
 *   - `Comment`: comment events → the comment with content + resolved
 *                state
 */
export const ATTIO_LIST_FOR_EVENT_FIELD = 'List';
export const ATTIO_ENTRY_FOR_EVENT_FIELD = 'Entry';
export const ATTIO_TASK_FOR_EVENT_FIELD = 'Task';
export const ATTIO_NOTE_FOR_EVENT_FIELD = 'Note';
export const ATTIO_COMMENT_FOR_EVENT_FIELD = 'Comment';

/** Synthetic target-type ids for the non-record meta-edges above.
 *  Adapter-internal — mirrored in the schema descriptor and consumed
 *  by `getRelated` when materializing positions. */
export const ATTIO_TASK_TYPE_ID = 'attio:task';
export const ATTIO_NOTE_TYPE_ID = 'attio:note';
export const ATTIO_COMMENT_TYPE_ID = 'attio:comment';
export const ATTIO_LIST_ENTRY_TYPE_ID = 'attio:list_entry';
/** Synthetic target type for the `files` reference — one position per
 *  file-shaped value scanned out of a record's attribute envelope. Each
 *  position's `File` field returns a `FileRef` descriptor `resolveFileRef`
 *  redeems from Attio (symmetric with the file-on-write path). */
export const ATTIO_FILE_TYPE_ID = 'attio:file';
/** Outgoing reference name a record publishes for its attached files —
 *  `record-[:Files]->.\`File\``. The reference `fieldId` IS the read currency,
 *  so it doubles as the `getRelated` edge id. Mirrors slack's `Files` edge. */
export const ATTIO_FILES_REFERENCE = 'files';
/** Its NATURAL name — Title Case, the one convention across every adapter
 *  surface (Affinity publishes the same concept as `Files`). */
export const ATTIO_FILES_REFERENCE_NAME = 'Files';

/**
 * System entry metadata fields on an Attio list entry — distinct from
 * the list's *custom* attributes (`/v2/lists/<id>/attributes`), which
 * never include these. `created_at` ("Added to list at") is the moment
 * the record was added to the list. It is read-only (the system stamps
 * it) but perfectly READABLE — so it's a valid `within` recency key. We
 * surface it on every per-list synthetic type and on the generic
 * list-entry meta type. The slug matches what the `/v2/lists/<id>/
 * entries/query` filter API accepts, so a `within` filter built off it
 * is dispatch-correct.
 */
// list-entry `within` recency key
const ATTIO_ENTRY_ADDED_AT_SLUG = 'created_at';
const ATTIO_ENTRY_SYSTEM_DATE_FIELDS: SchemaFieldDescriptor[] = [
  {
    fieldId: ATTIO_ENTRY_ADDED_AT_SLUG,
    displayName: 'Added to list at',
    kind: 'date',
    writable: false,
    required: false,
    cardinality: 'one',
    capability: attioFieldCapability('date', false),
  },
];

/**
 * System metadata date on an Attio *record* (an object type's row) —
 * distinct from the object's custom attributes (`/v2/objects/<id>/
 * attributes`). Attio stamps `created_at` on every record at creation;
 * it is read-only but perfectly READABLE, so it's a valid `within`
 * recency key (e.g. "don't make a new Deal if one already exists in the
 * last 6 months"). The object-attributes endpoint does not reliably
 * surface it as a regular attribute, so — mirroring the list-entry
 * `Added to list at` fix — we inject it onto every record descriptor.
 * The slug `created_at` is what the `/v2/objects/<id>/records/query`
 * filter API accepts, so a `within` filter built off it is
 * dispatch-correct.
 */
// object `within` recency key
const ATTIO_RECORD_CREATED_AT_SLUG = 'created_at';
const ATTIO_RECORD_SYSTEM_DATE_FIELDS: SchemaFieldDescriptor[] = [
  {
    fieldId: ATTIO_RECORD_CREATED_AT_SLUG,
    displayName: 'Created At',
    kind: 'date',
    writable: false,
    required: false,
    cardinality: 'one',
    capability: attioFieldCapability('date', false),
  },
];

/**
 * Map from clean schema-field names on `attio:webhook_event` to the
 * raw Attio payload paths they read. Keeps the schema descriptor
 * speaking to the user (`Object`) while the adapter stays compatible
 * with Attio's underlying event shape (`id.object_id`).
 *
 * This is the exhaustive set of webhook-event fields the adapter
 * provides — anything not listed here is rejected at read time so a
 * mis-typed root (e.g. a Listen-Fire Valuations event landing on an
 * `attio:webhook_event` root) can't smuggle foreign fields through.
 */
const WEBHOOK_FIELD_TO_PAYLOAD_PATH: Record<string, string> = {
  event_type: 'event_type',
  Workspace: 'id.workspace_id',
  Object: 'id.object_id',
  Record: 'id.record_id',
  List: 'id.list_id',
  Entry: 'id.entry_id',
  Task: 'id.task_id',
  Note: 'id.note_id',
  Comment: 'id.comment_id',
  Attribute: 'id.attribute_id',
};

/**
 * Adapter-internal native filter — the result of `translateFilter` over a
 * user-authored filter Expression. The framework treats it as opaque
 * (`unknown` on the SnapshotInput.filter field); only this adapter knows
 * how to interpret it.
 *
 * - `all`: no filter — enumerate every record of the entry's object type
 * - `list`: enumerate records belonging to a specific Attio list (by id)
 *
 * New patterns get added here as `translateFilter` learns to recognize
 * more expression shapes.
 */
type AttioNativeFilter =
  | { kind: 'all' }
  | { kind: 'list'; listId: string }
  // A records-query filter body (`{slug: {$eq: v}, …}`) pushed from a hop
  // WHERE so the collection snapshot hits Attio's filtered query API instead of
  // paging every record (chunk 7). The engine still satisfies the full
  // predicate via the shared unit, so this only ever needs to NOT under-fetch.
  | { kind: 'records'; filter: Record<string, unknown> };

const SNAPSHOT_PAGE_SIZE = 500;

/** A page whose items may be produced lazily, as they are read. */
interface LazyRelatedPage {
  items: Iterable<RelatedResult> | AsyncIterable<RelatedResult>;
  nextCursor?: number;
}

/** One page of a snapshot; `events` may be lazy (list entries hydrate their
 *  parent record per event read). */
interface SnapshotPage {
  events: Iterable<TriggerEvent> | AsyncIterable<TriggerEvent>;
  nextOffset?: number;
}

/** Where the next snapshot page starts, given this page's offset and size —
 *  absent once a short page says the collection is exhausted. */
function nextSnapshotOffset(offset: number, pageLength: number): { nextOffset?: number } {
  return pageLength < SNAPSHOT_PAGE_SIZE ? {} : { nextOffset: offset + pageLength };
}

/** The offset an `iterateRelatedPage` cursor names. Attio's cursor is the
 *  record offset it minted; anything else did not come from this adapter. */
function attioPageOffset(cursor: unknown): number {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) return cursor;
  throw new Error(`AttioAdapter.iterateRelatedPage: unrecognised page cursor ${JSON.stringify(cursor)}.`);
}
/** GET /v2/notes caps `limit` at 50 (unlike tasks' 500). */
const NOTES_PAGE_SIZE = 50;
/** GET /v2/threads caps `limit` at 50, same as notes. */
const THREADS_PAGE_SIZE = 50;

type AttioApiClient = Awaited<ReturnType<typeof getAttioClient>>;

/**
 * In-memory lookup catalog for Attio objects, keyed by team.
 * Populated as a side effect of `warmCatalogs`; consumed by a future
 * `narrowReferenceType` (kept warm so narrowing needs no per-call API
 * round trip) and by `describeOpaqueId` for object-id → name resolution.
 * The contract relies on the catalog being warmed before narrowing is
 * invoked — engine paths reach this via `describe(typeId)` first.
 */
type AttioObjectInfo = { id: string; name: string; slug: string | null };
const objectCatalogCache = new LRUCache<string, Map<string, AttioObjectInfo>>({
  max: 50,
  ttl: 10 * 60 * 1000,
});

/**
 * Per-team list catalog keyed by team. Populated as a side effect of
 * `warmCatalogs`; consumed by `describe` (lazy per-list field fetch),
 * `getRelated` (per-list traversal), and `createRecord` (per-list
 * child writes) — all of which need to map a list name back to its
 * id + parent_object without firing another `/v2/lists` call.
 */
type AttioListInfo = {
  id: string;
  name: string;
  /** Object slugs this list scopes to. Empty list means the list is
   *  unscoped or Attio omitted the field. */
  parentObjectSlugs: string[];
  apiSlug: string | null;
};
const listsCache = new LRUCache<string, AttioListInfo[]>({
  max: 50,
  ttl: 10 * 60 * 1000,
});

/**
 * Per-list attribute cache. Populated lazily by `describeType` when
 * the editor first needs a list's fields. Repeated reads through the
 * 10-minute TTL avoid hammering `/v2/lists/{id}/attributes`.
 */
const listAttributesCache = new LRUCache<string, AttioAttribute[]>({
  max: 200,
  ttl: 10 * 60 * 1000,
});

/**
 * Per-attribute enum option cache. Attio serves select options and
 * status values from dedicated endpoints (`/options`, `/statuses`) —
 * never inline on the attributes list — so descriptor builds fetch them
 * per select/status attribute. Keyed by object/list id + attribute id;
 * both are workspace-unique UUIDs in real Attio so no team scoping is
 * needed.
 */
const attributeOptionsCache = new LRUCache<string, { id: string; name: string }[]>({
  max: 500,
  ttl: 10 * 60 * 1000,
});

/**
 * Enrich select/status attributes with their option values so the
 * descriptor can surface `enumValues` — the extraction entity guide
 * (EXTRACT_VALUE) depends on them to show the LLM a field's allowed
 * values. A failed fetch degrades that attribute to an option-less
 * enum rather than failing the whole describe.
 */
async function withAttributeOptions(
  client: AttioApiClient,
  scope: { objectId?: string; listId?: string },
  attrs: AttioAttribute[],
): Promise<AttioAttribute[]> {
  return Promise.all(
    attrs.map(async (attr) => {
      if (attr.type !== 'select' && attr.type !== 'status') return attr;
      if (attr.options) return attr;
      const cacheKey = `${scope.objectId ?? scope.listId}:${attr.id}`;
      let options = attributeOptionsCache.get(cacheKey);
      if (!options) {
        try {
          options =
            attr.type === 'select'
              ? await client.listAttributeOptions({ ...scope, attributeId: attr.id })
              : await client.listStatuses({ ...scope, attributeId: attr.id });
          attributeOptionsCache.set(cacheKey, options);
        } catch (err) {
          logger.warn('[AttioAdapter] failed to fetch attribute options', {
            attributeId: attr.id,
            attributeName: attr.name,
            type: attr.type,
            error: err instanceof Error ? err.message : String(err),
          });
          return attr;
        }
      }
      return { ...attr, options };
    }),
  );
}

/**
 * Synthetic outgoing references attached to every record type — Notes,
 * Tasks, Comments. Attio's real model lives the OTHER direction (Notes
 * carry parent_object + parent_record_id) but surfacing them as
 * outgoing-from-record refs gives the right TG-editor hierarchy
 * ("Companies has Notes") without polymorphic narrowing.
 *
 * `writable: true` is the edge-anchored create fact (the messaging
 * adapters' shape): `write record-[:Notes]->` creates the child AND its
 * attachment in one statement — which is the ONLY way these types are
 * created (a parentless create throws in the adapter), so the create
 * capability lives on this edge, never on a root collection (rule 0).
 */
const ATTACHABLE_TO_RECORDS: SchemaReferenceDescriptor[] = [
  { fieldId: 'Notes', targetTypeId: ATTIO_NOTE_TYPE_ID, cardinality: 'many', writable: true },
  { fieldId: 'Tasks', targetTypeId: ATTIO_TASK_TYPE_ID, cardinality: 'many', writable: true },
  { fieldId: 'Comments', targetTypeId: ATTIO_COMMENT_TYPE_ID, cardinality: 'many', writable: true },
];

/**
 * The LIST-ENTRY spelling of the attachables: an entry can READ its parent
 * record's notes/tasks and its own entry-scoped comments, but the adapter's
 * create path resolves parent links to an OBJECT record only — so from an
 * entry these edges are read-only for now. (POST /v2/comments does accept an
 * entry target; wiring the entry-parented create is recorded in plan 9, not
 * smuggled in here.)
 */
const ATTACHABLE_READS_FROM_ENTRIES: SchemaReferenceDescriptor[] = ATTACHABLE_TO_RECORDS.map(
  // Drop the write promise: absent IS the read-only fact now (layer 13).
  ({ writable: _writable, ...ref }) => ref,
);

/**
 * The up-hop from a list entry to the record it sits on. An entry's parent is
 * polymorphic over the workspace's objects, so — mirroring the webhook-event
 * per-object edges — we publish one edge per candidate object (named by the
 * object's display name), optionally scoped to the objects a specific list
 * attaches to. A traversal resolves only when the entry's `parent_object`
 * matches that edge's object; every other object edge yields `[]`
 * (`getRecordForListEntry`). `requiresLiveRecord`: the parent record must
 * still exist to hydrate, so it's excluded from the `delete` action variant.
 */
function recordBackEdges(
  objects: AttioObjectInfo[],
  scopeSlugs?: string[],
): SchemaReferenceDescriptor[] {
  const scoped =
    scopeSlugs && scopeSlugs.length > 0
      ? objects.filter((o) => o.slug != null && scopeSlugs.includes(o.slug))
      : objects;
  return scoped.map((obj) => ({
    fieldId: obj.name,
    targetTypeId: obj.name,
    cardinality: 'one' as const,
    requiresLiveRecord: true,
  }));
}

/**
 * Match a record-reference attribute against an edge name in ANY currency it
 * can arrive in:
 *   • the attribute's TITLE — the reference's `name`, hence the natural edge
 *     name AND (per `adapterNameResolver`) the write currency
 *     `parentLink.edgeName` / `linkRecords.edgeName` resolve to;
 *   • the api slug — the reference `fieldId` (the read currency), still what
 *     an unresolved/pass-through name carries;
 *   • the attribute UUID — the same fallback `fieldId` uses when a slug is
 *     absent.
 */
function matchesReferenceAttribute(attr: AttioAttribute, edge: string): boolean {
  return (
    attr.type === 'record-reference' &&
    (attr.name === edge || attr.apiSlug === edge || attr.id === edge)
  );
}

// ── Meta-type builders ──
// Each returns the static descriptor for a synthetic Attio meta type
// (Note, Task, Comment, generic List, generic List Entry, Webhook
// Event). Adapter dispatches to these from `describe(typeId)` so the
// editor gets a complete shape for any type the user navigates into,
// without the cost of bundling them into the eager descriptor.

/**
 * The list-membership write/read target. Unscoped (`scope` absent) it is the
 * generic `List` (ALL lists) — used only by the event edge now. Scoped to an
 * object it is that object's own membership type, its `listName` enum AND
 * discriminated variants FILTERED to the lists the object can join
 * (`parentObjectSlugs`), so the honesty is structural — the wrong lists aren't
 * in the type (layer 12).
 */
function describeListMeta(
  lists: AttioListInfo[],
  scope?: { typeId: string; displayName: string; objectSlug: string },
): SchemaTypeDescriptor {
  const joinable = scope
    ? lists.filter((l) => l.parentObjectSlugs.includes(scope.objectSlug))
    : lists;
  return {
    typeId: scope?.typeId ?? ATTIO_LIST_TYPE_ID,
    displayName: scope?.displayName ?? 'List',
    fields: [
      { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
      { fieldId: 'id', displayName: 'ID', kind: 'string', writable: false, required: false },
      // The target-list selector for `write <record>-[:Lists]-> { listName: … }`.
      // REQUIRED (there is no default list) and WRITE-ONLY (you read a list by
      // its `Name`; `listName` only ever names the create's target). An `enum`
      // over the joinable list names, so a typo is a checker error, not a
      // runtime one — a create NAMES its target with a required enum, it does
      // not filter it with a WHERE.
      {
        fieldId: ATTIO_LIST_NAME_FIELD,
        displayName: ATTIO_LIST_NAME_FIELD,
        kind: 'enum',
        enumValues: joinable.map((l) => l.name),
        writable: true,
        readable: false,
        required: true,
        description: scope
          ? `Which list to add this ${scope.displayName.replace(/ List$/, '').toLowerCase()} record to — one of its lists.`
          : 'Which list to add the record to — one of the workspace\'s list names.',
      },
    ],
    references: [],
    // The list-membership write is a DISCRIMINATED UNION: `listName`'s literal
    // decides which per-list entry values are valid (VC Deal Flow carries
    // `Stage`, Pipeline carries none). Each list name maps to its own per-list
    // type, whose already-described write shape IS that variant. Enum options
    // (above) and these variant keys are BOTH `joinable` names — the same
    // catalog — so a literal can never enum-check-pass yet variant-select-fail.
    // The host projection composes the variants (no new fanout: the per-list
    // types are described in the same pass).
    discriminatedWrite: {
      discriminant: ATTIO_LIST_NAME_FIELD,
      variantTypes: Object.fromEntries(joinable.map((l) => [l.name, l.name])),
    },
  };
}

function describeListEntryMeta(): SchemaTypeDescriptor {
  return {
    typeId: ATTIO_LIST_ENTRY_TYPE_ID,
    displayName: 'List Entry',
    labelTemplate: 'List Entry — {listId}',
    fields: [
      { fieldId: 'parent_record_id', displayName: 'Parent Record ID', kind: 'string', writable: false, required: false },
      ...ATTIO_ENTRY_SYSTEM_DATE_FIELDS,
    ],
    // The GENERIC list entry is the union of all per-list types. Its members'
    // parent up-hops are distinctly named and differ per list, so their
    // INTERSECTION is empty (layer 11) — the generic publishes NO parent
    // up-hop. You reach the parent by narrowing to a list: the webhook event's
    // per-list entry edge lands the per-list type, which carries its one real
    // parent. Only the genuinely-universal attachable reads survive here (every
    // entry can carry notes/tasks/comments). Nothing targets this type anymore
    // (the per-list edges replaced the single `Entry` hop); it remains as the
    // by-name/sentinel describe.
    references: [...ATTACHABLE_READS_FROM_ENTRIES],
  };
}

// Task / Note / Comment write semantics: these create as CHILD ACTIONS of a
// record write (the parent link supplies the record they attach to — Attio's
// linked_records / parent_object / record target). Writable fields mirror
// exactly what POST /v2/tasks, /v2/notes and /v2/comments accept; everything
// else stays read-only. Kept in lockstep with `createTaskFromWrite` /
// `createNoteFromWrite` / `createCommentFromWrite` below — a field must not
// be published writable unless the matching create actually sends it.
function describeTaskMeta(): SchemaTypeDescriptor {
  return {
    typeId: ATTIO_TASK_TYPE_ID,
    displayName: 'Task',
    fields: [
      { fieldId: 'content_plaintext', displayName: 'Content', kind: 'string', writable: true, required: true },
      { fieldId: 'deadline_at', displayName: 'Deadline', kind: 'date', writable: true, required: false },
      { fieldId: 'is_completed', displayName: 'Completed', kind: 'boolean', writable: false, required: false },
      { fieldId: 'completed_at', displayName: 'Completed At', kind: 'date', writable: false, required: false },
      { fieldId: 'created_at', displayName: 'Created At', kind: 'date', writable: false, required: false },
    ],
    references: [],
  };
}

function describeNoteMeta(): SchemaTypeDescriptor {
  return {
    typeId: ATTIO_NOTE_TYPE_ID,
    displayName: 'Note',
    fields: [
      { fieldId: 'title', displayName: 'Title', kind: 'string', writable: true, required: true },
      { fieldId: 'content_plaintext', displayName: 'Content', kind: 'string', writable: true, required: true },
      { fieldId: 'parent_object', displayName: 'Parent Object', kind: 'string', writable: false, required: false },
      { fieldId: 'parent_record_id', displayName: 'Parent Record ID', kind: 'string', writable: false, required: false },
      { fieldId: 'created_at', displayName: 'Created At', kind: 'date', writable: false, required: false },
    ],
    references: [],
  };
}

function describeCommentMeta(): SchemaTypeDescriptor {
  return {
    typeId: ATTIO_COMMENT_TYPE_ID,
    displayName: 'Comment',
    fields: [
      { fieldId: 'content_plaintext', displayName: 'Content', kind: 'string', writable: true, required: true },
      // Attio requires every comment to carry a workspace-member author.
      // Authors set this by EMAIL (the same convention as actor-reference
      // fields on records — `@user_email` is the natural mapping); the write
      // resolves it to a workspace member and rejects unknown addresses.
      { fieldId: 'author', displayName: 'Author (email)', kind: 'string', writable: true, required: true },
      // Set Thread ID to reply into an existing thread; leave it blank to
      // start a new thread on the parent record the action is attached to.
      { fieldId: 'thread_id', displayName: 'Thread ID', kind: 'string', writable: true, required: false },
      { fieldId: 'resolved_at', displayName: 'Resolved At', kind: 'date', writable: false, required: false },
      { fieldId: 'created_at', displayName: 'Created At', kind: 'date', writable: false, required: false },
    ],
    references: [],
  };
}

/**
 * Synthetic `attio:file` type — one position per file-shaped value on a
 * record. The `File` field is the binary primitive (`kind: 'file'`): a
 * `FileRef` descriptor `resolveFileRef` redeems from Attio. The remaining
 * fields surface the file metadata Attio carries on the value (id, name,
 * content type, the display URL). Mirrors the slack:file shape so
 * `record-[:Files]->.\`File\`` resolves to a FileRef symmetrically across
 * adapters.
 */
function describeFileMeta(): SchemaTypeDescriptor {
  return {
    typeId: ATTIO_FILE_TYPE_ID,
    // No system name in a type/edge name (adapters/CLAUDE.md rule 5) — the
    // instance already says which system you're in.
    displayName: 'File',
    fields: [
      { fieldId: 'id', displayName: 'File Id', kind: 'string', writable: false, required: true },
      { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
      { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: false },
      { fieldId: 'url', displayName: 'URL', kind: 'string', writable: false, required: false },
      // The binary primitive — a `FileRef` descriptor `resolveFileRef`
      // redeems via the Attio download endpoint. This is what
      // `record-[:Files]->.\`File\`` evaluates so file bytes reach
      // extraction / carry-forward. On the WRITE side it is the one input:
      // `write record-[:Files]-> { File: <file> }` uploads the bytes against
      // the parent record (`createFileFromWrite`, /v2/files/upload).
      { fieldId: 'data', displayName: 'File', kind: 'file', writable: true, required: true },
    ],
    references: [],
  };
}

function describeWebhookEvent(
  objects: AttioObjectInfo[],
  lists: AttioListInfo[],
): SchemaTypeDescriptor {
  // One outgoing reference per Attio object — `Companies`, `People`,
  // etc. — plus the non-record meta-edges. The author picks the edge
  // whose name matches the object the event is for; the engine fetches
  // from the corresponding REST endpoint at traversal time.
  // requiresLiveRecord: the referenced record must still exist to hydrate
  // this edge — so it is excluded from the `delete` action variant.
  const recordForEventEdges: SchemaReferenceDescriptor[] = objects.map((obj) => ({
    fieldId: obj.name,
    // The target must be the object's framework identity — its entry-point
    // typeId, which IS `obj.name` (natural display name) since the typeId→
    // displayname refactor retired the `attio:<slug>` codec for object types.
    // A stale `attio:<slug>` here no longer matches any entry, so the projection
    // can't resolve the edge to the natural position and leaves the raw colon-key
    // as `edge.target` — which then surface-stamps a traversed record
    // (`inferLinkedSurfaceType`) with `attio:companies`, breaking field
    // resolution (the `'Domains' is not a known field of 'attio:companies'` drift).
    targetTypeId: obj.name,
    cardinality: 'one',
    requiresLiveRecord: true,
  }));
  // The list-ENTRY hop, symmetric with the record hop above: ONE edge per
  // list, each landing on that list's per-list type (which already carries
  // its single real parent). The author picks the edge whose name matches the
  // list the event is for; a mismatched event resolves to `[]`. This replaces
  // the old single `Entry` edge → generic `List Entry` (whose polymorphic
  // parent up-hops only existed to make that hop reachable) — narrowing to a
  // list is how you reach the parent, so the generic goes to the empty
  // intersection (layer 11).
  const entryForEventEdges: SchemaReferenceDescriptor[] = lists.map((list) => ({
    fieldId: list.name,
    targetTypeId: list.name,
    cardinality: 'one',
    requiresLiveRecord: true,
  }));
  return {
    typeId: ATTIO_WEBHOOK_EVENT_TYPE_ID,
    displayName: 'Webhook Event',
    fields: [
      // The change-kind axis is an ORDINARY FIELD — `action`, an enum of the
      // listen's `events:` vocabulary (ONE namespace; the retired
      // `configValueToAction` translation table had nothing to translate).
      // A signature narrows it in the address:
      // `<crm-[:`Webhook Event` WHERE `action` == "record.created"]->>`.
      { fieldId: 'action', displayName: 'action', kind: 'enum', enumValues: ['record.created', 'record.updated', 'record.deleted'], writable: false, required: false, description: 'Which kind of change this event is — the same values a listen\'s `events:` names.' },
      { fieldId: 'Workspace', displayName: 'Workspace', kind: 'string', writable: false, required: false },
      { fieldId: 'Object', displayName: 'Object', kind: 'string', writable: false, required: false },
      { fieldId: 'Record', displayName: 'Record', kind: 'string', writable: false, required: false },
      { fieldId: 'List', displayName: 'List', kind: 'string', writable: false, required: false },
      { fieldId: 'Entry', displayName: 'Entry', kind: 'string', writable: false, required: false },
      { fieldId: 'Task', displayName: 'Task', kind: 'string', writable: false, required: false },
      { fieldId: 'Note', displayName: 'Note', kind: 'string', writable: false, required: false },
      { fieldId: 'Comment', displayName: 'Comment', kind: 'string', writable: false, required: false },
      { fieldId: 'Attribute', displayName: 'Attribute', kind: 'string', writable: false, required: false },
    ],
    references: [
      ...recordForEventEdges,
      { fieldId: ATTIO_LIST_FOR_EVENT_FIELD, targetTypeId: ATTIO_LIST_TYPE_ID, cardinality: 'one' },
      ...entryForEventEdges,
      { fieldId: ATTIO_TASK_FOR_EVENT_FIELD, targetTypeId: ATTIO_TASK_TYPE_ID, cardinality: 'one' },
      { fieldId: ATTIO_NOTE_FOR_EVENT_FIELD, targetTypeId: ATTIO_NOTE_TYPE_ID, cardinality: 'one' },
      { fieldId: ATTIO_COMMENT_FOR_EVENT_FIELD, targetTypeId: ATTIO_COMMENT_TYPE_ID, cardinality: 'one' },
    ],
  };
}

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. `supportedTriggers` is the single source for the class
 * field below. (Whole-adapter capability is the class's `runtimeCapabilities()`:
 * outgoing-only traversal, no edge properties, no resources — the retired
 * input-side `#resources` bundle is gone.)
 *
 */
export const ATTIO_MANIFEST: AdapterManifest = {
  adapterType: ATTIO_ADAPTER_TYPE,
  displayName: 'Attio',
  website: 'https://attio.com',
  category: 'CRM',
  description: 'The Attio CRM. Read companies, people, deals, and lists; create and update records; and run movements when records change in Attio.',
  authoringHints:
    'For any owner field, `@user_email` is the best value to set it from — it identifies the ' +
    'connected user as the record owner.',
  supportedTriggers: ['snapshot', 'webhook'],
  methods: [
    'listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue',
    'getRelated', 'listEventTypes', 'preprocessInbound', 'createRecord', 'updateRecord', 'deleteRecord',
    'linkRecords', 'unlinkRecords', 'readRecord', 'describeOpaqueId', 'translateFilter',
    'getActorCandidates', 'extractActor', 'ensureEventSubscription', 'removeEventSubscription',
    'resolveFileRef',
  ],
  requiredCredentialType: ExternalServiceType.ATTIO,
  triggerKinds: ['ATTIO'],
  introspectedSchema: true,
  // The webhook event-type vocabulary movements can subscribe to
  // (`listen to crm { events: ["record.created"] } fire …`) — the same
  // names the webhook_sync provider registers by default.
  subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
  triggerExpectation:
    'Listen-Fire registers the Attio webhook automatically when a listener goes ' +
    'live, subscribed to record.created / record.updated / record.deleted — ' +
    'it fires when a RECORD in the workspace is created, updated or deleted, ' +
    'shortly after the change. It does not fire on notes, tasks, comments or ' +
    'emails. An update event identifies which record changed, not reliably ' +
    'which field — so do not promise field-level triggers ("when the stage ' +
    'changes") without gating on the event content, and narrow with listen ' +
    'events / record types rather than claiming everything is watched.',
  vocabulary: {
    icon: {
      d: "M29.755 22.362l.002-.001c.412.661.412 1.503 0 2.164l-2.515 4.025c-.002.004-.01.012-.01.012l-.2.32c-.37.591-1.031.959-1.73.959h-5.67c-.712 0-1.358-.359-1.732-.961l-2.027-3.235.267-.428 4.835-7.736.282-.453 4.046.014c.702 0 1.356.363 1.726.96l.198.316c.006.007.015.024.015.024zm-.767 1.683h.003c.23-.366.23-.837 0-1.203l-2.511-4.02c-.09-.146-.234-.164-.292-.164h-.028c-.018.003-.041.005-.067.013-.065.013-.14.054-.2.144l-.006.01-2.512 4.02c-.169.271-.215.601-.127.908.029.102.073.2.13.29l2.515 4.027c.062.101.172.163.291.163.096 0 .189-.041.253-.113.011-.016.025-.03.035-.05zm-6.666-11.408l-.004.001-1.917 3.07-5.999 9.6-2.024 3.237-.003.007v.004l-.208.33c-.374.6-1.02.96-1.732.96h-5.67c-.703.003-1.36-.361-1.73-.959l-2.723-4.359c-.414-.66-.414-1.503.002-2.162l10.153-16.251c.377-.6 1.024-.96 1.731-.96h5.67c.704-.002 1.361.361 1.732.959l.21.338 2.512 4.02c.41.662.41 1.503 0 2.165zm-.593-1.083c0-.208-.058-.417-.175-.602l-2.512-4.02c-.091-.147-.235-.164-.293-.164-.119-.001-.23.061-.292.163l-9.945 15.913c-.228.368-.228.834 0 1.202l2.513 4.027c.063.1.174.161.292.16.118.001.228-.06.291-.16l9.946-15.918c.117-.185.175-.394.175-.601z",
      fill: true,
      viewBox: "2 3 30 28",
    },
    eventPhrase: {
      // No per-event phrasing today (create/update/delete all shared one
      // generic sentence in the former switch) — `default` mirrors that.
      default: [{ template: 'When a record changes in Attio' }],
    },
  },
};

export class AttioAdapter extends BaseAdapter {
  readonly adapterType = ATTIO_ADAPTER_TYPE;
  /** Objects and lists each carry their own attributes, fetched one call at a time.
   *  So a full-surface describe is refused and the author walks in instead. */
  readonly walksContainers = true;

  /** Unstable (webhook/synthetic) positions resolve to Attio's well-known
   *  webhook-event meta type. Pure config consumed by the engine's generic
   *  `resolvePositionTypeId`. */
  readonly webhookEventTypeId = ATTIO_WEBHOOK_EVENT_TYPE_ID;

  /**
   * Snapshot for backfill + webhook for live updates. Webhook routing
   * itself lives in webhook_sync/handler.ts (per the contract: webhook is
   * a route the adapter registers, not a method on this interface).
   * Mutation is KG-intrinsic; never on Attio.
   */
  readonly supportedTriggers = ATTIO_MANIFEST.supportedTriggers;

  /** Outgoing-only traversal, no edge properties, but resources yes (record
   *  attachments via `#resources`). */
  private apiClient: AttioApiClient | null = null;
  private readonly teamId: TeamId;
  private readonly credentialsId: string;
  private readonly fetchCache = new Map<string, SourcePosition>();

  constructor(input: { teamId: TeamId; credentialsId: string }) {
    super();
    this.teamId = input.teamId;
    this.credentialsId = input.credentialsId;
  }

  // ── 0. Actor candidate parsing (acting-user split) ──────────────────────
  // Attio surfaces at most one `originator` candidate: the workspace
  // member's email, resolved at runtime via `/v2/workspace_members/{id}`
  // (the webhook payload carries only `actor: { type, id }`, never an
  // email). No persistence — no `user_attio` mapping table, no stored
  // actors. Only attempted for `workspace-member` actors (api-token /
  // system actors have no email); failure-resilient — any API error
  // swallows to null and yields an empty candidate list.
  //
  // External-system API enrichment (the workspace-member fetch) is
  // explicitly allowed in `getActorCandidates`; Listen-Fire DB access is NOT.
  // The creator-override (T6) — the PRIMARY Attio use case, where the
  // creator who connected the integration is the right acting user even
  // though the literal actor is someone else (still visible via
  // `@actor_*`) — plus the email→user match, the creator-fallback
  // (`trigger.config.fallbackToCreatorIfActorUnregistered`), and the
  // null-on-no-match rejection all live in `resolveActingUser`.
  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const resolved = await this.resolveActorEmail(input.event);
    if (!resolved) return [];
    // `identifier` stays the workspace-member id (the source-system primary
    // key); the API-resolved address rides `email`, making the candidate
    // email-resolvable (`scheme: 'email'`).
    return [
      {
        identity: {
          identifier: resolved.memberId,
          scheme: 'email',
          adapterType: this.adapterType,
          email: resolved.email,
        },
        source: 'originator',
      },
    ];
  }

  /**
   * Resolve the inbound Attio actor's email at runtime.
   *
   * Attio webhook payloads carry only `actor: { type, id }` — no email. The
   * email lives on the workspace member record, fetched via
   * `GET /v2/workspace_members/{workspace_member_id}` with the stored API
   * key. Only `workspace-member` actors are resolvable; `api-token` /
   * `system` actors (and our own echoes) have no human email and return
   * null immediately.
   *
   * Failure-resilient by contract: a missing actor, a non-member actor
   * type, a missing credential, or any API failure returns null so the
   * caller falls through the resolution chain rather than throwing into
   * dispatch. No persistence of the resolved email.
   */
  private async resolveActorEmail(
    event: TriggerEvent,
  ): Promise<{ memberId: string; email: string } | null> {
    const actor = readAttioActor(event);
    if (!actor || actor.type !== 'workspace-member' || !actor.id) return null;

    try {
      const client = await this.getApiClient();
      const response = await client.fetch({
        route: `/v2/workspace_members/${actor.id}`,
        method: 'GET',
        responseValidator: z.object({
          data: z.object({
            email_address: z.string().nullable().optional(),
          }).passthrough(),
        }),
      });
      const email = response.data.email_address;
      const normalized = email ? email.trim().toLowerCase() : null;
      return normalized ? { memberId: actor.id, email: normalized } : null;
    } catch (err) {
      logger.warn('[AttioAdapter] workspace-member actor-email resolution failed', {
        teamId: this.teamId,
        workspaceMemberId: actor.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // Raw Attio actor — Attio webhook payloads carry an `actor` envelope
  // with `id` (and sometimes `type`/`workspace_member_id`). Synchronous
  // parse only; resolving Attio actor → workspace member display name
  // would need a separate API call, which `extractActor` forbids.
  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    // First-class Attio actor surfaced by `webhook_sync/providers/attio.ts`
    // lands on `event.actor.id`; the raw webhook payload also carries
    // `payload.actor.id` for some event shapes. Tolerate both.
    const eventActor = input.event.actor;
    if (eventActor && typeof eventActor === 'object') {
      const id = (eventActor as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) {
        // Pure parse — a bare actor id with no resolved email maps to no
        // Listen-Fire user (`scheme: 'opaque'`); the candidate path resolves the
        // workspace-member email separately.
        return { identifier: id, scheme: 'opaque', adapterType: this.adapterType, label: id };
      }
    }
    const payload = (input.event.payload ?? {}) as Record<string, unknown>;
    const payloadActor = payload.actor as Record<string, unknown> | undefined;
    if (payloadActor && typeof payloadActor === 'object') {
      const id = payloadActor.id;
      if (typeof id === 'string' && id.length > 0) {
        // Pure parse — a bare actor id with no resolved email maps to no
        // Listen-Fire user (`scheme: 'opaque'`); the candidate path resolves the
        // workspace-member email separately.
        return { identifier: id, scheme: 'opaque', adapterType: this.adapterType, label: id };
      }
    }
    return null;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────
  // The adapter publishes two primitives:
  //   • `listEntryPoints()` — lightweight catalog of types the editor's
  //     "Add action" picker offers in root mode + types author-time UI
  //     needs to enumerate. Costs one /v2/objects + one /v2/lists call,
  //     no per-type attribute fetches.
  //   • `describe(typeId)` — full descriptor for one type. Per-type
  //     attribute fetch happens here, lazily, only for the types the
  //     editor / engine actually lands on. Caller-cached at the
  //     trpc layer; adapter pays the API cost at most once per
  //     (team, typeId) per cache window.

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    const { objects, lists } = await this.warmCatalogs();

    const recordEntries: SchemaEntryPoint[] = objects.map((obj) => ({
      // The framework identity IS the pretty object name — the structured
      // slug/UUID lives only in the private cache. `externalId` keeps the raw
      // object UUID for callers that key on the external object.
      typeId: obj.name,
      displayName: obj.name,
      externalId: obj.id,
      writable: true,
      readable: true,
    }));
    const perListEntries: SchemaEntryPoint[] = lists.map((list) => ({
      // Same: the list's display name is its framework identity; the list id
      // rides `externalId` (and the private cache).
      typeId: list.name,
      displayName: list.name,
      // The raw list UUID — lets generic consumers (e.g. the webhook-filter
      // editor) resolve `id.list_id` ↔ name without an Attio-specific catalog
      // fetch, mirroring how object entries carry `externalId: obj.id`.
      externalId: list.id,
      // READ-ONLY root: enumerating a list's entries is a real root read (a
      // list is enumerated in its own right — rule 8, `POST /v2/lists/{list}/
      // entries/query` needs no record). But a per-list ENTRY cannot be
      // created here: `createPerListEntry` requires the parent RECORD to
      // attach, which a root write can't supply (the honesty bug —
      // `writable: true` typechecked `write crm-[:`VC Deal Flow`]->` then
      // threw at run time for a missing parent). The entry WRITE lives on the
      // object edge instead: `write <record>-[:Lists]-> { list: "…", … }`,
      // where the record IS the parent (the write's subject) and the list is
      // named in the body. So the top-level list write now fails AT THE
      // CHECKER (no writable root ⇒ the meta collection edge carries no
      // `creatable`), never at run time.
      writable: false,
      readable: true,
    }));
    const meta: SchemaEntryPoint[] = [
      {
        typeId: ATTIO_LIST_ENTRY_TYPE_ID,
        displayName: 'List Entry',
        labelTemplate: 'List Entry — {listId}',
        // Read-only: the legacy generic list-entry type was published
        // writable while its create threw "not yet implemented". List writes
        // are covered by the dynamic PER-LIST entry types above — author
        // against those; this type remains for reads/traversal only.
        writable: false,
        // A GENERIC list entry has no root read — "which list?" has no answer
        // from the meta node. The PER-LIST entries above carry the real root
        // reads; this type stays traversable (webhook event's `Entry` edge)
        // via the derived position.
        readable: false,
      },
      // Records OWN their tasks and notes — the natural CRM graph is objects +
      // event, and a task/note hangs off the record it belongs to. The API's
      // workspace-wide GET /v2/tasks + GET /v2/notes is API-SHAPE, which rule 0
      // reverses: access lives where access is real, on the record edge. Both
      // are reached AND created via `record-[:Tasks]->` / `record-[:Notes]->`
      // (ATTACHABLE_TO_RECORDS, creatable). No root promise; a read that still
      // arrives at the old root redirects loudly (relatedPageFromMeta).
      // (The low-level createRecord still tolerates a parentless task — the
      // Attio API allows it — but the SURFACE no longer offers a root task
      // create; every edge write supplies its record parent.)
      { typeId: ATTIO_TASK_TYPE_ID, displayName: 'Task', writable: false, readable: false },
      { typeId: ATTIO_NOTE_TYPE_ID, displayName: 'Note', writable: false, readable: false },
      // Comment is reachable ONLY through its record: no list-comments
      // endpoint (threads scope to a record or entry), and a parentless
      // create throws — reads AND writes both live on the record
      // (`record-[:Comments]->`). No root promise at all (rule 0).
      { typeId: ATTIO_COMMENT_TYPE_ID, displayName: 'Comment', writable: false, readable: false },
      // Lists live under their PARENT OBJECT (rule 0: a list is created with
      // one required parent object — single-parent in practice, however
      // workspace-wide GET /v2/lists is). Reached via `record-[:Lists]->`;
      // the root offers nothing.
      { typeId: ATTIO_LIST_TYPE_ID, displayName: 'List', writable: false, readable: false },
      // File exists only on its record (GET /v2/files REQUIRES object +
      // record_id; upload attaches to a record) — reads and writes both live
      // on `record-[:Files]->`. No root promise (rule 0).
      { typeId: ATTIO_FILE_TYPE_ID, displayName: 'File', writable: false, readable: false },
      {
        typeId: ATTIO_WEBHOOK_EVENT_TYPE_ID,
        displayName: 'Webhook Event',
        writable: false,
        // You cannot list the webhook events that have happened — an event is
        // pushed, never pulled. `readable: false` is the honest statement
        // about the root's edge; the edge's whole promise is `fires`.
        readable: false,
        // The event EDGE marker. THE EVENT IS JUST A NODE: nothing is
        // synthesized from this — the change-kind axis is the node's own
        // `action` enum field (describeWebhookEvent), narrowed in the address
        // (`<crm-[:`Webhook Event` WHERE `action` == "record.created"]->>`).
        // Presentation as named narrowed edges (`Record Created` …) is layer
        // 4's choice and deliberately NOT taken: polymorphic reads better.
        fires: true,
      },
    ];
    // One list-membership target per object — edge-creatable meta types (no
    // root promise, like the generic `List`): the create shape rides each
    // object's `Lists` edge, its enum filtered to that object's lists. Present
    // here so their names resolve (resolveTypeRef) and the resolver learns their
    // `listName` field for write-key translation.
    const membershipEntries: SchemaEntryPoint[] = objects.map((obj) => ({
      typeId: listMembershipTypeId(obj),
      displayName: listMembershipDisplayName(obj),
      writable: false,
      readable: false,
    }));
    return [...recordEntries, ...perListEntries, ...meta, ...membershipEntries];
  }

  /**
   * The event-type union for this workspace: one entry per object type,
   * recognised by the inbound event's `id.object_id`. Drives engine-side
   * discrimination of inbound events into typed record positions — replacing
   * the `attio:webhook_event` meta-type + per-target-edge hop. (Per-list /
   * task / note / comment event discrimination is a follow-up.)
   */
  async listEventTypes(): Promise<EventType[]> {
    const { objects } = await this.warmCatalogs();
    return objects.map((obj) => {
      // The discriminated position carries the object's NAME as its
      // positionType — the engine seeds the inbound root with it directly (no
      // typeId → displayName restamp needed). The `match` still keys on the
      // raw object UUID the webhook payload carries.
      const positionType = obj.name;
      return {
        tag: positionType,
        positionType,
        match: { path: 'id.object_id', equals: obj.id },
      };
    });
  }

  /**
   * Inbound intercept. Attio delivers a BATCH of changes in one POST body
   * (`{ webhook_id, events: [...] }`) — no async fetch needed, so this just
   * splits the batch into one `DiscriminableEvent` per change. The synthesized
   * payload (`{ event_type, id, actor }`) is what `listEventTypes`' `match`
   * (`id.object_id`) discriminates on. `record_id` → `externalId` (the KG
   * bridge key), `object_id` → `recordType` (the source object), and the
   * changed attribute UUID → `changedFields` for edge pruning.
   */
  async preprocessInbound(input: { raw: unknown }): Promise<{ events: DiscriminableEvent[] }> {
    const parsed = attioWebhookBodySchema.safeParse(input.raw);
    if (!parsed.success) return { events: [] };

    return {
      events: parsed.data.events.map((e) => ({
        payload: {
          event_type: e.event_type,
          // The event node's `action` field — the same value the wire's
          // `event_type` carries, under the surface name the schema declares
          // (and the name an address pins: `WHERE `action` == "…"`).
          action: e.event_type,
          id: { record_id: e.id.record_id, object_id: e.id.object_id },
          actor: e.actor,
        },
        externalId: e.id.record_id,
        recordType: e.id.object_id,
        eventType: e.event_type,
        ...(attioChangeType(e.event_type) ? { changeType: attioChangeType(e.event_type) } : {}),
        ...(normalizeAttioActor(e.actor) ? { actor: normalizeAttioActor(e.actor) } : {}),
        ...(e.id.attribute_id ? { changedFields: [e.id.attribute_id] } : {}),
      })),
    };
  }

  /**
   * Attio's walk. Its types are located by NAME — `describe` resolves an
   * object or list from the workspace catalogs — so the generic walk applies
   * despite the surface being large.
   *
   * EVERY root edge is STUBBED, and Attio is the reason stubbing exists.
   * Describing one target means fetching that object's or list's attributes;
   * the root has an edge per object and per list, so hydrating it fetches the
   * whole workspace to answer "what is in this connection". Measured at 10
   * upstream calls on a three-object dev workspace, and it scales with the
   * customer. The agent gets every name here for two calls, and pays one fetch
   * for the thing it actually touches.
   *
   * Deeper hops hydrate normally: a record's edges land on a handful of
   * related types, which is a frontier rather than a workspace.
   *
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    const atRoot =
      position.recordType === null ||
      position.recordType === META_RECORD_TYPE ||
      position.recordType === ADAPTER_META_TYPE_ID;

    // Standing on a NARROWED `Lists` member (`-[:Lists WHERE `Name` == "VC Deal
    // Flow"]->`). The member is addressed by the polymorphic edge's name, so
    // resolve it back to the concrete list and stand there — narrowing and
    // naming reach the SAME node, which is what makes them one edge presented
    // two ways rather than two claims.
    const narrowedList = await this.listNameForMember(position);
    const at = narrowedList !== undefined ? { ...position, recordType: narrowedList } : position;

    return this.withListMembers(
      await uniformWalk({
        adapterType: ATTIO_ADAPTER_TYPE,
        at,
        root: await this.walkRoot(),
        describe: (typeId) => this.describe(typeId),
      // Attio's object and list type ids ARE the natural names, so a stub
      // names its target correctly with no extra lookup — which is part of why
      // stubbing is cheap here.
      //
      // The event edge is NOT stubbed: `describeWebhookEvent` reads the
      // already-warm catalogs, so it costs nothing, and its fields (`action`
      // and the record it carries) are exactly what an author needs to write a
      // listener. Stub what is expensive, not everything.
      //
      // Hydrating the whole root was tried and measured at 2 upstream calls →
      // 10 (2026-07-19). Reverted: every root edge here is walkable, so a stub
      // costs one call for the edge you follow instead of ten for the ones you
      // don't.
      ...(atRoot
        ? {
            stubTarget: (reference) =>
              reference.targetTypeId === ATTIO_WEBHOOK_EVENT_TYPE_ID
                ? undefined
                : stubTargetOf({ typeId: reference.targetTypeId }),
          }
        : {}),
      }),
    );
  }

  /**
   * The list a `-[:Lists WHERE …]->` member position names, if this position is
   * one. A member is addressed by the EDGE's name (`membersOf` matches on
   * `recordType`) and carries the list's id, which is what identifies it —
   * the label is for reading, the id is for resolving.
   */
  private async listNameForMember(position: SourcePosition): Promise<string | undefined> {
    if (position.recordType !== ATTIO_LISTS_EDGE) return undefined;
    const listId = positionRecordId(position);
    if (listId === undefined) return undefined;
    const { lists } = await this.warmCatalogs();
    return lists.find((l) => l.id === listId)?.name;
  }

  /**
   * Make `-[:Lists]->` NARROWABLE: one member per list this record can join.
   *
   * The members ride the hop as paths with no reference row of their own, which
   * is what a polymorphic edge IS — the same shape Airtable's bases and
   * Affinity's list collections use. Narrowing lands on the concrete list, the
   * same node the named `-[:`VC Deal Flow`]->` edge reaches: one relationship,
   * two spellings, never two different claims.
   *
   * READS are what narrowing serves here. A narrowed WRITE would not work —
   * a WHERE on a write edge is dropped before the adapter sees it — which is
   * why the write stays a discriminated union on the required `listName` enum
   * (describeListMembership), and why the per-list NAMED edges are the typed
   * write surface. The predicate is for finding, the enum is for naming.
   */
  private async withListMembers(hop: EdgesFromResult | null): Promise<EdgesFromResult | null> {
    if (!hop) return null;
    const listsRef = hop.descriptor.references.find((r) => r.fieldId === ATTIO_LISTS_EDGE);
    if (!listsRef) return hop;
    const objectSlug = await this.resolveObjectSlugFromRecordType(hop.descriptor.typeId);
    if (!objectSlug) return hop;
    const { lists } = await this.warmCatalogs();
    const joinable = lists.filter((l) => l.parentObjectSlugs.includes(objectSlug));
    if (joinable.length === 0) return hop;

    return {
      ...hop,
      targetPositions: {
        ...hop.targetPositions,
        // Keyed by list id — NOT by a reference `fieldId`, which is the
        // discriminator between a member and an edge's own address.
        ...Object.fromEntries(
          joinable.map((list) => [
            `list:${list.id}`,
            makeStablePosition({
              adapterType: ATTIO_ADAPTER_TYPE,
              recordType: ATTIO_LISTS_EDGE,
              recordId: list.id,
              data: { Name: list.name },
            }),
          ]),
        ),
      },
    };
  }

  /**
   * The root node: the meta descriptor's collection edges, plus the event edge
   * the meta descriptor deliberately omits.
   *
   * `describeMeta` leaves the event out because it must not project a
   * traversable COLLECTION. Under the walk that reasoning inverts: an event is
   * reached along an edge like everything else, and the edge says which
   * promise it makes. `fires: true, readable: false` states it exactly — you
   * are pushed along this one, you cannot enumerate it.
   */
  private async walkRoot(): Promise<SchemaTypeDescriptor> {
    const meta = await this.describeMeta();
    return {
      ...meta,
      typeId: META_RECORD_TYPE,
      references: [
        ...meta.references,
        {
          fieldId: ATTIO_WEBHOOK_EVENT_TYPE_ID,
          targetTypeId: ATTIO_WEBHOOK_EVENT_TYPE_ID,
          cardinality: 'one',
          direction: 'outgoing',
          name: 'Webhook Event',
          fires: true,
          readable: false,
          description: 'A record being created, updated or deleted — what a listen delivers.',
        },
      ],
    };
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // Accept the NATURAL type name (engine / checker currency) or the internal
    // typeId (resolver build, legacy callers) — `resolveTypeRef` normalizes
    // both. The synthetic/meta ids (`attio:webhook_event`, per-list ids, …)
    // are entry-point typeIds, so they pass through unchanged. Everything
    // below works on the internal `typeId`.
    const typeId = await this.resolveTypeRef(typeRef);
    // Adapter root — references list the entry-point types that snapshots
    // can fan out into. The TG's root traversal walks meta → a collection
    // edge to land on individual external records.
    if (typeId === ADAPTER_META_TYPE_ID) {
      return this.describeMeta();
    }
    // Synthetic meta types are FIXED internal sentinels (not user-renamable
    // external objects with a name↔id gap), so they're resolved by their
    // constant first — before the name cache. The remaining names (object
    // record types + per-list types) carry their pretty display name.
    if (typeId === ATTIO_LIST_TYPE_ID) {
      const { lists } = await this.warmCatalogs();
      return describeListMeta(lists);
    }
    // Per-object membership target — the `<Object> List` an object's `Lists`
    // edge lands on. Its enum + variants are filtered to that object's lists.
    if (typeId.startsWith(ATTIO_LIST_MEMBERSHIP_PREFIX)) {
      const slug = typeId.slice(ATTIO_LIST_MEMBERSHIP_PREFIX.length);
      const { objects, lists } = await this.warmCatalogs();
      const obj = objects.find((o) => (o.slug ?? o.id) === slug);
      if (!obj) return null;
      return describeListMeta(lists, {
        typeId,
        displayName: listMembershipDisplayName(obj),
        objectSlug: obj.slug ?? slug,
      });
    }
    if (typeId === ATTIO_LIST_ENTRY_TYPE_ID) {
      return describeListEntryMeta();
    }
    if (typeId === ATTIO_TASK_TYPE_ID) return describeTaskMeta();
    if (typeId === ATTIO_NOTE_TYPE_ID) return describeNoteMeta();
    if (typeId === ATTIO_COMMENT_TYPE_ID) return describeCommentMeta();
    if (typeId === ATTIO_FILE_TYPE_ID) return describeFileMeta();
    if (typeId === ATTIO_WEBHOOK_EVENT_TYPE_ID) {
      const { objects, lists } = await this.warmCatalogs();
      return describeWebhookEvent(objects, lists);
    }
    // Object record types: the name resolves to its structured identifier via
    // the private cache, then a lazy per-type attribute fetch builds the
    // descriptor. Per-list types fall through to their own builder. An unknown
    // name (drift) → null.
    const obj = await this.structuredIdFor(typeId);
    if (obj) return this.describeRecord(obj);
    const list = await this.structuredListFor(typeId);
    if (list) return this.describePerList(list);
    return null;
  }

  /** Fetch + cache the workspace-level catalogs the schema methods
   *  depend on (objects + lists). Called by `listEntryPoints` and
   *  `describe` so they share state. */
  private async warmCatalogs(): Promise<{
    objects: AttioObjectInfo[];
    lists: AttioListInfo[];
  }> {
    const cachedObjects = objectCatalogCache.get(this.teamId);
    const cachedLists = listsCache.get(this.teamId);
    if (cachedObjects && cachedLists) {
      return {
        objects: Array.from(cachedObjects.values()),
        lists: cachedLists,
      };
    }
    const client = await this.getApiClient();
    const objects = cachedObjects
      ? Array.from(cachedObjects.values())
      : await client.listObjects();
    if (!cachedObjects) {
      const map = new Map<string, AttioObjectInfo>();
      for (const obj of objects) map.set(obj.id, obj);
      objectCatalogCache.set(this.teamId, map);
    }
    let lists = cachedLists ?? [];
    if (!cachedLists) {
      try {
        lists = await client.listLists();
      } catch (err) {
        logger.warn('[AttioAdapter.warmCatalogs] /v2/lists failed; per-list edges will be unavailable', {
          teamId: this.teamId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      listsCache.set(this.teamId, lists);
    }
    return { objects, lists };
  }

  // ── Name → structured-identifier cache ──────────────────────────────────
  // The framework names an Attio object or list only by its pretty
  // `displayName` (the object's name, the list's name) — that IS the
  // `recordType` every position carries and the `typeId` `listEntryPoints` /
  // `describe` publish. The Attio API, by contrast, routes on the object's
  // slug/UUID (or the list's id). These helpers are the PRIVATE map between
  // the two, derived from the SAME `warmCatalogs` introspection that lists
  // entry points (cache-backed per team) — so every read/write/traverse
  // recovers its routing id from the recordType NAME here, on its first line,
  // never by parsing an `attio:<slug>` magic string. The slug-stringly
  // `parseObjectId` / `perListTypeId` codec is retired.

  /** Resolve an object type's pretty NAME to its structured identifier
   *  (`{ id, name, slug }` — the Attio API consumes `slug ?? id`). undefined
   *  when the name isn't a known object (the caller decides graceful-empty vs
   *  hard error). */
  private async structuredIdFor(name: string): Promise<AttioObjectInfo | undefined> {
    const { objects } = await this.warmCatalogs();
    return objects.find((o) => o.name === name);
  }

  /** The write/read variant: a name that doesn't resolve is a hard error (the
   *  movement targets an object this connection can't see — drift). */
  private async requireStructuredId(name: string, method: string): Promise<AttioObjectInfo> {
    const obj = await this.structuredIdFor(name);
    if (!obj) {
      // Speak the NATURAL name even when handed an internal id (drift and
      // internal-currency paths) — internal ids never belong in a message a
      // user or agent reads (leakage audit, 2026-07-07).
      const natural = (await this.resolver()).naturalTypeName(name);
      throw new Error(`AttioAdapter.${method}: unrecognised recordType "${natural}".`);
    }
    return obj;
  }

  /** The Attio API object id for an object type NAME — slug preferred (stable
   *  across renames), UUID fallback. The single value `getRecord` /
   *  `createRecord` / `queryRecords*` / `deleteRecord` consume as `objectId`. */
  private async objectApiIdFor(name: string, method: string): Promise<string> {
    const obj = await this.requireStructuredId(name, method);
    return obj.slug ?? obj.id;
  }

  /** Resolve a per-list type's pretty NAME (the list's display name) to its
   *  list catalog entry. undefined when the name isn't a known list. */
  private async structuredListFor(name: string): Promise<AttioListInfo | undefined> {
    const { lists } = await this.warmCatalogs();
    return lists.find((l) => l.name === name);
  }

  /**
   * Adapter-root descriptor. Each entry point appears as an outgoing
   * reference whose `fieldId` matches the target typeId — the meta-edge
   * picker enumerates these as "Companies", "People", "<list>", and the
   * engine resolves them by typeId in `getRelated` /
   * `relatedPageFromMeta`, which serves object snapshots, per-list
   * entries, notes, tasks and lists.
   */
  private async describeMeta(): Promise<SchemaTypeDescriptor> {
    const { objects, lists } = await this.warmCatalogs();
    const objectReferences: SchemaReferenceDescriptor[] = objects.map((obj) => {
      // The collection edge + its target are both named by the object's
      // display name — the framework identity. A top-level object collection
      // is an unbounded fan-out — Attio narrows it natively via the
      // records-query API; the sort runs in the engine (chunk 4).
      return {
        fieldId: obj.name,
        targetTypeId: obj.name,
        cardinality: 'many',
        capability: ATTIO_NATIVE_EDGE_CAP,
        // The same create promise the object's entry point makes. Left off, the
        // walk called every object read-only — so describe and getStarted told
        // an author that `write crm-[:Companies]->` was not allowed, while the
        // checker (which reads the entry list) accepted it.
        writable: true,
      };
    });
    // The meta node's edges state the same promises the entry list makes —
    // the entry list and the walk must not disagree. Only OBJECTS and the
    // per-list collections carry a root edge. Note / Task / List / Comment /
    // File have NO meta edge at all: they are RECORD-OWNED (or list-owned) and
    // reachable only through their parent (rule 0 — the surface must not lie
    // about access; access lives where it is real). The Webhook Event entry is
    // deliberately ABSENT here too: an event edge's promise is `fires`, not
    // read or write, and it must not project a traversable collection
    // (8_event_edges.md).
    const perListReferences: SchemaReferenceDescriptor[] = lists.map((list) => ({
      fieldId: list.name,
      targetTypeId: list.name,
      cardinality: 'many' as const,
      // `listEntriesPageFromRoot` takes no filter and no sort argument — it
      // always pages the whole list — so a WHERE and an ORDER BY both run in
      // the engine over everything the list holds. `supportsLimit: true`
      // because that is still safe: the engine slices what it fetched, and
      // over-fetching is never wrong (D1) — the fetch was always going to be
      // the whole list either way.
      capability: ATTIO_BOUNDED_EDGE_CAP,
    }));
    return {
      typeId: ADAPTER_META_TYPE_ID,
      displayName: 'Attio',
      fields: [],
      references: [...objectReferences, ...perListReferences],
    };
  }

  /** Build a record type's full descriptor: object attributes →
   *  fields, record-references → references (target typeIds aligned
   *  with the slug-preferring convention), plus the synthetic
   *  per-list refs (lists scoped to this object) and Notes/Tasks/
   *  Comments attachable refs. */
  private async describeRecord(obj: AttioObjectInfo): Promise<SchemaTypeDescriptor | null> {
    const { objects, lists } = await this.warmCatalogs();
    const objectsById = new Map<string, AttioObjectInfo>();
    for (const o of objects) objectsById.set(o.id, o);
    const client = await this.getApiClient();
    const base = await buildTypeDescriptor(client, obj, objectsById);
    const matchingLists = obj.slug
      ? lists.filter((l) => l.parentObjectSlugs.includes(obj.slug!))
      : [];
    const perListRefs: SchemaReferenceDescriptor[] = matchingLists.map((list) => ({
      fieldId: list.name,
      targetTypeId: list.name,
      cardinality: 'many' as const,
      // A list's entries are filterable server-side; the sort runs in the engine.
      capability: ATTIO_NATIVE_EDGE_CAP,
      // WRITABLE — `write <record>-[:`VC Deal Flow`]-> { … }` adds this record
      // to that list. The write path has always supported it: `createRecord`
      // resolves a list by display name (`structuredListFor`) BEFORE the
      // generic branch and lands on the same `createPerListEntry`, which needs
      // exactly one parent link — which an edge write from a record supplies by
      // construction.
      //
      // It was read-only only because the flag was never set (absent in every
      // revision — no commit removed it). The documented read-only decision is
      // about the ROOT entry, where a write genuinely cannot supply a parent;
      // that reasoning never applied to a record-anchored edge.
      //
      // This edge also types its target CONCRETELY (`describePerList`), so
      // entry attributes check — where the generic `Lists` edge can only accept
      // `listName`, having no way to know which list's schema applies.
      writable: true,
    }));
    return {
      ...base,
      references: [
        ...base.references,
        ...perListRefs,
        ...ATTACHABLE_TO_RECORDS,
        {
          // Lists live under their PARENT OBJECT (rule 0): `record-[:Lists]->`
          // lands on the List nodes whose parent object is this record's —
          // filtered from the same /v2/lists catalog the instance already
          // holds, no extra call. READABLE ("which lists is this record in")
          // AND CREATABLE: `write <record>-[:Lists]-> { listName: "VC Deal
          // Flow" }` adds THIS record (the write's subject, hence the parent)
          // to the NAMED list, minting a list entry via `createListEntry`. The
          // list is NAMED in the body (`listName`, a required enum), not by a
          // WHERE — a WHERE on a write edge is silently dropped before the
          // adapter sees it (`singleWriteEdge` keeps only the edge name), and a
          // create names its target rather than filtering it. Creating the LIST
          // ITSELF is still schema administration the adapter doesn't offer (a
          // write here only ever attaches to an existing list). Rule 6: one
          // edge, read + create.
          fieldId: ATTIO_LISTS_EDGE,
          // This object's OWN membership type — so `write <record>-[:Lists]->`
          // offers only lists this object can join (layer 12), not every
          // workspace list.
          targetTypeId: listMembershipTypeId(obj),
          cardinality: 'many' as const,
          writable: true,
        },
        {
          // Files (`record-[:Files]->`) — one `attio:file` position per
          // file-shaped value scanned out of the record's attribute envelope.
          // Each carries a `File` field returning a `FileRef` descriptor
          // `resolveFileRef` redeems from Attio. Symmetric with the
          // file-on-write path, and mirrors the slack `Files` edge.
          fieldId: ATTIO_FILES_REFERENCE,
          targetTypeId: ATTIO_FILE_TYPE_ID,
          cardinality: 'many' as const,
          name: ATTIO_FILES_REFERENCE_NAME,
          // Edge-anchored create: `write record-[:Files]-> { File: … }`
          // uploads against THIS record — the only way a file is created.
          writable: true,
        },
      ],
    };
  }

  /** Build a per-list type's full descriptor: the list's entry
   *  attributes become the type's fields. Caches per-list attribute
   *  fetches across calls. */
  private async describePerList(list: AttioListInfo): Promise<SchemaTypeDescriptor | null> {
    const cacheKey = `${this.teamId}:${list.id}`;
    let attrs = listAttributesCache.get(cacheKey);
    try {
      const client = await this.getApiClient();
      if (!attrs) {
        attrs = await client.listAttributes({ listId: list.id });
        listAttributesCache.set(cacheKey, attrs);
      }
      // Enum options ride their own cache, so enriching after the
      // attribute-cache read stays cheap on repeat describes.
      attrs = await withAttributeOptions(client, { listId: list.id }, attrs);
    } catch (err) {
      if (!attrs) {
        logger.warn('[AttioAdapter.describePerList] failed to fetch list attributes', {
          listId: list.id,
          listName: list.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
    const { objects } = await this.warmCatalogs();
    return buildPerListTypeDescriptor(list, attrs, objects);
  }

  // ── 2. Entity resolution ────────────────────────────────────────────────
  // Two stages, lowest-cost first:
  //   1. Match against existing linked_objects (Tier 0). The bridge says
  //      "we've already matched this Attio record up before" — adopt it.
  //   2. Query Attio's record API with a filter built from the action's
  //      uniqueness constraints + the values the engine intends to write.
  //      Catches the "KG knows about Acme, no bridge yet, but an Attio
  //      record with name=Acme already exists" case so we update it
  //      instead of creating a duplicate. Per-list synthetic types skip
  //      this — list-entry filtering needs a different endpoint and isn't
  //      wired today.

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // The engine speaks NATURAL names: `recordType` is the type displayName,
    // `record` keys + constraint `field`s are field/edge displayNames. Resolve
    // them to this adapter's internal currency (the attribute slug the search
    // + bridge `external_object_type` are keyed by) on the first line; a name
    // admissible as either a property or an edge resolves property-first
    // (`tryFieldId`) then edge (`tryEdgeReadId`), else passes through. The edge
    // arm resolves to the reference's `fieldId` — the ATTRIBUTE SLUG — because
    // everything downstream (`attrBySlug`, `buildAttioPredicate`, the record
    // filter) is keyed by slug; the edge's natural NAME is its title, which is
    // not a currency Attio's API understands.
    const resolver = await this.resolver({ types: [input.recordType] });
    const recordType = await this.resolveTypeRef(input.recordType);
    const naturalType = naturalName(input.recordType);
    const toInternalField = (field: string): string =>
      resolver.tryFieldId(naturalType, naturalName(field)) ??
      resolver.tryEdgeReadId(naturalType, naturalName(field)) ??
      field;

    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.record)) {
      record[toInternalField(key)] = value;
    }
    const constraints: UniquenessConstraints = {
      any: input.constraints.any.map((branch) => ({
        all: branch.all.map((entry) => ({ ...entry, field: toInternalField(entry.field) })),
      })),
    };
    const internalInput: ResolveEntityInput = { ...input, recordType, record, constraints };

    const bridgeMatch = this.resolveByBridge(internalInput);
    if (bridgeMatch) return bridgeMatch;
    const result = await this.resolveByConstraints(internalInput);
    // Candidate `data` is keyed by Attio attribute slug (internal). The engine
    // arbitrates exactness against the NATURAL-keyed asserted record, so rename
    // each candidate's data keys back to their display names.
    return { candidates: await this.toNaturalCandidates(result.candidates, recordType) };
  }

  /** Rename each candidate `ExternalRecordRef.data` key from the Attio
   *  attribute slug (internal) to its field displayName (natural), so the
   *  engine's arbitration sees the same currency as the asserted record.
   *  Built from this type's own descriptor; an unmapped slug passes through. */
  private async toNaturalCandidates(
    candidates: ResolveEntityResult['candidates'],
    internalRecordType: string,
  ): Promise<ResolveEntityResult['candidates']> {
    if (candidates.length === 0) return candidates;
    const descriptor = await this.describe(internalRecordType);
    const naturalBySlug = new Map<string, string>();
    for (const f of descriptor?.fields ?? []) naturalBySlug.set(f.fieldId, f.displayName);
    return candidates.map((c) => {
      const data: Record<string, unknown> = {};
      for (const [slug, value] of Object.entries(c.data)) {
        data[naturalBySlug.get(slug) ?? slug] = value;
      }
      return { ...c, data };
    });
  }

  private resolveByBridge(input: ResolveEntityInput): ResolveEntityResult | null {
    if (input.candidates.length === 0) return null;
    const matching = input.candidates
      .filter((c: LinkedObjectCandidate) => c.external_object_type === input.recordType)
      .sort(
        (a, b) =>
          new Date(b.created_at ?? 0).getTime() -
          new Date(a.created_at ?? 0).getTime(),
      );
    if (matching.length === 0) return null;
    // A single bridge hit is the unambiguous match — the external id is the
    // linked_object's recorded Attio record id.
    return {
      candidates: [
        {
          adapterType: ATTIO_ADAPTER_TYPE,
          externalId: matching[0].external_id,
          data: {},
        },
      ],
    };
  }

  private async resolveByConstraints(
    input: ResolveEntityInput,
  ): Promise<ResolveEntityResult> {
    if (input.constraints.any.length === 0) return { candidates: [] };
    // `recordType` is the object's NATURAL name; recover its structured id
    // from the private cache. A per-list type name (or any non-object name)
    // resolves to no object — per-list entry resolution (`/v2/lists/<id>/
    // entries/query`) has a different filter shape and slippery
    // single-entry-per-list semantics, so it's skipped until there's a real
    // need to wire it.
    const obj = await this.structuredIdFor(input.recordType);
    if (!obj) return { candidates: [] };

    // Attribute metadata is needed to translate each constraint property
    // into the right Attio filter shape — typed attributes (domain,
    // email-address, phone-number, reference) require a sub-attribute
    // wrapper, and multi-value attributes must not be filtered with an
    // array value (Attio rejects with `filter_error`). Cache hit is the
    // common case here; first-time miss falls back to a live fetch.
    let attrs: AttioAttribute[] = [];
    try {
      const client = await this.getApiClient();
      attrs = await client.listAttributes({ objectId: obj.id });
    } catch (err) {
      logger.warn('[AttioAdapter.resolveByConstraints] attribute fetch failed', {
        recordType: input.recordType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const attrBySlug = new Map<string, AttioAttribute>();
    for (const a of attrs) {
      if (a.apiSlug) attrBySlug.set(a.apiSlug, a);
      attrBySlug.set(a.id, a);
    }

    // Each constraint branch becomes a conjunction of scalar entries —
    // `field` names the Attio attribute slug, value comes from the asserted
    // record. When a value is an array (multi-value source), cartesian-expand
    // so each emitted branch is a pure scalar AND — Attio's filter language
    // has no "array equality" form. The engine arbitrates exactness
    // separately (3b §3.2), so the adapter only builds the search.
    type ScalarEntry = { propTypeId: string; value: unknown; fuzzy: boolean };
    const branches: { entries: ScalarEntry[] }[] = [];
    for (const branch of input.constraints.any) {
      let usable = true;
      let expanded: ScalarEntry[][] = [[]];
      for (const entry of branch.all) {
        const raw = input.record[entry.field];
        if (raw === null || raw === undefined || raw === '') {
          usable = false;
          break;
        }
        // Edge-valued uniqueness: the engine folds a resolved neighbour in as
        // `{ id }` (compound identity via a reference attribute). For a
        // reference attribute, unwrap to the neighbour's record id —
        // `buildAttioPredicate` then emits Attio's reference filter
        // (`target_record_id`). Any other attribute holding an object is
        // unfilterable; skip the branch rather than coerce it into a broken
        // scalar filter.
        let unwrapped: unknown = raw;
        if (
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          raw !== null &&
          'id' in (raw as Record<string, unknown>)
        ) {
          const attrType = attrBySlug.get(entry.field)?.type;
          if (attrType !== 'record-reference' && attrType !== 'actor-reference') {
            usable = false;
            break;
          }
          unwrapped = (raw as { id: unknown }).id;
        }
        const values = Array.isArray(unwrapped)
          ? unwrapped.filter((v) => v !== null && v !== undefined && v !== '')
          : [unwrapped];
        if (values.length === 0) {
          usable = false;
          break;
        }
        const next: ScalarEntry[][] = [];
        for (const partial of expanded) {
          for (const v of values) {
            next.push([...partial, { propTypeId: entry.field, value: v, fuzzy: !!entry.fuzzy }]);
          }
        }
        expanded = next;
      }
      if (!usable) continue;
      for (const entries of expanded) {
        if (entries.length > 0) branches.push({ entries });
      }
    }
    if (branches.length === 0) return { candidates: [] };

    const filterBranches = branches.map((b) => buildAttioBranchFilter(b.entries, attrBySlug, []));
    const filter =
      filterBranches.length === 1
        ? filterBranches[0]
        : { $or: filterBranches };

    let matches: AttioRecord[];
    try {
      const client = await this.getApiClient();
      // Fetch a wider shortlist (was 2) so the engine's LLM judge has the
      // full picture when the constraint is already violated in Attio.
      // Cap is small enough that the prompt stays compact and the API
      // round-trip stays cheap.
      matches = await client.queryRecordsWithFilter({
        objectId: obj.id,
        filter,
        limit: 10,
      });
    } catch (err) {
      logger.warn('[AttioAdapter.resolveByConstraints] filter query failed', {
        recordType: input.recordType,
        error: err instanceof Error ? err.message : String(err),
      });
      return { candidates: [] };
    }

    if (matches.length === 0) return { candidates: [] };

    // Flatten each returned record's attribute values into the flat
    // currency's `data` bag. No linked_object bridge yet — this is the
    // pre-bridge path; the engine reads `externalId` for the update and
    // writes a bridge after the write completes. Per-candidate exactness
    // is no longer attributed here: the engine arbitrates over the held
    // constraints in T2 (the flat currency carries no exactness flag).
    const candidates = matches.map((rec) => {
      const data: Record<string, unknown> = {};
      for (const [attrKey, raw] of Object.entries(rec.values ?? {})) {
        const v = extractAttioValue(raw);
        if (v !== null && v !== undefined && v !== '') data[attrKey] = v;
      }
      return {
        adapterType: ATTIO_ADAPTER_TYPE,
        externalId: rec.id.record_id,
        data,
      };
    });

    return { candidates };
  }

  // ── 3. Field-level access ───────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    // Webhook event positions store the parsed event payload. The
    // schema descriptor exposes clean field names (`Object`, `List`,
    // `Record`, …); we map those to the underlying Attio payload
    // paths (`id.object_id`, `id.list_id`, …) here. `Object` and
    // `List` are translated UUID → display name so authors can write
    // `Object == "Companies"` and `List == "Hot Leads"`; the others
    // surface the raw id unchanged. Unknown values (object renamed,
    // catalog stale) pass the raw UUID through — comparison against
    // the authored name then fails to match, surfacing the staleness.
    //
    // The webhook event type publishes `fieldId === displayName`
    // (`Object`/`Object`, `List`/`List`, …), so the NATURAL field name
    // the engine hands us IS already the key `WEBHOOK_FIELD_TO_PAYLOAD_PATH`
    // and the descriptor are keyed by — natural==internal here, no resolve.
    if (!isStablePosition(input.position)) {
      if (input.position.adapterType !== this.adapterType) {
        throw new Error(
          `AttioAdapter.getFieldValue expects ${this.adapterType} positions; got ${input.position.adapterType}`,
        );
      }
      // `attio:file` positions (reached via `record-[:Files]->`) carry a
      // parsed file record on `data`. The program names the field by its
      // NATURAL displayName (`File`, `Name`, `Content Type`); resolve it to
      // the internal field id the parsed record is keyed by, then read it.
      // The `File` (`data`) field is the binary primitive — a `FileRef`
      // descriptor `resolveFileRef` redeems via the Attio download endpoint.
      const fileRecordType = input.position.recordType;
      // Naming the type is entries-only and free; describing it is not, so the
      // scoped resolve happens INSIDE the branch that actually reads a field.
      const naturalFileType = (await this.resolver()).naturalTypeName(ATTIO_FILE_TYPE_ID);
      if (fileRecordType === ATTIO_FILE_TYPE_ID || fileRecordType === naturalFileType) {
        const data = positionData(input.position) as AttioFileRecord | null | undefined;
        const fileFieldId = (await this.resolver({ types: [ATTIO_FILE_TYPE_ID] })).fieldId(
          naturalName(naturalFileType),
          naturalName(input.fieldId),
        );
        if (fileFieldId === 'data') return this.attioFileRef(data ?? null);
        return data ? (data[fileFieldId as keyof AttioFileRecord] ?? null) : null;
      }
      const payloadPath = WEBHOOK_FIELD_TO_PAYLOAD_PATH[input.fieldId];
      if (!payloadPath) {
        throw new Error(
          `AttioAdapter.getFieldValue: field "${input.fieldId}" is not declared on the Attio webhook event`,
        );
      }
      const raw = readDotPath(positionData(input.position), payloadPath);
      if (input.fieldId === 'Object' && typeof raw === 'string') {
        return (await this.translateObjectIdToName(raw)) ?? raw;
      }
      if (input.fieldId === 'List' && typeof raw === 'string') {
        return (await this.translateListIdToName(raw)) ?? raw;
      }
      return raw;
    }

    if (input.position.adapterType !== this.adapterType) {
      throw new Error(
        `AttioAdapter.getFieldValue expects ${this.adapterType} positions; got ${input.position.adapterType}`,
      );
    }

    // The program names the field by its NATURAL displayName; resolve it to
    // this adapter's internal currency — the attribute slug `record.values`
    // (and the synthetic types' flat data) are keyed by — and the position's
    // NATURAL recordType to its internal typeId, on the first line.
    const typeId = input.position.recordType !== null
      ? await this.resolveTypeRef(input.position.recordType)
      : null;
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);

    // Synthetic non-record types (list, list_entry, task, note, comment)
    // store materialized GET-response fields flat — no Attio
    // typed-array unwrapping. The recordType check is the seam between
    // "this came from /v2/objects/<obj>/records/<id>" and "this came
    // from a per-entity endpoint with a normal flat shape."
    const SYNTHETIC_FLAT_TYPES = new Set<string>([
      ATTIO_LIST_TYPE_ID,
      ATTIO_LIST_ENTRY_TYPE_ID,
      ATTIO_TASK_TYPE_ID,
      ATTIO_NOTE_TYPE_ID,
      ATTIO_COMMENT_TYPE_ID,
    ]);
    if (
      typeId !== null &&
      (SYNTHETIC_FLAT_TYPES.has(typeId) || typeId.startsWith(ATTIO_LIST_MEMBERSHIP_PREFIX))
    ) {
      const data = positionData(input.position) as Record<string, unknown> | null | undefined;
      return data?.[fieldId] ?? null;
    }

    const data = positionData(input.position) as Record<string, unknown> | null | undefined;
    if (!data) return null;

    // Attio record positions store values as `{ [slug]: [{ value | full_name | ... }] }`.
    const raw = data[fieldId];
    return extractAttioValue(raw);
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.direction !== 'outgoing') {
      throw new Error(
        `AttioAdapter.getRelated only supports outgoing direction (incoming traversal isn't supported by Attio's API).`,
      );
    }

    // Adapter-root → collection. The edge fieldId is the record entry
    // type (e.g. `attio:companies`); we walk the snapshot iterator and
    // materialize one external-record position per yielded event. Builds
    // on the existing `snapshot()` primitive — collection iteration is
    // not a separate API. The streaming variant (`iterateRelated`) is
    // preferred by the engine; this eager collector is kept for callers
    // (and adapters) that don't have the streaming path wired.
    if (input.position.recordType === META_RECORD_TYPE) {
      // Meta-root hop: the NATURAL edge name is the target type's display
      // name (`Companies`, `People`, …). Resolve it to the internal typeId
      // `getRelatedFromMeta` scans (`attio:companies`).
      const recordType = (await this.resolver()).collectionTypeId(naturalName(input.fieldId));
      // Push the hop's WHERE down to the records-query API so an unbounded
      // collection never pages every record (chunk 7). Falls back to a
      // pre-built nativeFilter if the engine supplied one.
      let nativeFilter = input.nativeFilter;
      if (nativeFilter === undefined && input.where !== undefined) {
        nativeFilter = (
          await this.translateFilter({ expression: input.where, entityType: recordType })
        ).native;
      }
      return this.getRelatedFromMeta({ edgeFieldId: recordType, nativeFilter });
    }

    // Webhook event → record traversal. The edge field id is the Attio
    // object's display name (`Companies`, `People`, …); we resolve it
    // against the catalog to get the slug/UUID for the REST fetch. Edge
    // existence implies "this event might be for this object" — the
    // actual yield is conditional on `event.id.object_id` matching, so a
    // mismatched event resolves to an empty traversal (the framework
    // treats "no related positions" as a clean no-op).
    if (!isStablePosition(input.position)) {
      if (input.fieldId === ATTIO_LIST_FOR_EVENT_FIELD) {
        return this.getListForEvent({
          position: input.position,
        });
      }
      // Per-list entry edge: the fieldId is a LIST's display name. Land the
      // entry typed as that list's per-list type (which carries its one real
      // parent), gated on the event's `list_id` matching — a mismatched list
      // yields `[]`, symmetric with the per-object record edges above.
      const targetList = await this.structuredListFor(input.fieldId);
      if (targetList) {
        return this.getEntryForEvent({
          position: input.position,
          targetList,
        });
      }
      if (input.fieldId === ATTIO_TASK_FOR_EVENT_FIELD) {
        return this.getTaskForEvent({
          position: input.position,
        });
      }
      if (input.fieldId === ATTIO_NOTE_FOR_EVENT_FIELD) {
        return this.getNoteForEvent({
          position: input.position,
        });
      }
      if (input.fieldId === ATTIO_COMMENT_FOR_EVENT_FIELD) {
        return this.getCommentForEvent({
          position: input.position,
        });
      }

      const obj = await this.findObjectByDisplayName(input.fieldId);
      if (obj) {
        return this.getRecordForEvent({
          position: input.position,
          targetObject: obj,
        });
      }
      // Unknown edge name on a webhook-event position. Fall through so
      // the synthetic-edge / record-reference branches below produce the
      // standard "not implemented" error rather than silently no-oping.
    }

    if (!isStablePosition(input.position)) {
      throw new Error(
        `AttioAdapter.getRelated expects external-record positions for fieldId="${input.fieldId}"; got ${input.position.recordType ?? 'unknown'}`,
      );
    }

    // `__list_membership` is a synthetic adapter sentinel — it isn't in the
    // record's published references, so resolving it would (correctly) drift.
    // Cross it verbatim, like `#resources`.
    if (input.fieldId === ATTIO_LIST_MEMBERSHIP_FIELD) {
      return this.getListMemberships({
        record: input.position,
      });
    }

    // List entry → parent record back-edge. From a list-entry position (the
    // generic `attio:list_entry` meta type, or a per-list type) an object-named
    // edge hops up to the record the entry sits on. Matched by object display
    // name BEFORE the generic edge resolver — like the webhook-event record
    // edge — because the entry type isn't keyed for object edges in the edge
    // resolver. Resolution is gated on the entry's `parent_object` matching
    // that object; a non-object edge on a list entry falls through below.
    if (await this.isListEntryRecordType(input.position.recordType)) {
      const targetObject = await this.findObjectByDisplayName(naturalName(input.fieldId));
      if (targetObject) {
        return this.getRecordForListEntry({ position: input.position, targetObject });
      }
    }

    // Resolve the NATURAL edge name to this adapter's read currency against
    // the position's NATURAL record type. For Attio record edges the read
    // currency IS the published reference fieldId (per-list refs publish the
    // list's display name; record-references publish the attribute slug), so
    // the resolved id is exactly what the branches below match on — and an
    // edge the schema doesn't publish drifts loudly instead of silently.
    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);

    // Files (`record-[:Files]->`): the record's file-shaped attribute values
    // UNION the files attached via Attio's files API (GET /v2/files, whose
    // object + record_id params are REQUIRED — the record scope IS the read).
    if (edgeId === ATTIO_FILES_REFERENCE) {
      return this.getFilesForRecord(input.position);
    }

    // Downstream per-list / reference helpers key on the INTERNAL record
    // type (`attio:<slug>`); resolve the position's NATURAL type once.
    const internalRecordType = input.position.recordType !== null
      ? await this.resolveTypeRef(input.position.recordType)
      : input.position.recordType;

    // Per-list edge: a record's `-[:<List Name>]->` traversal. The resolved
    // edge id is the list's display name; we resolve it to a list whose
    // parent_object matches this record's object type, then fetch the
    // entries for this record.
    const perListEdge = await this.findPerListEdgeByName({
      recordType: internalRecordType,
      edgeName: edgeId,
    });
    if (perListEdge) {
      return this.getListEntriesForRecord({
        record: input.position,
        list: perListEdge,
      });
    }

    // Attachables (`record-[:Notes|Tasks|Comments]->`) — the record-scoped
    // reads behind the ATTACHABLE_TO_RECORDS references. Each is a real API
    // scope, verified against the OpenAPI spec: notes filter by
    // parent_object + parent_record_id, tasks by linked_object +
    // linked_record_id, and comments ride threads (GET /v2/threads scoped by
    // record — or by entry, for a list-entry position). These edges were
    // published readable with no read behind them (d255f1016's loose end).
    if (edgeId === 'Notes' || edgeId === 'Tasks' || edgeId === 'Comments') {
      return this.getAttachablesForPosition({
        position: input.position,
        edgeId,
        internalRecordType,
      });
    }

    // `record-[:Lists]->` — the lists under this record's object (rule 0).
    if (edgeId === 'Lists') {
      return this.getListsForRecord(input.position);
    }

    // Record-reference attributes (record → record): the record's own value
    // names its targets — read it and fetch each. (7_readable_means_readable.md
    // category 3: this edge was published readable with no read behind it.)
    const referenceResults = await this.getRecordReferenceTargets({
      position: input.position,
      edgeId,
    });
    if (referenceResults !== undefined) return referenceResults;

    throw new Error(
      `AttioAdapter.getRelated for fieldId="${input.fieldId}" is not yet implemented. Per-list edges, Notes/Tasks/Comments/files/Lists, record-reference attributes and __list_membership are supported.`,
    );
  }

  /**
   * The record-scoped attachable reads. Scope derivation:
   *
   * - an OBJECT RECORD position scopes by its own object slug + record id;
   * - a LIST-ENTRY position scopes Notes/Tasks by its PARENT record (notes
   *   and tasks attach to records, never to entries — the entry's own
   *   `parent_object`/`parent_record_id` name it), and Comments by the ENTRY
   *   itself (threads are natively entry-scopable:
   *   GET /v2/threads?entry_id&list).
   *
   * A parent the position can't confirm is an empty traversal (the same
   * semantics as the list-entry record back-edge); an unknown OBJECT type is
   * drift and throws.
   */
  private async getAttachablesForPosition(input: {
    position: SourcePosition;
    edgeId: 'Notes' | 'Tasks' | 'Comments';
    internalRecordType: string | null;
  }): Promise<RelatedResult[]> {
    const isEntry = await this.isListEntryRecordType(input.internalRecordType);
    const data = positionData(input.position) as Record<string, unknown> | null | undefined;

    if (isEntry && input.edgeId === 'Comments') {
      const entryId = positionRecordId(input.position);
      const rawListId = data?.list_id;
      // A per-list position knows its list by NAME (its recordType); a
      // generic entry carries `list_id` in its data (stamped at minting).
      const listId =
        typeof rawListId === 'string' && rawListId.length > 0
          ? rawListId
          : (await this.structuredListFor(naturalName(input.position.recordType ?? '')))?.id;
      if (typeof entryId !== 'string' || entryId.length === 0 || listId === undefined) {
        logger.warn('[AttioAdapter.getRelated] list entry without a resolvable list — empty Comments traversal', {
          recordType: input.position.recordType,
        });
        return [];
      }
      return this.collectThreadComments({ entryId, list: listId });
    }

    // Notes/Tasks scope: the record itself, or the entry's parent record.
    const scope = isEntry
      ? (() => {
          const parentObject = data?.parent_object;
          const parentRecordId = data?.parent_record_id;
          return typeof parentObject === 'string' && typeof parentRecordId === 'string'
            ? { objectSlug: parentObject, recordId: parentRecordId }
            : null;
        })()
      : await (async () => {
          const naturalType = naturalName(input.position.recordType ?? '');
          const objectSlug = await this.objectApiIdFor(naturalType, 'getRelated');
          const recordId = positionRecordId(input.position);
          return typeof recordId === 'string' && recordId.length > 0
            ? { objectSlug, recordId }
            : null;
        })();
    if (scope === null) return [];

    const client = await this.getApiClient();
    if (input.edgeId === 'Notes') {
      const results: RelatedResult[] = [];
      let offset = 0;
      while (true) {
        const page = await client.listNotesPage({
          limit: NOTES_PAGE_SIZE,
          offset,
          parentObject: scope.objectSlug,
          parentRecordId: scope.recordId,
        });
        for (const note of page) results.push({ position: await this.notePosition(note) });
        if (page.length < NOTES_PAGE_SIZE) return results;
        offset += page.length;
      }
    }
    if (input.edgeId === 'Tasks') {
      const results: RelatedResult[] = [];
      let offset = 0;
      while (true) {
        const page = await client.listTasksPage({
          limit: SNAPSHOT_PAGE_SIZE,
          offset,
          linkedObject: scope.objectSlug,
          linkedRecordId: scope.recordId,
        });
        for (const task of page) results.push({ position: await this.taskPosition(task) });
        if (page.length < SNAPSHOT_PAGE_SIZE) return results;
        offset += page.length;
      }
    }
    return this.collectThreadComments({ recordId: scope.recordId, object: scope.objectSlug });
  }

  /** Page the threads for one record or entry and flatten their inline
   *  comments into positions — Attio has no list-comments endpoint; the
   *  thread hop is the ONLY way to enumerate them (threads carry their
   *  comments inline, sorted by created_at). */
  private async collectThreadComments(scope: {
    recordId?: string;
    object?: string;
    entryId?: string;
    list?: string;
  }): Promise<RelatedResult[]> {
    const client = await this.getApiClient();
    const results: RelatedResult[] = [];
    let offset = 0;
    while (true) {
      const page = await client.listThreadsPage({
        limit: THREADS_PAGE_SIZE,
        offset,
        ...scope,
      });
      for (const thread of page) {
        for (const comment of thread.comments) {
          results.push({ position: await this.commentPosition(comment) });
        }
      }
      if (page.length < THREADS_PAGE_SIZE) return results;
      offset += page.length;
    }
  }

  /**
   * `record-[:Files]->` — BOTH file surfaces of a record, deduped by file id:
   *
   * - file-shaped ATTRIBUTE values scanned out of the record's own envelope
   *   (`parseAttioFileEntry` — detection by value shape, since Attio's
   *   attribute catalogue doesn't enumerate a file kind);
   * - the record's attached files via GET /v2/files (object + record_id are
   *   REQUIRED there — which is exactly why the `Attio File` root is
   *   write-only: a file exists only on its record). This is where files
   *   uploaded through `write record-[:Files]->` (POST /v2/files/upload)
   *   live, so without this half the write path's own output was unreadable.
   *
   * Each position's `File` field returns the byte-bearing FileRef. An API
   * listing failure degrades to the envelope files with a warning (partial
   * data over a dead read — same trade as the other traversal fetches).
   */
  private async getFilesForRecord(position: SourcePosition): Promise<RelatedResult[]> {
    const recordType = (await this.resolver()).naturalTypeName(ATTIO_FILE_TYPE_ID);
    const files: AttioFileRecord[] = [...this.resolveFileRefs(position)];
    const seen = new Set(files.map((f) => f.id));

    const recordId = positionRecordId(position);
    const naturalType = naturalName(position.recordType ?? '');
    const objectSlug = (await this.structuredIdFor(naturalType))?.slug;
    if (typeof recordId === 'string' && recordId.length > 0 && objectSlug) {
      try {
        const client = await this.getApiClient();
        let cursor: string | undefined;
        do {
          const page = await client.listFilesPage({
            object: objectSlug,
            recordId,
            cursor,
          });
          for (const file of page.files) {
            if (seen.has(file.id.file_id)) continue;
            seen.add(file.id.file_id);
            files.push({
              id: file.id.file_id,
              name: file.name ?? null,
              contentType: file.content_type ?? null,
              url: null,
            });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      } catch (err) {
        logger.warn('[AttioAdapter.getRelated] GET /v2/files failed; serving attribute-envelope files only', {
          recordId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return files.map((file) => ({
      position: makeUnstablePosition({
        adapterType: this.adapterType,
        recordType,
        data: file,
      }),
    }));
  }

  /**
   * Traverse a record-reference attribute (`company-[:Team]->`). The resolved
   * `edgeId` is the reference attribute's slug; the record's OWN value under
   * that slug names the targets (`[{ target_object, target_record_id }]`), so
   * the only fetches are the target records themselves. Returns `undefined`
   * when the edge isn't a record-reference attribute of this record's object
   * (caller falls through to the unknown-edge error); an empty or absent
   * value is an empty traversal; a dead target is skipped with a warning.
   */
  private async getRecordReferenceTargets(input: {
    position: SourcePosition;
    edgeId: string;
  }): Promise<RelatedResult[] | undefined> {
    const naturalType = naturalName(input.position.recordType ?? '');
    const { attrBySlug } = await this.attrTypesForObject(naturalType);
    if (attrBySlug.get(input.edgeId)?.type !== 'record-reference') return undefined;

    const data = positionData(input.position) as Record<string, unknown> | null | undefined;
    const rawValue = data?.[input.edgeId];
    if (rawValue == null) return [];
    const valueEntries = Array.isArray(rawValue) ? rawValue : [rawValue];

    const { objects } = await this.warmCatalogs();
    const client = await this.getApiClient();
    const results: RelatedResult[] = [];
    for (const entry of valueEntries) {
      if (entry === null || typeof entry !== 'object') continue;
      const ref = entry as Record<string, unknown>;
      const targetRecordId = ref.target_record_id;
      const targetObjectKey = ref.target_object;
      if (typeof targetRecordId !== 'string' || targetRecordId.length === 0) continue;
      // The value names the target object by slug (or UUID); the emitted
      // position must carry the object's NATURAL name — the framework
      // identity, exactly as `getRecordForEvent` stamps it.
      const targetObj = objects.find(
        (o) => o.slug === targetObjectKey || o.id === targetObjectKey,
      );
      if (!targetObj) {
        logger.warn('[AttioAdapter.getRelated] record-reference target object not in catalog', {
          edgeId: input.edgeId,
          targetObject: targetObjectKey,
        });
        continue;
      }
      const cacheKey = `${this.adapterType}:${targetObj.name}:${targetRecordId}`;
      const cached = this.fetchCache.get(cacheKey);
      if (cached) {
        results.push({ position: cached });
        continue;
      }
      try {
        const record = await client.getRecord({
          objectId: targetObj.slug ?? targetObj.id,
          recordId: targetRecordId,
        });
        const position: SourcePosition = makeStablePosition({
          adapterType: this.adapterType,
          recordType: targetObj.name,
          recordId: record.id.record_id,
          data: record.values,
        });
        this.fetchCache.set(cacheKey, position);
        results.push({ position });
      } catch (err) {
        logger.warn('[AttioAdapter.getRelated] failed to fetch record-reference target', {
          edgeId: input.edgeId,
          targetRecordId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * Streaming variant of `getRelated`: Attio's pages walked to the end, each
   * item produced only when it is read — a list-entry page hydrates its
   * parent records one per yielded item, so a traversal that stops early
   * fetches only what it used.
   */
  iterateRelated(input: GetRelatedInput): AsyncIterable<RelatedResult> {
    return iterateRelatedPages((cursor) => this.lazyRelatedPage(input, cursor));
  }

  /** One page of `iterateRelated`, materialised — the paged contract hands
   *  back whole pages, so this hydrates the page it answers. */
  async iterateRelatedPage(input: GetRelatedInput, cursor?: unknown): Promise<RelatedPage> {
    const page = await this.lazyRelatedPage(input, cursor);
    const items: RelatedResult[] = [];
    for await (const item of page.items) items.push(item);
    return { items, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
  }

  /**
   * A meta-edge hop (`adapter-meta → -[:<recordType>]->`) pages Attio's own
   * offset paging, with the offset as the cursor. Other position kinds aren't
   * paged today — they answer the eager `getRelated` read as a single page.
   */
  private async lazyRelatedPage(input: GetRelatedInput, cursor: unknown): Promise<LazyRelatedPage> {
    if (input.direction !== 'outgoing') {
      throw new Error(
        `AttioAdapter.iterateRelated / iterateRelatedPage only support outgoing direction.`,
      );
    }
    if (input.position.recordType === META_RECORD_TYPE) {
      // Meta-root hop: resolve the NATURAL target-type name → internal typeId,
      // matching the eager `getRelated` path.
      const recordType = (await this.resolver()).collectionTypeId(naturalName(input.fieldId));
      return this.relatedPageFromMeta({
        edgeFieldId: recordType,
        nativeFilter: input.nativeFilter,
        offset: attioPageOffset(cursor),
      });
    }
    return { items: await this.getRelated(input) };
  }

  private async relatedPageFromMeta(input: {
    edgeFieldId: string;
    nativeFilter?: unknown;
    offset: number;
  }): Promise<LazyRelatedPage> {
    const recordType = input.edgeFieldId;

    // Synthetic meta sentinels first — fixed internal ids that can never
    // collide with a workspace object/list name (same ordering rule as
    // `describe`). These types have NO root promise at all (rule 0 — reachable
    // only through their parent record/list). Their entries say readable: false
    // AND writable: false, so no collection exists to typecheck against; a read
    // that still arrives here fails loudly and points at the real path.
    //
    // Notes and Tasks are RECORD-OWNED: they live on the record they belong to,
    // not at the root (the workspace-wide GET /v2/notes + GET /v2/tasks is
    // API-shape, which rule 0 reverses). Reached and created via the record
    // edge.
    if (recordType === ATTIO_NOTE_TYPE_ID) {
      throw new Error(
        `Attio notes live on the record they annotate — hop \`record-[:Notes]->\` ` +
          `(a note is read and created under its record).`,
      );
    }
    if (recordType === ATTIO_TASK_TYPE_ID) {
      throw new Error(
        `Attio tasks live on the record they belong to — hop \`record-[:Tasks]->\` ` +
          `(a task is read and created under its record).`,
      );
    }
    if (recordType === ATTIO_LIST_TYPE_ID) {
      throw new Error(
        `Attio lists live under their parent object — hop \`record-[:Lists]->\`, ` +
          `or read one list's entries via its own collection (\`crm-[:\`<list name>\`]->\`).`,
      );
    }
    if (recordType === ATTIO_COMMENT_TYPE_ID) {
      throw new Error(
        `Attio cannot list comments from the root — comments live on a record's threads. ` +
          `Reach them through the record (\`record-[:Comments]->\`).`,
      );
    }
    if (recordType === ATTIO_FILE_TYPE_ID) {
      throw new Error(
        `Attio cannot list files from the root — a file exists only on its record. ` +
          `Reach them through the record (\`record-[:Files]->\`).`,
      );
    }
    if (recordType === ATTIO_LIST_ENTRY_TYPE_ID) {
      throw new Error(
        `Attio cannot list generic list entries from the root — entries belong to a list. ` +
          `Read a specific list's collection instead.`,
      );
    }

    // Object collection → snapshot. Forward the pushed-down native filter so
    // it can scope the fetch (e.g. "Companies in this list" hits the
    // list-entries endpoint instead of paging every record). Engine
    // post-filters when the residual is non-null; the native filter is at
    // most an early-pruning hint.
    if (await this.structuredIdFor(recordType)) {
      const page = await this.snapshotPage(
        { pipelineInputId: '', recordType, filter: input.nativeFilter },
        input.offset,
      );
      async function* items(): AsyncIterable<RelatedResult> {
        for await (const event of page.events) {
          const payload = event.payload as SourcePosition | undefined;
          if (payload && isStablePosition(payload)) yield { position: payload };
        }
      }
      return { items: items(), ...(page.nextOffset !== undefined ? { nextCursor: page.nextOffset } : {}) };
    }

    // Per-list collection → every entry of the list, as per-list positions.
    // (7_readable_means_readable.md category 3: the per-list roots were
    // published readable with no read behind them.)
    const list = await this.structuredListFor(recordType);
    if (list) return this.listEntriesPageFromRoot(list, input.offset);

    // Unknown name → clean no-op.
    return { items: [] };
  }

  /** Eager collector over `relatedPageFromMeta` — one implementation, so
   *  the paged and eager meta-hop reads can never disagree. */
  private async getRelatedFromMeta(input: {
    edgeFieldId: string;
    nativeFilter?: unknown;
  }): Promise<RelatedResult[]> {
    const results: RelatedResult[] = [];
    const pages = iterateRelatedPages((cursor) =>
      this.relatedPageFromMeta({ ...input, offset: attioPageOffset(cursor) }),
    );
    for await (const result of pages) results.push(result);
    return results;
  }

  /** `record-[:Lists]->` — the lists whose PARENT OBJECT is this record's
   *  (rule 0: lists live under their parent object). Served from the warm
   *  /v2/lists catalog, filtered by the record's object slug — no extra
   *  call. Data shape matches `getListForEvent`; recordType is the NATURAL
   *  name (field reads resolve against it). */
  private async getListsForRecord(position: SourcePosition): Promise<RelatedResult[]> {
    const naturalType = naturalName(position.recordType ?? '');
    const obj = await this.requireStructuredId(naturalType, 'getRelated');
    const { lists } = await this.warmCatalogs();
    // Land on THIS object's membership type — the same type the `Lists` edge
    // targets — so the declared target and the read positions agree.
    const recordType = listMembershipDisplayName(obj);
    return lists
      .filter((l) => obj.slug !== null && l.parentObjectSlugs.includes(obj.slug))
      .map((list) => ({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType,
          recordId: list.id,
          data: { id: list.id, name: list.name },
        }),
      }));
  }

  // ── Note / Task / Comment position minting ──────────────────────────────
  // ONE minting path per synthetic type, shared by every read that lands on
  // it (root collection, record-scoped edge, event hop) — so a Note reads the
  // same wherever it was reached, and every position carries the NATURAL
  // recordType (the resolver's field maps are keyed by displayName; an
  // internal-sentinel recordType like `attio:note` drifts at resolveFieldId).

  private async notePosition(
    note: Awaited<ReturnType<AttioApiClient['listNotesPage']>>[number],
  ): Promise<SourcePosition> {
    const recordType = (await this.resolver()).naturalTypeName(ATTIO_NOTE_TYPE_ID);
    return makeStablePosition({
      adapterType: this.adapterType,
      recordType,
      recordId: note.id.note_id,
      data: {
        title: note.title ?? null,
        content_plaintext: note.content_plaintext ?? null,
        parent_object: note.parent_object ?? null,
        parent_record_id: note.parent_record_id ?? null,
        created_at: note.created_at ?? null,
      },
    });
  }

  private async taskPosition(
    task: Awaited<ReturnType<AttioApiClient['listTasksPage']>>[number],
  ): Promise<SourcePosition> {
    const recordType = (await this.resolver()).naturalTypeName(ATTIO_TASK_TYPE_ID);
    return makeStablePosition({
      adapterType: this.adapterType,
      recordType,
      recordId: task.id.task_id,
      data: {
        content_plaintext: task.content_plaintext ?? null,
        deadline_at: task.deadline_at ?? null,
        is_completed: task.is_completed ?? null,
        completed_at: task.completed_at ?? null,
        created_at: task.created_at ?? null,
      },
    });
  }

  private async commentPosition(
    comment: Awaited<ReturnType<AttioApiClient['getComment']>>,
  ): Promise<SourcePosition> {
    const recordType = (await this.resolver()).naturalTypeName(ATTIO_COMMENT_TYPE_ID);
    // The wire carries the author as an actor `{ type, id }`; the schema's
    // `Author (email)` field speaks email (the same currency the write side
    // accepts), so resolve workspace members here. Best-effort: an
    // unresolvable actor reads as null, never fails the traversal.
    const authorId =
      comment.author?.type === 'workspace-member' && typeof comment.author.id === 'string'
        ? comment.author.id
        : null;
    const author = authorId ? ((await this.memberEmailById()).get(authorId) ?? null) : null;
    return makeStablePosition({
      adapterType: this.adapterType,
      recordType,
      recordId: comment.id.comment_id,
      data: {
        content_plaintext: comment.content_plaintext ?? null,
        author,
        thread_id: comment.thread_id ?? null,
        resolved_at: comment.resolved_at ?? null,
        created_at: comment.created_at ?? null,
      },
    });
  }

  /** workspace-member id → email, one fetch per instance. The read-side
   *  inverse of the write path's email → member resolution (comments carry
   *  actors on the wire, never emails). Failure degrades to an empty map —
   *  authors read as null rather than failing the traversal. */
  private memberEmailsPromise?: Promise<Map<string, string>>;
  private async memberEmailById(): Promise<Map<string, string>> {
    if (!this.memberEmailsPromise) {
      this.memberEmailsPromise = (async () => {
        try {
          const client = await this.getApiClient();
          const members = await client.listWorkspaceMembers();
          return new Map(members.map((m) => [m.id, m.email]));
        } catch (err) {
          logger.warn('[AttioAdapter] failed to list workspace members for author resolution', {
            error: err instanceof Error ? err.message : String(err),
          });
          return new Map<string, string>();
        }
      })();
    }
    return this.memberEmailsPromise;
  }

  /** One page of a root read of one list's entries (`crm-[:`Hot Leads`]->`) —
   *  the list-entries query with no record scope. Position shape matches
   *  `getListEntriesForRecord` (plus `created_at`, the entry's added-at date),
   *  so a per-list node reads the same whether reached from the root or from
   *  its record. */
  private async listEntriesPageFromRoot(list: AttioListInfo, offset: number): Promise<LazyRelatedPage> {
    const client = await this.getApiClient();
    const page = await client.queryListEntriesPage({
      listId: list.id,
      limit: SNAPSHOT_PAGE_SIZE,
      offset,
    });
    const items = page.map((entry) => ({
      position: makeStablePosition({
        adapterType: this.adapterType,
        recordType: list.name,
        recordId: entry.entryId,
        data: {
          created_at: entry.createdAt,
          ...entry.entryValues,
          parent_record_id: entry.parentRecordId,
          parent_object: entry.parentObjectId,
        },
      }),
    }));
    const { nextOffset } = nextSnapshotOffset(offset, page.length);
    return { items, ...(nextOffset !== undefined ? { nextCursor: nextOffset } : {}) };
  }

  /**
   * Resolve `webhook-event → -[:<ObjectName>]->`. The edge name picks the
   * target object; we still verify that `event.id.object_id` agrees with
   * that object before fetching. A mismatch yields no related positions
   * — the event is for a different object and the traversal terminates
   * cleanly. (Authors filter `event_type == 'record.created'` plus the
   * specific edge they want; combining several edges in one filter is
   * how they cover multiple objects.)
   */
  private async getRecordForEvent(input: {
    position: SourcePosition;
    targetObject: AttioObjectInfo;
  }): Promise<RelatedResult[]> {
    const eventObjectId = readDotPath(positionData(input.position), 'id.object_id');
    if (eventObjectId !== input.targetObject.id) {
      // Wrong object for this edge — the trigger filter let an event
      // through that doesn't match this traversal's target. Empty
      // traversal is the right "no-op" semantics; the caller's
      // remaining traversals continue.
      return [];
    }

    const recordId = readDotPath(positionData(input.position), 'id.record_id');
    if (typeof recordId !== 'string' || recordId.length === 0) {
      logger.warn('[AttioAdapter.getRelated] webhook event missing id.record_id', {
        targetObjectName: input.targetObject.name,
      });
      return [];
    }

    // The emitted record position is named by the target object's display
    // name (the framework identity); the API fetch uses its slug/UUID.
    const targetTypeId = input.targetObject.name;
    const fetchObjectId = input.targetObject.slug ?? input.targetObject.id;
    const cacheKey = `${this.adapterType}:${targetTypeId}:${recordId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];

    try {
      const client = await this.getApiClient();
      const record = await client.getRecord({ objectId: fetchObjectId, recordId });
      const position: SourcePosition = makeStablePosition({
        adapterType: this.adapterType,
        recordType: targetTypeId,
        recordId: record.id.record_id,
        data: record.values,
      });
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to fetch record for event', {
        targetTypeId,
        recordId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** True when a position's record type is a list entry — the generic
   *  list-entry meta type (natural `List Entry` or the internal sentinel), or
   *  a per-list type (its display name resolves to a known list). Gates the
   *  list-entry → parent record back-edge and the entry-scoped attachables. */
  private async isListEntryRecordType(recordType: string | null): Promise<boolean> {
    if (recordType === null) return false;
    if ((await this.resolveTypeRef(recordType)) === ATTIO_LIST_ENTRY_TYPE_ID) return true;
    return (await this.structuredListFor(recordType)) !== undefined;
  }

  /**
   * Resolve a list entry's `-[:<Object>]->` back-edge to the record it sits on.
   * HONEST resolution: the entry carries `parent_record_id` + `parent_object`,
   * and only the edge whose object matches `parent_object` resolves — every
   * other object edge (and an entry whose parent object we can't confirm)
   * yields `[]` rather than fetching the wrong-typed record. The materialized
   * position is the parent record, named by the object's display name.
   */
  private async getRecordForListEntry(input: {
    position: SourcePosition;
    targetObject: AttioObjectInfo;
  }): Promise<RelatedResult[]> {
    const data = positionData(input.position);
    const parentRecordId = readDotPath(data, 'parent_record_id');
    const parentObject = readDotPath(data, 'parent_object');
    if (typeof parentRecordId !== 'string' || parentRecordId.length === 0) return [];

    const obj = input.targetObject;
    const matchesObject =
      typeof parentObject === 'string' &&
      (parentObject === obj.slug || parentObject === obj.id || parentObject === obj.name);
    if (!matchesObject) return [];

    const targetTypeId = obj.name;
    const fetchObjectId = obj.slug ?? obj.id;
    const cacheKey = `${this.adapterType}:${targetTypeId}:${parentRecordId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];

    try {
      const client = await this.getApiClient();
      const record = await client.getRecord({ objectId: fetchObjectId, recordId: parentRecordId });
      const position: SourcePosition = makeStablePosition({
        adapterType: this.adapterType,
        recordType: targetTypeId,
        recordId: record.id.record_id,
        data: record.values,
      });
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to fetch record for list entry', {
        targetTypeId,
        parentRecordId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Resolve `webhook-event → -[:List]->`. The event payload carries
   * `id.list_id`; we materialize a synthetic `attio:list` position with
   * the list's id + name. Used for traversals like `-[:List]->.name`.
   * Looks the list up in the workspace catalog; missing or stale lists
   * yield an empty traversal.
   */
  private async getListForEvent(input: {
    position: SourcePosition;
  }): Promise<RelatedResult[]> {
    const listId = readDotPath(positionData(input.position), 'id.list_id');
    if (typeof listId !== 'string' || listId.length === 0) {
      return [];
    }

    const cacheKey = `${this.adapterType}:${ATTIO_LIST_TYPE_ID}:${listId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];

    try {
      const client = await this.getApiClient();
      const lists = await client.listLists();
      const list = lists.find((l) => l.id === listId);
      if (!list) return [];
      const position: SourcePosition = makeStablePosition({
        adapterType: this.adapterType,
        // NATURAL name — the internal sentinel (`attio:list`) drifts at
        // resolveFieldId, which keys its maps by displayName.
        recordType: (await this.resolver()).naturalTypeName(ATTIO_LIST_TYPE_ID),
        recordId: list.id,
        data: { id: list.id, name: list.name },
      });
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to resolve list for event', {
        listId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Resolve `webhook-event → -[:Entry]->`. The event payload carries
   * `id.list_id` + `id.entry_id`; we fetch the full list entry and
   * materialize a synthetic `attio:list_entry` position.
   */
  private async getEntryForEvent(input: {
    position: SourcePosition;
    /** The list this hop names. The entry lands typed as this list's per-list
     *  type (so its one parent up-hop is reachable), and the event must be for
     *  THIS list — a mismatch yields `[]`, like a mismatched record edge. */
    targetList: AttioListInfo;
  }): Promise<RelatedResult[]> {
    const listId = readDotPath(positionData(input.position), 'id.list_id');
    const entryId = readDotPath(positionData(input.position), 'id.entry_id');
    if (
      typeof listId !== 'string' || listId.length === 0 ||
      typeof entryId !== 'string' || entryId.length === 0
    ) {
      return [];
    }
    // Gate on the named list matching the event's list (symmetric with the
    // per-object record edge's `parent_object` match).
    if (listId !== input.targetList.id) return [];
    const cacheKey = `${this.adapterType}:${input.targetList.name}:${entryId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];
    try {
      const client = await this.getApiClient();
      const entry = await client.getListEntry({ listId, entryId });
      const position: SourcePosition = makeStablePosition({
        adapterType: this.adapterType,
        // The PER-LIST type name (`VC Deal Flow`), so the checker's
        // `-[:<Object>]->` parent hop types against that list's single parent
        // and `isListEntryRecordType` still recognizes it (via structuredListFor).
        recordType: input.targetList.name,
        recordId: entryId,
        // Flat shape: parent_record_id + parent_object + created_at at top
        // level, entry's own attribute values nested in `entry_values` (the
        // adapter's external-record getFieldValue path will read them
        // out of `data` directly without the Attio array-unwrapping
        // since list_entry's recordType isn't a real object slug). The
        // parent keys come AFTER the spread so a same-named entry value can't
        // shadow the record → object back-hop. `list_id` rides along so the
        // entry's `Comments` edge can scope its thread read
        // (GET /v2/threads?entry_id=…&list=…) without a second lookup.
        data: {
          created_at: entry.created_at,
          ...entry.values,
          parent_record_id: entry.parent_record_id,
          parent_object: entry.parent_object ?? null,
          list_id: listId,
        },
      });
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to resolve entry for event', {
        listId,
        entryId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Resolve `webhook-event → -[:Task]->` via GET /v2/tasks/{id}. */
  private async getTaskForEvent(input: {
    position: SourcePosition;
  }): Promise<RelatedResult[]> {
    const taskId = readDotPath(positionData(input.position), 'id.task_id');
    if (typeof taskId !== 'string' || taskId.length === 0) return [];
    const cacheKey = `${this.adapterType}:${ATTIO_TASK_TYPE_ID}:${taskId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];
    try {
      const client = await this.getApiClient();
      const task = await client.getTask({ taskId });
      // The shared minter stamps the NATURAL recordType — an event-hop Task
      // must read identically to a root-read Task.
      const position = await this.taskPosition(task);
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to resolve task for event', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Resolve `webhook-event → -[:Note]->` via GET /v2/notes/{id}. */
  private async getNoteForEvent(input: {
    position: SourcePosition;
  }): Promise<RelatedResult[]> {
    const noteId = readDotPath(positionData(input.position), 'id.note_id');
    if (typeof noteId !== 'string' || noteId.length === 0) return [];
    const cacheKey = `${this.adapterType}:${ATTIO_NOTE_TYPE_ID}:${noteId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];
    try {
      const client = await this.getApiClient();
      const note = await client.getNote({ noteId });
      // Shared minter — natural recordType, same shape as the root read.
      const position = await this.notePosition(note);
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to resolve note for event', {
        noteId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Resolve `webhook-event → -[:Comment]->` via GET /v2/comments/{id}. */
  private async getCommentForEvent(input: {
    position: SourcePosition;
  }): Promise<RelatedResult[]> {
    const commentId = readDotPath(positionData(input.position), 'id.comment_id');
    if (typeof commentId !== 'string' || commentId.length === 0) return [];
    const cacheKey = `${this.adapterType}:${ATTIO_COMMENT_TYPE_ID}:${commentId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];
    try {
      const client = await this.getApiClient();
      const comment = await client.getComment({ commentId });
      // Shared minter — natural recordType, author actor resolved to email.
      const position = await this.commentPosition(comment);
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to resolve comment for event', {
        commentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Look up an Attio object by its display name (`"Companies"`). The
   * catalog is keyed by UUID, so we scan values; size is small enough
   * (one entry per object type, typically tens) that a linear scan is
   * fine. Warms the catalog on first call. Returns null when the name
   * doesn't match any object — caller decides whether that's an error.
   */
  private async findObjectByDisplayName(
    displayName: string,
  ): Promise<AttioObjectInfo | null> {
    if (!objectCatalogCache.get(this.teamId)) {
      await this.warmCatalogs();
    }
    const catalog = objectCatalogCache.get(this.teamId);
    if (!catalog) return null;
    for (const obj of catalog.values()) {
      if (obj.name === displayName) return obj;
    }
    return null;
  }

  /**
   * Resolve a per-list edge name on an external-record position to
   * the matching list. The edge name is the list's display name
   * ("Hot Leads"); the match is scoped to lists whose
   * `parent_object` includes the record's object slug so a record
   * can't accidentally traverse a list of a different parent.
   * Returns null when no list matches — caller falls through to the
   * record-reference path which will throw a clear error.
   */
  private async findPerListEdgeByName(input: {
    recordType: string | null;
    edgeName: string;
  }): Promise<AttioListInfo | null> {
    if (!listsCache.get(this.teamId)) {
      await this.warmCatalogs();
    }
    const lists = listsCache.get(this.teamId) ?? [];
    if (input.recordType === null) return null;
    // Resolve the record's object slug from its NATURAL recordType (the
    // object's display name); per-list scoping keys on slug.
    const recordSlug = await this.resolveObjectSlugFromRecordType(
      input.recordType,
    );
    if (!recordSlug) return null;
    return (
      lists.find(
        (l) =>
          l.parentObjectSlugs.includes(recordSlug) && l.name === input.edgeName,
      ) ?? null
    );
  }

  /** Map a record's NATURAL `recordType` (the object's display name) back to
   *  the underlying Attio object UUID via the private name cache. */
  private async resolveObjectIdFromRecordType(
    recordType: string,
  ): Promise<string | null> {
    return (await this.structuredIdFor(recordType))?.id ?? null;
  }

  /** Same as `resolveObjectIdFromRecordType` but returns the slug. Used
   *  for matching against `list.parentObjectSlugs` (which is slug-keyed
   *  per Attio's API). */
  private async resolveObjectSlugFromRecordType(
    recordType: string,
  ): Promise<string | null> {
    return (await this.structuredIdFor(recordType))?.slug ?? null;
  }

  /**
   * Materialize the entries of a record in a list. One position per
   * entry, recordType = the per-list synthetic type id, data = the
   * entry's `entry_values` so per-list field reads (`-[:Hot Leads]->.Stage`)
   * work without an extra fetch. Per-fetch cached so repeated
   * traversals within a single TG evaluation don't re-query.
   */
  private async getListEntriesForRecord(input: {
    record: SourcePosition;
    list: AttioListInfo;
  }): Promise<RelatedResult[]> {
    const recordId = positionRecordId(input.record) ?? '';
    const cacheKey = `${this.adapterType}:list-entries:${input.list.id}:${recordId}`;
    const cached = this.fetchCache.get(cacheKey);
    // Cached single position only when there's one — otherwise re-fetch.
    if (cached) return [{ position: cached }];

    try {
      const client = await this.getApiClient();
      const entries = await client.queryListEntriesForRecord({
        listId: input.list.id,
        recordId,
      });
      const recordType = input.list.name;
      // These entries all sit on `input.record`, so its object is their parent
      // object — stamp it (plus the parent record id) so the entry can hop back
      // up via its `record` edge. Fall back to the entry's own `parent_object`
      // when the record's object slug can't be resolved.
      const recordSlug = await this.resolveObjectSlugFromRecordType(
        input.record.recordType ?? '',
      );
      const results: RelatedResult[] = entries.map((entry) => {
        const position: SourcePosition = makeStablePosition({
          adapterType: this.adapterType,
          recordType,
          recordId: entry.entryId,
          data: {
            ...entry.entryValues,
            parent_record_id: entry.parentRecordId,
            parent_object: recordSlug ?? entry.parentObject ?? null,
          },
        });
        return { position };
      });
      // Cache only when a single entry — otherwise we'd lose the
      // others on cache hit. Common case in CRMs is one entry per
      // (record, list) so this is the hot path.
      if (results.length === 1) {
        this.fetchCache.set(cacheKey, results[0].position);
      }
      return results;
    } catch (err) {
      logger.warn('[AttioAdapter.getRelated] failed to fetch list entries for record', {
        listId: input.list.id,
        recordId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── 6a. Opaque-id translation ───────────────────────────────────────────

  /**
   * Render an opaque Attio id (object UUID, list UUID, attribute UUID) as
   * its human-readable name. Powers the editor when migrating an old
   * UUID-shaped AST to its display form, and the runtime translation in
   * `getFieldValue`. Returns null when the id isn't recognized — caller
   * decides whether to fall back to the raw UUID or surface a warning.
   */
  async describeOpaqueId(input: {
    fieldPath: string;
    value: string;
  }): Promise<string | null> {
    // Accepts both the new clean field names (`Object`, `List`) and
    // the legacy Attio-payload paths so old AST values still render
    // through the picker label resolver.
    if (input.fieldPath === 'Object' || input.fieldPath === 'id.object_id') {
      return this.translateObjectIdToName(input.value);
    }
    if (input.fieldPath === 'List' || input.fieldPath === 'id.list_id') {
      return this.translateListIdToName(input.value);
    }
    return null;
  }

  /** Object UUID → display name. Warms the catalog on first call;
   *  subsequent lookups are O(1) against the cache. */
  private async translateObjectIdToName(
    objectId: string,
  ): Promise<string | null> {
    if (!objectCatalogCache.get(this.teamId)) {
      await this.warmCatalogs();
    }
    const obj = objectCatalogCache.get(this.teamId)?.get(objectId);
    return obj?.name ?? null;
  }

  /** List UUID → display name. Always hits the API on a cache miss
   *  because lists aren't held in a long-lived module cache today;
   *  `getRelated` for the List edge already does this lookup, so the
   *  per-fetch cache absorbs repeated calls inside one evaluation. */
  private async translateListIdToName(listId: string): Promise<string | null> {
    try {
      const client = await this.getApiClient();
      const lists = await client.listLists();
      const match = lists.find((l) => l.id === listId);
      return match?.name ?? null;
    } catch (err) {
      logger.warn('[AttioAdapter.translateListIdToName] failed to resolve list', {
        listId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Resolve every Attio list a record currently belongs to. Iterates the
   * workspace's lists and queries each for entries with parent_record_id
   * matching the record. N+1 in list-count today — fine for typical
   * workspaces (tens of lists) and per-fetch cached so repeated traversal
   * within one evaluation reuses the result.
   */
  private async getListMemberships(input: {
    record: SourcePosition;
  }): Promise<RelatedResult[]> {
    const client = await this.getApiClient();
    const lists = await client.listLists();
    const recordId = positionRecordId(input.record) ?? '';

    const results: RelatedResult[] = [];
    for (const list of lists) {
      const cacheKey = `${this.adapterType}:list-membership:${list.id}:${recordId}`;
      const cached = this.fetchCache.get(cacheKey);
      if (cached) {
        results.push({ position: cached });
        continue;
      }

      const member = await client.isRecordInList({
        listId: list.id,
        recordId,
      });
      if (!member) continue;

      const position: SourcePosition = makeStablePosition({
        adapterType: this.adapterType,
        // NATURAL name, matching every other List position this adapter mints.
        recordType: (await this.resolver()).naturalTypeName(ATTIO_LIST_TYPE_ID),
        recordId: list.id,
        data: { id: list.id, name: list.name },
      });
      this.fetchCache.set(cacheKey, position);
      results.push({ position });
    }
    return results;
  }

  // ── 6b. Filter pushdown ─────────────────────────────────────────────────

  /**
   * Translate a filter expression into Attio's native query shape.
   *
   * Patterns recognized:
   *   • `static: true` (or absent caller) → `{ kind: 'all' }`
   *   • `EXISTS({ steps: [{ edge: __list_membership }], where: list.name = X })`
   *     → resolves the list by name → `{ kind: 'list', listId }`
   *   • `EXISTS({ steps: [{ edge: __list_membership }], where: list.id = X })`
   *     → uses listId directly
   *
   * Anything else returns the original expression as `residual` — the
   * framework throws by default unless the caller opts into client-side
   * fallback. Loud failure prevents the "fetch a million records to filter
   * in memory" footgun.
   */
  async translateFilter(input: {
    expression: Expression;
    entityType: string;
  }): Promise<FilterTranslationResult> {
    const expr = input.expression;

    // No filter / true predicate → all records
    if (expr.type === 'static' && expr.value === true) {
      return { native: { kind: 'all' } satisfies AttioNativeFilter, residual: null };
    }

    // EXISTS list-membership pattern
    if (expr.type === 'exists' && expr.steps.length === 1) {
      const step = expr.steps[0];
      if (
        step.type === 'edge' &&
        step.edgeTypeId === ATTIO_LIST_MEMBERSHIP_FIELD &&
        step.direction === 'outgoing'
      ) {
        const where = expr.where;
        const listId = await this.resolveListIdFromPredicate(where);
        if (listId) {
          return {
            native: { kind: 'list', listId } satisfies AttioNativeFilter,
            residual: null,
          };
        }
      }
    }

    // Equality conjuncts → a records-query filter (chunk 7). Conservative on
    // purpose: a pushed filter must never UNDER-fetch (the engine satisfies the
    // predicate over what comes back, but can't recover records the API never
    // returned). So we push only top-level AND-ed `field == value` conjuncts
    // whose field resolves to a real attribute slug; everything else (ranges,
    // IN, OR, WITHIN, impure) stays in the residual for the engine to satisfy.
    const records = await this.pushdownEqualityFilter(expr, input.entityType);
    if (records !== undefined) {
      return { native: { kind: 'records', filter: records.filter }, residual: records.residual };
    }

    // Default: nothing pushed down. Framework throws unless caller opts in.
    return {
      native: { kind: 'all' } satisfies AttioNativeFilter,
      residual: expr,
    };
  }

  /**
   * Build a records-query filter from the top-level AND-ed `field == value`
   * conjuncts of a WHERE, mapping each field to its Attio attribute slug via
   * the resolver and typing the predicate via the object's attributes (reusing
   * the same builders `resolveEntity` uses in production). Returns `undefined`
   * when nothing equality-shaped is pushable. The residual carries the
   * conjuncts that weren't pushed.
   */
  private async pushdownEqualityFilter(
    expr: Expression,
    entityType: string,
  ): Promise<{ filter: Record<string, unknown>; residual: Expression | null } | undefined> {
    const conjuncts = flattenAndConjuncts(expr);
    const { attrBySlug, slugForField } = await this.attrTypesForObject(entityType);

    const entries: { propTypeId: string; value: unknown; fuzzy: boolean }[] = [];
    const residualConjuncts: Expression[] = [];
    for (const c of conjuncts) {
      // Resolve the WHERE field (written as a slug OR a display name) to its
      // attribute slug. Only a real attribute, an `eq`, and a literal RHS are
      // safe to push — anything else stays in the residual so the engine
      // satisfies it (never under-fetch).
      const slug =
        c.type === 'compare' &&
        c.op === 'eq' &&
        (c.left.type === 'property' || c.left.type === 'edge_property') &&
        c.right.type === 'static'
          ? slugForField.get(naturalName(c.left.propertyTypeId))
          : undefined;
      if (slug !== undefined && c.type === 'compare' && c.right.type === 'static') {
        entries.push({ propTypeId: slug, value: c.right.value, fuzzy: false });
      } else {
        residualConjuncts.push(c);
      }
    }
    if (entries.length === 0) return undefined;

    const filter = buildAttioBranchFilter(entries, attrBySlug, []);
    const residual: Expression | null =
      residualConjuncts.length === 0
        ? null
        : residualConjuncts.length === 1
          ? residualConjuncts[0]
          : { type: 'logical', op: 'and', operands: residualConjuncts };
    return { filter, residual };
  }

  /**
   * For one object type: attribute slug → { type } (the typing
   * `buildAttioPredicate` needs), plus a field-name → slug map keyed by both
   * the slug and the display name (normalised), so a WHERE field written either
   * way resolves to the slug.
   */
  private async attrTypesForObject(entityType: string): Promise<{
    attrBySlug: Map<string, { type: string }>;
    slugForField: Map<string, string>;
  }> {
    const attrBySlug = new Map<string, { type: string }>();
    const slugForField = new Map<string, string>();
    // `entityType` is the object's NATURAL name — recover its structured id
    // from the private cache.
    const obj = await this.structuredIdFor(entityType);
    if (!obj) return { attrBySlug, slugForField };
    const client = await this.getApiClient();
    const attrs = await client.listAttributes({ objectId: obj.id });
    for (const attr of attrs) {
      const slug = attr.apiSlug ?? attr.id;
      attrBySlug.set(slug, { type: attr.type });
      slugForField.set(naturalName(slug), slug);
      if (attr.name) slugForField.set(naturalName(attr.name), slug);
    }
    return { attrBySlug, slugForField };
  }

  /** Internal: read a list id out of a `list.name = X` or `list.id = X`
   *  predicate inside an EXISTS body. Returns null when the predicate
   *  shape isn't recognized. */
  private async resolveListIdFromPredicate(
    where: Expression | undefined,
  ): Promise<string | null> {
    if (!where) return null;
    if (where.type !== 'compare' || where.op !== 'eq') return null;

    // Normalize: predicate may be (property, static) or (static, property).
    const propSide =
      where.left.type === 'property' ? where.left
      : where.right.type === 'property' ? where.right
      : null;
    const staticSide =
      where.left.type === 'static' ? where.left
      : where.right.type === 'static' ? where.right
      : null;
    if (!propSide || !staticSide) return null;
    if (typeof staticSide.value !== 'string') return null;

    if (propSide.propertyTypeId === 'id') {
      return staticSide.value;
    }
    if (propSide.propertyTypeId === 'name') {
      const client = await this.getApiClient();
      const lists = await client.listLists();
      const match = lists.find((l) => l.name === staticSide.value);
      return match?.id ?? null;
    }
    return null;
  }

  // ── 4. Trigger implementations ──────────────────────────────────────────

  /**
   * Snapshot iterator. The framework calls this once per (pipelineInputId,
   * recordType, native-filter); it must yield one TriggerEvent per source
   * record.
   *
   * `recordType` is the entry's NATURAL object name (e.g. `People`); we
   * recover the slug/UUID the Attio REST API routes on from the private name
   * cache. `filter` carries the post-translateFilter native shape
   * (`AttioNativeFilter`); absence defaults to `{ kind: 'all' }`.
   */
  async *snapshot(input: SnapshotInput): AsyncIterable<TriggerEvent> {
    let offset: number | undefined = 0;
    do {
      const page = await this.snapshotPage(input, offset);
      yield* page.events;
      offset = page.nextOffset;
    } while (offset !== undefined);
  }

  /** One page of `snapshot` at `offset` — the shared unit of Attio's offset
   *  paging, so the trigger snapshot and a paged root read step identically.
   *  The page's listing is fetched up front; its events may be produced
   *  lazily (see `listEntriesSnapshotPage`). `nextOffset` is absent on the
   *  last page. */
  private async snapshotPage(
    input: SnapshotInput,
    offset: number,
  ): Promise<SnapshotPage> {
    const objectId = await this.objectApiIdFor(input.recordType, 'snapshot');
    const native: AttioNativeFilter = parseNativeFilter(input.filter);
    const client = await this.getApiClient();

    if (native.kind === 'all' || native.kind === 'records') {
      return this.recordsSnapshotPage({
        objectId,
        objectType: input.recordType,
        pipelineInputId: input.pipelineInputId,
        client,
        offset,
        ...(native.kind === 'records' ? { filter: native.filter } : {}),
      });
    }
    return this.listEntriesSnapshotPage({
      listId: native.listId,
      objectType: input.recordType,
      pipelineInputId: input.pipelineInputId,
      client,
      offset,
    });
  }

  private async recordsSnapshotPage(input: {
    objectId: string;
    objectType: string;
    pipelineInputId: string;
    client: AttioApiClient;
    offset: number;
    /** A pushed records-query filter (chunk 7) — scopes the fetch server-side
     *  so an unbounded collection WHERE never pages every record. */
    filter?: Record<string, unknown>;
  }): Promise<SnapshotPage> {
    const page =
      input.filter !== undefined
        ? await input.client.queryRecordsWithFilter({
            objectId: input.objectId,
            filter: input.filter,
            limit: SNAPSHOT_PAGE_SIZE,
            offset: input.offset,
          })
        : await input.client.queryRecordsPage({
            objectId: input.objectId,
            limit: SNAPSHOT_PAGE_SIZE,
            offset: input.offset,
          });
    const events = page.map((record) =>
      this.recordToTriggerEvent({
        objectType: input.objectType,
        recordId: record.id.record_id,
        values: record.values,
        pipelineInputId: input.pipelineInputId,
      }),
    );
    return { events, ...nextSnapshotOffset(input.offset, page.length) };
  }

  private async listEntriesSnapshotPage(input: {
    listId: string;
    objectType: string;
    pipelineInputId: string;
    client: AttioApiClient;
    offset: number;
  }): Promise<SnapshotPage> {
    const page = await input.client.queryListEntriesPage({
      listId: input.listId,
      limit: SNAPSHOT_PAGE_SIZE,
      offset: input.offset,
    });
    return { events: this.hydrateListEntries(input, page), ...nextSnapshotOffset(input.offset, page.length) };
  }

  /**
   * Each list entry references a parent record; fetch it for full data — one
   * fetch per event as it is READ, so a consumer that stops early (a LIMIT 1
   * traversal) doesn't hydrate the rest of the page. N+1 — fine for backfill
   * latency, batchable later. An entry with no parent reference can't
   * hydrate a record — skip it.
   */
  private async *hydrateListEntries(
    input: { listId: string; objectType: string; pipelineInputId: string; client: AttioApiClient },
    entries: Awaited<ReturnType<AttioApiClient['queryListEntriesPage']>>,
  ): AsyncIterable<TriggerEvent> {
    for (const entry of entries) {
      if (entry.parentObjectId === null || entry.parentRecordId === null) continue;
      try {
        const record = await input.client.getRecord({
          objectId: entry.parentObjectId,
          recordId: entry.parentRecordId,
        });
        yield this.recordToTriggerEvent({
          objectType: input.objectType,
          recordId: record.id.record_id,
          values: record.values,
          pipelineInputId: input.pipelineInputId,
        });
      } catch (err) {
        logger.warn('[AttioAdapter.snapshot] failed to fetch list-entry parent record', {
          listId: input.listId,
          entryId: entry.entryId,
          parentRecordId: entry.parentRecordId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private recordToTriggerEvent(input: {
    objectType: string;
    recordId: string;
    values: Record<string, unknown>;
    pipelineInputId: string;
  }): TriggerEvent {
    return {
      pipelineInputId: input.pipelineInputId,
      adapterType: this.adapterType,
      objectType: input.objectType,
      triggerType: 'snapshot',
      payload: makeStablePosition({
        adapterType: this.adapterType,
        recordType: input.objectType,
        recordId: input.recordId,
        data: input.values,
      }),
      occurredAt: new Date().toISOString(),
    };
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  /**
   * Translate a write's NATURAL names to this adapter's internal currency on
   * the first line of each write method: `recordType` (type displayName) →
   * internal typeId (`attio:<slug>`); `fields` keys (field displayNames) →
   * attribute slugs; each parent link's `recordType` → internal typeId and
   * `edgeName` (edge displayName) → the write-edge currency (`edgeWriteName`,
   * which for Attio is the reference attribute slug). The downstream write
   * helpers (`objectApiIdFor`, `partitionFileFields`, `classifyParentLink`)
   * all consume this internal shape.
   */
  private async toInternalWrite<T extends WriteInput>(input: T): Promise<T> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const recordType = await this.resolveTypeRef(input.recordType);
    const naturalType = naturalName(input.recordType);

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.fields)) {
      fields[resolver.tryFieldId(naturalType, naturalName(key)) ?? key] = value;
    }

    const translateParent = async (link: { recordType: string; externalId: string; edgeName: string }) => ({
      // The parent's type name resolves against THIS adapter's entries
      // (the edge belongs to the from/parent side's type); `resolveTypeRef`
      // accepts a natural name or an already-internal id.
      recordType: await this.resolveTypeRef(link.recordType),
      externalId: link.externalId,
      edgeName:
        resolver.tryEdgeWriteName(naturalName(link.recordType), naturalName(link.edgeName)) ??
        link.edgeName,
    });
    const parentLinks = input.parentLinks
      ? await Promise.all(input.parentLinks.map(translateParent))
      : undefined;

    return { ...input, recordType, fields, parentLinks };
  }

  /**
   * Coerce author-provided values for `actor-reference` ("User") fields into
   * Attio's write shape. Authors set these by EMAIL — a literal, or a meta
   * value like `@actor_email` / `@user_email` — and Attio's API expects
   * `[{ referenced_actor_type: 'workspace-member', referenced_actor_id }]`. We
   * resolve each email to a workspace member (case-insensitive). An email that
   * matches no member is dropped with a warning rather than sent as a broken
   * value (e.g. an external sender's address can't own a record — the author
   * should use `@user_email`, the responsible team member, for an owner field).
   * Mutates `fields` in place. No-op — and no workspace-member fetch — when the
   * write touches no actor-reference field.
   */
  private async coerceActorReferenceFields(
    recordType: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const { attrBySlug } = await this.attrTypesForObject(recordType);
    const actorSlugs = Object.keys(fields).filter(
      (slug) => attrBySlug.get(slug)?.type === 'actor-reference',
    );
    if (actorSlugs.length === 0) return;

    const client = await this.getApiClient();
    const members = await client.listWorkspaceMembers();
    const idByEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.id]));

    for (const slug of actorSlugs) {
      const raw = fields[slug];
      if (raw == null) continue;
      const emails = Array.isArray(raw) ? raw : [raw];
      const refs: { referenced_actor_type: 'workspace-member'; referenced_actor_id: string }[] = [];
      for (const email of emails) {
        if (typeof email !== 'string' || email.trim() === '') continue;
        const memberId = idByEmail.get(email.trim().toLowerCase());
        if (!memberId) {
          logger.warn(
            '[AttioAdapter] actor-reference email did not match a workspace member; dropping value',
            { recordType, field: slug, email },
          );
          continue;
        }
        refs.push({ referenced_actor_type: 'workspace-member', referenced_actor_id: memberId });
      }
      if (refs.length > 0) fields[slug] = refs;
      else delete fields[slug];
    }
  }

  async createRecord(rawInput: WriteInput): Promise<WriteResult> {
    const input = await this.toInternalWrite(rawInput);
    // Per-list types (named by the list's display name) write a list entry
    // attaching the parent record to that list. The lone parent link carries
    // the parent record's externalId + recordType (which we resolve back to
    // its parent_object UUID for the POST body).
    const perList = await this.structuredListFor(input.recordType);
    if (perList) {
      return this.createPerListEntry(input, perList);
    }

    // `write <record>-[:Lists]-> { listName: "…" }` — add the parent record to
    // a NAMED list. The write target type is the generic `List` (the `Lists`
    // edge's target); the specific list rides the body (`listName`, a required
    // enum) because a WHERE on a write edge never reaches the adapter. Resolves
    // the list, then re-homes onto `createPerListEntry` (the record IS the
    // parent).
    if (
      input.recordType === ATTIO_LIST_TYPE_ID ||
      input.recordType.startsWith(ATTIO_LIST_MEMBERSHIP_PREFIX)
    ) {
      return this.createListMembershipFromWrite(input);
    }

    // Notes / Tasks / Comments attach to a record (the write's parent link)
    // but create through their own endpoints.
    if (input.recordType === ATTIO_NOTE_TYPE_ID) return this.createNoteFromWrite(input);
    if (input.recordType === ATTIO_TASK_TYPE_ID) return this.createTaskFromWrite(input);
    if (input.recordType === ATTIO_COMMENT_TYPE_ID) return this.createCommentFromWrite(input);
    if (input.recordType === ATTIO_FILE_TYPE_ID) return this.createFileFromWrite(input);
    // The legacy generic list-entry type is no longer published writable
    // (list writes go through the dynamic PER-LIST entry types, handled by
    // createPerListEntry above) — an author reaching here bypassed the schema.
    if (input.recordType === ATTIO_LIST_ENTRY_TYPE_ID) {
      throw new Error(
        `AttioAdapter.createRecord: the generic "List Entry" type is not writable — ` +
          `write to the specific list's own entry type instead (each list appears as ` +
          `its own writable type in the schema).`,
      );
    }

    const client = await this.getApiClient();
    const objectId = await this.objectApiIdFor(input.recordType, 'createRecord');
    // File-kind values can't ride the records values envelope — Attio's
    // /v2/files/upload attaches files to a record as a whole and requires
    // the record to already exist. Split them out, create the record from the
    // remaining fields, then upload each file against the new record id.
    const { recordFields, fileRefs } = partitionFileFields(input.fields);
    // Record→record relationships (e.g. Person → Company): wire every edge
    // the record was authored under — one for an ordinary linked write, N
    // for a tuple-path multi-parent create. References living on the CHILD
    // fold into this create's payload (N reference fields on one POST);
    // references living on the PARENT link after the create.
    const links: ParentLinkClassification[] = [];
    for (const parentLink of writeParentLinks(input)) {
      const link = await this.classifyParentLink({
        childRecordType: input.recordType,
        parentLink,
      });
      if (link) links.push(link);
    }
    for (const link of links) {
      if (link.kind === 'child-ref') recordFields[link.fieldSlug] = link.value;
    }
    await this.coerceActorReferenceFields(input.recordType, recordFields);
    const record = await client.createRecord({ objectId, fields: recordFields });
    for (const link of links) {
      if (link.kind === 'parent-ref') {
        await this.linkParentReference({ link, childRecordId: record.id.record_id });
      }
    }
    await this.uploadFileRefs({
      objectSlug: objectId,
      recordId: record.id.record_id,
      fileRefs,
    });
    const data = flattenAttioRecordValues(record.values as Record<string, unknown>);
    if (record.web_url) data.url = record.web_url;
    return {
      adapterType: ATTIO_ADAPTER_TYPE,
      externalId: record.id.record_id,
      url: record.web_url ?? undefined,
      data,
    };
  }

  /**
   * Upload each `FileRef`-valued field's bytes to an existing Attio record via
   * /v2/files/upload. Attio's file model is record-level, not per-attribute:
   * the upload form carries `object` + `record_id` (not an attribute slug), so
   * the file attaches to the record and the attribute name a `file`-kind field
   * was mapped to is not addressable here. No-op when there are no file refs.
   *
   * Attio file-on-write (file-as-attribute)
   */
  private async uploadFileRefs(input: {
    objectSlug: string;
    recordId: string;
    fileRefs: FileRef[];
  }): Promise<void> {
    if (input.fileRefs.length === 0) return;
    const client = await this.getApiClient();
    for (const ref of input.fileRefs) {
      const blob = await fileRefToBlob(ref, this.teamId);
      await client.uploadFile({
        file: blob.body,
        fileName: blob.fileName,
        objectSlug: input.objectSlug,
        recordId: input.recordId,
      });
    }
  }

  /**
   * Write a list entry. The list is resolved (by the action's NATURAL
   * `recordType`, the list's display name) by the caller and handed in;
   * resolves the parent record's `parent_object` from the lone parent link's
   * recordType (must be a record action — list entries can only attach to
   * records).
   */
  /** Required-string accessor for the note/task/comment creates: the schema
   *  marks these fields `required`, but a movement can still produce a blank
   *  at runtime — reject it with the field's name rather than sending Attio
   *  an invalid body. */
  private requireStringField(input: WriteInput, fieldId: string): string {
    const raw = input.fields[fieldId];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      throw new Error(
        `AttioAdapter.createRecord(${input.recordType}): field "${fieldId}" is required and must be a non-empty string.`,
      );
    }
    return value;
  }

  /** The single record a note/comment attaches to, from the write's parent
   *  link, resolved to Attio's (object slug, record id) pair. */
  private async requireAttachmentParent(
    input: WriteInput,
    what: string,
  ): Promise<{ objectSlug: string; recordId: string }> {
    const parents = writeParentLinks(input);
    if (parents.length !== 1) {
      throw new Error(
        parents.length === 0
          ? `AttioAdapter.createRecord(${input.recordType}): ${what} must be authored as a child of a record action — the parent link supplies the record it attaches to.`
          : `AttioAdapter.createRecord(${input.recordType}): ${what} attaches to exactly ONE record — it cannot carry ${parents.length} parent links.`,
      );
    }
    const parent = parents[0];
    const objectSlug = await this.resolveObjectSlugFromRecordType(parent.recordType);
    if (!objectSlug) {
      throw new Error(
        `AttioAdapter.createRecord(${input.recordType}): parent action's recordType "${parent.recordType}" doesn't resolve to a known Attio object.`,
      );
    }
    return { objectSlug, recordId: parent.externalId };
  }

  /** POST /v2/notes — parent record from the write's parent link, title +
   *  content from the write's fields. */
  private async createNoteFromWrite(input: WriteInput): Promise<WriteResult> {
    const parent = await this.requireAttachmentParent(input, 'a note');
    const title = this.requireStringField(input, 'title');
    const content = this.requireStringField(input, 'content_plaintext');
    const client = await this.getApiClient();
    const note = await client.createNote({
      parentObject: parent.objectSlug,
      parentRecordId: parent.recordId,
      title,
      content,
      format: 'plaintext',
    });
    return {
      adapterType: ATTIO_ADAPTER_TYPE,
      externalId: note.id.note_id,
      data: {
        title,
        content_plaintext: content,
        parent_object: parent.objectSlug,
        parent_record_id: parent.recordId,
      },
    };
  }

  /** POST /v2/files/upload — `write record-[:Files]->` attaches the File
   *  field's bytes to the parent record. Mirrors the Note/Task/Comment shape:
   *  a parent-linked create through its own endpoint. */
  private async createFileFromWrite(input: WriteInput): Promise<WriteResult> {
    const parent = await this.requireAttachmentParent(input, 'a file');
    const value = input.fields['data'];
    if (!isFileValue(value)) {
      throw new Error(
        `AttioAdapter.createRecord(File): the "File" field must carry a file value ` +
          `(an attachment's \`File\` read, or FILE(...)) — got ${typeof value}.`,
      );
    }
    const blob = await fileRefToBlob(value, this.teamId);
    const client = await this.getApiClient();
    const uploaded = await client.uploadFile({
      file: blob.body,
      fileName: blob.fileName,
      objectSlug: parent.objectSlug,
      recordId: parent.recordId,
    });
    return {
      adapterType: ATTIO_ADAPTER_TYPE,
      externalId: uploaded.fileId,
      data: {
        id: uploaded.fileId,
        name: uploaded.name,
        contentType: uploaded.contentType,
        parent_object: parent.objectSlug,
        parent_record_id: parent.recordId,
      },
    };
  }

  /** POST /v2/tasks — every parent link becomes a linked record (Attio tasks
   *  link N records); content required, deadline optional. */
  private async createTaskFromWrite(input: WriteInput): Promise<WriteResult> {
    const content = this.requireStringField(input, 'content_plaintext');
    const linkedRecords: { targetObject: string; targetRecordId: string }[] = [];
    for (const parent of writeParentLinks(input)) {
      const objectSlug = await this.resolveObjectSlugFromRecordType(parent.recordType);
      if (!objectSlug) {
        throw new Error(
          `AttioAdapter.createRecord(${input.recordType}): parent action's recordType "${parent.recordType}" doesn't resolve to a known Attio object.`,
        );
      }
      linkedRecords.push({ targetObject: objectSlug, targetRecordId: parent.externalId });
    }
    const rawDeadline = input.fields['deadline_at'];
    const deadlineAt =
      rawDeadline instanceof Date
        ? rawDeadline.toISOString()
        : typeof rawDeadline === 'string' && rawDeadline.trim() !== ''
          ? rawDeadline.trim()
          : null;
    const client = await this.getApiClient();
    const task = await client.createTask({
      content,
      assignees: [],
      linkedRecords,
      deadlineAt,
    });
    return {
      adapterType: ATTIO_ADAPTER_TYPE,
      externalId: task.id.task_id,
      data: {
        content_plaintext: content,
        ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
        is_completed: false,
      },
    };
  }

  /** POST /v2/comments — Attio requires a workspace-member author, set by
   *  EMAIL (the `author` field; `@user_email` is the natural mapping). Target
   *  is the parent record's thread (new) or an explicit `thread_id` (reply). */
  private async createCommentFromWrite(input: WriteInput): Promise<WriteResult> {
    const content = this.requireStringField(input, 'content_plaintext');
    const authorEmail = this.requireStringField(input, 'author');

    const client = await this.getApiClient();
    const members = await client.listWorkspaceMembers();
    const member = members.find(
      (m) => m.email.toLowerCase() === authorEmail.toLowerCase(),
    );
    if (!member) {
      throw new Error(
        `AttioAdapter.createRecord(${input.recordType}): author "${authorEmail}" does not match any Attio workspace member. Comments must be authored by a workspace member — map the "author" field to a member's email (e.g. @user_email).`,
      );
    }

    const rawThreadId = input.fields['thread_id'];
    const threadId =
      typeof rawThreadId === 'string' && rawThreadId.trim() !== ''
        ? rawThreadId.trim()
        : undefined;

    const comment = threadId
      ? await client.createComment({
          content,
          authorWorkspaceMemberId: member.id,
          threadId,
        })
      : await (async () => {
          const parent = await this.requireAttachmentParent(input, 'a comment');
          return client.createComment({
            content,
            authorWorkspaceMemberId: member.id,
            record: { object: parent.objectSlug, recordId: parent.recordId },
          });
        })();

    return {
      adapterType: ATTIO_ADAPTER_TYPE,
      externalId: comment.id.comment_id,
      data: {
        content_plaintext: comment.content_plaintext ?? content,
        ...(comment.thread_id ? { thread_id: comment.thread_id } : {}),
        ...(comment.created_at ? { created_at: comment.created_at } : {}),
      },
    };
  }

  /**
   * `write <record>-[:Lists]-> { listName: "VC Deal Flow" }` — the single
   * list-write surface on every object record. The write's subject (the parent
   * record) is the thing being added; the target list is NAMED in the body
   * under `ATTIO_LIST_NAME_FIELD` (the required write-only enum), never a WHERE
   * (a WHERE on a write edge is dropped by the engine before the adapter runs).
   * Resolves the list, strips the selector, and delegates to the shared
   * `createPerListEntry` (the record parent + `createListEntry` call). Any
   * remaining body fields would be list-scoped ENTRY VALUES — re-resolved
   * against the RESOLVED list's own attributes; today the generic `List` write
   * shape is CLOSED to `listName`, so the checker rejects extra fields (a
   * list's per-list entry schema can't be typed from the generic edge — see
   * plan 9's discriminated-write assessment), and this loop is a no-op in
   * practice. It stays so the adapter never silently drops a value that does
   * arrive (a non-checked path, or a future discriminated write shape).
   */
  private async createListMembershipFromWrite(input: WriteInput): Promise<WriteResult> {
    const rawListName = input.fields[ATTIO_LIST_NAME_FIELD];
    if (typeof rawListName !== 'string' || rawListName.trim() === '') {
      throw new Error(
        `AttioAdapter.createRecord: adding a record to a list needs the list named — set the ` +
          `"${ATTIO_LIST_NAME_FIELD}" field to the list's name ` +
          `(write <record>-[:Lists]-> { ${ATTIO_LIST_NAME_FIELD}: "VC Deal Flow" }).`,
      );
    }
    const list = await this.structuredListFor(rawListName.trim());
    if (!list) {
      throw new Error(
        `AttioAdapter.createRecord: no Attio list named "${rawListName.trim()}" — ` +
          `check the "${ATTIO_LIST_NAME_FIELD}" value against the workspace's lists.`,
      );
    }
    const resolver = await this.resolver({ types: [list.name] });
    const listType = naturalName(list.name);
    const entryValues: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.fields)) {
      if (key === ATTIO_LIST_NAME_FIELD) continue;
      entryValues[resolver.tryFieldId(listType, naturalName(key)) ?? key] = value;
    }
    return this.createPerListEntry({ ...input, fields: entryValues }, list);
  }

  private async createPerListEntry(input: WriteInput, list: AttioListInfo): Promise<WriteResult> {
    const parents = writeParentLinks(input);
    if (parents.length !== 1) {
      throw new Error(
        parents.length === 0
          ? `AttioAdapter.createRecord(${input.recordType}): list entries must be authored as a child of a record action — a parent link is required so we know which record to attach to.`
          : `AttioAdapter.createRecord(${input.recordType}): a list entry attaches exactly ONE record to the list — it cannot carry ${parents.length} parent links.`,
      );
    }
    const parentLink = parents[0];
    const parentObjectId = await this.resolveObjectIdFromRecordType(
      parentLink.recordType,
    );
    if (!parentObjectId) {
      throw new Error(
        `AttioAdapter.createRecord(${input.recordType}): parent action's recordType "${parentLink.recordType}" doesn't resolve to a known Attio object — can't populate parent_object on the list entry.`,
      );
    }
    const client = await this.getApiClient();
    const result = await client.createListEntry({
      listId: list.id,
      parentObjectId,
      parentRecordId: parentLink.externalId,
      entryValues: input.fields,
    });
    return { adapterType: ATTIO_ADAPTER_TYPE, externalId: result.entryId, data: {} };
  }

  /**
   * Classify a record→record `parentLink` so the right side carries the
   * reference. Attio reference attributes are single-directional, so the
   * edge the child was authored under (`parentLink.edgeName`) may live on
   * either object:
   *   • child-ref  — the attribute is on the CHILD, pointing at the parent
   *     (the canonical CRM shape, e.g. a Person's "Company"). Set during the
   *     child's own create/update.
   *   • parent-ref — the attribute is on the PARENT, pointing at the child
   *     (e.g. a Company's "Team"). Linked by updating the parent afterwards.
   * Returns null (with a warning) when the edge resolves to neither — the
   * record still writes, but the relationship is flagged rather than silent.
   */
  private async classifyParentLink(input: {
    childRecordType: string;
    parentLink: { recordType: string; externalId: string; edgeName: string };
  }): Promise<ParentLinkClassification | null> {
    const client = await this.getApiClient();
    const edge = input.parentLink.edgeName;
    const isRefAttr = (a: AttioAttribute) => matchesReferenceAttribute(a, edge);

    const childObjectId = await this.resolveObjectIdFromRecordType(input.childRecordType);
    const parentObjectSlug = await this.resolveObjectSlugFromRecordType(
      input.parentLink.recordType,
    );
    if (childObjectId && parentObjectSlug) {
      const childAttrs = await client.listAttributes({ objectId: childObjectId });
      const childRef = childAttrs.find(isRefAttr);
      if (childRef) {
        return {
          kind: 'child-ref',
          fieldSlug: childRef.apiSlug ?? childRef.id,
          value: [
            { target_object: parentObjectSlug, target_record_id: input.parentLink.externalId },
          ],
        };
      }
    }

    const parentObjectId = await this.resolveObjectIdFromRecordType(input.parentLink.recordType);
    const childObjectSlug = await this.resolveObjectSlugFromRecordType(input.childRecordType);
    if (parentObjectId && childObjectSlug) {
      const parentAttrs = await client.listAttributes({ objectId: parentObjectId });
      const parentRef = parentAttrs.find(isRefAttr);
      if (parentRef) {
        return {
          kind: 'parent-ref',
          parentObjectId,
          parentRecordId: input.parentLink.externalId,
          fieldSlug: parentRef.apiSlug ?? parentRef.id,
          isMulti: parentRef.isMulti,
          childObjectSlug,
        };
      }
    }

    logger.warn(
      `AttioAdapter: parentLink edge "${edge}" is not a record-reference attribute on ` +
        `either "${input.childRecordType}" or "${input.parentLink.recordType}" — ` +
        `the records were written but not linked.`,
    );
    return null;
  }

  /**
   * Case `parent-ref`: link the child onto the parent's reference attribute.
   * For a multi-value attribute we read-modify-write to union the child in
   * (Attio PATCH replaces the whole list), so existing links survive.
   *
   * Returns whether the association was MADE here — false when the parent
   * already pointed at this child. A single-value attribute is set without a
   * read, so it can only report the write it performed.
   */
  private async linkParentReference(input: {
    link: Extract<ParentLinkClassification, { kind: 'parent-ref' }>;
    childRecordId: string;
  }): Promise<boolean> {
    const client = await this.getApiClient();
    const { parentObjectId, parentRecordId, fieldSlug, isMulti, childObjectSlug } = input.link;
    const childRef = { target_object: childObjectSlug, target_record_id: input.childRecordId };

    let value: Array<{ target_object: string; target_record_id: string }> = [childRef];
    if (isMulti) {
      const current = await client.getRecord({ objectId: parentObjectId, recordId: parentRecordId });
      const existing = extractReferenceTargets(
        (current.values as Record<string, unknown> | undefined)?.[fieldSlug],
      );
      if (existing.some((r) => r.target_record_id === input.childRecordId)) return false; // already linked
      value = [...existing, childRef];
    }
    await client.updateRecord({
      objectId: parentObjectId,
      recordId: parentRecordId,
      fields: { [fieldSlug]: value },
    });
    return true;
  }

  async updateRecord(rawInput: UpdateInput): Promise<UpdateResult> {
    const input = await this.toInternalWrite(rawInput);
    const client = await this.getApiClient();
    const objectId = await this.objectApiIdFor(input.recordType, 'updateRecord');
    // Same split as createRecord — file values upload separately. The record
    // already exists here, so the upload order relative to the patch doesn't
    // matter; we patch the scalar fields first, then attach the files.
    const { recordFields, fileRefs } = partitionFileFields(input.fields);
    // Wire the parent relationship the same way createRecord does — a matched
    // (vs newly-created) child still needs its edge(s) to the parent(s) set.
    // A linked write carries one parent, a tuple write N; both ride
    // `parentLinks`, so iterate the list exactly like the create branch.
    //
    // A parent whose edge is a reference attribute on NEITHER side cannot be
    // wired at all (`classifyParentLink` answers null). Dropping it quietly
    // would report an attach nobody made, so the write says `unsupported` and
    // the engine fails it.
    const links: ParentLinkClassification[] = [];
    let association: ParentAssociation = 'none';
    for (const parentLink of writeParentLinks(input)) {
      const link = await this.classifyParentLink({
        childRecordType: input.recordType,
        parentLink,
      });
      if (link) links.push(link);
      else association = 'unsupported';
    }
    for (const link of links) {
      if (link.kind === 'child-ref') recordFields[link.fieldSlug] = link.value;
    }
    await this.coerceActorReferenceFields(input.recordType, recordFields);
    // NOT-FOUND contract (3b): a PATCH to a record Attio no longer has 404s.
    // Surface the typed signal so the engine's bind self-heal re-mints.
    //
    // A parent-only attach reaches here with NOTHING of the record's own to
    // change — a matched child whose fields all already hold the written
    // values, hung off its parent. Patching an empty value bag would be a
    // write that changes nothing; read the record instead, so the handle
    // still carries the target's computed values and a deleted record still
    // 404s into the self-heal.
    let record: Awaited<ReturnType<typeof client.updateRecord>>;
    try {
      record =
        Object.keys(recordFields).length === 0
          ? await client.getRecord({ objectId, recordId: input.externalId })
          : await client.updateRecord({
              objectId,
              recordId: input.externalId,
              fields: recordFields,
            });
    } catch (e) {
      if (isHttp404(e)) return UPDATE_NOT_FOUND;
      throw e;
    }
    // A child-ref parent rode the PATCH above (Attio replaces the whole value,
    // so there is no read that would separate "was already pointing here" from
    // "now points here" without a second call) — the write happened, so it
    // reports `made`. A parent-ref knows, because it reads the parent's current
    // targets before unioning the child in.
    let anyMade = links.some((l) => l.kind === 'child-ref');
    for (const link of links) {
      if (link.kind === 'parent-ref') {
        const made = await this.linkParentReference({ link, childRecordId: input.externalId });
        if (made) anyMade = true;
      }
    }
    if (association !== 'unsupported' && links.length > 0) {
      association = anyMade ? 'made' : 'already';
    }
    await this.uploadFileRefs({
      objectSlug: objectId,
      recordId: input.externalId,
      fileRefs,
    });
    const data = flattenAttioRecordValues(record.values as Record<string, unknown>);
    if (record.web_url) data.url = record.web_url;
    return {
      adapterType: ATTIO_ADAPTER_TYPE,
      externalId: input.externalId,
      url: record.web_url ?? undefined,
      data,
      association,
    };
  }

  // ── 5b. linkRecords — assert a record→record reference between two
  //       existing records (the movement engine's standalone edge assert).

  /**
   * The edge resolves against the FROM side: `edgeName` must be a
   * record-reference attribute (apiSlug or id — the currencies `describe`
   * publishes as reference fieldIds) on the from record's object, pointing
   * at the to record. Cardinality comes from the same attribute catalog
   * `describe()` projects (`isMulti` ⇒ `cardinality: 'many'`): a
   * multi-value reference unions the target in via read-modify-write
   * (Attio PATCH replaces the whole list, so existing links survive — the
   * `linkParentReference` pattern); a single-value reference is set,
   * replacing any previous target. An already-linked pair is a no-op
   * (`created: false`).
   */
  async linkRecords(input: LinkRecordsInput): Promise<LinkRecordsResult> {
    const client = await this.getApiClient();
    // NATURAL → internal on the first line: endpoint type names → internal
    // typeIds; the edge name (belonging to the FROM type) → its write
    // currency (the reference attribute slug). The resolved currencies feed
    // the from/to object lookups + the reference-attribute match below.
    const { fromRecordType, toRecordType, edgeName } = await this.resolveLinkInput(input);
    const fromObjectId = await this.resolveObjectIdFromRecordType(fromRecordType);
    if (!fromObjectId) {
      throw new Error(
        `AttioAdapter.linkRecords: "${input.from.recordType}" doesn't resolve to a known Attio object.`,
      );
    }
    const toObjectSlug = await this.resolveObjectSlugFromRecordType(toRecordType);
    if (!toObjectSlug) {
      throw new Error(
        `AttioAdapter.linkRecords: "${input.to.recordType}" doesn't resolve to a known Attio object.`,
      );
    }
    const attrs = await client.listAttributes({ objectId: fromObjectId });
    const ref = attrs.find((a) => matchesReferenceAttribute(a, edgeName));
    if (!ref) {
      throw new Error(
        `AttioAdapter.linkRecords: "${input.edgeName}" is not a record-reference attribute on "${input.from.recordType}" — a standalone link walks a reference field of the from-side record.`,
      );
    }
    const fieldSlug = ref.apiSlug ?? ref.id;
    const current = await client.getRecord({
      objectId: fromObjectId,
      recordId: input.from.externalId,
    });
    const existing = extractReferenceTargets(
      (current.values as Record<string, unknown> | undefined)?.[fieldSlug],
    );
    if (existing.some((r) => r.target_record_id === input.to.externalId)) {
      return { created: false };
    }
    const target = { target_object: toObjectSlug, target_record_id: input.to.externalId };
    const value = ref.isMulti ? [...existing, target] : [target];
    await client.updateRecord({
      objectId: fromObjectId,
      recordId: input.from.externalId,
      fields: { [fieldSlug]: value },
    });
    return { created: true };
  }

  /**
   * Sever a record→record reference — the inverse of `linkRecords`, same
   * read-modify-write shape: resolve the reference attribute on the FROM
   * side, read its current targets, and PATCH the field back without the
   * to-record (a multi-value reference keeps its other links; a
   * single-value reference is cleared). A pair that isn't linked is an
   * idempotent no-op (`removed: false`).
   */
  /** Translate a link/unlink assert's NATURAL names to internal currency:
   *  both endpoint type names → internal typeIds and the FROM-side edge name
   *  → its write currency (the reference attribute slug). */
  private async resolveLinkInput(input: LinkRecordsInput): Promise<{
    fromRecordType: string;
    toRecordType: string;
    edgeName: string;
  }> {
    const resolver = await this.resolver({ types: [input.from.recordType] });
    return {
      fromRecordType: await this.resolveTypeRef(input.from.recordType),
      toRecordType: await this.resolveTypeRef(input.to.recordType),
      edgeName:
        resolver.tryEdgeWriteName(
          naturalName(input.from.recordType),
          naturalName(input.edgeName),
        ) ?? input.edgeName,
    };
  }

  async unlinkRecords(input: UnlinkRecordsInput): Promise<UnlinkRecordsResult> {
    const client = await this.getApiClient();
    const { fromRecordType, edgeName } = await this.resolveLinkInput(input);
    const fromObjectId = await this.resolveObjectIdFromRecordType(fromRecordType);
    if (!fromObjectId) {
      throw new Error(
        `AttioAdapter.unlinkRecords: "${input.from.recordType}" doesn't resolve to a known Attio object.`,
      );
    }
    const attrs = await client.listAttributes({ objectId: fromObjectId });
    const ref = attrs.find((a) => matchesReferenceAttribute(a, edgeName));
    if (!ref) {
      throw new Error(
        `AttioAdapter.unlinkRecords: "${input.edgeName}" is not a record-reference attribute on "${input.from.recordType}" — a standalone unlink walks a reference field of the from-side record.`,
      );
    }
    const fieldSlug = ref.apiSlug ?? ref.id;
    const current = await client.getRecord({
      objectId: fromObjectId,
      recordId: input.from.externalId,
    });
    const existing = extractReferenceTargets(
      (current.values as Record<string, unknown> | undefined)?.[fieldSlug],
    );
    const remaining = existing.filter((r) => r.target_record_id !== input.to.externalId);
    if (remaining.length === existing.length) {
      return { removed: false };
    }
    await client.updateRecord({
      objectId: fromObjectId,
      recordId: input.from.externalId,
      fields: { [fieldSlug]: remaining },
    });
    return { removed: true };
  }

  /** Delete a record via Attio's DELETE endpoint (the API client's
   *  `deleteRecord`). Attio cleans up the record's own references; no
   *  mutation events are emitted (echoes come back via webhooks). */
  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    const client = await this.getApiClient();
    // `recordType` is the NATURAL object name → recover its slug/UUID from the
    // private name cache.
    const objectId = await this.objectApiIdFor(input.recordType, 'deleteRecord');
    await client.deleteRecord({ objectId, recordId: input.externalId });
    return {};
  }

  // ── 6. readRecord — supports no-op detection ────────────────────────────

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    try {
      const client = await this.getApiClient();
      // `recordType` is the NATURAL object name → recover its slug/UUID from
      // the private name cache.
      const objectId = await this.objectApiIdFor(input.recordType, 'readRecord');
      const record = await client.getRecord({
        objectId,
        recordId: input.externalId,
      });
      return record.values as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('404')) return null;
      throw err;
    }
  }

  /**
   * Build the `attio:file` records for a record position — scanned out of the
   * record's value envelope (file values appear as `[{ file_id, ... }]` arrays
   * under attribute slots). Reached via `record-[:Files]->` (`getRelated`).
   * Returns the parsed file metadata keyed by the `attio:file` descriptor's
   * field ids (`id` / `name` / `contentType` / `url`); `getFieldValue`'s
   * `File` field turns each into a byte-bearing `FileRef`.
   */
  private resolveFileRefs(position: SourcePosition): AttioFileRecord[] {
    if (!isStablePosition(position)) return [];
    if (position.adapterType !== this.adapterType) return [];
    const data = positionData(position) as Record<string, unknown> | null | undefined;
    if (!data) return [];

    const files: AttioFileRecord[] = [];
    for (const raw of Object.values(data)) {
      if (!Array.isArray(raw)) continue;
      for (const entry of raw) {
        const file = parseAttioFileEntry(entry);
        if (!file) continue;
        files.push({
          id: file.fileId,
          name: file.name,
          contentType: file.contentType,
          url: file.url,
        });
      }
    }
    return files;
  }

  /**
   * The `File` primitive for an Attio file record — a `FileRef` descriptor
   * naming this instance (its credential) as the owner and the raw Attio file
   * id as the handle, redeemed through `resolveFileRef`. Returns null when the
   * record carries no file id. Mirrors `slackFileRef`.
   */
  private attioFileRef(record: AttioFileRecord | null): FileRef | null {
    if (!record?.id) return null;
    const id = record.id;
    const contentType = record.contentType ?? undefined;
    return {
      __brand: 'FileRef',
      name: record.name ?? undefined,
      contentType,
      source: ownedFileSource({ adapterType: this.adapterType, credentialsId: this.credentialsId, handle: id }),
    };
  }

  /** Bytes for a file this instance read, by its Attio file id — the download
   *  endpoint serves any file id the credential can see. */
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error('AttioAdapter.resolveFileRef: FileRef has no source handle to resolve.');
    }
    return this.streamAttioFileBytes(handle, input.ref.contentType);
  }

  /**
   * The byte channel for an Attio file id. `GET /v2/files/{file_id}/download`
   * 302-redirects to a short-lived signed URL; `client.downloadFile` follows it
   * and streams the bytes — fetched WITH the same Bearer credential the upload
   * path uses. A fresh round trip each call (a fresh signed URL).
   */
  private async streamAttioFileBytes(
    handle: string,
    fallbackContentType?: string,
  ): Promise<ResolveFileRefResult> {
    const client = await this.getApiClient();
    const { stream, contentType } = await client.downloadFile({ fileId: handle });
    return {
      stream: Readable.fromWeb(stream as unknown as WebReadableStream<Uint8Array>),
      contentType: contentType ?? fallbackContentType ?? undefined,
    };
  }

  // ── 7. File read / write ────────────────────────────────────────────────
  //
  // READ side (symmetric with the write): a record's file-shaped attribute
  // values are surfaced as `attio:file` positions via `record-[:Files]->`
  // (`resolveFileRefs`, reached from `getRelated`). Attio's attribute
  // catalogue (apps/api/src/adapters/attio/interface.ts) doesn't enumerate a
  // file kind, so detection is by value shape (`parseAttioFileEntry`), not
  // attribute type — keeping the adapter tolerant of file-bearing attributes
  // whose enum hasn't been wired through. Each file's `File` field returns a
  // `FileRef` descriptor (`attioFileRef`) that `resolveFileRef` redeems via
  // `GET /v2/files/{file_id}/download` — the SAME credential the write path
  // uploads with.
  //
  // Writes go through /v2/files/upload (`uploadFile`), which attaches a
  // binary to a record globally (Attio's file model isn't per-field —
  // upload-and-link is its only primitive). The target record is resolved
  // via the linked_object bridge for the TargetRef's nodeId; absence of a
  // bridge means we have no Attio anchor to attach to and the write is
  // logged + no-op'd. Non-FILE resources are no-op'd outright (Attio has
  // no general resource sink for URL/TEXT — those live in notes/comments,
  // explicitly out of scope per R4c).
  //
  // PropertyEvidence + Facts are dropped on the floor — the brief leaves
  // comment-evidence writing as a no-op unless trivial, and Attio has no
  // native fact storage to mirror the KG's `extraction_fact` table.

  // File-on-write (`4d_resources.md`): a `file`-kind field's value is a
  // `FileRef`, uploaded by createRecord/updateRecord via `uploadFileRefs`. The
  // record's own externalId + object slug are in hand at the write — no
  // linked_object bridge lookup is needed (the old `writeResource` path, which
  // attached to an already-bridged record, was removed in R4). The retained
  // upload primitive is `client.uploadFile`; the FileRef → bytes step is
  // `fileRefToBlob`.

  // ── Event subscriptions (the listen-reconciliation seam) ────────────────
  // REAL provisioning: Attio has a first-class webhook API. The platform
  // owns the stable per-(adapter, credential) callback URL and the inbound
  // verification path (webhook_sync handler + the attio provider's HMAC
  // check); these two calls own the source-side registration. Diff-sync
  // semantics: no current registration → create; same events → no-op;
  // changed events → PATCH the webhook in place (URL and secret stable).

  async ensureEventSubscription(
    input: EnsureEventSubscriptionInput,
  ): Promise<EventSubscriptionRegistration | undefined> {
    const client = await this.getApiClient();
    // Attio requires every subscription to carry a `filter` (nullable, but the
    // field must be present) — omitting it is a 400 `validation_type` on
    // `subscriptions[].filter`. `null` = no filter (fire on every record of the
    // subscribed event), which is exactly the listen semantics here.
    const subscriptions = input.events.map((event_type) => ({ event_type, filter: null }));
    if (input.current?.externalId !== undefined) {
      const unchanged =
        input.current.events.length === input.events.length &&
        input.current.events.every((e) => input.events.includes(e));
      if (unchanged) return undefined;
      await client.updateWebhook({
        webhookId: input.current.externalId,
        subscriptions,
      });
      // PATCH keeps the source-issued id and secret — nothing new to persist.
      return { externalId: input.current.externalId };
    }
    const created = await client.createWebhook({
      targetUrl: input.callbackUrl,
      subscriptions,
    });
    return { externalId: created.webhookId, secret: created.secret };
  }

  async removeEventSubscription(input: RemoveEventSubscriptionInput): Promise<void> {
    if (input.externalId === undefined) return;
    const client = await this.getApiClient();
    await client.deleteWebhook(input.externalId);
  }

  // ── Adapter-specific extensions (not part of the framework Adapter contract)
  //    — surface Attio's list catalog for the snapshot scope picker UI.

  async listLists(): Promise<{ id: string; name: string }[]> {
    const client = await this.getApiClient();
    return client.listLists();
  }

  // ── Internal: lazy API client construction ──────────────────────────────

  private async getApiClient(): Promise<AttioApiClient> {
    if (this.apiClient) return this.apiClient;

    const qb = getAutomationsQb(['external_service_credentials']);
    const row = await qb
      .selectFrom('external_service_credentials')
      .where('id', '=', this.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', this.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Attio credentials ${this.credentialsId} not found for team ${this.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
      );
    }

    // decryptToken returns a JSON string — parse before validating shape.
    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch (err) {
      logger.error('[AttioAdapter] credential payload is not valid JSON', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `Attio credentials ${row.id} are malformed (not valid JSON).`,
      );
    }
    // Route dev-loop team traffic to fake-channels. Mirrors the
    // injection that `maybeFakeCreds` does at the credentials-router
    // surface — but that path doesn't run when the engine / TG editor
    // load credentials directly via this adapter. Without this branch
    // the adapter hits real Attio and 401s on the seeded stub token.
    const rawPayload = isTestHarnessTeam(this.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'ATTIO')
      : payload;

    const parsed = attioCredsParser.safeParse(rawPayload);
    if (!parsed.success) {
      logger.error('[AttioAdapter] credential payload failed validation', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: parsed.error.message,
      });
      throw new Error(
        `Attio credentials ${row.id} are malformed (${parsed.error.message}).`,
      );
    }

    this.apiClient = getAttioClient(parsed.data.accessToken, parsed.data.baseUrl);
    return this.apiClient;
  }

}

/**
 * Flatten Attio's `record.values` envelope into scalar `{name, title, …}`
 * fields. The UI prettifier and `linked_object.data` consumers all want
 * scalars; Attio returns arrays of typed value objects. Mirrors
 * `buildRecordData` in services/knowledge_pipeline/output_v3/adapters/attio.ts.
 */
export function flattenAttioRecordValues(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    if (!Array.isArray(val) || val.length === 0) {
      if (val !== null && typeof val !== 'object') flat[key] = val;
      continue;
    }
    const first = val[0] as Record<string, unknown>;
    if (typeof first !== 'object' || first === null) continue;
    const displayValue =
      first.value ??
      first.full_name ??
      first.first_name ??
      first.domain ??
      first.email_address ??
      first.original_email_address ??
      // status / select: surface the chosen option's title (see
      // extractAttioValue — same wire shape on the read path).
      optionTitle(first.status) ??
      optionTitle(first.option);
    if (displayValue != null && typeof displayValue !== 'object') {
      flat[key] = displayValue;
    }
  }
  return flat;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read the post-translateFilter native shape passed to `snapshot()`. The
 * framework guarantees this came from this adapter's `translateFilter`, so
 * the shape is internal — but we still defensively default to `all` if
 * something unexpected slipped through.
 */
function parseNativeFilter(filter: unknown): AttioNativeFilter {
  if (filter === undefined || filter === null) return { kind: 'all' };
  if (typeof filter === 'object' && filter !== null && 'kind' in filter) {
    const f = filter as { kind: string; listId?: string };
    if (f.kind === 'all') return { kind: 'all' };
    if (f.kind === 'list' && typeof f.listId === 'string') {
      return { kind: 'list', listId: f.listId };
    }
    if (
      f.kind === 'records' &&
      'filter' in f &&
      typeof (f as { filter: unknown }).filter === 'object' &&
      (f as { filter: unknown }).filter !== null
    ) {
      return { kind: 'records', filter: (f as { filter: Record<string, unknown> }).filter };
    }
  }
  logger.warn('[AttioAdapter.snapshot] unexpected native filter shape; defaulting to all', {
    filter,
  });
  return { kind: 'all' };
}

// ── Capability declarations (chunk 4: adapter-capability-contract) ──────────
//
// What the movement language may ask of Attio, answered live from `describe()`.
// Split across the property grain (`attioFieldCapability`) and the edge grain
// (the two `EdgeCapability` constants):
//
//   • A collection off the adapter root (`crm-[c:companies]->`) is an UNBOUNDED
//     fan-out — Attio narrows it natively via its records-query API, so the
//     offerable fields are the target's per-property capability.
//   • A record-reference traversal (`company-[:associated_people]->`) yields a
//     BOUNDED set — the adapter runs the shared filter unit over it, so any
//     target field is filterable / orderable.
//
// ORDER is `bounded` on both, because `getRelated` reads no `orderBy` at all:
// the snapshot query carries the filter and nothing else, and the engine sorts
// what comes back. Saying `native` claimed a server-side sort that does not
// happen — and, now that the root capability is read rather than fabricated,
// would have narrowed every root ORDER BY to the fields Attio marks orderable
// while still sorting in the engine. The declaration follows the code
// (D2 — a declaration `getRelated` does not honour is a lie to correct here).
//
// Resource / Note / Task / Comment edges leave capability absent (unknown ⇒
// silent best-effort) until we model their bounds honestly.
const ATTIO_NATIVE_EDGE_CAP: EdgeCapability = {
  filter: 'native',
  order: 'bounded',
  supportsLimit: true,
};
const ATTIO_BOUNDED_EDGE_CAP: EdgeCapability = {
  filter: 'bounded',
  order: 'bounded',
  supportsLimit: true,
};

/**
 * The per-property half of the contract, by field kind — Attio's records-query
 * filter surface. Date fields add WITHIN (recency, which the adapter lowers to a
 * created/updated range). `json` / `file` / `reference` attributes aren't
 * server-side filterable (absent ⇒ not filterable natively; still filterable
 * across a bounded edge via the shared unit). Multi-valued and complex kinds
 * aren't orderable.
 */
function attioFieldCapability(kind: SchemaFieldKind, isMulti: boolean): FieldCapability | undefined {
  switch (kind) {
    case 'string':
      return { filterOperators: ['eq', 'neq', 'in', 'contains'], orderable: !isMulti };
    case 'number':
      return { filterOperators: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'], orderable: !isMulti };
    case 'date':
      return { filterOperators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'within'], orderable: true };
    case 'enum':
      return { filterOperators: ['eq', 'neq', 'in'], orderable: !isMulti };
    case 'boolean':
      return { filterOperators: ['eq', 'neq'], orderable: false };
    default:
      return undefined;
  }
}

/**
 * The single object a record-reference attribute lands on, or `undefined` when
 * there isn't one — in which case the attribute publishes NO edge, and the
 * reason is logged (never dropped in silence).
 *
 * Attio names a record-reference's target two different ways, and only one of
 * them was ever read:
 *
 *   - `relationship` — the paired back-reference Attio mints for its OWN
 *     built-in links (a person's `parent_object`). Authoritative when present.
 *   - `config.record_reference.allowed_object_ids` — what a reference created
 *     through the Attio UI carries. Such an attribute has `relationship: null`,
 *     so reading targets from `relationship` alone made EVERY UI-created
 *     reference invisible (reported: a custom "Funds" object's multi-value
 *     "GPs" → People attribute never appeared as an edge).
 *
 * ONE EDGE, MANY LANDING TYPES. A reference allowed on several objects is one
 * edge onto a UNION of them (`targetTypeIds`), which is what it actually is —
 * the projection turns it into a `polymorphic` edge over a union position type,
 * so a read narrows with `IS` and a linked write must name the member it
 * creates. Splitting it into one edge per target would be the dishonest
 * alternative: they would all share this attribute's slug as `fieldId` — the
 * identity `getRecordReferenceTargets` traverses on — so each would deliver the
 * OTHER types' records too. (The `recordBackEdges` idiom gets away with
 * one-edge-per-object because there the object name IS the fieldId, which lets
 * the runtime filter.)
 *
 * A member the workspace catalog cannot name is DROPPED with a warning rather
 * than emitted as a raw UUID (the same leak class as the retired `attio:<slug>`
 * codec). What is left decides the shape: several members ⇒ the union, exactly
 * one ⇒ an ordinary single-target edge, none ⇒ no edge at all.
 *
 * Absent / empty `allowed_object_ids` means UNRESTRICTED, and that is still a
 * loud skip: an unbounded target set is not a target list. The TS analogue is
 * `any`, not a union.
 */
function resolveRecordReferenceTargets(
  attr: AttioAttribute,
  fieldId: string,
  obj: { id: string; name: string },
  objectsById: Map<string, AttioObjectInfo>,
): AttioObjectInfo[] {
  // An unresolvable target leaks an internal id that matches no type and drifts
  // at traversal-time field resolution (the same leak class as the retired
  // attio:<slug> codec), so a missing target is the honest projection either way.
  const unnameable = (reason: string): AttioObjectInfo[] => {
    logger.warn(
      `[AttioAdapter] record-reference '${fieldId}' on '${obj.name}': ${reason}`,
      { objectId: obj.id, attributeId: attr.id, fieldId, allowedObjectIds: attr.allowedObjectIds },
    );
    return [];
  };

  if (attr.relationshipObjectId) {
    const linked = objectsById.get(attr.relationshipObjectId);
    return linked !== undefined
      ? [linked]
      : unnameable(
          `publishes no edge: its linked object ${attr.relationshipObjectId} is not in the workspace catalog`,
        );
  }

  const allowed = attr.allowedObjectIds ?? [];
  if (allowed.length === 0) {
    return unnameable(
      'publishes no edge: it names no allowed object (unrestricted references have no landing type)',
    );
  }
  const resolved: AttioObjectInfo[] = [];
  for (const objectId of allowed) {
    const target = objectsById.get(objectId);
    if (target === undefined) {
      unnameable(`drops allowed object ${objectId} — it is not in the workspace catalog`);
      continue;
    }
    if (!resolved.some((r) => r.name === target.name)) resolved.push(target);
  }
  return resolved;
}

/**
 * Build a SchemaTypeDescriptor for one Attio object type. Lists attributes,
 * partitions reference attributes from value attributes, maps each to the
 * framework's field/reference shape.
 *
 * `objectsById` is the workspace's object catalog; a record-reference's target
 * is named by the linked object's display name (the framework identity, matching
 * how entry points are keyed), resolved by `resolveRecordReferenceTarget`.
 */
async function buildTypeDescriptor(
  client: AttioApiClient,
  obj: { id: string; name: string; slug: string | null },
  objectsById: Map<string, { id: string; name: string; slug: string | null }>,
): Promise<SchemaTypeDescriptor> {
  const attrs = await withAttributeOptions(
    client,
    { objectId: obj.id },
    await client.listAttributes({ objectId: obj.id }),
  );

  const fields: SchemaFieldDescriptor[] = [];
  const references: SchemaReferenceDescriptor[] = [];

  for (const attr of attrs) {
    const fieldId = attr.apiSlug ?? attr.id;
    if (attr.type === 'record-reference') {
      const targetObjs = resolveRecordReferenceTargets(attr, fieldId, obj, objectsById);
      if (targetObjs.length === 0) {
        // No nameable landing type at all. SKIP — and never fall through to the
        // field branch: `mapAttributeTypeToFieldKind('record-reference')` yields
        // kind `reference`, which the movement projection discards silently, so
        // the attribute would become a phantom that is neither field nor edge
        // with nothing logged (the trap the actor-reference note below warns of).
        continue;
      }
      // The reference targets are named by the linked objects' display names —
      // the framework identity, matching how entry points are keyed. Several of
      // them is ONE edge onto their union; one is an ordinary edge, and says so
      // by declaring no target set at all.
      const targetTypeIds = targetObjs.map((t) => t.name);
      const targetTypeId = targetTypeIds[0];
      references.push({
        fieldId,
        ...(targetTypeIds.length > 1 ? { targetTypeIds } : {}),
        // The edge's NATURAL name is the attribute's own title ("Company"),
        // exactly as a field's is (`displayName: attr.name`). Attio's api slug
        // (`parent_object`) stays the `fieldId` — the stable identity the read
        // path and `backingFields` key on — but it is Attio's internal
        // vocabulary and must never be what an author types. These edges are
        // writable, so the slug would otherwise land verbatim in movement
        // source (`write person-[:parent_object]-> { … }`).
        //
        // Titles are unique only by convention (Attio enforces uniqueness on
        // `api_slug`, not `title`), which is the SAME risk fields already
        // carry — references adopting the convention removes an
        // inconsistency rather than adding a class of risk.
        name: attr.name,
        targetTypeId,
        cardinality: attr.isMulti ? 'many' : 'one',
        // A record-reference traversal yields a bounded set — the adapter runs
        // the shared filter unit over it (chunk 4).
        capability: ATTIO_BOUNDED_EDGE_CAP,
        // The attribute-list API surfaces `is_required` on every
        // attribute, record-references included — a required reference
        // attribute IS a required edge (the movement projection rule).
        ...(attr.isRequired === true ? { required: true } : {}),
        // Attio record-references are backed by the attribute itself —
        // when the attribute changes, the edge changes. Lets event-mode
        // prune traversal when a webhook tells us the FK didn't move.
        //
        // Includes both the API slug (preferred fieldId) and the UUID
        // (`attr.id`) because Attio webhooks surface changes as attribute
        // UUIDs in `id.attribute_id`, while authored TGs typically
        // reference attributes by slug. Containing both shapes lets the
        // runtime match regardless of which form the change-info carries.
        backingFields: attr.id && attr.id !== fieldId ? [fieldId, attr.id] : [fieldId],
        // A record-reference IS a linked write (layer 13 makes the promise
        // explicit). `classifyParentLink` exists precisely to serve this edge:
        // it matches the write's `edgeName` against the record-reference
        // attributes of BOTH endpoints — Attio reference attributes are
        // single-directional, so the attribute backing `Person -[:company]->
        // Company` may live on either side — and then either folds the value
        // into the child's own create/update payload (`child-ref`) or PATCHes
        // it onto the parent afterwards (`parent-ref` → `linkParentReference`,
        // which read-modify-writes a multi attribute so existing links
        // survive). Both `createRecord` and `updateRecord` run that loop, so a
        // matched child links exactly like a new one.
        //
        // Gated on the attribute's own writability: Attio marks derived
        // reverse-relationship attributes `is_writable: false`, and a PATCH to
        // one is rejected — an unwritable attribute is an honestly read-only
        // edge.
        ...(attr.isWritable !== false ? { writable: true } : {}),
      });
      continue;
    }

    const kind = mapAttributeTypeToFieldKind(attr.type);
    fields.push({
      fieldId,
      displayName: attr.name,
      kind,
      enumValues:
        attr.type === 'select' || attr.type === 'status'
          ? attr.options?.map((o) => o.name)
          : undefined,
      writable: attr.isWritable ?? true,
      required: attr.isRequired ?? false,
      cardinality: attr.isMulti ? 'many' : 'one',
      capability: attioFieldCapability(kind, attr.isMulti ?? false),
    });
  }

  // Append the system record metadata (`Created At`) the object-attributes
  // API doesn't reliably return — a read-only date the engine can use as a
  // `within` recency key. Skip any whose slug a custom attribute already
  // claimed so the object's own attributes always win.
  const customSlugs = new Set(fields.map((f) => f.fieldId));
  for (const sys of ATTIO_RECORD_SYSTEM_DATE_FIELDS) {
    if (!customSlugs.has(sys.fieldId)) fields.push(sys);
  }

  return {
    // The framework identity for the type IS its display name; the structured
    // slug/UUID lives only in the adapter's private name cache.
    typeId: obj.name,
    displayName: obj.name,
    // The webhook event payload's `id.object_id` is the object's UUID;
    // surfacing it here lets the editor build enum completions keyed by
    // UUID (so the runtime equality matches) while displaying the
    // object's plural noun as the option label.
    externalId: obj.id,
    fields,
    references,
    // An object's records are removed by `deleteRecord` (Attio's DELETE
    // endpoint); its list entries, notes, tasks and files are not.
    deletable: true,
    uniquenessConstraints: uniquenessConstraintsFromAttrs(attrs),
    // Attio resolves a fuzzy uniqueness component via its `$contains`
    // filter (see buildPropertyMatch), so FUZZY is allowed on Attio writes.
    supportsFuzzyResolution: true,
  };
}

/**
 * Translate Attio's per-attribute `is_unique` flag into engine-shaped
 * uniqueness constraints. Each unique attribute becomes its own
 * OR-branch (a one-entry constraint), so authors see "unique by email
 * OR unique by domain" rather than "unique by email AND domain".
 */
function uniquenessConstraintsFromAttrs(
  attrs: AttioAttribute[],
): UniquenessConstraints {
  const any: UniquenessConstraints['any'] = [];
  for (const attr of attrs) {
    if (!attr.isUnique) continue;
    const fieldId = attr.apiSlug ?? attr.id;
    any.push({ all: [{ field: fieldId }] });
  }
  return { any };
}

/**
 * Build a per-list synthetic type. The list's entry attributes become
 * the type's fields — so traversing `Companies → -[:Hot Leads]->` lands
 * on a position whose fields are exactly the columns the user can set
 * on a Hot Leads entry (Stage, Owner, Last Touched, …). Reference
 * attributes are skipped — entries CAN have record-reference attrs but
 * we don't yet model traversing them. Display name is the list's name.
 */
function buildPerListTypeDescriptor(
  list: AttioListInfo,
  attrs: AttioAttribute[],
  objects: AttioObjectInfo[],
): SchemaTypeDescriptor {
  const fields: SchemaFieldDescriptor[] = [];
  for (const attr of attrs) {
    if (attr.type === 'record-reference') continue;
    const fieldId = attr.apiSlug ?? attr.id;
    const kind = mapAttributeTypeToFieldKind(attr.type);
    fields.push({
      fieldId,
      displayName: attr.name,
      kind,
      enumValues:
        attr.type === 'select' || attr.type === 'status'
          ? attr.options?.map((o) => o.name)
          : undefined,
      writable: attr.isWritable ?? true,
      required: attr.isRequired ?? false,
      cardinality: attr.isMulti ? 'many' : 'one',
      capability: attioFieldCapability(kind, attr.isMulti ?? false),
    });
  }
  // Append the system entry metadata fields (`Added to list at`) that the
  // list-attributes API never returns — a read-only date the engine can
  // use as a `within` recency key. Skip any whose slug a custom attribute
  // already claimed so the list's own attributes always win.
  const customSlugs = new Set(fields.map((f) => f.fieldId));
  for (const sys of ATTIO_ENTRY_SYSTEM_DATE_FIELDS) {
    if (!customSlugs.has(sys.fieldId)) fields.push(sys);
  }
  return {
    // The list's display name IS its framework identity (the list id lives in
    // the private name cache).
    typeId: list.name,
    displayName: list.name,
    fields,
    // The up-hop to the parent record this list attaches to — scoped to the
    // list's own parent object(s), so a per-list entry resolves straight to
    // its typed record — PLUS the universal attachable reads (Notes/Tasks/
    // Comments) every entry can carry. A per-list type is now the landing for a
    // list-entry event (the webhook event's per-list edge), so it must offer
    // the same reads the retired generic `List Entry` did — its single scoped
    // parent instead of the generic's three.
    references: [...ATTACHABLE_READS_FROM_ENTRIES, ...recordBackEdges(objects, list.parentObjectSlugs)],
    uniquenessConstraints: uniquenessConstraintsFromAttrs(attrs),
    // Attio resolves a fuzzy uniqueness component via its `$contains`
    // filter (see buildPropertyMatch), so FUZZY is allowed on Attio writes.
    supportsFuzzyResolution: true,
  };
}

/**
 * Read the raw Attio actor `{ type, id }` from a trigger event, tolerating
 * both shapes: the framework-normalized `event.actor` (where the webhook
 * provider maps `workspace-member` → `user`) and the raw webhook
 * `payload.actor` (which carries Attio's literal `workspace-member`).
 *
 * Returns a uniform `{ type, id }` where `type` is the literal Attio actor
 * type — `'workspace-member' | 'api-token' | 'system'` — so the
 * email-resolution path can gate on member-ness. The normalized `'user'`
 * is mapped back to `'workspace-member'`.
 */
function readAttioActor(
  event: TriggerEvent,
): { type: 'workspace-member' | 'api-token' | 'system'; id: string | null } | null {
  const denormalize = (
    type: unknown,
  ): 'workspace-member' | 'api-token' | 'system' | null => {
    if (type === 'workspace-member' || type === 'user') return 'workspace-member';
    if (type === 'api-token') return 'api-token';
    if (type === 'system') return 'system';
    return null;
  };

  const eventActor = event.actor as Record<string, unknown> | undefined;
  if (eventActor && typeof eventActor === 'object') {
    const type = denormalize(eventActor.type);
    const id = typeof eventActor.id === 'string' ? eventActor.id : null;
    if (type) return { type, id };
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const payloadActor = payload.actor as Record<string, unknown> | undefined;
  if (payloadActor && typeof payloadActor === 'object') {
    const type = denormalize(payloadActor.type);
    const id = typeof payloadActor.id === 'string' ? payloadActor.id : null;
    // Raw payload actors without an explicit type are assumed to be
    // workspace members (the only actor shape that carries a resolvable
    // email); the resolution still gates on a non-null id.
    return { type: type ?? 'workspace-member', id };
  }

  return null;
}

function mapAttributeTypeToFieldKind(type: string): SchemaFieldKind {
  switch (type) {
    case 'number':
    case 'currency':
    case 'rating':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'date':
    case 'timestamp':
      return 'date';
    case 'select':
    case 'status':
      return 'enum';
    case 'record-reference':
      return 'reference';
    // Actor-references (Attio "User" fields — Deal owner, Created by, …) are
    // SETTABLE values: you assign a workspace member by email, not an edge to a
    // traversable record. Surface them as a writable string field (the author
    // writes an email — a literal or a meta value like @actor_email /
    // @user_email — and createRecord/updateRecord resolves it to the workspace
    // member). Mapping them to 'reference' made them phantom edges that
    // buildTypeDescriptor never added to `references` and schema_projection then
    // silently dropped, so required User fields vanished from write completions.
    case 'actor-reference':
      return 'string';
    case 'location':
    case 'interaction':
      return 'json';
    // Attio's attribute-type enum (`interface.ts`) doesn't currently
    // enumerate a file kind, but the raw Attio API surface uses the
    // string `'file'` for attachment attributes (see also the
    // best-effort detection in `parseAttioFileEntry`). When it does
    // surface, route it to the typed file primitive so the editor
    // routes File-typed expressions only into File-typed targets
    // (E5, wave-2).
    case 'file':
      return 'file';
    case 'text':
    case 'email-address':
    case 'phone-number':
    case 'domain':
    case 'personal-name':
    default:
      return 'string';
  }
}

/**
 * Attio stores values as arrays of typed objects. Pull a sensible scalar from
 * the first entry — `value` for plain types, named fields for personal-name /
 * email / domain. Returns the raw array if no scalar is extractable so callers
 * can decide.
 */
/**
 * Translate a list of (propTypeId, scalar value, fuzzy) entries into an
 * Attio filter body. Typed attributes (domain, email, phone, reference)
 * carry a sub-attribute wrapper that Attio's filter API requires —
 * `{ domains: { domain: { $eq: "x.com" } } }` rather than
 * `{ domains: { $eq: "x.com" } }`. Without this the API returns 400
 * `filter_error`.
 *
 * Caller is responsible for cartesian-expanding array-valued entries
 * upstream so every value here is a scalar.
 */
/** The top-level AND-ed conjuncts of a predicate (a bare predicate is one
 *  conjunct). Nested ANDs flatten; OR / other shapes stay whole. */
function flattenAndConjuncts(expr: Expression): Expression[] {
  if (expr.type === 'logical' && expr.op === 'and') {
    return expr.operands.flatMap(flattenAndConjuncts);
  }
  return [expr];
}

function buildAttioBranchFilter(
  entries: { propTypeId: string; value: unknown; fuzzy: boolean }[],
  attrBySlug: Map<string, { type: string }>,
  within: { dateFieldSlug: string; cutoffIso: string }[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { propTypeId, value, fuzzy } of entries) {
    out[propTypeId] = buildAttioPredicate(attrBySlug.get(propTypeId)?.type, value, fuzzy);
  }
  // Temporal scopes: emit a `$gte` filter on each date field. If the
  // same field already appears as a scalar entry in this branch (rare),
  // the within clause replaces it — recency wins because it's the more
  // specific predicate.
  for (const w of within) {
    out[w.dateFieldSlug] = { $gte: w.cutoffIso };
  }
  return out;
}

function buildAttioPredicate(
  attrType: string | undefined,
  value: unknown,
  fuzzy: boolean,
): unknown {
  const op = fuzzy ? '$contains' : '$eq';
  const v = fuzzy ? String(value) : value;
  switch (attrType) {
    case 'domain':
      return { domain: { [op]: v } };
    case 'email-address':
      return { email_address: { [op]: v } };
    case 'phone-number':
      // Phone $contains is brittle (raw vs. formatted); fall back to $eq.
      return { phone_number: { $eq: v } };
    case 'record-reference':
    case 'actor-reference':
      return { target_record_id: { $eq: v } };
    default:
      return { [op]: v };
  }
}

export function extractAttioValue(raw: unknown): unknown {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  if (typeof first !== 'object' || first === null) return first;

  const obj = first as Record<string, unknown>;
  return (
    obj.value ??
    obj.full_name ??
    obj.first_name ??
    obj.domain ??
    obj.email_address ??
    obj.original_email_address ??
    // status / select values nest the chosen option under `status` / `option`
    // with a human `title` — read that back, so the field compares and
    // interpolates as the plain option name ("Lead"), never as the raw
    // envelope. Without this, every predicate over a status field (including
    // the engine's re-check of a pushed-down filter) compares an object to a
    // string and silently matches nothing.
    optionTitle(obj.status) ??
    optionTitle(obj.option) ??
    // actor-reference ("User") values — read back the workspace-member id as
    // a clean string so the field reads consistently with its `string` kind
    // (rather than the raw `[{ referenced_actor_type, referenced_actor_id }]`).
    obj.referenced_actor_id ??
    raw
  );
}

/** The `title` of a nested status/select option object, or undefined. */
function optionTitle(nested: unknown): string | undefined {
  if (typeof nested !== 'object' || nested === null) return undefined;
  const title = (nested as Record<string, unknown>).title;
  return typeof title === 'string' ? title : undefined;
}

/**
 * Walk a dot-separated path through a nested object. Returns null at any
 * missing segment or when the source isn't an object. Used to read fields
 * on the webhook event payload (`id.object_id`, `id.record_id`, ...) — the
 * field naming convention encodes the nesting as a flat string so authors
 * write `event.id.object_id` instead of nested traversal.
 */
function readDotPath(data: unknown, path: string): unknown {
  if (data === null || data === undefined) return null;
  const parts = path.split('.');
  let cursor: unknown = data;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return null;
    if (typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor ?? null;
}

/**
 * Parsed Attio file record carried on an `attio:file` position's `data`.
 * Keyed by the `attio:file` descriptor's field ids (`describeFileMeta`), so
 * `getFieldValue` reads each field straight off it.
 */
interface AttioFileRecord {
  id: string;
  name: string | null;
  contentType: string | null;
  url: string | null;
}

/**
 * Best-effort detection of a file-shaped value entry inside an Attio
 * `record.values[slot]` array. Attio's file values look like
 * `{ file_id, file_url?, name, content_type }` (sometimes nested under
 * `file: {...}` or `value: {...}` depending on attribute kind). The
 * attribute-type catalogue in `interface.ts` doesn't enumerate `file`
 * today, so we detect by value shape rather than by attribute type.
 * Returns null when the entry isn't a file.
 */
function parseAttioFileEntry(
  entry: unknown,
):
  | {
      fileId: string;
      url: string | null;
      name: string | null;
      contentType: string | null;
    }
  | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  // The file fields may live at the top level of the value entry, or
  // nested under `value` / `file`. Try each in turn.
  const candidates: Record<string, unknown>[] = [e];
  if (e.value && typeof e.value === 'object') candidates.push(e.value as Record<string, unknown>);
  if (e.file && typeof e.file === 'object') candidates.push(e.file as Record<string, unknown>);
  for (const c of candidates) {
    const fileId = c.file_id ?? c.fileId;
    if (typeof fileId !== 'string' || fileId.length === 0) continue;
    const url = pickStringField(c, ['file_url', 'url', 'document_url']);
    const name = pickStringField(c, ['name', 'file_name', 'filename']);
    const contentType = pickStringField(c, ['content_type', 'contentType', 'mime_type', 'mimeType']);
    return { fileId, url, name, contentType };
  }
  return null;
}

function pickStringField(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Split a write's `fields` into the file values to upload and the rest to
 * pass through to Attio's record values envelope.
 *
 * A `file`-kind field's value is a file the engine holds, redeemed for its
 * bytes on this side. Multi-cardinality file attributes arrive as an array of
 * them. Detection is by the engine's own mark (`isFileValue`), never the
 * value's keys: Attio's attribute catalogue doesn't enumerate a file kind, and
 * a dict that spells a descriptor is data the author wrote, not a file.
 *
 * The file fields are dropped from the passthrough payload because Attio has
 * no per-attribute file write — files attach to the record as a whole via
 * `/v2/files/upload` (`uploadFileRefs`), and a raw `FileRef` in the values
 * envelope would be rejected by the records API.
 */
/**
 * How a record→record `parentLink` resolves: the reference attribute lives
 * on the child (set during its own write) or on the parent (linked after).
 */
type ParentLinkClassification =
  | {
      kind: 'child-ref';
      fieldSlug: string;
      value: Array<{ target_object: string; target_record_id: string }>;
    }
  | {
      kind: 'parent-ref';
      parentObjectId: string;
      parentRecordId: string;
      fieldSlug: string;
      isMulti: boolean;
      childObjectSlug: string;
    };

/**
 * Pull `{ target_object, target_record_id }` out of an Attio record-reference
 * value (read back as an array of target objects). Used to union a child into
 * a parent's multi-value reference without clobbering existing links.
 */
function extractReferenceTargets(
  raw: unknown,
): Array<{ target_object: string; target_record_id: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ target_object: string; target_record_id: string }> = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const t = item as { target_object?: unknown; target_record_id?: unknown };
      if (typeof t.target_object === 'string' && typeof t.target_record_id === 'string') {
        out.push({ target_object: t.target_object, target_record_id: t.target_record_id });
      }
    }
  }
  return out;
}

function partitionFileFields(fields: Record<string, unknown>): {
  recordFields: Record<string, unknown>;
  fileRefs: FileRef[];
} {
  const recordFields: Record<string, unknown> = {};
  const fileRefs: FileRef[] = [];
  for (const [key, value] of Object.entries(fields)) {
    // Attio rejects `null` outright (`validation_type` / "Invalid input") —
    // it expects a value or omission, not null. The engine writes null for a
    // field that evaluated to nothing, so omit those here rather than POST a
    // value Attio bounces. Mirrors the v3 output adapter (adapters/attio/
    // output.ts), which skips null/undefined before building the payload.
    // To CLEAR an existing value, a mapping must produce an empty array (`[]`),
    // Attio's documented "unset" — which is preserved here.
    if (value === null || value === undefined) {
      continue;
    }
    if (isFileValue(value)) {
      fileRefs.push(value);
      continue;
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isFileValue)) {
      fileRefs.push(...value);
      continue;
    }
    recordFields[key] = value;
  }
  return { recordFields, fileRefs };
}

/**
 * Redeem a `FileRef` descriptor for its bytes (`streamFileRef`, for this team)
 * and buffer them into a Blob ready for `client.uploadFile`. Throws on a missing
 * byte channel or a retrieval failure — a file the author mapped that can't be
 * retrieved is a write failure the engine should surface, not silently drop.
 */
async function fileRefToBlob(
  ref: FileRef,
  teamId: TeamId,
): Promise<{ body: Blob; fileName: string }> {
  const resolved = await streamFileRef(ref, { teamId });
  const bytes = await streamToBuffer(resolved.stream);
  const contentType =
    resolved.contentType ?? ref.contentType ?? 'application/octet-stream';
  const fileName = ref.name ?? 'attachment';
  return { body: new Blob([bytes], { type: contentType }), fileName };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createAttioAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): AttioAdapter {
  if (!input.credentialsId) {
    throw new Error(
      'Attio adapter requires credentialsId — wire pipeline_input.credentials_id (in-flow) or pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  return new AttioAdapter({
    teamId: input.teamId,
    credentialsId: input.credentialsId,
  });
}
