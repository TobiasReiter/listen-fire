// Affinity inbound deliveries → DiscriminableEvents.
//
// Affinity webhooks deliver one event per POST: `{ type, body, sent_at }`
// where `type` is e.g. `organization.updated` and `body` is the entity
// verbatim (https://api-docs.affinity.co/ + the support article "Types of
// webhooks available with Affinity's API"). This module is the PURE half of
// the adapter's `preprocessInbound` — no credential needed, because unlike
// Airtable's notify-then-pull, Affinity pushes the full entity and
// `field_value` bodies already carry `entity_type` / `entity_id` /
// `list_entry_id`.
//
// Event mapping:
//   organization.* / person.* / opportunity.* / list_entry.* / note.* /
//     reminder.*  → that entity's event (recordType = the adapter's natural
//     type name, externalId = body.id).
//   field_value.*  → an `updated` event on the PARENT record: the list entry
//     when `list_entry_id` is set (deal-stage changes live here), else the
//     entity by `entity_type` (0 = person, 1 = organization, 8 = opportunity
//     — the Field Entity Types enum).
//   Everything else (list.*, field.*, file.*) → ignored: the adapter has no
//     matching source type to position them on.
//
// First adapter built ON `preprocessInbound` from day one — events are
// constructed natively (no legacy WebhookEvent conversion).

import { z } from 'zod';

import type { DiscriminableEvent } from 'movement-engine/public/adapter';

const deliverySchema = z
  .object({
    type: z.string(),
    body: z.record(z.string(), z.unknown()),
    sent_at: z.number().optional(),
  })
  .passthrough();

/** Natural type names — must match the schema catalog's ENTITY_DISPLAY_NAMES
 *  (Affinity's framework typeIds ARE the pretty names). */
const ENTITY_TYPE_NAMES: Record<string, string> = {
  organization: 'Organization',
  person: 'Person',
  opportunity: 'Opportunity',
  list_entry: 'List Entry',
  note: 'Note',
  reminder: 'Reminder',
};

/** field_value.entity_type → natural type name (Field Entity Types enum:
 *  person = 0, organization = 1, opportunity = 8). Anything else is unmapped
 *  and the event is dropped. */
const FIELD_VALUE_ENTITY_NAMES: Record<number, string> = {
  0: 'Person',
  1: 'Organization',
  8: 'Opportunity',
};

function changeTypeOf(eventType: string): 'create' | 'update' | 'delete' | undefined {
  if (eventType.endsWith('.created')) return 'create';
  if (eventType.endsWith('.updated')) return 'update';
  if (eventType.endsWith('.deleted')) return 'delete';
  return undefined;
}

/**
 * Parse one Affinity delivery into events (0 or 1 — Affinity sends one event
 * per POST). Unparseable bodies and unmapped event kinds yield `[]`, never a
 * throw — a webhook door must not 500 on vocabulary drift.
 */
export function parseAffinityEvents(raw: unknown): DiscriminableEvent[] {
  const parsed = deliverySchema.safeParse(raw);
  if (!parsed.success) return [];
  const { type, body, sent_at } = parsed.data;
  const dot = type.indexOf('.');
  if (dot < 0) return [];
  const kind = type.slice(0, dot);
  const occurredAt =
    sent_at !== undefined ? new Date(sent_at * 1000).toISOString() : undefined;

  if (kind === 'field_value') {
    // A value changed ON a record — surface it as that record's update. The
    // list entry wins when present (deal-stage moves are list-entry field
    // values); otherwise the flat entity. Payload stays the field_value body
    // verbatim so filters can read `field_id` / `value` / `entity_id`.
    const listEntryId = body.list_entry_id;
    const entityType = body.entity_type;
    const entityId = body.entity_id;
    const parent =
      typeof listEntryId === 'number'
        ? { recordType: 'List Entry', externalId: String(listEntryId) }
        : typeof entityType === 'number' &&
            FIELD_VALUE_ENTITY_NAMES[entityType] !== undefined &&
            (typeof entityId === 'number' || typeof entityId === 'string')
          ? { recordType: FIELD_VALUE_ENTITY_NAMES[entityType], externalId: String(entityId) }
          : null;
    if (!parent) return [];
    return [
      {
        payload: body,
        externalId: parent.externalId,
        recordType: parent.recordType,
        eventType: type,
        changeType: 'update',
        ...(occurredAt ? { occurredAt } : {}),
      },
    ];
  }

  const recordType = ENTITY_TYPE_NAMES[kind];
  if (!recordType) return [];
  const id = body.id;
  if (typeof id !== 'number' && typeof id !== 'string') return [];
  const changeType = changeTypeOf(type);
  return [
    {
      payload: body,
      externalId: String(id),
      recordType,
      eventType: type,
      ...(changeType ? { changeType } : {}),
      ...(occurredAt ? { occurredAt } : {}),
    },
  ];
}

/** The `listen to <affinity> { events: [...] }` vocabulary — the exact event
 *  strings Affinity's webhook API accepts for these mapped kinds. (The docs'
 *  supported-events table lists only created/deleted for list entries;
 *  `list_entry.updated` predates this note and is kept — deal-stage moves
 *  arrive as `field_value.*` either way.) */
export const AFFINITY_SUBSCRIBABLE_EVENTS = [
  'organization.created',
  'organization.updated',
  'organization.deleted',
  'person.created',
  'person.updated',
  'person.deleted',
  'opportunity.created',
  'opportunity.updated',
  'opportunity.deleted',
  'list_entry.created',
  'list_entry.updated',
  'list_entry.deleted',
  'note.created',
  'note.updated',
  'note.deleted',
  'reminder.created',
  'reminder.updated',
  'reminder.deleted',
  'field_value.created',
  'field_value.updated',
  'field_value.deleted',
] as const;
