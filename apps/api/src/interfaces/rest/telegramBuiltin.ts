// Shared built-in Telegram bot — the SINGLE global inbound entry.
//
// Distinct from the per-subscription BYO door (`/api/public/webhook-sync/
// telegram/<subId>`): there is NO subscription id in this URL because the
// shared bot serves every team at once. One bot, one webhook, fan-out by
// SENDER IDENTITY (see `services/webhook_sync/telegram_builtin.ts`).
//
// Mounted at `/api/public/telegram` so the entry is `POST /api/public/telegram/
// builtin`.
//
// AUTHENTICATION — why this route MUST verify a secret, unlike the BYO door:
// The BYO door's security is the unguessable `subId` in its URL (a forged
// caller can't know it). This shared entry is a FIXED, guessable, public path —
// so URL-secrecy is no defence. And routing is by SENDER IDENTITY → run-as-that-
// user, so a forged `Update` carrying a victim's `telegram_user_id` would run an
// automation AS that victim. Telegram does NOT HMAC-sign its webhook bodies;
// instead, when the webhook is registered via `setWebhook(secret_token=…)`,
// Telegram includes the header `X-Telegram-Bot-Api-Secret-Token: <secret>` on
// EVERY delivery. We verify that header (constant-time) against
// `TELEGRAM_WEBHOOK_SECRET` before processing. That is the only thing proving
// the POST genuinely came from Telegram.

import { Router } from 'express';

import type { Request, Response } from 'express';

import {
  handleSharedBotInbound,
  type SharedBotDelivery,
} from '../../services/webhook_sync/telegram_builtin';
import { logger } from 'movement-engine/public/log';
import { notifyWork } from '../../services/work/drain';
import { runHarnessDelivery } from '../../services/work/harness';
import { authorizeUnsignedWebhook } from '../../lib/unsigned_webhooks';
import { admitShared, type InboundAuth, type SharedAdmission, type SharedDoor } from 'movement-engine/public/inbound';

const telegramBuiltinRouter: ReturnType<typeof Router> = Router();

/** Telegram's per-delivery shared-secret header (set via `setWebhook`). */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * The webhook shared secret, read from `TELEGRAM_WEBHOOK_SECRET`. Read directly
 * off `process.env` (rather than the throwing `getEnvVar`) so an unset secret
 * yields null instead of crashing — mirroring how the built-in bot token /
 * username are read in Chunks 3/4. An empty/whitespace value counts as unset.
 *
 */
function telegramWebhookSecret(): string | null {
  const raw = process.env.TELEGRAM_WEBHOOK_SECRET;
  const secret = typeof raw === 'string' ? raw.trim() : '';
  return secret.length > 0 ? secret : null;
}

/** No signature: Telegram echoes the `secret_token` it was registered with. */
export const TELEGRAM_SHARED_DOOR: SharedDoor = {
  verifier: { scheme: 'telegram_secret_token', signatureHeaders: [TELEGRAM_SECRET_HEADER] },
  intercepts: [],
};

export type WebhookAuthResult = InboundAuth;

/**
 * Fail-closed authentication of a shared-bot delivery against the configured
 * secret. The header value is whatever Telegram sent in
 * `X-Telegram-Bot-Api-Secret-Token` (or undefined if absent).
 *
 *   secret SET   → header MUST match (constant-time). Mismatch/missing → reject.
 *   secret UNSET → the shared no-secret rule (`lib/unsigned_webhooks`): refused
 *                  unless this deployment set ALLOW_UNSIGNED_WEBHOOKS and is not
 *                  production. That is how the dev loop keeps injecting updates.
 */
export function verifyTelegramWebhookSecret(headerValue: string | undefined): WebhookAuthResult {
  const admission: SharedAdmission = admitShared(TELEGRAM_SHARED_DOOR, {
    rawBody: Buffer.alloc(0),
    headers: { [TELEGRAM_SECRET_HEADER]: headerValue },
    secret: telegramWebhookSecret(),
    allowUnsigned: () => authorizeUnsignedWebhook('telegram/builtin').authorized,
  });
  return admission.kind === 'refused' ? { authorized: false, reason: admission.reason } : { authorized: true };
}

/**
 * Verify the Telegram secret, then (only if authorized) process the inbound.
 * An unauthorized delivery is dropped WITHOUT calling `handleSharedBotInbound`,
 * and reported as `{ ok:false, classification:'unauthorized' }`.
 */
export async function authenticateAndHandle(args: {
  headerSecret: string | undefined;
  raw: unknown;
}): Promise<SharedBotDelivery> {
  const auth = verifyTelegramWebhookSecret(args.headerSecret);
  if (!auth.authorized) {
    if (auth.reason === 'no_secret') {
      logger.error(
        '[telegram/builtin] REJECTING shared-bot inbound: TELEGRAM_WEBHOOK_SECRET ' +
          'is unset, so nothing proves this delivery came from Telegram. Set it (and ' +
          'register the webhook with the matching secret_token).',
      );
    } else {
      logger.warn(
        '[telegram/builtin] dropping shared-bot inbound: secret header missing or ' +
          'mismatched (request not from Telegram, or wrong secret configured).',
      );
    }
    return { result: { ok: false, classification: 'unauthorized' } };
  }
  return handleSharedBotInbound(args.raw);
}

// POST /api/public/telegram/builtin
// The body is the raw Telegram `Update` JSON. Answers 200 (Telegram retries on
// non-2xx, and an unlinked/ignored/unauthorized message is not worth a
// retry-storm) — the JSON payload carries the classification + routing outcome
// for the dev loop. The one exception is a delivery whose work rows could not be
// queued: that answers 500, and the redelivery re-queues the stored receipt.
//
// Capture, queue, then ack. Authentication, identity routing, the `/start`
// handshake, the durable receipts and their work rows all finish inside the
// request; the movements run when the rows drain, after the 200, so a slow run
// can't hold Telegram's delivery open long enough to earn a redelivery. A run's
// failure lands on its receipt, never in the answer — that was already 200.
//
// Telegram also permits answering a webhook with a method call in the response
// body; this door has never done that (every reply is an explicit Bot API call),
// so nothing about the reply path depends on what we put in the body.
telegramBuiltinRouter.post('/builtin', async (req: Request, res: Response) => {
  let raw: unknown;
  try {
    raw = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString('utf-8'))
      : req.body;
  } catch {
    res.status(400).json({ ok: false, error: 'invalid_json' });
    return;
  }

  const headerRaw = req.header(TELEGRAM_SECRET_HEADER);
  const headerSecret = typeof headerRaw === 'string' ? headerRaw : undefined;

  try {
    const delivery = await authenticateAndHandle({ headerSecret, raw });

    // A test-harness delivery drains its rows before acking, so `pnpm dev:inject
    // telegram-builtin` still observes the dispatch synchronously.
    // The rows land before the 200: a receipt without one would never run. A
    // failure to queue them is the one non-2xx, so Telegram redelivers.
    const { enqueueDeferred } = delivery;
    if (enqueueDeferred) {
      try {
        if (delivery.awaitDeferred) {
          res.status(200).json(await runHarnessDelivery(enqueueDeferred));
          return;
        }
        await enqueueDeferred();
      } catch (err) {
        logger.error('[telegram/builtin] queueing the delivery failed:', err);
        res.status(500).json({ ok: false, error: 'enqueue_failed' });
        return;
      }
    }
    res.status(200).json(delivery.result);
    notifyWork();
  } catch (err) {
    logger.error('[telegram/builtin] shared-bot inbound failed:', err);
    // Still 200 so Telegram doesn't retry-storm a genuine bug; surface the
    // error in the body for the dev loop.
    res.status(200).json({
      ok: false,
      classification: 'no_message',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

export { telegramBuiltinRouter };
