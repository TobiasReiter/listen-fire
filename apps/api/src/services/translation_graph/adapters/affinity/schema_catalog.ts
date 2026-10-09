// Affinity TG adapter — schema introspection. `listEntryPoints` enumerates
// the five writable entity types (plus a per-list entry type per Affinity
// list); `describe(typeId)` loads one entity's built-in fields, its custom
// fields (via `getFields`), and its references (org↔person).
//
// Built-in identity fields are NOT invented as uniqueness constraints —
// Affinity identity (domain/name for orgs, email for persons) is surfaced as
// natural-key fields, and the TG layer designates identity via author-defined
// constraints (adapter-minimalism). `describe` therefore leaves
// `uniquenessConstraints` unset.

import type { AffinityAPIClient } from '../../../../adapters/affinity/apiClient';
import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaFieldKind,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from '../../types';
import {
  AFFINITY_ADAPTER_TYPE,
  AFFINITY_ENTITIES,
  AFFINITY_VALUE_TYPE,
  ENTITY_DISPLAY_NAMES,
  isReferenceValueType,
  listEntityKind,
  perListTypeName,
  listScopedFieldDisplayNames,
  LIST_ENTRY_COLLECTION_DISPLAY_NAMES,
  WRITABLE_LIST_ENTITY_KINDS,
  type AffinityEntity,
  type AffinityFieldMeta,
  type DecodedTypeId,
  type ListEntityKind,
} from './types';

// ── The field catalog ───────────────────────────────────────────────────────
// The cache itself lives on the CLIENT (adapters/affinity/apiClient.ts), which
// is the one layer already keyed by the credential — this was keyed by team,
// which served a team's second Affinity connection the FIRST workspace's
// schema, and a list-scoped ask skipped it entirely.

export async function cachedFields(input: {
  client: AffinityAPIClient;
  type: 'ORGANIZATION' | 'PERSON';
  listId?: number;
}): Promise<AffinityFieldMeta[]> {
  return (await input.client.getFields({
    type: input.type,
    ...(input.listId != null ? { limitToListId: input.listId } : {}),
  })) as AffinityFieldMeta[];
}

/** The workspace's lists, named and typed. Cached on the client, per
 *  credential; `type` is the Affinity `list.type` — it decides each entry's
 *  single parent up-hop and its list-scoped custom-field type. */
async function cachedLists(input: {
  client: AffinityAPIClient;
  teamId: string;
}): Promise<{ id: number; name: string; type: number | null }[]> {
  const lists = await input.client.getAllLists();
  return lists.map((l) => ({ id: l.id, name: l.name ?? `List ${l.id}`, type: l.type ?? null }));
}

// ── Entity → built-in fields + references ───────────────────────────────────
// The built-in (non-custom) fields each entity carries natively. Org identity
// is domain/name; person identity is email. These are surfaced as natural-key
// fields the TG layer can designate as identity — never as invented
// uniqueness constraints.

interface BuiltinField {
  fieldId: string;
  displayName: string;
  kind: SchemaFieldKind;
  cardinality?: 'one' | 'many';
  writable: boolean;
  /** Absent ⇒ true. `false` = write-only (an upload channel, never read back). */
  readable?: boolean;
  enumValues?: string[];
  description?: string;
}

const ORG_BUILTINS: BuiltinField[] = [
  { fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, description: "Organization name — a natural key Affinity matches on." },
  { fieldId: 'domain', displayName: 'Domain', kind: 'string', writable: true, description: "Primary web domain — the strongest natural key for org identity." },
  { fieldId: 'domains', displayName: 'Domains', kind: 'string', cardinality: 'many', writable: false, description: 'All known web domains for the organization.' },
];

const PERSON_BUILTINS: BuiltinField[] = [
  { fieldId: 'firstName', displayName: 'First name', kind: 'string', writable: true },
  { fieldId: 'lastName', displayName: 'Last name', kind: 'string', writable: true },
  { fieldId: 'name', displayName: 'Full name', kind: 'string', writable: true, description: 'Full name — split into first/last when first/last are not provided.' },
  { fieldId: 'email', displayName: 'Email', kind: 'string', writable: true, description: 'Primary email — the natural key for person identity.' },
  { fieldId: 'emails', displayName: 'Emails', kind: 'string', cardinality: 'many', writable: false, description: 'All known email addresses for the person.' },
];

const NOTE_BUILTINS: BuiltinField[] = [
  {
    fieldId: 'content',
    displayName: 'Content',
    kind: 'string',
    writable: true,
    description: 'Note body. Attached to the parent organization, person, or opportunity.',
  },
  { fieldId: 'created_at', displayName: 'Created at', kind: 'date', writable: false },
  { fieldId: 'updated_at', displayName: 'Updated at', kind: 'date', writable: false },
];

const FILE_BUILTINS: BuiltinField[] = [
  {
    fieldId: 'file',
    displayName: 'File',
    kind: 'file',
    writable: true,
    // The upload channel: bytes go in on a write and are never read back as a
    // scalar (downloads are a separate endpoint the adapter doesn't surface).
    readable: false,
    description: 'A file (deck, document) uploaded to the parent organization, person, or opportunity.',
  },
  { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, description: 'File name.' },
  { fieldId: 'size', displayName: 'Size', kind: 'number', writable: false, description: 'File size in bytes.' },
  { fieldId: 'created_at', displayName: 'Created at', kind: 'date', writable: false },
];

const LIST_ENTRY_BUILTINS: BuiltinField[] = [];

const OPPORTUNITY_BUILTINS: BuiltinField[] = [
  {
    fieldId: 'name',
    displayName: 'Name',
    kind: 'string',
    writable: false,
    description: 'Opportunity name.',
  },
];

const REMINDER_BUILTINS: BuiltinField[] = [
  { fieldId: 'content', displayName: 'Content', kind: 'string', writable: false, description: 'What the reminder says.' },
  { fieldId: 'type', displayName: 'Type', kind: 'enum', writable: false, enumValues: ['One-time', 'Recurring'] },
  { fieldId: 'status', displayName: 'Status', kind: 'enum', writable: false, enumValues: ['Completed', 'Active', 'Overdue'] },
  { fieldId: 'reset_type', displayName: 'Reset type', kind: 'enum', writable: false, enumValues: ['Interaction', 'Email', 'Meeting'], description: 'What resets a recurring reminder.' },
  { fieldId: 'reminder_days', displayName: 'Reminder days', kind: 'number', writable: false, description: 'Days until a recurring reminder is due again after completing or resetting.' },
  { fieldId: 'due_date', displayName: 'Due date', kind: 'date', writable: false },
  { fieldId: 'created_at', displayName: 'Created at', kind: 'date', writable: false },
  { fieldId: 'completed_at', displayName: 'Completed at', kind: 'date', writable: false },
];

const INTERACTION_BUILTINS: BuiltinField[] = [
  { fieldId: 'type', displayName: 'Type', kind: 'enum', writable: false, enumValues: ['Meeting', 'Call', 'Chat message', 'Email'] },
  { fieldId: 'date', displayName: 'Date', kind: 'date', writable: false, description: 'When the interaction happened.' },
  { fieldId: 'title', displayName: 'Title', kind: 'string', writable: false, description: 'Event title (meetings and calls).' },
  { fieldId: 'subject', displayName: 'Subject', kind: 'string', writable: false, description: 'Email subject (emails only).' },
  { fieldId: 'direction', displayName: 'Direction', kind: 'enum', writable: false, enumValues: ['Sent', 'Received'], description: 'Sent by an internal or an external person (chat messages and emails).' },
  { fieldId: 'attendees', displayName: 'Attendees', kind: 'string', cardinality: 'many', writable: false, description: 'Attendee emails (meetings and calls).' },
  { fieldId: 'start_time', displayName: 'Start time', kind: 'date', writable: false },
  { fieldId: 'end_time', displayName: 'End time', kind: 'date', writable: false },
];

const RELATIONSHIP_STRENGTH_BUILTINS: BuiltinField[] = [
  {
    fieldId: 'strength',
    displayName: 'Strength',
    kind: 'number',
    writable: false,
    description: 'Affinity-computed relationship strength between the internal and external person (currently 0–1; an estimate, recalculated roughly daily).',
  },
];

function builtinsFor(entity: AffinityEntity): BuiltinField[] {
  switch (entity) {
    case 'organization':
      return ORG_BUILTINS;
    case 'person':
      return PERSON_BUILTINS;
    case 'opportunity':
      return OPPORTUNITY_BUILTINS;
    case 'note':
      return NOTE_BUILTINS;
    case 'file':
      return FILE_BUILTINS;
    case 'list-entry':
      return LIST_ENTRY_BUILTINS;
    case 'reminder':
      return REMINDER_BUILTINS;
    case 'interaction':
      return INTERACTION_BUILTINS;
    case 'relationship-strength':
      return RELATIONSHIP_STRENGTH_BUILTINS;
  }
}

/**
 * References each entity publishes. The three top-level Affinity entities
 * (organization / person / opportunity) each scope the record-attached
 * surfaces — notes, files, list entries, interactions, reminders — as edges
 * (explorer review, 2026-07-17: attached records hang off the records
 * they're about, not the workspace root alone). Promises are per-EDGE:
 * `writable: false` on the enumerate-only surfaces (the v1 API reads them
 * here but creates them elsewhere or not at all), `writable: true` where a
 * linked write really creates along the hop (notes, files, note replies).
 */
function referencesFor(entity: AffinityEntity, listType?: number): SchemaReferenceDescriptor[] {
  /** The record-attached read surfaces every top-level entity scopes. */
  const attachedSurfaces = (
    parent: 'organization' | 'person' | 'opportunity',
  ): SchemaReferenceDescriptor[] => [
    {
      fieldId: 'notes',
      name: 'Notes',
      targetTypeId: ENTITY_DISPLAY_NAMES.note,
      cardinality: 'many',
      direction: 'outgoing',
      writable: true,
      // A note is WRITTEN onto its owner; Affinity has no way to re-home one
      // that already exists, so a `link` along this edge would only fail at
      // run time. Same for files and list entries below.
      linkable: false,
      description: `Notes attached to this ${parent} (GET /notes scoped to it). A linked write creates a note on it.`,
    },
    {
      fieldId: 'files',
      name: 'Files',
      targetTypeId: ENTITY_DISPLAY_NAMES.file,
      cardinality: 'many',
      direction: 'outgoing',
      writable: true,
      linkable: false,
      description: `Files uploaded to this ${parent} (GET /entity-files scoped to it). A linked write uploads one.`,
    },
    // ONE edge for ONE relationship (rule 6), readable AND writable. An Affinity
    // list is genuinely its own type — `Pipeline` carries `Deal Stage`,
    // `Portfolio` carries `Ownership %` — so this lands on a POLYMORPHIC
    // collection of that kind's per-list entry types:
    //
    //   read   `co-[e:List Entries WHERE `listName` == "Pipeline"]->` narrows to
    //          that list's own fields (unnarrowed shows the intersection).
    //   write  `write co-[:List Entries]-> { listName: "Pipeline", … }` — the
    //          SAME `listName` discriminant selects the same member's write
    //          shape (`discriminatedWrite`).
    //
    // Same member set both directions, so the declared type finally agrees with
    // what the read already lands at runtime (per-list, not the generic).
    {
      fieldId: 'list_entries',
      name: AFFINITY_LIST_ENTRIES_EDGE,
      targetTypeId: LIST_ENTRY_COLLECTION_DISPLAY_NAMES[parent],
      cardinality: 'many',
      direction: 'outgoing',
      // Affinity's `createListEntry` attaches an org or a person; an opportunity
      // joins a list only at creation, so its collection reads but never writes.
      writable: (WRITABLE_LIST_ENTITY_KINDS as readonly string[]).includes(parent),
      // Membership is MADE by adding this record to a list. An entry that
      // already exists IS its (list, member) pair — there is nothing to point
      // at a different list — so a `link` along this edge cannot be honoured.
      linkable: false,
      description: `This ${parent}'s rows across the lists it's on. Narrow by \`listName\` to one list and its own entry fields${
        (WRITABLE_LIST_ENTITY_KINDS as readonly string[]).includes(parent)
          ? `; a write adds this ${parent} to the named list.`
          : '.'
      }`,
    },
    {
      fieldId: 'interactions',
      name: 'Interactions',
      targetTypeId: ENTITY_DISPLAY_NAMES.interaction,
      cardinality: 'many',
      direction: 'outgoing',
      writable: false,
      description: `Emails, meetings, calls, and chat messages involving this ${parent} over the last year (GET /interactions, one call per interaction type).`,
    },
    {
      fieldId: 'reminders',
      name: 'Reminders',
      targetTypeId: ENTITY_DISPLAY_NAMES.reminder,
      cardinality: 'many',
      direction: 'outgoing',
      writable: false,
      description: `Reminders tagged with this ${parent}.`,
    },
  ];

  switch (entity) {
    case 'organization':
      return [
        {
          fieldId: 'people',
          name: AFFINITY_PEOPLE_EDGE,
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'many',
          direction: 'outgoing',
          // Affinity's org↔person association is N×M (a person works at many
          // orgs, an org has many people) and the adapter really writes it
          // from THIS side: `createPerson`'s `parentOrgId` (person.ts) picks up
          // an organization parent whose edge is not a custom reference field
          // and passes it as `orgId`, which `createOrUpdatePerson`
          // (adapters/affinity/operations.ts) APPENDS to the person's
          // `organization_ids` — link, never clobber — or supplies at
          // `createPerson` time for a brand-new person.
          writable: true,
          description:
            'People associated with this organization. A linked write creates or finds the person and adds this organization to their employers (the association is many-to-many, so existing ones are kept).',
        },
        ...attachedSurfaces('organization'),
      ];
    case 'person':
      return [
        {
          fieldId: 'organizations',
          name: AFFINITY_ORGANIZATIONS_EDGE,
          targetTypeId: ENTITY_DISPLAY_NAMES.organization,
          cardinality: 'many',
          direction: 'outgoing',
          // The same N×M association as `Organization -[:People]->`, written
          // from this side too: `createOrganization`'s `linkParentPeople`
          // (organization.ts) picks up a person parent whose edge is not a
          // custom reference field and APPENDS the created/matched org to that
          // person's `organization_ids` — link, never clobber, and a no-op when
          // the link already exists.
          writable: true,
          description:
            'Organizations this person is associated with. A linked write creates or finds the organization and adds it to this person’s employers (the association is many-to-many, so existing ones are kept).',
        },
        ...attachedSurfaces('person'),
        {
          fieldId: 'relationship_strengths',
          name: 'Relationship Strengths',
          targetTypeId: ENTITY_DISPLAY_NAMES['relationship-strength'],
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description:
            'Affinity-computed strengths between this (external) person and each internal person they have history with (GET /relationships-strengths). Read-only.',
        },
      ];
    case 'opportunity':
      return [
        {
          fieldId: 'people',
          name: 'People',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description: 'People associated with this opportunity.',
        },
        {
          fieldId: 'organizations',
          name: 'Organizations',
          targetTypeId: ENTITY_DISPLAY_NAMES.organization,
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description: 'Organizations associated with this opportunity.',
        },
        ...attachedSurfaces('opportunity'),
      ];
    case 'list-entry': {
      // The up-hop to the record the entry sits on. An Affinity list is TYPED
      // (`list.type`), so every entry on it sits on exactly ONE entity kind —
      // a per-list type publishes that single parent up-hop, named by the
      // concrete type. The generic (un-narrowed) `List Entry` is the UNION of
      // every per-list type; the up-hops are distinctly named and differ per
      // list, so their intersection is empty and the generic publishes NONE
      // (layer 11 — a polymorphic type's direct surface is the intersection of
      // its members; you learn the parent by narrowing to a list). Deal-stage
      // moves arrive as list-entry events; the per-list parent hop is what lets
      // a movement read/act on the underlying company, person, or opportunity.
      const parentUpHop: Record<'organization' | 'person' | 'opportunity', SchemaReferenceDescriptor> = {
        organization: {
          fieldId: 'organization',
          name: 'Organization',
          targetTypeId: ENTITY_DISPLAY_NAMES.organization,
          cardinality: 'one',
          direction: 'outgoing',
          description: 'The organization this list entry is on.',
        },
        person: {
          fieldId: 'person',
          name: 'Person',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'one',
          direction: 'outgoing',
          description: 'The person this list entry is on.',
        },
        opportunity: {
          fieldId: 'opportunity',
          name: 'Opportunity',
          targetTypeId: ENTITY_DISPLAY_NAMES.opportunity,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The opportunity this list entry is on.',
        },
      };
      const parent = listEntityKind(listType);
      return parent ? [parentUpHop[parent]] : [];
    }
    case 'note':
      return [
        {
          fieldId: 'replies',
          name: 'Replies',
          targetTypeId: ENTITY_DISPLAY_NAMES.note,
          cardinality: 'many',
          direction: 'outgoing',
          writable: true,
          // A reply is a note WRITTEN under this one; an existing note cannot
          // be re-parented, so there is nothing to link.
          linkable: false,
          description:
            'Reply notes threaded under this note (notes whose parent_id is this note). A linked write creates a reply.',
        },
        {
          fieldId: 'parent',
          name: 'Parent Note',
          targetTypeId: ENTITY_DISPLAY_NAMES.note,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The note this note replies to (empty for a top-level note).',
        },
        {
          fieldId: 'organizations',
          name: 'Organizations',
          targetTypeId: ENTITY_DISPLAY_NAMES.organization,
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description: 'Organizations this note is attached to (replies carry none — only the parent note is associated).',
        },
        {
          fieldId: 'people',
          name: 'People',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description: 'People this note is attached to.',
        },
        {
          fieldId: 'opportunities',
          name: 'Opportunities',
          targetTypeId: ENTITY_DISPLAY_NAMES.opportunity,
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description: 'Opportunities this note is attached to.',
        },
      ];
    case 'file':
      return [
        {
          fieldId: 'organization',
          name: 'Organization',
          targetTypeId: ENTITY_DISPLAY_NAMES.organization,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The organization this file is on (when it was uploaded to one).',
        },
        {
          fieldId: 'person',
          name: 'Person',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The person this file is on (when it was uploaded to one).',
        },
        {
          fieldId: 'opportunity',
          name: 'Opportunity',
          targetTypeId: ENTITY_DISPLAY_NAMES.opportunity,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The opportunity this file is on (when it was uploaded to one).',
        },
      ];
    case 'reminder':
      return [
        {
          fieldId: 'person',
          name: 'Person',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The person tagged in the reminder (when it tags one).',
        },
        {
          fieldId: 'organization',
          name: 'Organization',
          targetTypeId: ENTITY_DISPLAY_NAMES.organization,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The organization tagged in the reminder (when it tags one).',
        },
        {
          fieldId: 'opportunity',
          name: 'Opportunity',
          targetTypeId: ENTITY_DISPLAY_NAMES.opportunity,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The opportunity tagged in the reminder (when it tags one).',
        },
        {
          fieldId: 'owner',
          name: 'Owner',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The internal person the reminder is assigned to.',
        },
      ];
    case 'interaction':
      return [
        {
          fieldId: 'people',
          name: 'People',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description: 'The people involved (attendees, callers, senders and recipients).',
        },
        {
          fieldId: 'notes',
          name: 'Notes',
          targetTypeId: ENTITY_DISPLAY_NAMES.note,
          cardinality: 'many',
          direction: 'outgoing',
          writable: false,
          description: 'Notes taken on this interaction.',
        },
      ];
    case 'relationship-strength':
      return [
        {
          fieldId: 'internal_person',
          name: 'Internal Person',
          targetTypeId: ENTITY_DISPLAY_NAMES.person,
          cardinality: 'one',
          direction: 'outgoing',
          writable: false,
          description: 'The internal person this strength is measured against.',
        },
      ];
  }
}

/** Entity → which custom-field entity_type to query (null = no custom fields). */
function customFieldEntityType(entity: AffinityEntity): 'ORGANIZATION' | 'PERSON' | null {
  if (entity === 'organization') return 'ORGANIZATION';
  if (entity === 'person') return 'PERSON';
  // list-entry custom fields are list-scoped org/person fields, resolved at
  // describe time once a list is pinned. note/file carry no custom fields.
  return null;
}

/** Entities whose write config is inherited from the enclosing parent action
 *  (note attaches to org/person; file to org; list-entry to org/person). */
const INHERITS_PARENT: ReadonlySet<AffinityEntity> = new Set([
  'list-entry',
  'note',
  'file',
]);

function affinityValueTypeToKind(valueType: number): { kind: SchemaFieldKind; cardinality: 'one' | 'many' } {
  switch (valueType) {
    case AFFINITY_VALUE_TYPE.NUMBER:
      return { kind: 'number', cardinality: 'one' };
    case AFFINITY_VALUE_TYPE.DATE:
      return { kind: 'date', cardinality: 'one' };
    case AFFINITY_VALUE_TYPE.DROPDOWN:
    case AFFINITY_VALUE_TYPE.RANKED_DROPDOWN:
      return { kind: 'enum', cardinality: 'one' };
    case AFFINITY_VALUE_TYPE.PERSON:
    case AFFINITY_VALUE_TYPE.ORGANIZATION:
      return { kind: 'reference', cardinality: 'one' };
    case AFFINITY_VALUE_TYPE.LOCATION:
      // A structured address (street / city / state / country), so genuinely
      // json — it never was readable as text, whatever the projection claimed.
      return { kind: 'json', cardinality: 'one' };
    case AFFINITY_VALUE_TYPE.TEXT:
    default:
      return { kind: 'string', cardinality: 'one' };
  }
}

/**
 * A custom field that points at another Affinity record (a Person- or
 * Organization-valued field) is a REFERENCE — modelled as an edge, not a
 * scalar property (per the field-vs-edge rule: an FK is an edge by default;
 * it only collapses to a field when you wouldn't write the target and it's
 * uniquely keyable on hand). Affinity write-resolves these by name with
 * find-or-create — i.e. we DO write the target — so they're edges. Surfacing
 * them in `references[]` (rather than as a `kind:'reference'` field, which the
 * movement schema projection silently drops) makes them author-able as linked
 * writes and keeps the editor edge picker honest.
 */
function customFieldReference(
  field: AffinityFieldMeta,
  displayName: string,
): SchemaReferenceDescriptor {
  const targetEntity: AffinityEntity =
    field.value_type === AFFINITY_VALUE_TYPE.PERSON ? 'person' : 'organization';
  return {
    fieldId: String(field.id),
    name: displayName,
    targetTypeId: ENTITY_DISPLAY_NAMES[targetEntity],
    cardinality: field.allows_multiple ? 'many' : 'one',
    direction: 'outgoing',
    // The write is real and is the whole reason these are edges:
    // `applyCustomReferenceParentLinks` (shared.ts) matches the write's
    // edgeName back to this field and creates/updates the field value pointing
    // at the freshly written child — append for `allows_multiple`, replace for
    // single. Both createOrganization and createPerson call it.
    writable: true,
    description: `${displayName} — a ${targetEntity} reference field on this record. A linked write sets it to the ${targetEntity} written along the edge.`,
  };
}

function customFieldDescriptor(
  field: AffinityFieldMeta,
  displayName: string,
): SchemaFieldDescriptor {
  const shape = affinityValueTypeToKind(field.value_type);
  const enumValues =
    (field.value_type === AFFINITY_VALUE_TYPE.DROPDOWN ||
      field.value_type === AFFINITY_VALUE_TYPE.RANKED_DROPDOWN) &&
    field.dropdown_options?.length
      ? field.dropdown_options.map((o) => o.text)
      : undefined;
  return {
    fieldId: String(field.id),
    displayName,
    kind: shape.kind,
    cardinality: field.allows_multiple ? 'many' : shape.cardinality,
    enumValues,
    // Affinity documents no custom field whose value the API refuses —
    // enriched ones included (`enrichment_source` names where a value came
    // from, not who may set it) — so every field is writable, and a value
    // Affinity does refuse fails the write naming the field.
    writable: true,
    required: false,
    uiHint: enumValues ? 'select' : undefined,
  };
}

function builtinDescriptor(field: BuiltinField): SchemaFieldDescriptor {
  return {
    fieldId: field.fieldId,
    displayName: field.displayName,
    kind: field.kind,
    cardinality: field.cardinality ?? 'one',
    writable: field.writable,
    ...(field.readable === false ? { readable: false } : {}),
    ...(field.enumValues ? { enumValues: field.enumValues } : {}),
    required: false,
    description: field.description,
    uiHint:
      field.kind === 'string' && field.fieldId === 'content'
        ? 'prompt'
        : field.enumValues
          ? 'select'
          : undefined,
  };
}

// ── listEntryPoints ──────────────────────────────────────────────────────────

/**
 * Per-entity ROOT promises — what the meta edge to each type honestly commits
 * to. Rule 0 (adapters/CLAUDE.md): the root reflects the most NATURAL graph,
 * not the shape of the v1 API. A root promise means BOTH "the API affords the
 * access" AND "this is where the access naturally lives":
 *
 *   - Root readable: organizations, persons, opportunities
 *     (GET /opportunities) and reminders (GET /reminders). Each is a thing a
 *     user genuinely enumerates workspace-wide — and a reminder can be
 *     UNTAGGED (no parent record), so the root is its only COMPLETE surface
 *     (rule 9: it also appears as `record-[:Reminders]->`).
 *   - NOTES and FILES are retired from the root (rule 0, 2026-07-17). The v1
 *     API does enumerate both workspace-wide (GET /notes, GET /entity-files) —
 *     but a note and a file are OWNED by their record: createNote/createFile
 *     THROW without a parent (no orphan exists), so a flat root list is the
 *     API's shape, not the natural graph. Reads AND creates both live on
 *     `organization/person/opportunity-[:Notes|Files]->`. Attio's File made
 *     the same call from the other direction (record-scoped GET); this is the
 *     Affinity analog — same concept, same placement.
 *   - The generic List Entry is not root-readable — entries enumerate per list
 *     (`GET /lists/{id}/list-entries`), so its reads live on the per-list roots
 *     and the record edges. Interactions require a type + entity + time range;
 *     relationship strengths require an external person — both edge-only reads.
 *   - `writable` ⇔ the adapter really creates from the ROOT: org / person.
 *     Notes/files create along their record edge (never the root). List entries
 *     write through their per-list type. Opportunities are created on their
 *     list (POST /opportunities requires list_id) — not wired. Reminders /
 *     interactions / relationship strengths are read surfaces.
 */
const ENTRY_PROMISES: Record<AffinityEntity, { readable: boolean; writable: boolean; description: string }> = {
  organization: {
    readable: true,
    writable: true,
    description: 'A company in the CRM. Identity: domain (strongest) or name.',
  },
  person: {
    readable: true,
    writable: true,
    description: 'A person in the CRM. Identity: email.',
  },
  opportunity: {
    readable: true,
    writable: false,
    description:
      'A potential deal. Read-only here — Affinity creates opportunities on their list; every opportunity lives on exactly one list.',
  },
  'list-entry': {
    // NEITHER promise is real at the root, and nothing reaches this type any
    // more: a record's `List Entries` edge lands on its per-entity COLLECTION
    // (`Organization List Entry`), whose members are the per-list types. The
    // generic survives as a by-name sentinel — inbound events parse into it
    // before `preprocessInbound` narrows them to their per-list type.
    readable: false,
    writable: false,
    description:
      'A row on an Affinity list, before its list is known. Read a specific list via its own type (`List Entry — <list>`), or a record\'s List Entries edge — the API has no workspace-wide entry surface.',
  },
  note: {
    // Owned by its record (rule 0): a note attaches to exactly one org /
    // person / opportunity — createNote throws without a parent, so there is
    // no orphan note a root list could show. Read and write it on the record
    // (`record-[:Notes]->`); the root offers nothing.
    readable: false,
    writable: false,
    description:
      'A note on an organization, person, or opportunity. Notes live under their record — read or write one on the record\'s Notes edge (`<org/person/opportunity>-[:Notes]->`). Notes can reply to other notes.',
  },
  file: {
    // Owned by its record (rule 0): a file uploads to exactly one org /
    // person / opportunity — createFile throws without a parent. Same
    // placement as Attio's File. Read and write it on the record
    // (`record-[:Files]->`); the root offers nothing.
    readable: false,
    writable: false,
    description:
      'A file uploaded to an organization, person, or opportunity. Files live under their record — read or upload one on the record\'s Files edge (`<org/person/opportunity>-[:Files]->`).',
  },
  reminder: {
    readable: true,
    writable: false,
    description: 'A one-time or recurring reminder, optionally tagged with a person, organization, or opportunity. Read-only.',
  },
  interaction: {
    readable: false,
    writable: false,
    description:
      'An email, meeting, call, or chat message. Read it off a record\'s Interactions edge — the API enumerates interactions per record, per type, over a time range.',
  },
  'relationship-strength': {
    readable: false,
    writable: false,
    description:
      'Affinity\'s computed strength between an internal and an external person. Read it off a person\'s Relationship Strengths edge.',
  },
};

export async function listEntryPoints(input: {
  client: AffinityAPIClient;
  teamId: string;
}): Promise<SchemaEntryPoint[]> {
  const entries: SchemaEntryPoint[] = [];

  for (const entity of AFFINITY_ENTITIES) {
    const promises = ENTRY_PROMISES[entity];
    entries.push({
      // The framework identity IS the pretty entity name — the structured id
      // (`{ entity }`) lives only in the adapter's name cache.
      typeId: ENTITY_DISPLAY_NAMES[entity],
      displayName: ENTITY_DISPLAY_NAMES[entity],
      writable: promises.writable,
      readable: promises.readable,
      description: promises.description,
      scope: INHERITS_PARENT.has(entity) ? 'inherits-parent-config' : 'self-configured',
    });
  }

  // Per-list entry types — one per Affinity list, so an action can pin a list.
  let lists: { id: number; name: string; type: number | null }[] = [];
  try {
    lists = await cachedLists({ client: input.client, teamId: input.teamId });
  } catch {
    // A whoami/list failure shouldn't blank the whole picker — the generic
    // list-entry type above still lets the user author with an explicit listId.
    lists = [];
  }
  for (const list of lists) {
    entries.push({
      // Same: the per-list type's display name is its framework identity; the
      // list id rides `externalId` (and the per-list name cache).
      typeId: perListTypeName(list.name),
      displayName: perListTypeName(list.name),
      externalId: String(list.id),
      // READ-ONLY root (layer 12): a per-list root enumerates that list's
      // entries (`GET /lists/{id}/list-entries`), a real root read. But the
      // ENTRY create needs a parent record to attach — a root write can't
      // supply it (the honesty bug: `writable: true` typechecked
      // `write crm-[:`List Entry — Pipeline`]->` then threw for a missing
      // parent). Membership is written from the RECORD instead, via its
      // `List Entries` edge (`write <org/person>-[:List Entries]->
      // { listName: … }`).
      writable: false,
      readable: true,
      scope: 'inherits-parent-config',
      labelTemplate: perListTypeName(list.name),
    });
  }

  // The per-entity list-entry collections — the polymorphic type each record's
  // `List Entries` edge lands on. NEITHER promise is real at the ROOT: there is
  // no workspace-wide "all the list entries of org lists" enumeration, and a
  // create needs the parent record to attach. Both promises are the EDGE's, and
  // access lives where access is real (rule 0). The type is published so the
  // edge's target resolves, and so `membersOf` has a recordType to match.
  for (const listsFor of Object.keys(LIST_ENTRY_COLLECTION_DISPLAY_NAMES) as ListEntityKind[]) {
    entries.push({
      typeId: LIST_ENTRY_COLLECTION_DISPLAY_NAMES[listsFor],
      displayName: LIST_ENTRY_COLLECTION_DISPLAY_NAMES[listsFor],
      writable: false,
      readable: false,
      scope: 'inherits-parent-config',
    });
  }

  return entries;
}

/**
 * The per-list entry types' name → structured identifier map — one entry per
 * Affinity list, keyed by the same `List Entry — <list>` display name
 * `listEntryPoints` publishes. The five fixed entity types are NOT here; they
 * resolve purely via `decodedFixedType` before this introspected cache. A
 * whoami/list failure degrades to an empty map (the generic `List Entry` type
 * still resolves), never a throw.
 */
export async function loadPerListTypes(input: {
  client: AffinityAPIClient;
  teamId: string;
}): Promise<Map<string, DecodedTypeId>> {
  const map = new Map<string, DecodedTypeId>();
  let lists: { id: number; name: string; type: number | null }[] = [];
  try {
    lists = await cachedLists({ client: input.client, teamId: input.teamId });
  } catch {
    lists = [];
  }
  for (const list of lists) {
    map.set(perListTypeName(list.name), {
      entity: 'list-entry',
      listId: list.id,
      listName: list.name,
      listType: list.type ?? undefined,
    });
  }
  return map;
}

/** The write-only discriminant field that names the target list on a membership
 *  write (`write <record>-[:Lists]-> { listName: … }`). Shared authoring
 *  currency with Attio's `listName` — one word for "which list to add to". */
export const AFFINITY_LIST_NAME_FIELD = 'listName';

/** The edge a record's list memberships hang off. It is also the name the
 *  membership's identity is keyed by: an entry is unique per (record, list),
 *  and the record reaches the write through THIS edge, so the engine folds it
 *  into the resolve record under this exact name. */
export const AFFINITY_LIST_ENTRIES_EDGE = 'List Entries';

/**
 * The two names Affinity's BUILT-IN person↔organization association is
 * published under — one per side. Declared once and only ever COMPARED: the
 * catalog publishes exactly these names below, and the link path recognises
 * them, so neither can drift from the other.
 *
 * The association is no field on either record; it is the person's
 * `organization_ids`, which is why it needs naming at all — every other
 * relationship Affinity has IS a field, and is found by looking one up.
 */
export const AFFINITY_PEOPLE_EDGE = 'People';
export const AFFINITY_ORGANIZATIONS_EDGE = 'Organizations';
/** The internal ids of those same two edges, tolerated where an older saved
 *  program spelled an edge by its fieldId. */
export const AFFINITY_EMPLOYER_EDGE_IDS = ['people', 'organizations'] as const;

/**
 * The list-membership write target for one entity kind. Its single writable
 * field is a required, write-only `listName` enum over that kind's lists, and
 * its `discriminatedWrite` maps each list name to its per-list type — so the
 * list-scoped entry fields that ride the add are the ones THAT list actually
 * has (layer 12 + layer 10). Filtered to the entity's own lists (`list.type`),
 * so an org is only ever offered org-lists.
 */
async function describeListEntryCollection(input: {
  client: AffinityAPIClient;
  teamId: string;
  displayName: string;
  listsFor: ListEntityKind;
}): Promise<SchemaTypeDescriptor> {
  let lists: { id: number; name: string; type: number | null }[] = [];
  try {
    lists = await cachedLists({ client: input.client, teamId: input.teamId });
  } catch {
    lists = [];
  }
  const ownLists = lists.filter((l) => listEntityKind(l.type) === input.listsFor);
  const writable = (WRITABLE_LIST_ENTITY_KINDS as readonly string[]).includes(input.listsFor);
  return {
    typeId: input.displayName,
    displayName: input.displayName,
    description:
      `A row on one of this ${input.listsFor}'s lists. Which fields it has depends on WHICH ` +
      `list — narrow to one (\`-[e:List Entries WHERE \`${AFFINITY_LIST_NAME_FIELD}\` == "…"]->\`) ` +
      `and that list's own entry fields become available.`,
    // The INTERSECTION of the members (layer 11), and no more: the per-list
    // entry fields differ by list, so none of them are here. `listName` IS
    // common to every member — every entry knows the list it sits on — so it is
    // honestly readable, and it doubles as the narrowing predicate and the write
    // discriminant. One word, one meaning, both directions.
    fields: [
      {
        fieldId: AFFINITY_LIST_NAME_FIELD,
        displayName: AFFINITY_LIST_NAME_FIELD,
        kind: 'enum',
        enumValues: ownLists.map((l) => l.name),
        writable,
        readable: true,
        required: writable,
        uiHint: 'select',
        description: writable
          ? `Which list — narrow a read to one, or name it on a write to add this ${input.listsFor} to it.`
          : `Which list this entry sits on — narrow a read to one of your ${input.listsFor} lists.`,
      },
    ],
    references: [],
    // The write body is a discriminated union over the SAME member set the read
    // narrows over: `listName`'s literal selects the list, and that list's
    // per-list type carries the entry fields valid for it. Variant keys and the
    // enum above are BOTH `ownLists` names — same catalog — so a literal can't
    // enum-pass yet variant-miss.
    ...(writable
      ? {
          discriminatedWrite: {
            discriminant: AFFINITY_LIST_NAME_FIELD,
            variantTypes: Object.fromEntries(
              ownLists.map((l) => [l.name, perListTypeName(l.name)]),
            ),
          },
        }
      : {}),
    scope: 'inherits-parent-config',
    // A record sits on a list once. Re-asserting the membership must find the
    // entry it already has rather than mint a second one, so identity is the
    // pair (the record, the list) — the record folded in under the edge that
    // reached this write, the list named by the same discriminant the variant
    // is selected by. Without this the engine has no way to ask for the entry
    // and every re-run is a create.
    uniquenessConstraints: writable
      ? {
          any: [
            {
              all: [
                { field: AFFINITY_LIST_ENTRIES_EDGE },
                { field: AFFINITY_LIST_NAME_FIELD },
              ],
            },
          ],
        }
      : undefined,
    supportsFuzzyResolution: false,
  };
}

// ── describe ─────────────────────────────────────────────────────────────────

export async function describe(input: {
  client: AffinityAPIClient;
  teamId: string;
  /** The structured id the adapter recovered from the type NAME via its name
   *  cache (fixed entity or per-list entry). */
  decoded: DecodedTypeId;
  /** The pretty type name — the descriptor's framework identity. */
  displayName: string;
}): Promise<SchemaTypeDescriptor | null> {
  const { entity, listId, listName, listType, listsFor } = input.decoded;

  // A per-entity list-entry collection (`<record>-[:List Entries]->`): the
  // polymorphic union of that kind's per-list entry types — narrowed by
  // `listName` on a read, discriminated by the same field on a write.
  if (listsFor) {
    return describeListEntryCollection({
      client: input.client,
      teamId: input.teamId,
      displayName: input.displayName,
      listsFor,
    });
  }

  const fields: SchemaFieldDescriptor[] = builtinsFor(entity).map(builtinDescriptor);
  const references: SchemaReferenceDescriptor[] = referencesFor(entity, listType);

  // A per-list entry carries `listName` too — the collection publishes it as
  // the INTERSECTION of its members (layer 11), and an intersection field no
  // member admits to having is not an intersection. Concretely: narrowing
  // (`WHERE \`listName\` == "Pipeline"`) lands on the CONCRETE per-list type,
  // and the predicate is evaluated against whatever it lands on — so without
  // this the narrowed read resolves `Deal Stage` fine and then fails on the
  // very field it narrowed by.
  //
  // The VALUE was never missing: `getRelated` already stamps `listName` onto
  // every landed entry. Only the declaration was, so the read read as drift.
  // Single-valued, because on THIS type the list is fixed — that is the
  // narrowing having actually happened.
  if (entity === 'list-entry' && listId != null) {
    if (listName !== undefined) {
      fields.push({
        fieldId: AFFINITY_LIST_NAME_FIELD,
        displayName: AFFINITY_LIST_NAME_FIELD,
        kind: 'enum',
        enumValues: [listName],
        readable: true,
        // Never writable HERE: the discriminant belongs to the collection's
        // write shape, which every variant already inherits.
        writable: false,
        required: false,
        description: `The list this entry sits on — always "${listName}" on this type.`,
      });
    }
  }

  // A custom field is routed by its value type: record-valued (Person /
  // Organization) fields are edges → references[]; everything else is a scalar
  // property → fields[]. `addCustom` makes that split once for every code path,
  // and names each one through the same display-name rule, so a field and an
  // edge on the same list can never be spelled differently.
  const addCustom = (cf: AffinityFieldMeta, displayNames?: Map<number, string>): void => {
    const displayName = displayNames?.get(cf.id) ?? cf.name;
    if (isReferenceValueType(cf.value_type)) references.push(customFieldReference(cf, displayName));
    else fields.push(customFieldDescriptor(cf, displayName));
  };

  // Custom fields for org / person (and the org/person custom fields scoped to
  // a pinned list, for a per-list entry type).
  const customType = customFieldEntityType(entity);
  if (customType) {
    const custom = await cachedFields({
      client: input.client,
      type: customType,
      listId,
    });
    for (const cf of custom) {
      if (listId == null && cf.list_id != null) continue; // entity-level describe excludes list-scoped fields
      addCustom(cf);
    }
  } else if (entity === 'list-entry' && listId != null) {
    // A pinned list entry's list-scoped custom fields are the fields of its
    // list's OWN entity kind — the list is typed, so we query exactly that one
    // (person list → PERSON fields, org list → ORGANIZATION fields), never the
    // org∪person union. Opportunity lists carry no org/person-typed custom
    // fields on this surface, so they contribute none.
    const parent = listEntityKind(listType);
    const listCustomType = parent === 'organization' ? 'ORGANIZATION' : parent === 'person' ? 'PERSON' : null;
    if (listCustomType) {
      const custom = await cachedFields({
        client: input.client,
        type: listCustomType,
        listId,
      });
      // On the type that IS the list, a field's `[<list>] ` prefix says only
      // what the type name already says, so it comes off (`listScopedField
      // DisplayNames`). Names that would collide keep it.
      const displayNames =
        listName === undefined
          ? undefined
          : listScopedFieldDisplayNames({ catalog: custom, listId, listName });
      for (const cf of custom) {
        if (cf.list_id === listId) addCustom(cf, displayNames);
      }
    }
  }

  return {
    // Both the framework identity and the human label are the pretty name now.
    typeId: input.displayName,
    displayName: input.displayName,
    references,
    fields,
    scope: INHERITS_PARENT.has(entity) ? 'inherits-parent-config' : 'self-configured',
    // Identity is the TG layer's concern — Affinity's domain/name (org) and
    // email (person) natural keys are surfaced as fields, not invented as
    // native uniqueness constraints (adapter-minimalism).
    uniquenessConstraints: undefined,
    // Org/person resolution runs through Affinity's fuzzy matchers
    // (`findMatchingOrganisation` / `findMatchingPerson` — name/domain/email
    // similarity, not exact equality), so the movement-language `FUZZY`
    // uniqueness modifier is honestly supported on these types. The attached
    // entities (list-entry/note/file) have no identity resolution.
    supportsFuzzyResolution: entity === 'organization' || entity === 'person',
    // Affinity decides org/person identity ITSELF — its native matchers key on
    // domain/name (org) and email (person), with a workspace-vs-global-data
    // nuance a movement can't express. So `unique by` is NOT author-configurable
    // here; the checker rejects it rather than letting it be silently ignored.
    ...(entity === 'organization' || entity === 'person'
      ? { uniquenessAuthorable: false }
      : {}),
  };
}

/** Drop one WORKSPACE's cached shape — the credential's, not a team's: two
 *  credentials on one team are two workspaces, and a team-wide bust would have
 *  been both too wide and, for the second workspace, wrong. */
export function invalidateFieldCache(client: AffinityAPIClient): void {
  client.invalidateSchemaCache();
}

export { AFFINITY_ADAPTER_TYPE };
