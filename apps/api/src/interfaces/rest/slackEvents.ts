// The "Listen-Fire" Slack app's Events Request URL — POST /api/public/slack/events.
// One URL for the whole app; every workspace install delivers here, routed by
// team_id (see services/webhook_sync/slack_events.ts). Its own signing secret
// (SLACK_MOVEMENTS_SIGNING_SECRET) so traffic is cleanly separated from the
// legacy app.

import { Router } from 'express';

import type { Request, Response } from 'express';

import { verifySlackSignature } from '../../services/webhook_sync/providers/slack';
import { handleSlackEventsInbound } from '../../services/webhook_sync/slack_events';
import { logger } from 'movement-engine/services/logger';
import { authorizeUnsignedWebhook } from '../../lib/unsigned_webhooks';

const slackEventsRouter: ReturnType<typeof Router> = Router();

/** The Listen-Fire app's signing secret. Read directly off process.env (not the
 *  throwing getEnvVar) so an unset secret yields null; empty counts as unset. */
function signingSecret(): string | null {
  const raw = process.env.SLACK_MOVEMENTS_SIGNING_SECRET;
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length > 0 ? s : null;
}

export type SlackEventsAuthResult =
  | { authorized: true }
  | { authorized: false; reason: 'signature_invalid' | 'no_secret' };

/** Fail-closed: secret set → the Slack signature must verify; unset → the shared
 *  no-secret rule (`lib/unsigned_webhooks`), which refuses unless the deployment
 *  explicitly opted into unsigned deliveries and is not production. */
export function verifySlackEventsRequest(
  rawBody: Buffer,
  signatureHeader: string,
): SlackEventsAuthResult {
  const secret = signingSecret();
  if (secret !== null) {
    return verifySlackSignature(rawBody, signatureHeader, secret)
      ? { authorized: true }
      : { authorized: false, reason: 'signature_invalid' };
  }
  return authorizeUnsignedWebhook('slack/events');
}

/** Echo Slack's url_verification challenge (no signature required). */
function respondToChallenge(rawBody: Buffer, res: Response): boolean {
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
    if (typeof challenge === 'string') res.status(200).json({ challenge });
    else res.status(400).json({ error: 'missing_challenge' });
    return true;
  }
  return false;
}

/** Pack Slack's two signature headers into the "{timestamp}:{signature}" string
 *  verifySlackSignature splits internally. Empty when either is missing. */
function buildSlackSignatureHeader(req: Request): string {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (typeof timestamp !== 'string' || typeof signature !== 'string') return '';
  return `${timestamp}:${signature}`;
}

slackEventsRouter.post('/events', async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

  if (respondToChallenge(rawBody, res)) return;

  const auth = verifySlackEventsRequest(rawBody, buildSlackSignatureHeader(req));
  if (!auth.authorized) {
    if (auth.reason === 'no_secret') {
      logger.error(
        '[slack/events] REJECTING inbound: SLACK_MOVEMENTS_SIGNING_SECRET is unset, so ' +
          'nothing can prove this delivery came from Slack.',
      );
    } else {
      logger.warn('[slack/events] dropping inbound: Slack signature missing or invalid.');
    }
    res.status(auth.reason === 'no_secret' ? 500 : 401).json({ ok: false });
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    res.status(400).json({ ok: false, error: 'invalid_json' });
    return;
  }

  // Ack within Slack's 3-second budget, THEN process off the request cycle.
  // Blocking the ack on the full dispatch (which makes live Slack API calls for
  // the channel/actor filters and kicks the engine) blew past 3s, so Slack
  // retried the same event and — before the receipt became idempotent — that
  // produced duplicate runs. The receipt store dedupes redeliveries on the
  // envelope `event_id` regardless, so a late-arriving retry is a safe no-op.
  res.status(200).json({ ok: true });
  setImmediate(() => {
    void handleSlackEventsInbound(raw).catch((err) => {
      logger.error('[slack/events] inbound failed:', err);
    });
  });
});

export { slackEventsRouter };
