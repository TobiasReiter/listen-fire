// Airtable webhook provider
import crypto from "node:crypto";

import type { WebhookProvider, WebhookRegistration } from './interface';

// Airtable's webhook contract is split like Attio's: this provider owns
// SIGNATURE verification only; subscription registration is the adapter's
// `ensureEventSubscription` (Airtable webhooks are per-(base, table), which the
// thin provider has no scope for) and event EXTRACTION is the adapter's async
// `preprocessInbound` (the ping carries no records — they're pulled). So there
// is no `parseEvents` and `registerSubscription` is unreachable here.
const airtableProvider: WebhookProvider = {
  canRegisterViaApi: true,

  defaultEventTypes: ['record.created', 'record.updated', 'record.deleted'],

  /**
   * Airtable signs the raw body with HMAC-SHA256 keyed by the base64-DECODED
   * `macSecretBase64` issued at webhook creation, and delivers it in the
   * `X-Airtable-Content-MAC` header as `hmac-sha256=<hex>`.
   */
  verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    const provided = signatureHeader.startsWith('hmac-sha256=')
      ? signatureHeader.slice('hmac-sha256='.length)
      : signatureHeader;
    const expected = crypto
      .createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(rawBody)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(provided, 'hex'),
      );
    } catch {
      return false;
    }
  },

  // Registration is owned by the adapter's `ensureEventSubscription` (it carries
  // the per-(base, table) scope the listen reconciler diff-syncs). This entry
  // exists only so the route can resolve the provider for signature
  // verification + registry presence; the path is never invoked.
  async registerSubscription(): Promise<WebhookRegistration> {
    throw new Error(
      'Airtable webhook registration is owned by the adapter ensureEventSubscription seam, not the webhook_sync provider.',
    );
  },
};

export { airtableProvider };
