//
// Webhook provider for the Listen-Fire Valuations product. Valuations is a "good
// third party": its outbox worker emits webhooks for every change, and this
// provider parses the resulting payloads on the inbound side. Outgoing webhook
// shape is defined by services/valuations_outbox/worker.ts:buildPayload —
// `{event, timestamp, actor: {type, id}, data: {id, before, after}}`.

import crypto from "node:crypto";

import { z } from 'zod';

import type {
  WebhookEvent,
  WebhookProvider,
  WebhookRegistration,
} from './interface';

import {
  NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS,
  registerValuationsWebhook,
  deregisterValuationsWebhook,
} from '../../translation_graph/adapters/native_valuations_webhook';

const actorSchema = z.object({
  type: z.enum(['user', 'api-token', 'system']),
  id: z.string().nullable(),
});

const eventSchema = z.object({
  /** "valuations:<entity>:<create|update|delete>" — exactly the row.type the
   *  outbox worker emits. Used as the WebhookEvent.eventType. */
  event: z.string(),
  timestamp: z.string(),
  actor: actorSchema,
  data: z.object({
    id: z.string(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
  }),
});

type ValuationsEvent = z.infer<typeof eventSchema>;

/**
 * Pure per-delivery parser — each delivery is a single OutboundWebhookRequest
 * carrying the worker's payload (not an envelope of multiple events like
 * Attio); wrap into the single-event array shape. The Valuations adapter's
 * `preprocessInbound` is the runtime consumer.
 */
export function parseValuationsEvents(body: unknown): WebhookEvent[] {
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) return [];
  return [valuationsEventToWebhookEvent(parsed.data)];
}

const nativeValuationsProvider: WebhookProvider = {
  // Valuations exposes /api/v1/valuations/webhooks for self-registration;
  // we hit it like any other 3rd-party provider so subscription create/delete
  // round-trips the real authentication + REST path. Lives in-process for
  // dev convenience but doesn't cheat past the public surface.
  canRegisterViaApi: true,

  defaultEventTypes: [...NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS],

  verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    // The outbox worker (services/webhook/worker.ts) signs deliveries with
    // HMAC-SHA256(secret, rawBody) and sends the hex digest as the
    // X-Webhook-Signature header. The receiving REST router forwards that
    // value to us as `signatureHeader`. Reject anything that doesn't match.
    if (!signatureHeader) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signatureHeader, 'hex'),
      );
    } catch {
      return false;
    }
  },

  async registerSubscription(input): Promise<WebhookRegistration> {
    // The manual Settings path; the adapter's ensureEventSubscription shares
    // the same register helper so the two never drift.
    return registerValuationsWebhook({
      credentialsId: input.credentialsId,
      targetUrl: input.targetUrl,
      eventTypes: input.eventTypes,
    });
  },

  async deregisterSubscription(input): Promise<void> {
    await deregisterValuationsWebhook({
      credentialsId: input.credentialsId,
      externalId: input.externalId,
    });
  },
};

function valuationsEventToWebhookEvent(e: ValuationsEvent): WebhookEvent {
  // event = "valuations:<entity>:<op>". The middle segment is the entity name
  // (legal_entity, investment, …), used as the framework's `objectId`. The
  // record id is the row's primary key from `data.id`.
  const segments = e.event.split(':');
  const objectId = segments[1] ?? '';
  return {
    eventType: e.event,
    recordId: e.data.id,
    objectId,
    actor: { type: e.actor.type, id: e.actor.id },
    // Forward the full event so trigger filters / field mappings can read
    // before/after via dot-paths (e.g. `data.after.name`). The webhook
    // handler drops it into the source position's `data` verbatim.
    rawPayload: e,
  };
}

export { nativeValuationsProvider };
