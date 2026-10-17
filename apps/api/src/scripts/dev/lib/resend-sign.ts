/**
 * Sign a synthetic Resend webhook the way Svix does.
 *
 * Mirrors the verification in
 * `packages/movement-engine/services/inbound/svix.ts`:
 *
 *     signature = base64(HMAC-SHA256(base64decode(secret), `${id}.${timestamp}.${body}`))
 *
 * and travels as the three `svix-*` headers, the signature one carrying a
 * space-separated list of `v1,<sig>` entries.
 *
 * The BODY here is the exact string that must be posted — sign a serialisation
 * and then post a different one and nothing verifies, which is the single
 * easiest way to lose an afternoon on this.
 *
 * Pure function — exported separately from the CLI wrapper so it can be
 * unit-tested against the verifier without spinning up an HTTP server.
 */
import { createHmac, randomBytes } from 'node:crypto';

interface SvixSignatureInputs {
  /** `whsec_`-prefixed base64 secret (the prefix is optional). */
  secret: string;
  /** The exact bytes that will be posted. */
  body: string;
  /** Unix SECONDS. Defaults to now. */
  timestamp?: string;
  /** Opaque per-delivery id. Defaults to a random one. */
  id?: string;
}

/** The three headers, shaped so they can be handed straight to a fetch init. */
type SvixHeaders = Record<'svix-id' | 'svix-timestamp' | 'svix-signature', string>;

function signResendWebhook({ secret, body, timestamp, id }: SvixSignatureInputs): SvixHeaders {
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const deliveryId = id ?? `msg_${randomBytes(12).toString('hex')}`;
  const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const signature = createHmac('sha256', Buffer.from(base64, 'base64'))
    .update(`${deliveryId}.${ts}.${body}`)
    .digest('base64');
  return {
    'svix-id': deliveryId,
    'svix-timestamp': ts,
    'svix-signature': `v1,${signature}`,
  };
}

export { signResendWebhook, type SvixHeaders, type SvixSignatureInputs };
