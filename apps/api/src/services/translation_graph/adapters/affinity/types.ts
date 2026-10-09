// Affinity TG adapter — shared types, the entity structured identifier, the
// credential parser, and the Affinity value-type constants the adapter consumes.
//
// A TG type is one of Affinity's writable entities: organization, person,
// list-entry, note, file. The framework names every type by its pretty
// `displayName` (`Organization`, `List Entry — <list>`); the adapter's private
// `name → structured identifier` cache maps that name to the `DecodedTypeId`
// (`{ entity, listId? }`) its read/write logic routes on. The five fixed
// entities resolve PURELY (their names are compile-time constants), so they
// resolve before any introspected per-list cache (mirrors Attio's synthetic
// meta types). The richer per-list form (`{ entity: 'list-entry', listId }`)
// pins a single list while still resolving back to the generic `list-entry`
// schema; only the per-list names carry a listId the live catalog knows.
//
// Affinity has a v3 OUTPUT only (no v3 input), so the TG adapter is a write
// target plus the reads that support it — parity = the target side.

import { z } from 'zod';

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const AFFINITY_ADAPTER_TYPE = 'affinity';

/**
 * The Affinity entities the adapter exposes as TG types. The first five are
 * the writable set lifted from the v3 output's action-type dispatch
 * (`organization`, `person`, `list-entry`, `note`, `file`); the rest are the
 * read surfaces the v1 API scopes to those records (2026-07-17,
 * explorer review): `opportunity` (the third top-level Affinity entity),
 * `reminder`, `interaction` (emails / calls / meetings / chat), and
 * `relationship-strength` (read-only, per external person). The v3 `preview`
 * action is a dry-run concern, not a TG method, so it is intentionally
 * absent.
 */
export const AFFINITY_ENTITIES = [
  'organization',
  'person',
  'opportunity',
  'list-entry',
  'note',
  'file',
  'reminder',
  'interaction',
  'relationship-strength',
] as const;

export type AffinityEntity = (typeof AFFINITY_ENTITIES)[number];

// ── Entity structured identifier ───────────────────────────────────────────
// The structured id the read/write/traverse logic routes on, recovered from a
// position's pretty type NAME via the adapter's name cache. `listId` is present
// only for a per-list entry type (`List Entry — <list>`).

export interface DecodedTypeId {
  entity: AffinityEntity;
  /** Present only for a per-list entry type. */
  listId?: number;
  /** The list's own name, present only for a per-list entry type. It comes off
   *  the same catalog row as `listId`, and it is what tells a list-scoped
   *  field's name from the redundant `[<list>] ` prefix Affinity puts in front
   *  of it — so every path that names a field on this type answers from the
   *  structured id rather than re-fetching the list catalog. */
  listName?: string;
  /** The list's entity kind (Affinity `list.type`: 0 person, 1 organization,
   *  8 opportunity), present only for a per-list entry type. It pins the entry's
   *  single parent up-hop and its list-scoped custom-field entity type — the
   *  facts a generic (un-narrowed) list entry cannot commit to. */
  listType?: number;
  /** Present only for a per-entity LIST-ENTRY COLLECTION — the polymorphic type
   *  a record's `List Entries` edge lands on. Its value is the parent entity
   *  kind, which filters the collection BOTH ways: its polymorphic members (the
   *  per-list entry types a read narrows to) and its `listName` enum plus
   *  discriminated write variants are all drawn from lists of THAT kind.
   *
   *  Per-entity rather than one shared collection because members are looked up
   *  globally by `position.recordType` (`membersOf`) — a shared type would let an
   *  organization narrow to a PERSON list, the fail-open lie layer 12 rejected.
   *  Here the wrong lists are not representable. Carries no `listId`: a member is
   *  selected by narrowing (read) or NAMED in the write body (write). */
  listsFor?: ListEntityKind;
}

/** The name a list's own entry type carries. One spelling, so a name minted by
 *  the catalog and a name looked up by a write cannot drift apart. */
export function perListTypeName(listName: string): string {
  return `List Entry — ${listName}`;
}

/** The list a per-list entry type is named for — the inverse of
 *  `perListTypeName`, for the paths that hold the type name and want the list. */
export function listNameFromPerListType(typeName: string): string {
  return typeName.replace(/^List Entry — /, '');
}

/** The entity kinds an Affinity list can be typed to (`list.type`). A list entry
 *  sits on exactly one of these, which is why each per-list type carries exactly
 *  one parent up-hop. */
export type ListEntityKind = 'organization' | 'person' | 'opportunity';

/** The per-entity list-entry collections — the polymorphic type each record's
 *  `List Entries` edge lands on. Display name ↔ parent entity kind. */
export const LIST_ENTRY_COLLECTION_DISPLAY_NAMES: Record<ListEntityKind, string> = {
  organization: 'Organization List Entry',
  person: 'Person List Entry',
  opportunity: 'Opportunity List Entry',
};

const LISTS_FOR_BY_DISPLAY_NAME = Object.fromEntries(
  Object.entries(LIST_ENTRY_COLLECTION_DISPLAY_NAMES).map(([kind, name]) => [name, kind]),
) as Record<string, ListEntityKind>;

/** Which entity kinds a record can actually be ADDED to a list as. Affinity's
 *  `createListEntry` attaches an organization or a person; an opportunity joins
 *  a list only at creation, so its collection reads but never writes. */
export const WRITABLE_LIST_ENTITY_KINDS: readonly ListEntityKind[] = ['organization', 'person'];

/** Affinity list-entity kinds (`list.type`) mapped to the adapter's entity
 *  names — the one parent a list entry of this list kind up-hops to. */
export function listEntityKind(listType: number | null | undefined): ListEntityKind | null {
  switch (listType) {
    case 0:
      return 'person';
    case 1:
      return 'organization';
    case 8:
      return 'opportunity';
    default:
      return null;
  }
}

/**
 * The `/fields` catalog a list entry's fields are named from: the entity kind
 * the LIST is typed to (an org list's fields are ORGANIZATION fields carrying
 * that list's id). A per-list type carries the kind on `listType`; a record's
 * membership collection is already scoped to it (`listsFor`). Opportunity lists
 * publish no org/person custom fields on this surface, so they name no catalog.
 */
export function listCatalogType(decoded: DecodedTypeId): 'ORGANIZATION' | 'PERSON' | null {
  const kind = decoded.listsFor ?? listEntityKind(decoded.listType);
  return kind === 'organization' ? 'ORGANIZATION' : kind === 'person' ? 'PERSON' : null;
}

/** The pretty display name each fixed entity carries as its framework identity
 *  (its `recordType` / entry `typeId`). The single source of truth shared by
 *  the schema catalog and the name cache. */
export const ENTITY_DISPLAY_NAMES: Record<AffinityEntity, string> = {
  organization: 'Organization',
  person: 'Person',
  opportunity: 'Opportunity',
  'list-entry': 'List Entry',
  note: 'Note',
  file: 'File',
  reminder: 'Reminder',
  interaction: 'Interaction',
  'relationship-strength': 'Relationship Strength',
};

const FIXED_ENTITY_BY_DISPLAY_NAME: Record<string, AffinityEntity> = Object.fromEntries(
  AFFINITY_ENTITIES.map((e) => [ENTITY_DISPLAY_NAMES[e], e]),
);

/**
 * Resolve a FIXED entity type's pretty display name to its structured id. The
 * five entity types have no name↔id introspection gap — their names are
 * compile-time constants — so they resolve PURELY, before the introspected
 * per-list name cache (mirrors Attio resolving its synthetic meta types before
 * the cache). A per-list entry type (`List Entry — <list>`) carries a listId
 * only the adapter's live list catalog knows, so it is NOT resolved here.
 */
export function decodedFixedType(displayName: string): DecodedTypeId | null {
  const listsFor = LISTS_FOR_BY_DISPLAY_NAME[displayName];
  if (listsFor) return { entity: 'list-entry', listsFor };
  const entity = FIXED_ENTITY_BY_DISPLAY_NAME[displayName];
  return entity ? { entity } : null;
}

// ── Affinity enum vocabularies (docs: api-docs.affinity.co) ─────────────────
// Numeric wire codes ↔ the author-facing labels the descriptors publish and
// the canonical landing data carries. One source so the schema catalog's
// `enumValues` and the landing builders can never disagree.

/** "Field Entity Types" enum — `entity_type` on list entries, field values,
 *  and webhook payloads: person = 0, organization = 1, opportunity = 8. */
export const AFFINITY_ENTITY_TYPE = {
  PERSON: 0,
  ORGANIZATION: 1,
  OPPORTUNITY: 8,
} as const;

/** Interaction `type` codes → labels (Interactions Types table). */
export const INTERACTION_TYPE_LABELS: Record<number, string> = {
  0: 'Meeting',
  1: 'Call',
  2: 'Chat message',
  3: 'Email',
};

/** Interaction / chat `direction` codes → labels (Direction Types table). */
export const INTERACTION_DIRECTION_LABELS: Record<number, string> = {
  0: 'Sent',
  1: 'Received',
};

/** Reminder `type` codes → labels (Reminder Types table). */
export const REMINDER_TYPE_LABELS: Record<number, string> = {
  0: 'One-time',
  1: 'Recurring',
};

/** Reminder `reset_type` codes → labels (Reminder Reset Types table). */
export const REMINDER_RESET_TYPE_LABELS: Record<number, string> = {
  0: 'Interaction',
  1: 'Email',
  2: 'Meeting',
};

/** Reminder `status` codes → labels (Reminder Status Types table). */
export const REMINDER_STATUS_LABELS: Record<number, string> = {
  0: 'Completed',
  1: 'Active',
  2: 'Overdue',
};

// ── Affinity custom-field value types (mirrors apiClient `valueType`) ───────
// Re-declared here so the schema-catalog mapping doesn't reach across the
// adapter boundary for a literal constant set. Values match the apiClient.

export const AFFINITY_VALUE_TYPE = {
  PERSON: 0,
  ORGANIZATION: 1,
  DROPDOWN: 2,
  NUMBER: 3,
  DATE: 4,
  LOCATION: 5,
  TEXT: 6,
  RANKED_DROPDOWN: 7,
} as const;

/**
 * THE display name every list-scoped field carries on its own list's type,
 * keyed by field id.
 *
 * The catalog is fetched with modified names, so Affinity prefixes a
 * list-scoped field with `[<list>] `. On the type that IS that list the prefix
 * repeats the type's own name and nothing else, so it comes off and the author
 * writes the field the way the list shows it. Organization and Person keep what
 * they show today — they carry no list-scoped fields at all.
 *
 * Two fields whose bare names would collide — with each other, or with some
 * other field already carrying that name verbatim — BOTH keep their prefix: one
 * name has to mean one field, and nothing else in the pair says which.
 *
 * `catalog` is the whole fetched field set, list-scoped and entity-level alike,
 * so the collision test sees every name in play; only fields on `listId` come
 * back.
 */
export function listScopedFieldDisplayNames(input: {
  catalog: readonly AffinityFieldMeta[];
  listId: number;
  listName: string;
}): Map<number, string> {
  const prefix = `[${input.listName}] `;
  const verbatim = new Set(input.catalog.map((f) => f.name));
  const scoped = input.catalog.filter((f) => f.list_id === input.listId);

  const bareByFieldId = new Map<number, string>();
  const claims = new Map<string, number>();
  for (const field of scoped) {
    if (!field.name.startsWith(prefix)) continue;
    const bare = field.name.slice(prefix.length);
    if (bare === '') continue;
    bareByFieldId.set(field.id, bare);
    claims.set(bare, (claims.get(bare) ?? 0) + 1);
  }

  const names = new Map<number, string>();
  for (const field of scoped) {
    const bare = bareByFieldId.get(field.id);
    const contested = bare === undefined || claims.get(bare)! > 1 || verbatim.has(bare);
    names.set(field.id, contested ? field.name : bare);
  }
  return names;
}

/**
 * A custom field whose value is another Affinity record (a Person- or
 * Organization-valued field) is a REFERENCE — modelled as an edge in
 * `describe`'s `references[]` and written via `parentLinks`, not as a scalar
 * property. The single source of truth for that classification, shared by the
 * schema catalog and the write path so they can never disagree.
 */
export function isReferenceValueType(valueType: number): boolean {
  return (
    valueType === AFFINITY_VALUE_TYPE.PERSON ||
    valueType === AFFINITY_VALUE_TYPE.ORGANIZATION
  );
}

// ── Credential parser ──────────────────────────────────────────────────────
// Mirrors `affinityCredsParser` from the apiClient; re-declared here so the
// adapter validates the decrypted payload at its own boundary (same shape).

export const affinityAdapterCredsParser = z.object({
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
});

export type AffinityAdapterCreds = z.infer<typeof affinityAdapterCredsParser>;

// ── Affinity field metadata (subset the adapter consumes) ──────────────────
// The apiClient's `getFields` returns richer rows; the adapter only reads
// these. Kept structural so the apiClient's parsed shape is assignable.

export interface AffinityFieldMeta {
  id: number;
  name: string;
  list_id: number | null;
  enrichment_source: string | null;
  value_type: number;
  allows_multiple: boolean;
  dropdown_options: { id: number; text: string; rank: number; color: number }[] | null;
}
