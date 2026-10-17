// Slack webhook provider — bridges Slack Events API deliveries into the
// translation-graph dispatch path so a Slack `event_callback` payload can
// route through `services/webhook_sync/handler.ts → routeTrigger` exactly
// the way Attio / Valuations webhooks do.
//
// Slack apps are configured via the slack.com UI — there's no API to
// "create a webhook subscription" — so this provider is manual-mode like
// the Affinity stub: `canRegisterViaApi: false`, `registerSubscription`
// generates a fresh signing-secret locally for the operator to paste into
// the Slack app's "Signing Secret" field.
//
// The shape of `WebhookEvent.rawPayload` is the inner `event` object (the
// `event_callback.event` field), which is also what the source-side
// SlackAdapter (`translation_graph/adapters/slack/index.ts`) expects to
// see on `external-record` source positions — its `getFieldValue` reads
// `text` / `user` / `channel` / `ts` / `thread_ts` directly off `data`
// and `getResources` walks `data.files`. Surfacing the inner event keeps
// the adapter contract honest without forcing it to know about envelope
// wrapping.

import crypto from "node:crypto";

import { z } from 'zod';

import type {
  WebhookProvider,
  WebhookEvent,
  WebhookRegistration,
} from './interface';

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

/**
 * Object id Slack events normalise to. The framework's source-side
 * SlackAdapter publishes exactly one entry-point type (`slack:message`),
 * so we surface the same id on every WebhookEvent. The router's
 * `dispatchToTranslationGraphs` doesn't currently filter by objectId —
 * trigger-entry filters do — but keeping it stable means the value
 * round-trips into anything that does look at it.
 */
const SLACK_OBJECT_ID = 'slack:message';

function slackEventTypeToEventType(innerType: string): string {
  // Surface the Slack inner-event type verbatim ('message', 'app_mention',
  // …) so trigger filters can match on `event.type` and the framework's
  // `mapEventTypeToChangeType` falls through to undefined (Slack events
  // aren't really row create/update/deletes — there's no analogous
  // semantic). Keeping it lossless rather than re-mapping into
  // record-shaped verbs avoids subtle false-positives.
  return innerType;
}

/**
 * Pure per-delivery parser — the same normalization the retired provider
 * `parseEvents` seam ran. The SlackAdapter's `preprocessInbound` is the sole
 * runtime consumer; exported so the parse stays testable in isolation.
 */
export function parseSlackEvents(body: unknown): WebhookEvent[] {
  const parsed = slackEnvelopeSchema.safeParse(body);
  if (!parsed.success) return [];

  // `url_verification` / `app_rate_limited` / any other non-event_callback
  // envelope → no events to dispatch. The REST handler short-circuits
  // url_verification with the challenge response before invoking this,
  // but returning [] here means the handler reports `eventsProcessed: 0`
  // and a 200 OK either way.
  if (parsed.data.type !== 'event_callback' || !parsed.data.event) {
    return [];
  }

  const inner = parsed.data.event;
  // Record id = message `ts`. Slack's `ts` is the stable identifier for
  // any message (and what the SlackAdapter's BaseAdapter linked-object
  // match keys on). Fall back to event_id / event_ts if absent so we
  // never emit an event with an empty recordId.
  const recordId = inner.ts ?? inner.event_ts ?? parsed.data.event_id ?? '';

  return [
    {
      eventType: slackEventTypeToEventType(inner.type),
      recordId,
      objectId: SLACK_OBJECT_ID,
      // The envelope `event_id` (Ev…) is Slack's per-delivery idempotency key:
      // stable across the retries Slack fires when it doesn't get a 200 within
      // 3s, so the receipt store dedupes redeliveries instead of running twice.
      idempotencyKey: parsed.data.event_id,
      // Slack doesn't surface a server-asserted actor in the framework's
      // `(adapterType, actor)` echo-recognition shape — `event.user` is
      // the Slack user id, not an authentication actor. Leave undefined;
      // the framework falls back to no-op detection.
      actor: undefined,
      // Forward the inner event verbatim. The SlackAdapter expects to
      // read `text` / `user` / `channel` / `ts` / `files` directly off
      // the source position's `data`, so the inner event (not the
      // envelope) is what becomes that `data`.
      rawPayload: inner,
      // Slack events don't surface field-level change granularity (a
      // message edit fires `message_changed` as a separate event with
      // the new message in `event.message`); no `changedFields`
      // pruning is possible. Leaving undefined falls through to "always
      // traverse" in event-mode TG execution.
      changedFields: undefined,
    },
  ];
}

const slackProvider: WebhookProvider = {
  canRegisterViaApi: false,

  // Default Slack event types we'd expect operators to subscribe to in
  // the Slack app config. The framework doesn't act on this list for
  // manual providers (operators choose in Slack's UI), but the field is
  // surfaced so the Settings page can hint at what to enable.
  defaultEventTypes: ['message', 'app_mention'],

  setupInstructions: [
    'Slack webhooks must be configured manually in the Slack app config:',
    '1. Open https://api.slack.com/apps and select the app.',
    '2. Under "Event Subscriptions", enable events and paste the Webhook URL above as the Request URL.',
    '3. Under "Basic Information → App Credentials", copy the Signing Secret and paste it into the Webhook Secret shown above (or vice versa).',
    '4. Subscribe to the bot events you need (e.g. message.channels, app_mention).',
    '5. Save. Slack will deliver `event_callback` payloads to the URL.',
  ].join('\n'),

  async registerSubscription(_input): Promise<WebhookRegistration> {
    // Manual mode — generate a fresh secret locally; the operator pastes
    // it into Slack as the Signing Secret. Slack itself never tells us
    // its own webhook id, so externalId stays undefined and we identify
    // the subscription by its row id (the path segment in the webhook URL).
    const secret = crypto.randomBytes(32).toString('hex');
    return { secret };
  },
};

export { slackProvider };

// Exported for the REST handler so it can branch on Slack's
// `url_verification` envelope without re-parsing.
export const slackEnvelopeSchemaForRest = slackEnvelopeSchema;
