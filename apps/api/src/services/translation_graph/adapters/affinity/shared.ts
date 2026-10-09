// Affinity TG adapter — shared helpers used across the per-entity concept
// files: the whoami-derived web base URL (memoised per adapter instance), the
// `{ name, url }` display-data builders (lifted from the v3 output), the noop
// tracer the AffinityOperations layer expects, and the custom-field write path
// (a copy of the v3 `writeFieldValues`/`resolveFieldValue`, LLM-free except for
// the LOCATION formatter the underlying operations already owns).

import type { AffinityAPIClient } from '../../../../adapters/affinity/apiClient';
import { valueType, locationFieldValue } from '../../../../adapters/affinity/apiClient';
import type { AffinityOperations } from '../../../../adapters/affinity/operations';
import { anthropicChat } from '../../../../lib/anthropic';
import { logger } from '../../../logger';
import { isAdapterCallCeilingExceeded } from '../../segment_scope';
import type { ParentAssociation, ParentLink, WriteInput } from '../../adapter';
import { writeParentLinks } from '../../adapter';
import {
  decodedFixedType,
  isReferenceValueType,
  listScopedFieldDisplayNames,
  INTERACTION_TYPE_LABELS,
  INTERACTION_DIRECTION_LABELS,
  REMINDER_TYPE_LABELS,
  REMINDER_RESET_TYPE_LABELS,
  REMINDER_STATUS_LABELS,
  type AffinityFieldMeta,
} from './types';

// ── Web base URL (whoami subdomain) ──────────────────────────────────────────

export interface WebUrlSource {
  getWebBaseUrl(): Promise<string>;
}

export function makeWebBaseUrlResolver(client: AffinityAPIClient): WebUrlSource {
  let cached: string | null = null;
  return {
    async getWebBaseUrl(): Promise<string> {
      if (cached) return cached;
      try {
        const whoami = await client.getWhoami();
        cached = `https://${whoami.tenant.subdomain}.affinity.co`;
      } catch (err) {
        if (isAdapterCallCeilingExceeded(err)) throw err;
        logger.warn('[AffinityAdapter] failed to fetch whoami for web URL — using default', { err });
        cached = 'https://app.affinity.co';
      }
      return cached;
    },
  };
}

// ── Display-data builders (lifted from output_v3/adapters/affinity.ts) ──────

export function buildOrgData(
  org: { id: number; name?: string | null; domain?: string | null; domains?: string[] | null },
  webBaseUrl: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (org.name) data.name = org.name;
  if (org.domain) data.domain = org.domain;
  if (org.domains?.length) data.domains = org.domains;
  data.url = `${webBaseUrl}/companies/${org.id}`;
  return data;
}

export function buildPersonData(
  person: {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    primary_email?: string | null;
    emails?: string[] | null;
  },
  webBaseUrl: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (person.first_name || person.last_name) {
    data.name = [person.first_name, person.last_name].filter(Boolean).join(' ');
  }
  if (person.primary_email) data.email = person.primary_email;
  if (person.emails?.length) data.emails = person.emails;
  data.url = `${webBaseUrl}/persons/${person.id}`;
  return data;
}

// ── Canonical record data (keyed by descriptor fieldId) ─────────────────────
// A traversed record (org→people, person→orgs) is stamped on the position so a
// downstream read (`person.Email`) resolves. `getFieldValue` looks values up by
// the descriptor's INTERNAL fieldId (`email`, `firstName`, …), so the position
// data must use those keys — NOT the raw Affinity API keys (`primary_email`,
// `first_name`). This is the "the record exposes keys that match the write"
// rule: the canonical record speaks the same field ids the writer does.
// Custom-field values are NOT inline on the API record — they live behind
// `/field-values`. Only built-ins land here; the adapter's `getFieldValue`
// override fetches a position's custom values on demand (memoised per record),
// so both halves of a record read through one surface.

export function canonicalPersonData(person: {
  first_name?: string | null;
  last_name?: string | null;
  primary_email?: string | null;
  emails?: string[] | null;
}): Record<string, unknown> {
  return {
    firstName: person.first_name ?? null,
    lastName: person.last_name ?? null,
    name: [person.first_name, person.last_name].filter(Boolean).join(' ') || null,
    email: person.primary_email ?? null,
    emails: person.emails ?? null,
  };
}

export function canonicalOrgData(org: {
  name?: string | null;
  domain?: string | null;
  domains?: string[] | null;
}): Record<string, unknown> {
  return {
    name: org.name ?? null,
    domain: org.domain ?? null,
    domains: org.domains ?? null,
  };
}

// The read-surface landings (notes / files / opportunities / reminders /
// interactions / relationship strengths) follow the same rule: data keyed by
// the descriptor's fieldId so the BaseAdapter scalar read resolves, with the
// link ids (`*_ids` / embedded objects) riding along so the onward hops can
// route without a refetch. Wire enums (reminder type/status, interaction
// type/direction) land as their LABELS — the same vocabulary the descriptor's
// `enumValues` publishes, one namespace.

export function canonicalNoteData(note: {
  id: number;
  content?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  creator_id?: number | null;
  type?: number | null;
  parent_id?: number | null;
  person_ids?: number[] | null;
  organization_ids?: number[] | null;
  opportunity_ids?: number[] | null;
}): Record<string, unknown> {
  return {
    content: note.content ?? null,
    created_at: note.created_at ?? null,
    updated_at: note.updated_at ?? null,
    parent_id: note.parent_id ?? null,
    person_ids: note.person_ids ?? [],
    organization_ids: note.organization_ids ?? [],
    opportunity_ids: note.opportunity_ids ?? [],
  };
}

export function canonicalFileData(file: {
  name?: string | null;
  size?: number | null;
  created_at?: string | null;
  person_id?: number | null;
  organization_id?: number | null;
  opportunity_id?: number | null;
}): Record<string, unknown> {
  return {
    name: file.name ?? null,
    size: file.size ?? null,
    created_at: file.created_at ?? null,
    person_id: file.person_id ?? null,
    organization_id: file.organization_id ?? null,
    opportunity_id: file.opportunity_id ?? null,
  };
}

export function canonicalOpportunityData(opp: {
  name?: string | null;
  person_ids?: number[] | null;
  organization_ids?: number[] | null;
  list_entries?: unknown[] | null;
}): Record<string, unknown> {
  return {
    name: opp.name ?? null,
    person_ids: opp.person_ids ?? [],
    organization_ids: opp.organization_ids ?? [],
    list_entries: opp.list_entries ?? [],
  };
}

type EmbeddedPerson = {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  primary_email?: string | null;
  emails?: string[] | null;
};

export function canonicalReminderData(reminder: {
  content?: string | null;
  type: number;
  status: number;
  reset_type?: number | null;
  reminder_days?: number | null;
  due_date?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  person?: EmbeddedPerson | null;
  organization?: { id: number } | null;
  opportunity?: { id: number } | null;
  owner?: EmbeddedPerson | null;
}): Record<string, unknown> {
  return {
    content: reminder.content ?? null,
    type: REMINDER_TYPE_LABELS[reminder.type] ?? null,
    status: REMINDER_STATUS_LABELS[reminder.status] ?? null,
    reset_type:
      reminder.reset_type != null ? (REMINDER_RESET_TYPE_LABELS[reminder.reset_type] ?? null) : null,
    reminder_days: reminder.reminder_days ?? null,
    due_date: reminder.due_date ?? null,
    created_at: reminder.created_at ?? null,
    completed_at: reminder.completed_at ?? null,
    // Link ids for the onward hops (tagged entity + owner).
    person: reminder.person ?? null,
    organization: reminder.organization ?? null,
    opportunity: reminder.opportunity ?? null,
    owner: reminder.owner ?? null,
  };
}

export function canonicalInteractionData(interaction: {
  id: number;
  type: number;
  date?: string | null;
  title?: string | null;
  subject?: string | null;
  direction?: number | null;
  attendees?: string[] | null;
  start_time?: string | null;
  end_time?: string | null;
  notes?: number[] | null;
  persons?: EmbeddedPerson[] | null;
  from?: EmbeddedPerson | null;
  to?: EmbeddedPerson[] | null;
  cc?: EmbeddedPerson[] | null;
}): Record<string, unknown> {
  // Fold every involved person into ONE list for the People hop — attendees
  // arrive as `persons` on meetings/calls/chats and as `from`/`to`/`cc` on
  // emails.
  const persons = new Map<number, EmbeddedPerson>();
  for (const p of [
    ...(interaction.persons ?? []),
    ...(interaction.from ? [interaction.from] : []),
    ...(interaction.to ?? []),
    ...(interaction.cc ?? []),
  ]) {
    persons.set(p.id, p);
  }
  return {
    type: INTERACTION_TYPE_LABELS[interaction.type] ?? null,
    date: interaction.date ?? null,
    title: interaction.title ?? null,
    subject: interaction.subject ?? null,
    direction:
      interaction.direction != null
        ? (INTERACTION_DIRECTION_LABELS[interaction.direction] ?? null)
        : null,
    attendees: interaction.attendees ?? [],
    start_time: interaction.start_time ?? null,
    end_time: interaction.end_time ?? null,
    notes: interaction.notes ?? [],
    persons: [...persons.values()],
  };
}

export function canonicalRelationshipStrengthData(strength: {
  internal_id: number;
  external_id: number;
  strength: number;
}): Record<string, unknown> {
  return {
    strength: strength.strength,
    internal_id: strength.internal_id,
    external_id: strength.external_id,
  };
}

// ── Noop tracer ──────────────────────────────────────────────────────────────
// AffinityOperations methods take a Tracer; the TG path has no trace sink, so
// supply a structurally-compatible noop (same shape the v3 output uses).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createNoopTracer(): any {
  return {
    add: () => {},
    child: () => createNoopTracer(),
    span: async <T>(fn: (t: unknown) => Promise<T>) => fn(createNoopTracer()),
    writeToContextLogs: async () => {},
  };
}

// ── Custom field value writing (lifted from v3 writeFieldValues) ────────────
// The engine has already resolved each custom field's value (keyed by the
// field's numeric id as a string); this maps each into the Affinity field-value
// API. Read-only (enrichment) fields are filtered upstream by `describe`'s
// `writable: false`, but we double-check here so a stale author config can't
// push a write at one.

export async function writeCustomFieldValues(
  operations: AffinityOperations,
  options: {
    entityId: number;
    entityType: 'organization' | 'person';
    /** Custom-field values keyed by the field's numeric id (as string). */
    fieldValues: Record<string, unknown>;
    listEntryId?: number;
    listId?: number;
    /** The target list's own name, when this write lands on a list entry. It is
     *  what strips a list-scoped field's redundant `[<list>] ` prefix, so a
     *  value keyed by the name the per-list type publishes finds its field. */
    listName?: string;
  },
): Promise<void> {
  const { entityId, entityType, fieldValues, listEntryId, listId, listName } = options;

  const writable = Object.entries(fieldValues).filter(
    ([, v]) => v != null && v !== '',
  );
  if (writable.length === 0) return;

  const client = operations.getClient();
  const fields = await client.getFields({
    type: entityType === 'organization' ? 'ORGANIZATION' : 'PERSON',
    limitToListId: listId,
  });
  // The write arrives keyed by field id where the engine resolved a name, and
  // by a name where it could not. Both spellings of a list-scoped field's name
  // are accepted: the one the per-list type publishes (the list's prefix
  // stripped) and the one Affinity itself carries. They name the same field,
  // and refusing the source system's own name would fail as a warning in a log.
  const displayNames =
    listId != null && listName !== undefined
      ? listScopedFieldDisplayNames({ catalog: fields as AffinityFieldMeta[], listId, listName })
      : undefined;
  const fieldById = new Map<string, AffinityFieldMeta>();
  for (const f of fields) {
    const meta = f as AffinityFieldMeta;
    const published = displayNames?.get(f.id);
    fieldById.set(String(f.id), meta);
    fieldById.set(f.name, meta);
    fieldById.set(f.name.toLowerCase(), meta);
    if (published !== undefined) {
      fieldById.set(published, meta);
      fieldById.set(published.toLowerCase(), meta);
    }
  }

  const entityFieldValues = await client.getFieldValues(
    entityType === 'organization' ? { organization_id: entityId } : { person_id: entityId },
  );
  const listEntryFieldValues = listEntryId
    ? await client.getFieldValues({ list_entry_id: listEntryId })
    : [];
  const entityByFieldId = new Map(
    entityFieldValues.filter((v) => v.list_entry_id == null).map((v) => [v.field_id, v]),
  );
  const listEntryByFieldId = new Map(listEntryFieldValues.map((v) => [v.field_id, v]));

  const target = listEntryId ? `list entry ${listEntryId}` : `${entityType} ${entityId}`;
  const failed: string[] = [];

  for (const [key, value] of writable) {
    const fieldDef = fieldById.get(key) ?? fieldById.get(key.toLowerCase());
    if (!fieldDef) {
      // The checker guarantees every authored field exists on the variant, so
      // a name that resolves to nothing here is drift between what `describe`
      // published and what the workspace has — a bug, not a value to skip.
      throw new Error(
        `AffinityAdapter: no Affinity field named "${key}" on ${target} — ` +
          `the published schema and the workspace disagree.`,
      );
    }
    if (fieldDef.list_id && !listEntryId) continue; // list field with no entry to hang it on

    // An existing value is UPDATED, never skipped: the engine decided what to
    // write (an unchanged value never got this far, and a `?:` on a filled
    // field was dropped upstream), so refusing here would only invert it.
    const existing = fieldDef.list_id
      ? listEntryByFieldId.get(fieldDef.id)
      : entityByFieldId.get(fieldDef.id);

    const resolved = await resolveFieldValue(operations, fieldDef, value);
    if (resolved === null) continue;

    // Every field is attempted before anything is raised: one field Affinity
    // refuses should not decide the fate of the others, and the author wants to
    // hear about all of them at once, not one per re-run.
    try {
      if (existing) {
        await client.updateFieldValue({ id: existing.id, value: resolved });
      } else {
        await client.createFieldValue({
          field_id: fieldDef.id,
          value: resolved,
          list_entry_id: fieldDef.list_id && listEntryId ? listEntryId : undefined,
          entity_id: entityId,
        });
      }
    } catch (err) {
      if (isAdapterCallCeilingExceeded(err)) throw err;
      // `key` may be the internal id the adapter resolved the author's name
      // to; the author wrote the field's name, so the failure names that.
      const label = displayNames?.get(fieldDef.id) ?? fieldDef.name;
      logger.warn(`[AffinityAdapter] writeCustomFieldValues: failed to write field "${label}"`, { err });
      failed.push(`"${label}" (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // A field that did not land is a failed write, not a log line. There is no
  // per-field channel back to the run, so the run fails naming the record and
  // every field that did not make it.
  if (failed.length > 0) {
    throw new Error(
      `AffinityAdapter: could not write ${failed.length === 1 ? 'field' : 'fields'} ` +
        `${failed.join(', ')} on ${target}.`,
    );
  }
}

/** Coerce a pre-resolved value into the Affinity field-value API shape, per
 *  the field's value_type. Lifted from the v3 `resolveFieldValue`. */
export async function resolveFieldValue(
  operations: AffinityOperations,
  fieldDef: { value_type: number; dropdown_options?: { id: number; text: string }[] | null },
  value: unknown,
): Promise<unknown> {
  if (fieldDef.value_type === valueType.PERSON) {
    const name = String(value);
    let match = await operations.findMatchingPerson({ name });
    if (!match) match = await operations.createPerson({ name });
    return match ? match.id : null;
  } else if (fieldDef.value_type === valueType.ORGANIZATION) {
    const name = String(value);
    let match = await operations.findMatchingOrganisation({ name });
    if (!match) {
      const newOrg = await operations.getClient().createOrganisation({ name });
      match = newOrg ? { id: newOrg.id } : null;
    }
    return match ? match.id : null;
  } else if (fieldDef.value_type === valueType.LOCATION) {
    const formatted = await anthropicChat({
      label: 'affinity.formatLocation',
      effort: 'low',
      system: `You are a location formatter. You will be given a location and you must format it into a string that can be used in a location field.
Output a JSON object with the following keys:
- street_address
- city
- state
- country
- continent

The corresponding values must be a string if an appropriate value appears in the user's input, or null otherwise.

Output: strictly this JSON format. Do not include any additional text.`,
      userMessage: String(value),
    });
    try {
      return locationFieldValue.parse(JSON.parse(formatted));
    } catch {
      return null;
    }
  } else if (fieldDef.value_type === valueType.RANKED_DROPDOWN) {
    const option = fieldDef.dropdown_options?.find((opt) => opt.text === String(value));
    return option ? option.id : null;
  } else if (fieldDef.value_type === valueType.NUMBER) {
    const num = Number(value);
    return Number.isNaN(num) ? null : num;
  } else if (fieldDef.value_type === valueType.DATE) {
    try {
      return new Date(String(value)).toISOString();
    } catch {
      return null;
    }
  }
  // TEXT, DROPDOWN, and other types: pass through as string.
  return String(value);
}

/**
 * The READ inverse of `resolveFieldValue`'s dropdown branch: a raw field-value
 * an option id → the option's TEXT. It lives next to its inverse so the two
 * can't drift — the write turns a label into an id, the read turns that id back
 * into the same label, and `describe` publishes exactly those labels as the
 * field's `enumValues` (schema_catalog's `customFieldDescriptor`). A read that
 * surfaced the raw id would break the descriptor's own promise: the value would
 * not be one of the `enumValues` the author was offered.
 *
 * Affinity returns dropdowns in three different wire shapes, and all three land
 * on the same label:
 *   • RANKED_DROPDOWN — the whole option object (`{id, rank, text}`); its
 *     `text` IS the label (see `fieldValuesValidator` in the api client).
 *   • DROPDOWN — either the option's id, or the label text already.
 * So an object yields its `text`, a number resolves through `dropdown_options`,
 * and a string is already a label and passes through.
 *
 * A value that matches no option passes through rather than becoming null: a
 * value we cannot name is still a value, and dropping it would be the silent
 * emptiness this decode exists to remove.
 */
export function decodeFieldValue(
  fieldDef: { value_type: number; dropdown_options?: { id: number; text: string }[] | null },
  value: unknown,
): unknown {
  const isDropdown =
    fieldDef.value_type === valueType.DROPDOWN || fieldDef.value_type === valueType.RANKED_DROPDOWN;
  if (!isDropdown || value == null) return value;

  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text : value;
  }
  const option = fieldDef.dropdown_options?.find((opt) => opt.id === value);
  return option ? option.text : value;
}

// ── Field partitioning ───────────────────────────────────────────────────────
// The engine hands `WriteInput.fields` keyed by our descriptor field ids:
// built-in ids (`name`, `domain`, `email`, …) and custom-field numeric ids.
// Split them so the entity create/update path consumes built-ins while the
// custom-field writer consumes the rest.

const ORG_BUILTIN_IDS = new Set(['name', 'domain', 'domains']);
const PERSON_BUILTIN_IDS = new Set(['firstName', 'lastName', 'name', 'email', 'emails']);

export function partitionFields(
  entityType: 'organization' | 'person',
  fields: Record<string, unknown>,
): { builtins: Record<string, unknown>; custom: Record<string, unknown> } {
  const builtinIds = entityType === 'organization' ? ORG_BUILTIN_IDS : PERSON_BUILTIN_IDS;
  const builtins: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (builtinIds.has(k)) builtins[k] = v;
    else custom[k] = v;
  }
  return { builtins, custom };
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = Array.isArray(v) ? String(v[0] ?? '') : String(v);
  return s.length ? s : undefined;
}

/** Everything else an organization write says about the company — each
 *  text-valued custom field, labelled by the name the author wrote it under —
 *  for the matcher's judge. A write with no website is matched by name alone,
 *  and a description is what tells "Fyvie" the startup from every other Fyvie
 *  in Affinity's global dataset. Capped so a long memo cannot crowd the judge. */
export function organisationMatchContext(
  fields: Array<{ label: string; fieldId: string; value: unknown }>,
): string | undefined {
  const lines = fields.flatMap(({ label, fieldId, value }) => {
    if (ORG_BUILTIN_IDS.has(fieldId) || typeof value !== 'string') return [];
    const text = value.trim();
    return text ? [`${label}: ${text.slice(0, MATCH_CONTEXT_FIELD_CHARS)}`] : [];
  });
  return lines.length ? lines.join('\n').slice(0, MATCH_CONTEXT_CHARS) : undefined;
}

const MATCH_CONTEXT_FIELD_CHARS = 500;
const MATCH_CONTEXT_CHARS = 2000;

export function readOrgBuiltins(fields: Record<string, unknown>): { name?: string; domain?: string } {
  return { name: str(fields.name), domain: str(fields.domain) };
}

/** The person identity a write carries. `name` is what MATCHING searches on —
 *  a single string either way. `firstName`/`lastName` survive alongside it
 *  because a CREATE needs the halves, and joining them here only to have a
 *  model guess them apart again is how an authored split gets lost. */
export function readPersonBuiltins(fields: Record<string, unknown>): {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
} {
  const firstName = str(fields.firstName);
  const lastName = str(fields.lastName);
  const full = str(fields.name);
  const name = full ?? ([firstName, lastName].filter(Boolean).join(' ') || undefined);
  return { name, firstName, lastName, email: str(fields.email) };
}

// ── Current custom-field values (for the engine's write-semantics gate) ──────
// The movement engine reads current values via `readRecord` and applies write
// semantics ITSELF — overwrite no-op suppression and `?:` set-if-empty — before
// handing the adapter the fields to write. It looks each value up by the
// field's DISPLAY NAME (the currency the author wrote), so `readRecord` must
// return current custom-field values keyed by display name, or `?:` silently
// clobbers (an unseen current value reads as empty → always written).

/**
 * Which record's custom-field values to read. Each scope reads its OWN values
 * and never merges another's: an entity's values and the values on that
 * entity's list entries are different records with different lifecycles.
 *
 * There is deliberately no `opportunity` scope. Opportunities publish no custom
 * fields on this surface (`schema_catalog.customFieldEntityType` returns null
 * for them, and the v1 `/fields` catalog is only queryable for PERSON and
 * ORGANIZATION), so an opportunity position can never resolve a custom field
 * to read. Adding a fetch for one would be unreachable code that merely looks
 * like a promise.
 */
export type AffinityCustomFieldScope =
  | { kind: 'entity'; entityType: 'organization' | 'person'; entityId: number }
  /** A list entry's LIST-SCOPED values. The catalog its fields are named from
   *  is the list's own entity kind (an org list's fields are ORGANIZATION
   *  fields carrying a `list_id`), and the list's id and name are what name
   *  those fields the way the entry's own type publishes them. */
  | {
      kind: 'list-entry';
      listEntryId: number;
      catalogType: 'ORGANIZATION' | 'PERSON';
      listId?: number;
      listName?: string;
    };

/** A field's current value rows, decoded, with the field meta they came from.
 *  `values` holds every row in API order — a single-value field has one, an
 *  `allows_multiple` field has one per linked value. Consumers project this to
 *  the shape they need; keeping the rows un-collapsed here is what lets them
 *  differ without disagreeing about what the values ARE. */
export interface AffinityCustomFieldValue {
  field: AffinityFieldMeta;
  values: unknown[];
}

/** One `/field-values` row, in the subset every reader here consumes. */
export interface AffinityFieldValueRow {
  field_id: number;
  list_entry_id?: number | null;
  value?: unknown;
}

/**
 * THE reader for a record's current custom-field values, keyed by DISPLAY NAME
 * (the currency both the engine's write-semantics gate and the author's
 * `co.\`Stage\`` are written in). Values are decoded through `decodeFieldValue`,
 * so a dropdown reads as its label everywhere.
 *
 * Both the expression read path (`getFieldValue`) and the no-op detection read
 * (`readRecord`) come through here, so they cannot disagree about what a
 * record's current values are.
 */
export async function readCustomFieldValues(
  operations: AffinityOperations,
  scope: AffinityCustomFieldScope,
  /** Rows and catalog the caller already holds. A list entry's own rows are
   *  what NAME its list when the position's type did not pin one, so the
   *  caller that discovered the list has already paid for them; re-fetching
   *  here would ask Affinity the same question twice per read. */
  options?: { catalog?: AffinityFieldMeta[]; values?: AffinityFieldValueRow[] },
): Promise<Map<string, AffinityCustomFieldValue>> {
  const client = operations.getClient();
  const catalogType =
    scope.kind === 'entity'
      ? scope.entityType === 'organization'
        ? 'ORGANIZATION'
        : 'PERSON'
      : scope.catalogType;
  const [fields, values] = await Promise.all([
    options?.catalog ?? client.getFields({ type: catalogType }),
    options?.values ??
      client.getFieldValues(
        scope.kind === 'list-entry'
          ? { list_entry_id: scope.listEntryId }
          : scope.entityType === 'organization'
            ? { organization_id: scope.entityId }
            : { person_id: scope.entityId },
      ),
  ]);
  const fieldById = new Map((fields as AffinityFieldMeta[]).map((f) => [f.id, f]));
  // Keyed by the name the position's OWN type publishes: on a per-list entry
  // that is the field without its list's prefix, which is what the author wrote
  // and so what a `?:` fill and a no-change comparison have to key on.
  const displayNames =
    scope.kind === 'list-entry' && scope.listId != null && scope.listName !== undefined
      ? listScopedFieldDisplayNames({
          catalog: fields as AffinityFieldMeta[],
          listId: scope.listId,
          listName: scope.listName,
        })
      : undefined;

  const grouped = new Map<string, AffinityCustomFieldValue>();
  for (const v of values) {
    // An entity-scoped query (`?organization_id=`) also returns the rows on
    // that entity's LIST ENTRIES. Those belong to the entry's own scope, so
    // they are never the entity's values.
    if (scope.kind === 'entity' && v.list_entry_id != null) continue;
    const field = fieldById.get(v.field_id);
    if (!field) continue;
    const name = displayNames?.get(field.id) ?? field.name;
    const entry = grouped.get(name) ?? { field, values: [] };
    entry.values.push(decodeFieldValue(field, (v as { value?: unknown }).value ?? null));
    grouped.set(name, entry);
  }
  return grouped;
}

export async function readCustomFieldCurrentValues(
  operations: AffinityOperations,
  options: { entityType: 'organization' | 'person'; entityId: number },
): Promise<Record<string, unknown>> {
  const grouped = await readCustomFieldValues(operations, {
    kind: 'entity',
    entityType: options.entityType,
    entityId: options.entityId,
  });
  const result: Record<string, unknown> = {};
  for (const [displayName, { values }] of grouped) {
    // A multi-value field has several rows; the last wins. The engine only
    // needs "is there a current value" (for `?:`) and exact equality (for
    // no-op suppression), so a representative value is sufficient.
    result[displayName] = values[values.length - 1] ?? null;
  }
  return result;
}

// ── Custom-reference edge writes (parentLinks) ───────────────────────────────
// A Person/Organization-valued custom field is an EDGE — `describe` surfaces it
// in `references[]`, so a linked write `write org -[:Champion]-> person` reaches
// the adapter as a `parentLink` on the CHILD (person), carrying the parent (org)
// and the resolved reference fieldId. Here we set that reference on the parent
// to point at the newly-written child — the mirror of Attio's parent-ref
// linking. Built-in person↔org association edges resolve to a NON-numeric
// fieldId ('people'/'organizations') and are wired by the entity create paths,
// so they're skipped here.

/** Whether an Affinity reference field-value already points at `id` (the value
 *  is a single record id, an array of them, or null). */
function referenceValueIncludes(value: unknown, id: number): boolean {
  if (Array.isArray(value)) return value.includes(id);
  return value === id;
}

/**
 * The record that HOLDS a custom reference pointing at the child. An entity
 * holds its own fields. A LIST ENTRY holds its list's fields — and a value on
 * an entry is addressed by BOTH the entry and the record the entry stands for,
 * which is why the entry's own entity travels with it.
 */
export type AffinityReferenceHolder =
  | { kind: 'entity'; entityType: 'organization' | 'person'; entityId: number }
  | {
      kind: 'list-entry';
      listEntryId: number;
      listId: number;
      listName: string | undefined;
      catalogType: 'ORGANIZATION' | 'PERSON';
      entityId: number;
    };

/** Which record a parent link's position stands for. Only the adapter knows —
 *  a per-list type's name resolves through its live list cache. */
export type ReferenceHolderResolver = (
  parent: ParentLink,
) => Promise<AffinityReferenceHolder | null>;

/**
 * Resolve a parentLink's edge to the custom REFERENCE field it names on the
 * holder, or null when the edge isn't a custom reference (a built-in person↔org
 * association edge, an unknown name, or a non-reference field). The edge
 * arrives in the adapter's write currency (`ref.name ?? ref.fieldId` from the
 * name resolver), so a field matches by its numeric id, by Affinity's own name,
 * or by the name its holder's type publishes — on a list entry that is the name
 * with the list's prefix off, the same rule `describe` named the edge by.
 * Read-only (enrichment) fields are never link targets.
 *
 * A holder only ever offers its OWN fields: an entity's are the unscoped ones,
 * an entry's are its list's. Nothing else can hold them.
 */
export async function referenceFieldOn(
  operations: AffinityOperations,
  holder: AffinityReferenceHolder,
  edgeName: string,
): Promise<AffinityFieldMeta | null> {
  const fields = (await operations.getClient().getFields(
    holder.kind === 'list-entry'
      ? { type: holder.catalogType, limitToListId: holder.listId }
      : { type: holder.entityType === 'organization' ? 'ORGANIZATION' : 'PERSON' },
  )) as AffinityFieldMeta[];
  const published =
    holder.kind === 'list-entry' && holder.listName !== undefined
      ? listScopedFieldDisplayNames({
          catalog: fields,
          listId: holder.listId,
          listName: holder.listName,
        })
      : undefined;
  const onHolder = (f: AffinityFieldMeta): boolean =>
    holder.kind === 'list-entry' ? f.list_id === holder.listId : f.list_id == null;

  const fieldDef = fields.find(
    (f) =>
      onHolder(f) &&
      (String(f.id) === edgeName || f.name === edgeName || published?.get(f.id) === edgeName),
  );
  if (!fieldDef) return null;
  if (!isReferenceValueType(fieldDef.value_type)) return null;
  return fieldDef;
}

/** The entity-shaped question: does this edge name a custom reference on an
 *  org/person? Asked by the employer-association detector, which has to tell a
 *  parent org that EMPLOYS the person from one that merely points at them. */
export async function customReferenceFieldFor(
  operations: AffinityOperations,
  entityType: 'organization' | 'person',
  edgeName: string,
): Promise<AffinityFieldMeta | null> {
  return referenceFieldOn(operations, { kind: 'entity', entityType, entityId: 0 }, edgeName);
}

/** The value rows a holder itself owns for one reference field. An entity's own
 *  rows only — the rows on its list entries belong to those entries. */
async function referenceRowsOn(
  operations: AffinityOperations,
  holder: AffinityReferenceHolder,
  fieldDef: AffinityFieldMeta,
) {
  const rows = await operations.getClient().getFieldValues(
    holder.kind === 'list-entry'
      ? { list_entry_id: holder.listEntryId }
      : holder.entityType === 'organization'
        ? { organization_id: holder.entityId }
        : { person_id: holder.entityId },
  );
  return rows.filter(
    (v) => v.field_id === fieldDef.id && (holder.kind === 'list-entry' || v.list_entry_id == null),
  );
}

/**
 * Point one of the holder's reference fields at a record — the single act
 * behind both a linked write (the child was just created) and a standalone
 * `link` (both records already existed). Idempotent: a row already naming the
 * target is left alone and nothing is sent.
 *
 * A MULTI-valued reference is one row per linked record, so a new target is
 * appended and the existing links survive. A SINGLE-valued one holds one row,
 * so a new target REPLACES what is there — an in-place `PUT` of the row's
 * value, not a delete and a re-create: the row is the field, and severing it
 * first would leave the field empty if the write that follows failed.
 *
 * Returns whether anything changed, which is what `linkRecords` reports.
 */
export async function assertCustomReference(
  operations: AffinityOperations,
  options: {
    holder: AffinityReferenceHolder;
    fieldDef: AffinityFieldMeta;
    targetId: number;
  },
): Promise<boolean> {
  const { holder, fieldDef, targetId } = options;
  const client = operations.getClient();
  const existing = await referenceRowsOn(operations, holder, fieldDef);
  if (existing.some((v) => referenceValueIncludes((v as { value?: unknown }).value, targetId))) {
    return false;
  }

  // A list-scoped value hangs off the ENTRY; `entity_id` still names the
  // record the entry stands for, which is how Affinity addresses it.
  const onEntry = holder.kind === 'list-entry' ? { list_entry_id: holder.listEntryId } : {};
  // A link that did not land fails the write, like any other field: the
  // record it was supposed to point at exists, and nothing downstream can
  // tell that it points at nothing.
  if (!fieldDef.allows_multiple && existing[0]) {
    await client.updateFieldValue({ id: existing[0].id, value: targetId });
  } else {
    await client.createFieldValue({
      field_id: fieldDef.id,
      entity_id: holder.entityId,
      value: targetId,
      ...onEntry,
    });
  }
  return true;
}

/**
 * Stop one of the holder's reference fields pointing at a record — the inverse
 * assert. Affinity has no "clear this field": a value row IS the value, so the
 * rows naming the target are deleted, which drops one target from a
 * multi-valued reference and empties a single-valued one. A field that never
 * pointed there is a quiet no-op, as `unlink` promises.
 */
export async function severCustomReference(
  operations: AffinityOperations,
  options: {
    holder: AffinityReferenceHolder;
    fieldDef: AffinityFieldMeta;
    targetId: number;
  },
): Promise<boolean> {
  const { holder, fieldDef, targetId } = options;
  const client = operations.getClient();
  const pointing = (await referenceRowsOn(operations, holder, fieldDef)).filter((v) =>
    referenceValueIncludes((v as { value?: unknown }).value, targetId),
  );
  if (pointing.length === 0) return false;
  for (const row of pointing) await client.deleteFieldValue({ id: row.id });
  return true;
}

export async function applyCustomReferenceParentLinks(
  operations: AffinityOperations,
  options: {
    childExternalId: string;
    write: Pick<WriteInput, 'parentLinks'>;
    holderFor: ReferenceHolderResolver;
  },
): Promise<ParentLinkPass> {
  const outcome = { handled: 0, made: 0 };
  const childId = Number(options.childExternalId);
  if (!Number.isInteger(childId)) return outcome;

  for (const parent of writeParentLinks(options.write)) {
    const holder = await options.holderFor(parent);
    if (!holder) continue;

    const fieldDef = await referenceFieldOn(operations, holder, parent.edgeName);
    if (!fieldDef) continue; // not a custom reference — handled elsewhere

    outcome.handled += 1;
    if (await assertCustomReference(operations, { holder, fieldDef, targetId: childId })) {
      outcome.made += 1;
    }
  }
  return outcome;
}

/** How many of a write's parents one pass accounted for, and how many of those
 *  it actually connected. Both numbers are needed to answer for the whole
 *  parent set: a parent no pass accounted for is one this system cannot attach.
 */
export interface ParentLinkPass {
  handled: number;
  made: number;
}

/**
 * The write's association, from the two ways Affinity connects a child to a
 * parent: the built-in person↔organization employer association, and a custom
 * reference field on one side or the other. A parent NEITHER pass accounted
 * for is one this workspace has no way to attach an existing record along, so
 * the write says so rather than reporting an attach that never happened.
 */
export function combineParentAssociation(input: {
  parents: number;
  passes: ParentLinkPass[];
}): ParentAssociation {
  if (input.parents === 0) return 'none';
  const handled = input.passes.reduce((n, p) => n + p.handled, 0);
  const made = input.passes.reduce((n, p) => n + p.made, 0);
  if (handled < input.parents) return 'unsupported';
  return made > 0 ? 'made' : 'already';
}
