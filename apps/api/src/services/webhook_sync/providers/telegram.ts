// Telegram webhook provider — bridges Telegram Bot API `setWebhook` deliveries
// into the translation-graph / movement dispatch path. Telegram POSTs one
// `Update` JSON per delivery to the webhook URL; this provider turns it into a
// `WebhookEvent` so `services/webhook_sync/handler.ts → dispatchToProviderTriggers`
// fans it out to any movement-derived trigger of kind `TELEGRAM`.
//
// Parsing lives with the module (`parseTelegramMessage` in @lf/telegram's
// inbound.ts, consumed by its `preprocessInbound` and the shared-bot
// classifier) — this provider carries only registration metadata.
//
// Verification: the platform registers a team's own bot with a random
// `secret_token` (stored as the subscription secret); the module's manifest
// declares `telegram_secret_token`, so a delivery without it is refused.

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import { TelegramClient } from '@listen-fire/telegram/write';

import type { WebhookProvider, WebhookRegistration } from './interface';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../lib/credentials';
import { getAutomationsQb } from '../../../lib/kysely';

const telegramProvider: WebhookProvider = {
  canRegisterViaApi: true,

  defaultEventTypes: ['message'],

  async registerSubscription(input): Promise<WebhookRegistration> {
    const client = await telegramClientFor(input.credentialsId);
    const secret = randomBytes(32).toString('hex');
    await client.setWebhook({ url: input.targetUrl, secretToken: secret });
    return { secret };
  },

  async deregisterSubscription(input): Promise<void> {
    const client = await telegramClientFor(input.credentialsId);
    await client.deleteWebhook();
  },
};

const telegramCredential = z.object({
  botToken: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

async function telegramClientFor(credentialsId: string): Promise<TelegramClient> {
  const cred = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  const { botToken, baseUrl } = telegramCredential.parse(JSON.parse(await decryptToken(cred.credentials, cred.id)));
  if (botToken === undefined || botToken.trim() === '') {
    throw new Error("This Telegram credential connects the platform's shared bot, which has no webhook of its own to register.");
  }
  return new TelegramClient(botToken, baseUrl, fetch);
}

export { telegramProvider };
