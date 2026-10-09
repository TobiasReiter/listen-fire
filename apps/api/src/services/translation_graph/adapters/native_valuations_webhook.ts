// Shared Listen-Fire Valuations webhook self-registration.
//
// Valuations exposes `/api/v1/valuations/webhooks` for self-registration. Two
// surfaces register against it and must never drift:
//   - the ADAPTER's `ensureEventSubscription` / `removeEventSubscription` — the
//     movement-listen bridge (`syncListenSubscriptions` provisions a webhook
//     when a movement `listen`s to the Valuations instance);
//   - the WebhookProvider's `registerSubscription` / `deregisterSubscription` —
//     the manual Settings ("Create subscription") path.
// Both are thin callers of the register/deregister helpers here.

import crypto from "node:crypto";

import { z } from 'zod';

import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb } from '../../../lib/kysely';
import { decryptToken } from '../../../lib/credentials';
import { apiBaseUrl } from '../../../lib/api_base_url';

/** The Valuations events a `listen to <vals> { events: [...] }` may subscribe
 *  to — exactly the `row.type` strings the Valuations outbox worker emits, so
 *  the registration's `eventTypes` and the inbound `parseEvents` agree. Also the
 *  WebhookProvider's `defaultEventTypes`. */
export const NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS = [
  'valuations:legal_entity:create',
  'valuations:legal_entity:update',
  'valuations:legal_entity:delete',
] as const;

const credsSchema = z.object({
  apiKey: z.string(),
  apiKeyId: z.string().uuid().optional(),
  baseUrl: z.string().url().optional(),
});

async function loadCreds(
  credentialsId: string,
): Promise<{ apiKey: string; baseUrl: string }> {
  // Decrypt the NATIVE_VALUATIONS credentials row for the api-key + optional
  // baseUrl override. baseUrl defaults to the API process's own address —
  // Valuations runs in this same monorepo, so by default we hit our own REST
  // surface.
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  const decrypted = await decryptToken(row.credentials as Buffer, credentialsId);
  const parsed = credsSchema.parse(JSON.parse(decrypted));
  // Old-format credentials (minted before the /api/v1 prefix moved onto every
  // request path) stored the prefix IN baseUrl — strip it so today's paths
  // (which already carry /api/v1) don't double it up.
  const storedBaseUrl = parsed.baseUrl?.replace(/\/$/, '').replace(/\/api\/v1$/, '');
  const baseUrl = storedBaseUrl ?? apiBaseUrl();
  return { apiKey: parsed.apiKey, baseUrl };
}

async function valuationsApi(
  creds: { apiKey: string; baseUrl: string },
  init: { method: 'POST' | 'DELETE'; path: string; body?: unknown },
): Promise<Response> {
  const url = `${creds.baseUrl.replace(/\/$/, '')}${init.path}`;
  const res = await fetch(url, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.apiKey}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Valuations REST ${init.method} ${init.path} failed: ${res.status} ${text}`,
    );
  }
  return res;
}

/**
 * Register a delivery webhook with Valuations. The target URL is the stable key
 * (Valuations' webhook table has no per-endpoint grouping column; URL does the
 * work), so it is BOTH the registration argument and the `externalId` handed
 * back for `deregister` to delete by. The HMAC secret is generated here and
 * handed to Valuations (the sender) so the outbox worker can sign deliveries;
 * the same value rides the platform's subscription row to verify inbound.
 */
export async function registerValuationsWebhook(input: {
  credentialsId: string;
  targetUrl: string;
  eventTypes: string[];
}): Promise<{ externalId: string; secret: string }> {
  const creds = await loadCreds(input.credentialsId);
  const secret = crypto.randomBytes(32).toString('hex');
  await valuationsApi(creds, {
    method: 'POST',
    path: '/api/v1/valuations/webhooks',
    body: { url: input.targetUrl, eventTypes: input.eventTypes, secret },
  });
  return { externalId: input.targetUrl, secret };
}

/** Deregister by the target URL (`externalId`). DELETE matches by url, so all
 *  per-event-type rows for the destination soft-delete in one call. */
export async function deregisterValuationsWebhook(input: {
  credentialsId: string;
  externalId: string;
}): Promise<void> {
  const creds = await loadCreds(input.credentialsId);
  await valuationsApi(creds, {
    method: 'DELETE',
    path: `/api/v1/valuations/webhooks?url=${encodeURIComponent(input.externalId)}`,
  });
}
