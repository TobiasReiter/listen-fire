// WhatsApp (Meta Cloud API) webhook provider — bridges Meta `messages`
// webhook deliveries into the movement dispatch path, the phone twin of the
// Telegram provider. Meta POSTs an envelope
// (`entry[].changes[].value.messages[]`) per delivery; this provider verifies
// the X-Hub-Signature-256 HMAC and flattens each message into a `WebhookEvent`
// whose `rawPayload` matches the canonical shape the source-side
// `WhatsappAdapter` reads (`from`/`body`/`attachments`, with Twilio-raw
// tolerance) — so `getFieldValue` reads it directly off the source position.
//
// Media: Meta delivers media by *id* (downloaded out-of-band via the Graph
// API with the business token), not a URL. parseEvents is synchronous, so it
// emits the media id in the attachment `key`; the live inbound router
// (`services/whatsapp/dispatch.ts`) resolves ids → stored documents before
// dispatch. (See the flagged note in that file.)

import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { WebhookEvent, WebhookProvider, WebhookRegistration } from './interface';

import { normalizeWhatsappPhone } from '../../translation_graph/adapters/acting_user/phone';
import {
  WHATSAPP_RECORD_TYPE_ID,
  WHATSAPP_INBOUND_REACTION_TYPE,
  WHATSAPP_INBOUND_LOCATION_TYPE,
  type WhatsappAttachment,
  type WhatsappPayload,
} from '../../translation_graph/adapters/whatsapp/types';

// ── Meta envelope schema (tolerant — extra fields pass through) ─────────────

const metaMediaSchema = z
  .object({ id: z.string(), mime_type: z.string().optional(), filename: z.string().optional(), caption: z.string().optional() })
  .passthrough();

const metaMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string().optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    image: metaMediaSchema.optional(),
    document: metaMediaSchema.optional(),
    audio: metaMediaSchema.optional(),
    video: metaMediaSchema.optional(),
    sticker: metaMediaSchema.optional(),
    reaction: z
      .object({ message_id: z.string(), emoji: z.string().optional() })
      .passthrough()
      .optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const metaContactSchema = z
  .object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).passthrough().optional() })
  .passthrough();

const metaChangeSchema = z
  .object({
    field: z.string().optional(),
    value: z
      .object({
        metadata: z.object({ display_phone_number: z.string().optional() }).passthrough().optional(),
        contacts: z.array(metaContactSchema).optional(),
        messages: z.array(metaMessageSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const metaWebhookSchema = z
  .object({ object: z.string().optional(), entry: z.array(z.object({ changes: z.array(metaChangeSchema).optional() }).passthrough()).optional() })
  .passthrough();

/** The inbound-message shape the dumb path reads. Hand-written (not a zod
 *  `.passthrough()` infer) so the webhook layer's `WhatsAppMessage` — which has
 *  no index signature — assigns to it cleanly. */
export interface MetaWhatsappMessage {
  from: string;
  id: string;
  timestamp?: string;
  type?: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; filename?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type?: string; filename?: string; caption?: string };
  video?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string; filename?: string; caption?: string };
  reaction?: { message_id: string; emoji?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

/** Flatten a Meta message into the canonical `WhatsappPayload`. Attachments
 *  carry the Meta media *id* in `key` (resolved to a stored document by the
 *  inbound router before dispatch). Shared by the provider and the router. */
export function normalizeMetaMessage(
  message: MetaWhatsappMessage,
  ctx: { businessNumber?: string; businessPhoneNumberId?: string; profileName?: string } = {},
): WhatsappPayload {
  const media =
    message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
  const attachments: WhatsappAttachment[] = media
    ? [
        {
          key: media.id,
          filename: media.filename ?? message.id,
          contentType: media.mime_type ?? 'application/octet-stream',
        },
      ]
    : [];
  return {
    messageId: message.id,
    from: normalizeWhatsappPhone(message.from) ?? message.from,
    to: ctx.businessNumber ? normalizeWhatsappPhone(ctx.businessNumber) ?? ctx.businessNumber : '',
    ...(ctx.businessPhoneNumberId ? { businessPhoneNumberId: ctx.businessPhoneNumberId } : {}),
    body: message.text?.body ?? media?.caption ?? '',
    waId: message.from,
    profileName: ctx.profileName,
    timestamp: message.timestamp,
    attachments,
  };
}

/** Inbound WhatsApp event kinds — the `listen to wa { events: [...] }`
 *  vocabulary (manifest `subscribableEvents`). A listen with no `events`
 *  subscribes to messages only, so reactions/locations never fire a movement
 *  that didn't opt in. */
export type WhatsappEventKind = 'message' | 'reaction' | 'location';

export { WHATSAPP_INBOUND_REACTION_TYPE, WHATSAPP_INBOUND_LOCATION_TYPE };

export interface ClassifiedWhatsappEvent {
  kind: WhatsappEventKind;
  /** The seeded root position's type — the RECORD the kind's fires edge
   *  delivers, whole (rule 1's collapse: the field-less event nodes are
   *  gone, so a listen seeds the message/reaction/location itself, stable
   *  on its wamid). */
  rootRecordType: string;
  payload: Record<string, unknown>;
}

/**
 * Classify one inbound Meta message into its event kind + typed payload.
 * Text/media/sticker are a `message` (sticker = one more media attachment);
 * reactions and locations are their own event types (a reaction used to
 * parse as an EMPTY message and fire movements spuriously). Anything else
 * (contacts, interactive replies, system notices) returns undefined — the
 * caller drops it with a log, never a silent empty-message firing.
 */
export function classifyMetaMessage(
  message: MetaWhatsappMessage,
  ctx: { businessNumber?: string; businessPhoneNumberId?: string; profileName?: string } = {},
): ClassifiedWhatsappEvent | undefined {
  const common = {
    messageId: message.id,
    from: normalizeWhatsappPhone(message.from) ?? message.from,
    waId: message.from,
    profileName: ctx.profileName,
    timestamp: message.timestamp,
    // The receiving number id rides every kind (message / reaction / location)
    // so a reply, reaction, or typing indicator goes out from that number.
    ...(ctx.businessPhoneNumberId ? { businessPhoneNumberId: ctx.businessPhoneNumberId } : {}),
  };
  if (message.reaction !== undefined) {
    return {
      kind: 'reaction',
      rootRecordType: WHATSAPP_INBOUND_REACTION_TYPE,
      payload: {
        ...common,
        emoji: message.reaction.emoji ?? '',
        reactedMessageId: message.reaction.message_id,
      },
    };
  }
  if (message.location !== undefined) {
    return {
      kind: 'location',
      rootRecordType: WHATSAPP_INBOUND_LOCATION_TYPE,
      payload: {
        ...common,
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        name: message.location.name,
        address: message.location.address,
      },
    };
  }
  const media = message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
  if (message.text !== undefined || media !== undefined || message.type === 'text') {
    return {
      kind: 'message',
      rootRecordType: WHATSAPP_RECORD_TYPE_ID,
      payload: { ...normalizeMetaMessage(message, ctx) },
    };
  }
  return undefined;
}

/** Whether a whatsapp trigger's listen config subscribes to this kind —
 *  `events` absent ⇒ messages only. */
export function triggerAcceptsWhatsappKind(config: unknown, kind: WhatsappEventKind): boolean {
  const events = (config as { events?: unknown } | null | undefined)?.events;
  const allowed =
    Array.isArray(events) && events.length > 0
      ? events.filter((e): e is string => typeof e === 'string')
      : ['message'];
  return allowed.includes(kind);
}

/**
 * Pure per-delivery parser — the same normalization the retired provider
 * `parseEvents` seam ran; the WhatsappAdapter's `preprocessInbound` is the
 * runtime consumer.
 */
export function parseWhatsappEvents(body: unknown): WebhookEvent[] {
  const parsed = metaWebhookSchema.safeParse(body);
  if (!parsed.success) return [];
  const events: WebhookEvent[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value;
      const businessNumber = value.metadata?.display_phone_number;
      const profileName = value.contacts?.[0]?.profile?.name;
      for (const message of value.messages ?? []) {
        const classified = classifyMetaMessage(message, { businessNumber, profileName });
        if (classified === undefined) continue; // unsupported kind — never an empty-message firing
        events.push({
          eventType: classified.kind,
          recordId: message.id,
          objectId: classified.rootRecordType,
          // The sender is a phone number, not an Listen-Fire auth actor — same call
          // the Slack/Telegram providers make.
          actor: undefined,
          rawPayload: classified.payload,
          changedFields: undefined,
        });
      }
    }
  }
  return events;
}

export const whatsappProvider: WebhookProvider = {
  // Meta webhooks are configured in the Meta App dashboard out of band, not via
  // an Listen-Fire API call — mirror the Telegram/Slack manual stance.
  canRegisterViaApi: false,

  defaultEventTypes: ['message'],

  setupInstructions: [
    'WhatsApp (Meta Cloud API) webhooks are configured in the Meta App dashboard:',
    '1. In WhatsApp > Configuration, set the Callback URL to the Webhook URL above',
    '   and the Verify Token to WHATSAPP_WEBHOOK_VERIFY_TOKEN.',
    '2. Subscribe to the `messages` field. Meta signs deliveries with your App',
    '   Secret (X-Hub-Signature-256), verified here.',
  ].join('\n'),

  // Meta signs the raw body with the App Secret using HMAC-SHA256, delivered as
  // `X-Hub-Signature-256: sha256=<hex>`.
  verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    if (!signatureHeader || !secret) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const got = signatureHeader.replace(/^sha256=/, '');
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(got, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  },


  async registerSubscription(): Promise<WebhookRegistration> {
    // Manual mode — Meta is configured in its dashboard; the subscription is
    // identified by its row id (the path segment in the webhook URL).
    return { secret: '' };
  },
};
