// Affinity inbound parsing — the pure half of the adapter's
// `preprocessInbound`. Pins the delivery→event mapping the Affinity docs
// specify ({type, body, sent_at}; one event per POST) so vocabulary drift or
// payload surprises degrade to dropped events, never 500s at the door.

import { parseAffinityEvents, AFFINITY_SUBSCRIBABLE_EVENTS } from '../inbound';

describe('parseAffinityEvents — entity events', () => {
  it('maps organization.updated to an Organization update with the body verbatim', () => {
    const body = { id: 123, name: 'Acme', domain: 'acme.com' };
    const events = parseAffinityEvents({ type: 'organization.updated', body, sent_at: 1_782_000_000 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      recordType: 'Organization',
      externalId: '123',
      eventType: 'organization.updated',
      changeType: 'update',
      payload: body,
    });
    expect(events[0].occurredAt).toBe(new Date(1_782_000_000 * 1000).toISOString());
  });

  it('maps person/list_entry/note kinds to their natural type names', () => {
    expect(
      parseAffinityEvents({ type: 'person.created', body: { id: 7 } })[0],
    ).toMatchObject({ recordType: 'Person', changeType: 'create' });
    expect(
      parseAffinityEvents({ type: 'list_entry.deleted', body: { id: 9 } })[0],
    ).toMatchObject({ recordType: 'List Entry', changeType: 'delete' });
    expect(
      parseAffinityEvents({ type: 'note.created', body: { id: 4 } })[0],
    ).toMatchObject({ recordType: 'Note', changeType: 'create' });
  });

  it('maps opportunity/reminder kinds now that those types exist (2026-07-17)', () => {
    expect(
      parseAffinityEvents({ type: 'opportunity.created', body: { id: 700 } })[0],
    ).toMatchObject({ recordType: 'Opportunity', changeType: 'create' });
    expect(
      parseAffinityEvents({ type: 'reminder.updated', body: { id: 800 } })[0],
    ).toMatchObject({ recordType: 'Reminder', changeType: 'update' });
  });

  it('drops unmapped kinds (list.*, field.*, file.*) and junk', () => {
    expect(parseAffinityEvents({ type: 'list.updated', body: { id: 1 } })).toEqual([]);
    expect(parseAffinityEvents({ type: 'field.created', body: { id: 1 } })).toEqual([]);
    expect(parseAffinityEvents({ type: 'file.created', body: { id: 1 } })).toEqual([]);
    expect(parseAffinityEvents(null)).toEqual([]);
    expect(parseAffinityEvents({ type: 'organization.updated', body: {} })).toEqual([]); // no id
  });
});

describe('parseAffinityEvents — field_value → parent record update', () => {
  it('a list-entry field value (deal stage) surfaces as that List Entry updated', () => {
    const body = { id: 55, field_id: 88, entity_type: 1, entity_id: 123, list_entry_id: 456, value: 'Diligence' };
    const events = parseAffinityEvents({ type: 'field_value.updated', body });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      recordType: 'List Entry',
      externalId: '456',
      eventType: 'field_value.updated',
      changeType: 'update',
      payload: body,
    });
  });

  it('a flat entity field value maps by entity_type (1=Organization, 0=Person)', () => {
    expect(
      parseAffinityEvents({
        type: 'field_value.created',
        body: { id: 1, field_id: 2, entity_type: 1, entity_id: 123, list_entry_id: null },
      })[0],
    ).toMatchObject({ recordType: 'Organization', externalId: '123', changeType: 'update' });
    expect(
      parseAffinityEvents({
        type: 'field_value.deleted',
        body: { id: 1, field_id: 2, entity_type: 0, entity_id: 77, list_entry_id: null },
      })[0],
    ).toMatchObject({ recordType: 'Person', externalId: '77' });
  });

  it('maps an opportunity field value by entity_type 8 (Field Entity Types enum)', () => {
    expect(
      parseAffinityEvents({
        type: 'field_value.updated',
        body: { id: 1, field_id: 2, entity_type: 8, entity_id: 5, list_entry_id: null },
      })[0],
    ).toMatchObject({ recordType: 'Opportunity', externalId: '5', changeType: 'update' });
  });

  it('drops field values with unmapped entity types instead of guessing', () => {
    expect(
      parseAffinityEvents({
        type: 'field_value.updated',
        body: { id: 1, field_id: 2, entity_type: 3, entity_id: 5, list_entry_id: null },
      }),
    ).toEqual([]);
  });
});

describe('subscribable vocabulary', () => {
  it('every subscribable event either maps to a record type or is a field_value kind', () => {
    for (const eventType of AFFINITY_SUBSCRIBABLE_EVENTS) {
      const kind = eventType.split('.')[0];
      const body =
        kind === 'field_value'
          ? { id: 1, field_id: 2, entity_type: 1, entity_id: 3, list_entry_id: null }
          : { id: 1 };
      expect(parseAffinityEvents({ type: eventType, body })).toHaveLength(1);
    }
  });
});
