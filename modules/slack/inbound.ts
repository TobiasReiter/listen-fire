// Slack's inbound: one Events API envelope per delivery. Only an
// `event_callback` carries an event; `url_verification` (answered by the
// host's door before it gets here), `app_rate_limited` and anything else
// carry none. The inner event is forwarded whole — the adapter reads `text` /
// `user` / `channel` / `ts` / `files` straight off a position's data — keyed
// by its `ts`, with the envelope's `event_id` as the idempotency key Slack's
// retries share. Pure: both of the platform's doors (a team's own app, the
// shared app) and every other host parse a delivery here.

import { z } from 'zod';

import type { DiscriminableEvent } from 'movement-engine/public/adapter';

/**
 * Slack file attachment subset. Only the fields the SlackAdapter's
 * `getResources` actually reads — anything else passes through verbatim
 * on `rawPayload`. Kept loose (`.passthrough()`) so future Slack file
 * fields don't reject otherwise-valid payloads.
 */
const slackFileSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    mimetype: z.string().optional(),
    url_private: z.string().optional(),
    url_private_download: z.string().optional(),
    size: z.number().optional(),
  })
  .passthrough();

/**
 * Inner Slack event (the `event_callback.event` field). Slack delivers
 * many event subtypes — `message`, `app_mention`, `reaction_added`, … —
 * but only `message` matters for the wave-1 dealflow path. We accept any
 * `type` and forward the payload; downstream filters on the trigger entry
 * decide what to act on.
 */
const slackInnerEventSchema = z
  .object({
    type: z.string(),
    user: z.string().optional(),
    channel: z.string().optional(),
    ts: z.string().optional(),
    event_ts: z.string().optional(),
    thread_ts: z.string().optional(),
    text: z.string().optional(),
    files: z.array(slackFileSchema).optional(),
    // `reaction_added` fields: the emoji name, the reacted item (a message —
    // its channel + ts), and the reacted message's author. `channel` is nested
    // under `item` for reactions (not at the top level like messages).
    reaction: z.string().optional(),
    item: z
      .object({
        type: z.string().optional(),
        channel: z.string().optional(),
        ts: z.string().optional(),
      })
      .passthrough()
      .optional(),
    item_user: z.string().optional(),
  })
  .passthrough();

/**
 * Slack envelope. Slack sends three envelope flavours:
 *
 *   • `url_verification` — one-shot setup challenge. The provider parses
 *     it but emits no events; the REST handler is responsible for
 *     responding with the challenge token. parseEvents returns [].
 *   • `event_callback` — the real payload; wraps a single `event` object.
 *   • `app_rate_limited` — informational; we drop on the floor.
 *
 * `.passthrough()` so unknown envelope fields don't break parsing.
 */
const slackEnvelopeSchema = z
  .object({
    type: z.string(),
    event_id: z.string().optional(),
    event_time: z.number().optional(),
    team_id: z.string().optional(),
    api_app_id: z.string().optional(),
    challenge: z.string().optional(),
    event: slackInnerEventSchema.optional(),
  })
  .passthrough();

/** The id Slack events normalise to: the one entry type, `slack:message`. */
export const SLACK_INBOUND_OBJECT_ID = 'slack:message';

/** The inner-event types that are a message (and so a `create`). */
export const SLACK_MESSAGE_EVENT_TYPES = ['message', 'app_mention'] as const;

/** One delivered event. */
export interface SlackDelivery {
  /** The inner event's `type`, verbatim (`message`, `app_mention`, …). */
  eventType: string;
  /** The message `ts`, else `event_ts`, else the envelope's `event_id`. */
  recordId: string;
  idempotencyKey: string | undefined;
  /** The inner event, whole. */
  event: z.infer<typeof slackInnerEventSchema>;
}

/** The events in one delivery: none, or the one an `event_callback` carries. */
export function parseSlackDeliveries(body: unknown): SlackDelivery[] {
  const parsed = slackEnvelopeSchema.safeParse(body);
  if (!parsed.success || parsed.data.type !== 'event_callback' || !parsed.data.event) return [];
  const inner = parsed.data.event;
  return [
    {
      eventType: inner.type,
      recordId: inner.ts ?? inner.event_ts ?? parsed.data.event_id ?? '',
      idempotencyKey: parsed.data.event_id,
      event: inner,
    },
  ];
}

/** A record verb an event type spells, for the few Slack types that are one
 *  (`channel_created`, …). */
function changeTypeOf(eventType: string): 'create' | 'update' | 'delete' | undefined {
  if (eventType.includes('created')) return 'create';
  if (eventType.includes('updated')) return 'update';
  if (eventType.includes('deleted')) return 'delete';
  return undefined;
}

/**
 * The events one delivery fires. A message (or a mention) is a `create`, so
 * the engine seeds a STABLE message position a reply can anchor on; the
 * engine discriminates the rest by the inner event's `type`.
 */
export function slackInboundEvents(body: unknown): DiscriminableEvent[] {
  return parseSlackDeliveries(body).map((delivery) => {
    const changeType = (SLACK_MESSAGE_EVENT_TYPES as readonly string[]).includes(delivery.eventType)
      ? ('create' as const)
      : changeTypeOf(delivery.eventType);
    return {
      payload: delivery.event,
      externalId: delivery.recordId,
      recordType: SLACK_INBOUND_OBJECT_ID,
      eventType: delivery.eventType,
      ...(delivery.idempotencyKey ? { idempotencyKey: delivery.idempotencyKey } : {}),
      ...(changeType !== undefined ? { changeType } : {}),
    };
  });
}

/** For a door that answers `url_verification` itself: the envelope, read. */
export const slackEnvelope = slackEnvelopeSchema;
