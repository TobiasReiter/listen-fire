// Webhook provider for the Listen-Fire knowledge graph.
//
// The graph is no longer privileged in-process machinery: the movement engine
// reaches it over HTTP with a stored credential, and hears about changes the
// way it hears about any other system — a signed webhook (D25). Its drainer
// (services/knowledge/mutation_outbox/worker.ts) POSTs one envelope per event,
// signed `HMAC-SHA256(secret, rawBody)` hex in `X-Webhook-Signature` — the same
// signature the Valuations outbox sends, which is why the verification below is
// the Valuations one.
//
// The inbound route picks that header up already: it is the last candidate in
// the generic branch of `interfaces/rest/webhookSync.ts`, so nothing there had
// to learn about this provider.
//
// PROVIDER KEY: `KG_MUTATION` — provider keys are trigger-kind aliases, and
// that is the alias the graph adapter's manifest declares (`triggerKinds`), so
// `resolveAdapterSlug('KG_MUTATION')` lands on the `kg` adapter. The
// movement-listen provisioner derives the same key from the same manifest
// (`providerKeyForSlug`), so the door it provisions and the door registered
// here are one door.

import crypto from "node:crypto";

import { z } from 'zod';

import type { WebhookEvent, WebhookProvider, WebhookRegistration } from './interface';

import { MUTATION_EVENT_TYPES } from '../../../lib/knowledge/store/events';
import { actorSchema } from '../../translation_graph/mutation_context';
import {
  deregisterKnowledgeWebhook,
  registerKnowledgeWebhook,
} from '../../translation_graph/adapters/knowledge_graph_webhook';

/** The provider key the inbound route and the subscription row agree on. */
export const NATIVE_KNOWLEDGE_PROVIDER_KEY = 'KG_MUTATION';

/**
 * What a `listen` to the graph may subscribe to — the drainer's own event
 * vocabulary, which is also what the graph's registration endpoint validates
 * and what the adapter's manifest advertises (`KG_SUBSCRIBABLE_EVENTS`). One
 * list, taken from the sender, so the registration and the parse can't drift.
 */
export const NATIVE_KNOWLEDGE_SUBSCRIBABLE_EVENTS = MUTATION_EVENT_TYPES;

// Registration lives with the adapter (`adapters/knowledge_graph_webhook.ts`),
// built on the adapter's own HTTP client. Two callers need it — a listen being
// reconciled and an operator (re)registering here — and a second copy would be
// two implementations that could register different endpoints and then disagree
// about which secret verifies the delivery.

// ── Inbound ────────────────────────────────────────────────────────────────

const envelopeSchema = z.object({
  event: z.enum([...MUTATION_EVENT_TYPES]),
  timestamp: z.string(),
  data: z.object({
    recordId: z.string(),
    nodeTypeId: z.string(),
    changeKind: z.enum(['create', 'update', 'delete']),
    /** Property type ids whose value moved; edge type ids for links. */
    changedFields: z.array(z.string()).optional(),
    /** The writer's provenance bag, forwarded verbatim by the graph. */
    context: z
      .object({ source: z.object({ actor: actorSchema.optional() }).passthrough() })
      .passthrough()
      .optional(),
  }),
});

type KnowledgeEnvelope = z.infer<typeof envelopeSchema>;

/**
 * Pure per-delivery parser — one envelope per delivery (the graph's drainer
 * sends events singly, like Valuations, not batched like Attio), so the result
 * is a one-element array.
 */
export function parseKnowledgeEvents(body: unknown): WebhookEvent[] {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return [];
  return [knowledgeEventToWebhookEvent(parsed.data)];
}

function knowledgeEventToWebhookEvent(e: KnowledgeEnvelope): WebhookEvent {
  // The actor is only ever what the WRITER declared and the graph carried back
  // verbatim — a movement's own write says so in its context bag, and that is
  // precisely the echo the token registry recognises. A bag without one leaves
  // the field absent rather than guessing a shape, so suppression falls back to
  // no-op detection instead of matching on something invented here.
  const actor = e.data.context?.source.actor;
  return {
    eventType: e.event,
    recordId: e.data.recordId,
    // The node TYPE is the graph's "object" — the same currency a listen names.
    objectId: e.data.nodeTypeId,
    ...(actor ? { actor } : {}),
    ...(e.data.changedFields ? { changedFields: e.data.changedFields } : {}),
    // Forward the whole envelope so filters and field mappings read it by
    // dot-path (`data.recordId`, `data.context.source.type`, …).
    rawPayload: e,
  };
}

const nativeKnowledgeProvider: WebhookProvider = {
  // The graph exposes `/api/v1/knowledge/graph/webhooks` for self-registration;
  // we hit it like any other third party, so a subscription round-trips the
  // real authentication and REST path even when the graph happens to be in this
  // same process.
  canRegisterViaApi: true,

  defaultEventTypes: [...NATIVE_KNOWLEDGE_SUBSCRIBABLE_EVENTS],

  verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
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
    return registerKnowledgeWebhook({
      credentialsId: input.credentialsId,
      targetUrl: input.targetUrl,
      eventTypes: input.eventTypes,
    });
  },

  async deregisterSubscription(input): Promise<void> {
    await deregisterKnowledgeWebhook({
      credentialsId: input.credentialsId,
      externalId: input.externalId,
    });
  },
};

export { nativeKnowledgeProvider };
