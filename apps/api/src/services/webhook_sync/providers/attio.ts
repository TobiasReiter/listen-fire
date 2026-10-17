// Attio webhook provider

import type {
  WebhookProvider,
  WebhookRegistration,
} from './interface';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../lib/credentials';
import { getAutomationsQb } from '../../../lib/kysely';
import {
  AttioAPIClient,
  attioCredsParser,
} from '../../../adapters/attio/apiClient';

// Attio's webhook contract is split: this provider owns SIGNATURE verification
// + subscription registration; event EXTRACTION moved to the adapter's async
// `preprocessInbound` intercept (`translation_graph/adapters/attio.ts`), the
// shared inbound seam Airtable also rides. So there is no `parseEvents` here.
const attioProvider: WebhookProvider = {
  canRegisterViaApi: true,

  defaultEventTypes: ['record.created', 'record.updated', 'record.deleted'],

  async registerSubscription(input): Promise<WebhookRegistration> {
    const client = await getAttioClient(input.credentialsId);
    const result = await client.createWebhook({
      targetUrl: input.targetUrl,
      subscriptions: input.eventTypes.map((e) => ({ event_type: e })),
    });
    return { externalId: result.webhookId, secret: result.secret };
  },

  async deregisterSubscription(input): Promise<void> {
    const client = await getAttioClient(input.credentialsId);
    await client.deleteWebhook(input.externalId);
  },
};

async function getAttioClient(credentialsId: string): Promise<AttioAPIClient> {
  const cred = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('external_service_credentials.id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['external_service_credentials.id', 'external_service_credentials.credentials'])
    .executeTakeFirstOrThrow();

  const decrypted = await decryptToken(cred.credentials as Buffer, credentialsId);
  const parsed = attioCredsParser.parse(JSON.parse(decrypted));
  return new AttioAPIClient(parsed);
}

export { attioProvider };
