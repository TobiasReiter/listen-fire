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

import { parseSlackDeliveries, slackEnvelope } from '@listen-fire/slack/inbound';

import type {
  WebhookProvider,
  WebhookEvent,
  WebhookRegistration,
} from './interface';

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
 * Pure per-delivery parser, over the module's (@lf/slack inbound.ts), as the
 * webhook layer's event — what the shared app's door (`slack_events.ts`)
 * dispatches on.
 */
export function parseSlackEvents(body: unknown): WebhookEvent[] {
  return parseSlackDeliveries(body).map((delivery) => ({
    eventType: slackEventTypeToEventType(delivery.eventType),
    recordId: delivery.recordId,
    objectId: SLACK_OBJECT_ID,
    // Slack's per-delivery idempotency key: stable across Slack's retries.
    idempotencyKey: delivery.idempotencyKey,
    // `event.user` is the Slack user id, not an authentication actor.
    actor: undefined,
    // The inner event, verbatim: what the adapter reads off a position.
    rawPayload: delivery.event,
    // No field-level change granularity in Slack events.
    changedFields: undefined,
  }));
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
export const slackEnvelopeSchemaForRest = slackEnvelope;
