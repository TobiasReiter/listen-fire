// How the webhook door verifies a delivery to a REMOTE adapter's subscription.
// (handler.ts recognises the subscription; this is only the signature.)
//
// Signature scheme (the protocol's, not any third party's): the remote signs
// each delivery with the secret its `ensureEventSubscription` returned, as the
// lowercase hex HMAC-SHA256 of the exact raw body, in `x-listen-fire-signature`.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const REMOTE_SIGNATURE_HEADER = 'x-listen-fire-signature';

/** The placeholder a subscription row holds until its registration returns a
 *  secret (listen_subscriptions.ts). Never a key anything may verify against. */
export const UNREGISTERED_SECRET = 'pending';

export function signRemoteDelivery(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyRemoteSignature(rawBody: Buffer, signatureHeader: string, secret: string | null): boolean {
  if (secret === null || secret.length === 0 || secret === UNREGISTERED_SECRET) return false;
  const expected = Buffer.from(signRemoteDelivery(rawBody, secret), 'hex');
  const presented = Buffer.from(signatureHeader, 'hex');
  return presented.length === expected.length && timingSafeEqual(expected, presented);
}
