// Affinity webhook provider — registration + signature stance for the
// `/api/public/webhook-sync/affinity/:subId` door. Event EXTRACTION lives on
// the adapter's `preprocessInbound` (translation_graph/adapters/affinity/
// inbound.ts) — the one raw→events seam.
//
// Rebuilt 2026-07-05. The previous provider was a black hole: it advertised
// manual setup instructions while its parseEvents unconditionally returned []
// — every delivery silently dropped. This one is real: Affinity's API
// registers subscriptions (POST /webhooks, max 3 per instance), so the
// provider is AUTO-registered like Attio/Airtable.
//
// Signature stance (2026-07-05, optional additional security step):
// Affinity signs deliveries with an ACCOUNT-level "Webhook Signature Key"
// (the profile's API tab) — SHA256 HMAC of the raw request body. The key is
// not issued by the subscribe call, so it is collected OPTIONALLY at connect
// time (`webhookSignatureKey` on the credential). When the credential carries
// it, `registerSubscription` stores it as the subscription secret and every
// delivery is verified strictly; without it, deliveries are trusted on the
// unguessable subscription URL (the Telegram-BYO stance) exactly as before.
// Subscriptions registered BEFORE a key was added keep the URL-trust stance
// until re-registered. Affinity's docs don't pin the signature header name or
// encoding, so verification accepts an optional `sha256=` prefix and matches
// the HMAC as hex OR base64 — but never accepts an EMPTY signature once a key
// is configured.


import type { WebhookProvider, WebhookRegistration } from './interface';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { decryptToken } from '../../../lib/credentials';
import { getAutomationsQb } from '../../../lib/kysely';
import {
  affinityCredsParser,
  getAffinityClient,
} from '../../../adapters/affinity/apiClient';
import { AFFINITY_SUBSCRIBABLE_EVENTS } from '../../translation_graph/adapters/affinity/inbound';

const affinityProvider: WebhookProvider = {
  canRegisterViaApi: true,

  defaultEventTypes: [...AFFINITY_SUBSCRIBABLE_EVENTS],

  // See the signature stance above: URL-trust without a key, strict HMAC
  // verification once the credential carries the account's signature key.
  async registerSubscription(input): Promise<WebhookRegistration> {
    const credential = await affinityCredentialFor(input.credentialsId);
    const client = getAffinityClient(credential.apiKey, credential.baseUrl);
    const created = await client.createWebhookSubscription({
      webhookUrl: input.targetUrl,
      subscriptions: input.eventTypes,
    });
    // The subscription secret IS the account's webhook signature key when the
    // credential carries one — empty keeps the trust-the-URL stance.
    return { externalId: String(created.id), secret: credential.webhookSignatureKey ?? '' };
  },

  async deregisterSubscription(input): Promise<void> {
    const client = await affinityClientFor(input.credentialsId);
    await client.deleteWebhookSubscription(input.externalId);
  },
};

async function affinityCredentialFor(credentialsId: string) {
  const cred = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  return affinityCredsParser.parse(
    JSON.parse(await decryptToken(cred.credentials, cred.id)),
  );
}

async function affinityClientFor(credentialsId: string) {
  const decrypted = await affinityCredentialFor(credentialsId);
  return getAffinityClient(decrypted.apiKey, decrypted.baseUrl);
}

export { affinityProvider };
