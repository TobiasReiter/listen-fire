// How each built-in provider's deliveries to the webhook door are verified,
// frozen as the door verified them before the doors shared one core: the same
// header (first present wins), the same key, the same scheme. A subscription
// some third party already signs for must keep verifying, so this table only
// ever gains rows; a built-in becoming a module declares the same entry in its
// manifest.
//
// The one deliberate change from the old door: `x-listen-fire-signature` is no
// longer read for built-ins. It headed every chain, so a bad value in it
// shadowed a good provider signature; it now verifies remote installs only.

import type { InboundIntercept, InboundVerifier } from 'movement-engine/public/inbound';

import { NATIVE_KNOWLEDGE_PROVIDER_KEY } from '../webhook_sync/providers/native_knowledge';

/** The chain every provider without one of its own was read through: Attio's
 *  two spellings, Airtable's MAC, the platform outbox's header. */
const SHARED_CHAIN = ['attio-signature', 'x-attio-signature', 'x-airtable-content-mac', 'x-webhook-signature'] as const;

export const LEGACY_SIGNATURE_HEADERS: Readonly<Record<string, InboundVerifier>> = Object.freeze({
  ATTIO: { scheme: 'attio', signatureHeaders: SHARED_CHAIN },
  AIRTABLE: { scheme: 'airtable_mac', signatureHeaders: SHARED_CHAIN },
  // Affinity's docs never pinned its header, so the first signature-shaped one.
  AFFINITY: {
    scheme: 'affinity_hex_or_b64',
    signatureHeaders: ['x-affinity-webhook-signature', 'x-affinity-signature', 'x-signature', 'x-webhook-signature'],
  },
  // The platform's own outbox signs as Attio does: bare hex HMAC-SHA256.
  NATIVE_VALUATIONS: { scheme: 'attio', signatureHeaders: SHARED_CHAIN },
  [NATIVE_KNOWLEDGE_PROVIDER_KEY]: { scheme: 'attio', signatureHeaders: SHARED_CHAIN },
  SLACK: { scheme: 'slack_v0', signatureHeaders: ['x-slack-signature'] },
  // A bring-your-own bot's webhook is registered without a secret token; the
  // unguessable URL is the shared secret in Telegram's model.
  TELEGRAM: { verifyInbound: () => true },
  // Meta's header only, keyed with the Meta app's secret.
  INBOUND_WHATSAPP: { scheme: 'hmac_sha256_hex', signatureHeaders: ['x-hub-signature-256'] },
});

/** The requests a built-in's door answers before looking anything up. */
export const LEGACY_INTERCEPTS: Readonly<Record<string, readonly InboundIntercept[]>> = Object.freeze({
  SLACK: ['slack_url_verification'],
});
