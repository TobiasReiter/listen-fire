import type { EventType } from 'movement-engine/services/translation_graph/adapter';

import { discriminateEvent } from 'movement-engine/services/translation_graph/engine/inbound/discriminate';
import { isStablePosition, positionData, positionRecordId } from 'movement-engine/services/translation_graph/types';

const TYPES: EventType[] = [
  { tag: 'company.updated', positionType: 'attio:companies', match: { path: 'id.object_id', equals: 'obj-co' } },
  { tag: 'deal.updated', positionType: 'attio:deals', match: { path: 'id.object_id', equals: 'obj-deal' } },
  { tag: 'multi', positionType: 'attio:people', match: { path: 'event_type', equals: ['record.created', 'record.updated'] } },
];

describe('discriminateEvent', () => {
  it('matches by declarative path + single equals → typed stable position', () => {
    const result = discriminateEvent({
      adapterType: 'attio',
      event: { payload: { id: { object_id: 'obj-co', record_id: 'rec-1' } }, externalId: 'rec-1' },
      eventTypes: TYPES,
    });
    expect(result).not.toBeNull();
    expect(result!.eventType.positionType).toBe('attio:companies');
    expect(isStablePosition(result!.position)).toBe(true);
    expect(result!.position.recordType).toBe('attio:companies');
    expect(positionRecordId(result!.position)).toBe('rec-1');
    expect(positionData(result!.position)).toEqual({ id: { object_id: 'obj-co', record_id: 'rec-1' } });
  });

  it('matches by array equals', () => {
    const result = discriminateEvent({
      adapterType: 'attio',
      event: { payload: { event_type: 'record.created' }, externalId: 'p-1' },
      eventTypes: TYPES,
    });
    expect(result!.eventType.positionType).toBe('attio:people');
  });

  it('prefers an explicit tag over the declarative match', () => {
    const result = discriminateEvent({
      adapterType: 'attio',
      // payload would match companies by path, but the adapter already tagged it a deal
      event: { tag: 'deal.updated', payload: { id: { object_id: 'obj-co' } }, externalId: 'rec-9' },
      eventTypes: TYPES,
    });
    expect(result!.eventType.positionType).toBe('attio:deals');
  });

  it('returns null when nothing matches', () => {
    expect(
      discriminateEvent({
        adapterType: 'attio',
        event: { payload: { id: { object_id: 'obj-unknown' } }, externalId: 'x' },
        eventTypes: TYPES,
      }),
    ).toBeNull();
  });

  it('returns null on an unknown tag', () => {
    expect(
      discriminateEvent({
        adapterType: 'attio',
        event: { tag: 'nope', payload: {}, externalId: 'x' },
        eventTypes: TYPES,
      }),
    ).toBeNull();
  });

  it('treats a non-string discriminator value as a non-match', () => {
    expect(
      discriminateEvent({
        adapterType: 'attio',
        event: { payload: { id: { object_id: 123 } }, externalId: 'x' },
        eventTypes: TYPES,
      }),
    ).toBeNull();
  });

  it('seeds an unstable typed position when the event has no externalId', () => {
    const result = discriminateEvent({
      adapterType: 'attio',
      event: { payload: { id: { object_id: 'obj-co' } } },
      eventTypes: TYPES,
    });
    expect(result).not.toBeNull();
    expect(isStablePosition(result!.position)).toBe(false);
    expect(result!.position.recordType).toBe('attio:companies');
  });

  it('returns null for an empty union', () => {
    expect(
      discriminateEvent({
        adapterType: 'attio',
        event: { payload: { id: { object_id: 'obj-co' } }, externalId: 'rec-1' },
        eventTypes: [],
      }),
    ).toBeNull();
  });
});

describe('tag-only event types (normalized payloads with no literal discriminator)', () => {
  const tagOnly = [
    { tag: 'message', positionType: 'telegram:message' },
    { tag: 'reaction', positionType: 'whatsapp:reaction' },
  ] as const;

  it('selects by the adapter-set tag', () => {
    const result = discriminateEvent({
      adapterType: 'telegram',
      event: { payload: { message_id: '77', chat_id: '42' }, externalId: '77', tag: 'message' },
      eventTypes: tagOnly,
    });
    expect(result?.eventType.positionType).toBe('telegram:message');
    expect(result?.position.identity).toMatchObject({ kind: 'stable', recordId: '77' });
  });

  it('never matches an un-tagged event against a match-less type (no accidental typing)', () => {
    const result = discriminateEvent({
      adapterType: 'telegram',
      event: { payload: { message_id: '77', chat_id: '42' }, externalId: '77' },
      eventTypes: tagOnly,
    });
    expect(result).toBeNull();
  });
});
