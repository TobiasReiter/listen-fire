// An inbound event as the engine is handed it: discriminated into a concrete
// root type (honouring a pre-set `tag`), so the engine seeds a typed record
// position rather than the raw payload. Every shell builds the TriggerEvent
// here, so an event reaches a run the same way in each.

import type { DiscriminableEvent, EventType } from '../adapter';
import type { TriggerType } from '../mutation_context';
import { discriminateEvent } from '../engine/inbound/discriminate';
import type { TriggerEvent } from './types';

export function triggerEventOf(input: {
  pipelineInputId: string;
  adapterType: string;
  triggerType: TriggerType;
  event: DiscriminableEvent;
  eventTypes: readonly EventType[];
  now: Date;
}): { triggerEvent: TriggerEvent; discriminated: boolean } {
  const { adapterType, triggerType, event, eventTypes, now } = input;
  let rootRecordType: string | undefined;
  if (eventTypes.length > 0) {
    const discriminated = discriminateEvent({ adapterType, event, eventTypes });
    if (discriminated) rootRecordType = discriminated.eventType.positionType;
  }

  // The external-side record type: the source's own type id when the adapter
  // names it directly (Attio's object id), else the discriminated position
  // type (the poll path's behaviour).
  const externalRecordRefType = event.recordType ?? rootRecordType;

  const triggerEvent: TriggerEvent = {
    pipelineInputId: input.pipelineInputId,
    adapterType,
    triggerType,
    payload: event.payload,
    ...(event.changeType ? { changeType: event.changeType } : {}),
    ...(rootRecordType ? { rootRecordType } : {}),
    ...(event.externalId !== undefined
      ? {
          externalRecordRef: {
            adapterType,
            externalId: event.externalId,
            ...(externalRecordRefType ? { recordType: externalRecordRefType } : {}),
          },
        }
      : {}),
    ...(event.actor ? { actor: event.actor } : {}),
    ...(event.changedFields ? { changedFields: event.changedFields } : {}),
    ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    occurredAt: event.occurredAt ?? now.toISOString(),
  };
  return { triggerEvent, discriminated: rootRecordType !== undefined };
}
