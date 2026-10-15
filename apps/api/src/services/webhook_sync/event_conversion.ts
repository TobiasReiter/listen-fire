// Legacy WebhookEvent → DiscriminableEvent conversion.
//
// The provider-side sync `parseEvents` seam is retired: every adapter now
// normalizes its own inbound deliveries through `Adapter.preprocessInbound`
// (the one async raw→events seam). The push-style adapters (Slack, Telegram,
// WhatsApp, Valuations) still PARSE with the pure per-provider functions the
// old seam used — exported from their provider modules — and convert here, so
// the event shape the runtime sees is byte-identical to what the legacy path
// produced. Lives in its own module (not handler.ts) because adapters import
// it, and adapters importing the handler would cycle.

import type { WebhookEvent } from './providers/interface';
import type { DiscriminableEvent } from 'movement-engine/services/translation_graph/adapter';

export function mapEventTypeToChangeType(
  eventType: string,
): 'create' | 'update' | 'delete' | undefined {
  if (eventType.includes('created')) return 'create';
  if (eventType.includes('updated')) return 'update';
  if (eventType.includes('deleted')) return 'delete';
  return undefined;
}

/**
 * Normalize a legacy `WebhookEvent` (the pure parser shape) into the uniform
 * `DiscriminableEvent` the inbound pipeline runs on. The synthesized payload
 * matches what the old handler seeded (`{ event_type, id, actor }`) so
 * discrimination's `match` rules still fire.
 */
export function webhookEventToDiscriminable(e: WebhookEvent): DiscriminableEvent {
  return {
    payload: e.rawPayload ?? {
      event_type: e.eventType,
      id: { record_id: e.recordId, object_id: e.objectId },
      actor: e.actor,
    },
    externalId: e.recordId,
    recordType: e.objectId,
    eventType: e.eventType,
    ...(e.idempotencyKey ? { idempotencyKey: e.idempotencyKey } : {}),
    ...(mapEventTypeToChangeType(e.eventType)
      ? { changeType: mapEventTypeToChangeType(e.eventType) }
      : {}),
    ...(e.actor ? { actor: e.actor } : {}),
    ...(e.changedFields ? { changedFields: e.changedFields } : {}),
  };
}
