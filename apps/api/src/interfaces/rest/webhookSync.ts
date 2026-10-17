// REST webhook endpoint
import { Router } from 'express';

import type { Request, Response } from 'express';

import { handleInboundWebhook } from '../../services/webhook_sync/handler';
import { logger } from 'movement-engine/services/logger';
import { notifyWork } from '../../services/work/drain';
import { runHarnessDelivery } from '../../services/work/harness';
import { REMOTE_SIGNATURE_HEADER } from 'movement-engine/services/webhook_sync/remote_inbound';

const webhookSyncRouter: ReturnType<typeof Router> = Router();

// POST /api/public/webhook-sync/:provider/:subscriptionId
// Raw body is needed for signature verification
webhookSyncRouter.post(
  '/:provider/:subscriptionId',
  async (req: Request, res: Response) => {
    const { provider, subscriptionId } = req.params;
    const providerKey = provider.toUpperCase();

    // req.body is the raw Buffer when express.raw() is used
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    // Slack short-circuit: the `url_verification` envelope is a one-shot
    // setup check. Slack expects the bare `challenge` token echoed in the
    // response body within 3s — no signature, no handler dispatch. Parsing
    // the raw body here (cheap) before we touch the framework keeps the
    // happy path simple and avoids round-tripping through verifySignature.
    if (providerKey === 'SLACK') {
      const challengeResponse = maybeRespondToSlackChallenge(rawBody, res);
      if (challengeResponse) return;
    }

    // Per-provider signature header. Attio sends `Attio-Signature`; the
    // Listen-Fire outbox worker sends `X-Webhook-Signature`; Slack splits the
    // signature across two headers (`X-Slack-Signature` + the
    // `X-Slack-Request-Timestamp`) so we encode both as
    // `"{timestamp}:{signature}"` and the slack provider splits internally.
    // Affinity's docs don't pin its header name, so we take the first
    // signature-shaped candidate; its provider verifies hex OR base64.
    const signatureHeader =
      providerKey === 'SLACK'
        ? buildSlackSignatureHeader(req)
        : providerKey === 'INBOUND_WHATSAPP'
          ? // Meta's own header; no other header is accepted for this provider.
            ((req.headers['x-hub-signature-256'] as string) ?? '')
          : providerKey === 'AFFINITY'
          ? ((req.headers['x-affinity-webhook-signature'] as string) ??
            (req.headers['x-affinity-signature'] as string) ??
            (req.headers['x-signature'] as string) ??
            (req.headers['x-webhook-signature'] as string) ??
            '')
          : // A remote adapter's subscription signs in the protocol's own header.
            ((req.headers[REMOTE_SIGNATURE_HEADER] as string) ??
            (req.headers['attio-signature'] as string) ??
            (req.headers['x-attio-signature'] as string) ??
            // Airtable signs with `X-Airtable-Content-MAC: hmac-sha256=<hex>`.
            (req.headers['x-airtable-content-mac'] as string) ??
            (req.headers['x-webhook-signature'] as string) ??
            '');

    try {
      const result = await handleInboundWebhook({
        provider: providerKey,
        subscriptionId,
        rawBody,
        signatureHeader,
      });

      if (!result.ok) {
        const statusMap: Record<string, number> = {
          unknown_provider: 404,
          subscription_not_found: 404,
          provider_mismatch: 400,
          signature_invalid: 401,
        };
        res.status(statusMap[result.error!] ?? 500).json({ error: result.error });
        return;
      }

      // Capture, queue, then ack. The handler has durably receipted everything
      // that arrived; queueing a work row per receipt and per await wake is a
      // cheap insert that has to land before the 200, since a receipt or a wake
      // without a row would never run. A wake that cannot be queued throws into
      // the 500 below, and the sender's retry replays the receipted events
      // idempotently.
      // The movements run off the request cycle, so a provider that times out
      // its delivery (Slack's 3s, Attio's retry budget) doesn't see a slow run
      // as a failed delivery and redeliver it.
      //
      // A test-harness subscription is the exception: the dev-loop inject CLI
      // reads dispatch errors out of this response, so it drains the rows first.
      if (result.enqueueDeferred && result.awaitDeferred) {
        const deferred = await runHarnessDelivery(result.enqueueDeferred);
        res.status(200).json({
          ok: true,
          eventsProcessed: deferred.eventsProcessed,
          ...(deferred.perEventErrors.length > 0
            ? { perEventErrors: deferred.perEventErrors }
            : {}),
        });
        return;
      }

      if (result.enqueueDeferred) await result.enqueueDeferred();
      res.status(200).json({ ok: true, eventsProcessed: result.eventsProcessed });
      notifyWork();
    } catch (err) {
      logger.error('Webhook sync endpoint error:', err);
      res.status(500).json({ error: 'internal' });
    }
  },
);

/**
 * Slack URL verification handshake. The first time an operator pastes the
 * webhook URL into the Slack app config, Slack POSTs
 * `{ type: 'url_verification', challenge: '<token>' }` and expects the
 * `<token>` echoed back as the response body (or JSON `{ challenge }`).
 *
 * Returns true when the request was handled — caller short-circuits.
 * Returns false when it wasn't a `url_verification` envelope — caller
 * proceeds with the normal handler dispatch.
 */
function maybeRespondToSlackChallenge(rawBody: Buffer, res: Response): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return false;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { type?: unknown }).type === 'url_verification'
  ) {
    const challenge = (parsed as { challenge?: unknown }).challenge;
    if (typeof challenge === 'string') {
      res.status(200).json({ challenge });
    } else {
      res.status(400).json({ error: 'missing_challenge' });
    }
    return true;
  }
  return false;
}

/**
 * Pack Slack's two signature headers (`X-Slack-Request-Timestamp`,
 * `X-Slack-Signature`) into the single string the framework's
 * `verifySignature(rawBody, signatureHeader, secret)` contract carries.
 * The slack provider knows to split on the first `:` and reconstruct
 * `v0:{timestamp}:{rawBody}` for HMAC verification.
 *
 * Empty string when either header is missing — the provider will reject.
 */
function buildSlackSignatureHeader(req: Request): string {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (typeof timestamp !== 'string' || typeof signature !== 'string') return '';
  return `${timestamp}:${signature}`;
}

export { webhookSyncRouter };
