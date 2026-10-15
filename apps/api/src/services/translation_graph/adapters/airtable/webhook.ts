// Airtable webhook trigger seam — the pure pieces of the notify-then-pull
// inbound path. The adapter's `preprocessInbound` owns the I/O (drain the
// payload feed from the persisted cursor); everything that doesn't need a
// network call lives here: the ping shape, the change-type vocabulary + its
// Airtable-native mapping, the discrimination event types, and the
// payload → `DiscriminableEvent` split.

import { z } from 'zod';

import type { DiscriminableEvent, EventType } from 'movement-engine/services/translation_graph/adapter';
import type { AirtableWebhookPayload } from '../../../../adapters/airtable/apiClient';

/** The Airtable ping POSTed to the callback URL. It carries only ids — the
 *  actual record changes are pulled from the webhook's payload feed. */
export const airtablePingSchema = z.object({
  base: z.object({ id: z.string() }),
  webhook: z.object({ id: z.string() }),
  timestamp: z.string().optional(),
});

/** The subscribable-event vocabulary, in Listen-Fire's uniform `record.*` currency
 *  (the same names Attio uses, so authoring/dispatch stay adapter-neutral). */
export const AIRTABLE_SUBSCRIBABLE_EVENTS = [
  'record.created',
  'record.updated',
  'record.deleted',
] as const;

export type AirtableSubscribableEvent = (typeof AIRTABLE_SUBSCRIBABLE_EVENTS)[number];

/** Listen-Fire `record.*` event → the Airtable native webhook `changeTypes` value. */
const EVENT_TO_AIRTABLE_CHANGE: Record<AirtableSubscribableEvent, 'add' | 'update' | 'remove'> = {
  'record.created': 'add',
  'record.updated': 'update',
  'record.deleted': 'remove',
};

/** Listen-Fire `record.*` event → the engine's change-type axis. */
const EVENT_TO_CHANGE_TYPE: Record<AirtableSubscribableEvent, 'create' | 'update' | 'delete'> = {
  'record.created': 'create',
  'record.updated': 'update',
  'record.deleted': 'delete',
};

// (The `record.*` → engine change-type translation lives in
// `EVENT_TO_CHANGE_TYPE`, stamped per event in `makeEvent`. The movement
// surface never sees it: there, the `record.*` value IS the event node's
// `action` field, one namespace end to end.)

/** Map the selected `record.*` events to the Airtable `changeTypes` the
 *  registration narrows to — so Airtable never pings for unchosen change kinds
 *  (each ping costs a pull + a movement run). */
export function airtableChangeTypes(events: readonly string[]): ('add' | 'update' | 'remove')[] {
  const out: ('add' | 'update' | 'remove')[] = [];
  for (const e of events) {
    const native = EVENT_TO_AIRTABLE_CHANGE[e as AirtableSubscribableEvent];
    if (native && !out.includes(native)) out.push(native);
  }
  return out;
}

/**
 * The EVENT node's position type — a record change, not the record.
 *
 * The two are different nodes and this adapter used to conflate them: it seeded
 * the changed RECORD as the event, which is why a movement could declare
 * `` <at-[:`Deals`]->> `` and have nothing check it (the declared type reached no
 * comparison at check time OR run time). An event is an OCCURRENCE — you cannot
 * re-retrieve it — so the event position is unstable, and the row hangs off its
 * `Record` edge.
 *
 */
export const AIRTABLE_WEBHOOK_RECORD_TYPE = 'airtable:record_change';

/** The event node's edge to the changed row. Free to follow: `eventRecordRef`
 *  below rides the payload, so hydration is a mint, never a fetch. */
export const AIRTABLE_EVENT_RECORD_EDGE = 'record';
/** Its NATURAL name — Title Case, the one convention across every adapter
 *  surface (the id above stays the `getRelated` dispatch currency). */
export const AIRTABLE_EVENT_RECORD_EDGE_NAME = 'Record';

/** The event node's own type name. JUST A NODE: its change kind is its
 *  `action` field, narrowed in the address —
 *  `<at-[:`Record Change` WHERE `action` == "record.created" AND …]->>`. */
export const AIRTABLE_EVENT_TYPE_NAME = 'Record Change';

/**
 * What the event node carries: the changed row's IDENTITY plus its changed
 * fields, and nothing else. The identity is what makes the `Record` edge free —
 * `preprocessInbound` already holds the base id (off the ping) and the table
 * metadata (fetched for the field-name map), so naming the row costs no call.
 *
 * `base`/`table` are the raw ids ON PURPOSE: they are what a `listen` config
 * names (`{ base: "appDevLoop", table: "tblDeals" }`), so a predicate over this
 * data reads the same values the author wrote.
 */
export interface AirtableEventData {
  /** Which kind of change this event is — the `record.*` value, verbatim from
   *  the listen's `events:` vocabulary (ONE namespace: it is the event node's
   *  `action` field, the value an address pins with `` WHERE `action` == … ``,
   *  and the pin the engine's seed derives its type from). */
  action: AirtableSubscribableEvent;
  /** The changed row's Airtable id (`rec…`). */
  record: string;
  /** The table's id (`tbl…`) — what the listen config names. */
  table: string;
  /** The table's display name — the row position's TYPE, so field reads
   *  resolve against the right table without a lookup. */
  tableName: string;
  /** The base's id (`app…`) — what the listen config names. */
  base: string;
  /** The changed cells, keyed by natural field name. Empty for a delete. */
  fields: Record<string, unknown>;
}

/** Read the event node's data back, or null when the position isn't one of
 *  ours (a defensive read at the adapter boundary, not a type assertion). */
export function eventRecordRef(data: unknown): AirtableEventData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<AirtableEventData>;
  if (typeof d.record !== 'string' || typeof d.tableName !== 'string') return null;
  return {
    action: AIRTABLE_SUBSCRIBABLE_EVENTS.includes(d.action as AirtableSubscribableEvent)
      ? (d.action as AirtableSubscribableEvent)
      : 'record.updated',
    record: d.record,
    table: typeof d.table === 'string' ? d.table : '',
    tableName: d.tableName,
    base: typeof d.base === 'string' ? d.base : '',
    fields: typeof d.fields === 'object' && d.fields !== null ? d.fields : {},
  };
}

/** The discrimination union: one entry per change kind. Every event the adapter
 *  emits carries a pre-set `tag` (its `record.*` name), so the engine matches by
 *  tag; `match` is a well-formed fallback that never has to fire. */
export function airtableEventTypes(): EventType[] {
  return AIRTABLE_SUBSCRIBABLE_EVENTS.map((tag) => ({
    tag,
    positionType: AIRTABLE_WEBHOOK_RECORD_TYPE,
    match: { path: 'eventType', equals: tag },
  }));
}

/** A subscription channel's (base, table) scope, validated off the reconciler's
 *  generic scope bag. Null when either half is missing (a misconfigured listen). */
export function airtableScope(
  scope: Record<string, string> | undefined,
): { base: string; table: string } | null {
  const base = scope?.base;
  const table = scope?.table;
  if (typeof base === 'string' && base.length > 0 && typeof table === 'string' && table.length > 0) {
    return { base, table };
  }
  return null;
}

/** Per-table `fieldId → fieldName` maps, so changed cell values (which Airtable
 *  keys by field id) become name-keyed record data the movement reads by
 *  natural field name. */
export type FieldNamesByTable = Map<string, Map<string, string>>;

/**
 * Split one Airtable payload into one `DiscriminableEvent` per record change.
 * `recordType` is the bare table id (the dispatch filter compares it to
 * `config.table`); `tag`/`eventType` carry the `record.*` change kind (the
 * change-type narrowing); `payload` is the name-keyed changed fields (the
 * seeded position's data). A delete carries no fields.
 */
export function eventsFromPayload(input: {
  payload: AirtableWebhookPayload;
  fieldNamesByTable: FieldNamesByTable;
  /** The delivery's base — off the ping, so it costs nothing. Rides the event
   *  data so the `Record` edge can name the row without a lookup. */
  baseId: string;
  /** `tableId → display name`, from the same metadata the field-name map came
   *  from. The row position's TYPE; absent ⇒ the bare id, as with fields. */
  tableNamesById?: Map<string, string>;
}): DiscriminableEvent[] {
  const { payload, fieldNamesByTable, baseId } = input;
  const occurredAt = payload.timestamp;
  const events: DiscriminableEvent[] = [];

  for (const [tableId, changes] of Object.entries(payload.changedTablesById ?? {})) {
    const names = fieldNamesByTable.get(tableId);
    const tableName = input.tableNamesById?.get(tableId) ?? tableId;
    const nameKeyed = (cells: Record<string, unknown> | undefined): Record<string, unknown> => {
      const data: Record<string, unknown> = {};
      for (const [fieldId, value] of Object.entries(cells ?? {})) {
        data[names?.get(fieldId) ?? fieldId] = value;
      }
      return data;
    };
    const at = { baseId, tableId, tableName, occurredAt };

    for (const [recordId, change] of Object.entries(changes.createdRecordsById ?? {})) {
      events.push(makeEvent({ ...at, recordId, event: 'record.created', fields: nameKeyed(change.cellValuesByFieldId) }));
    }
    for (const [recordId, change] of Object.entries(changes.changedRecordsById ?? {})) {
      events.push(makeEvent({ ...at, recordId, event: 'record.updated', fields: nameKeyed(change.current?.cellValuesByFieldId) }));
    }
    for (const recordId of changes.destroyedRecordIds ?? []) {
      events.push(makeEvent({ ...at, recordId, event: 'record.deleted', fields: {} }));
    }
  }

  return events;
}

/**
 * One record change, as the EVENT node.
 *
 * `payload` is the event's data — the row's identity plus its changed fields —
 * NOT the row's fields at top level. That distinction is the whole point: the
 * seed is the event, and the row is reached by its `Record` edge. `externalId`
 * and `recordType` are unchanged: the dispatch filter compares `recordType` to
 * the listen's `table` (`handler.ts`), and both predate the event node.
 */
function makeEvent(input: {
  baseId: string;
  tableId: string;
  tableName: string;
  recordId: string;
  event: AirtableSubscribableEvent;
  fields: Record<string, unknown>;
  occurredAt?: string;
}): DiscriminableEvent {
  const data: AirtableEventData = {
    action: input.event,
    record: input.recordId,
    table: input.tableId,
    tableName: input.tableName,
    base: input.baseId,
    fields: input.fields,
  };
  return {
    payload: data,
    externalId: input.recordId,
    recordType: input.tableId,
    eventType: input.event,
    tag: input.event,
    changeType: EVENT_TO_CHANGE_TYPE[input.event],
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}
