// Telegram webhook provider — bridges Telegram Bot API `setWebhook` deliveries
// into the translation-graph / movement dispatch path. Telegram POSTs one
// `Update` JSON per delivery to the webhook URL; this provider turns it into a
// `WebhookEvent` so `services/webhook_sync/handler.ts → dispatchToProviderTriggers`
// fans it out to any movement-derived trigger of kind `TELEGRAM`.
//
// Parsing lives with the ADAPTER (`parseTelegramEvents` in
// adapters/telegram/index.ts, consumed by its `preprocessInbound` and the
// shared-bot classifier) — this provider carries only registration metadata.
//
// Verification (services/inbound/legacy_signature_headers.ts): Telegram doesn't
// HMAC-sign webhooks, and a bring-your-own bot is registered without a secret
// token, so its deliveries are accepted on the unguessable URL (the
// bot-token-in-URL is itself the shared secret in Telegram's model).

import type { WebhookProvider, WebhookRegistration } from './interface';

const telegramProvider: WebhookProvider = {
  // Telegram webhooks are registered by calling the bot's own `setWebhook`
  // method (an API call), so in principle this is auto-registerable. v1 keeps
  // registration manual — the operator (or a future setup flow) calls
  // setWebhook out of band — so we mirror the Slack manual stance.
  canRegisterViaApi: false,

  defaultEventTypes: ['message'],

  setupInstructions: [
    'Telegram webhooks are registered against your bot via the Bot API:',
    '1. Create a bot with @BotFather and copy its token.',
    '2. Call setWebhook with the Webhook URL above:',
    '   https://api.telegram.org/bot<token>/setWebhook?url=<Webhook URL>',
    '3. Telegram will POST an Update JSON to the URL for each message your bot receives.',
  ].join('\n'),



  async registerSubscription(): Promise<WebhookRegistration> {
    // Manual mode — no source-issued id; the subscription is identified by its
    // row id (the path segment in the webhook URL).
    return { secret: '' };
  },
};

export { telegramProvider };
