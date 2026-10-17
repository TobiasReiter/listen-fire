// The "Listen-Fire" Slack app's Events Request URL — POST /api/public/slack/events.
// One URL for the whole app; every workspace install delivers here, routed by
// team_id (see services/webhook_sync/slack_events.ts). Its own signing secret
// (SLACK_MOVEMENTS_SIGNING_SECRET) so traffic is cleanly separated from the
// legacy app.

import { Router } from 'express';

import type { Request, Response } from 'express';

import { admitShared, authenticateInbound, type InboundAuth, type InboundHeaders, type SharedDoor } from 'movement-engine/public/inbound';
import { handleSlackEventsInbound } from '../../services/webhook_sync/slack_events';
import { logger } from 'movement-engine/public/log';
import { authorizeUnsignedWebhook } from '../../lib/unsigned_webhooks';
import { sendInboundAnswer } from './inbound_answer';

const slackEventsRouter: ReturnType<typeof Router> = Router();

/** The Listen-Fire app's signing secret. Read directly off process.env (not the
 *  throwing getEnvVar) so an unset secret yields null; empty counts as unset. */
function signingSecret(): string | null {
  const raw = process.env.SLACK_MOVEMENTS_SIGNING_SECRET;
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length > 0 ? s : null;
}

/** The app's one signing secret covers its Events and Interactivity doors; only
 *  Events is asked Slack's one-shot setup check. */
export const SLACK_APP_DOOR: SharedDoor = {
  verifier: { scheme: 'slack_v0', signatureHeaders: ['x-slack-signature'] },
  intercepts: ['slack_url_verification'],
};

export type SlackEventsAuthResult = InboundAuth;

/** Fail-closed: secret set → the Slack signature must verify; unset → the shared
 *  no-secret rule (`lib/unsigned_webhooks`), which refuses unless the deployment
 *  explicitly opted into unsigned deliveries and is not production. */
export function verifySlackEventsRequest(rawBody: Buffer, headers: InboundHeaders): SlackEventsAuthResult {
  return authenticateInbound({
    verifier: SLACK_APP_DOOR.verifier,
    rawBody,
    headers,
    secret: signingSecret(),
    allowUnsigned: () => authorizeUnsignedWebhook('slack/events').authorized,
  });
}

slackEventsRouter.post('/events', async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

  const admission = admitShared(SLACK_APP_DOOR, {
    rawBody,
    headers: req.headers,
    secret: signingSecret(),
    allowUnsigned: () => authorizeUnsignedWebhook('slack/events').authorized,
  });
  if (admission.kind === 'answered') {
    sendInboundAnswer(res, admission.answer);
    return;
  }
  if (admission.kind === 'refused') {
    if (admission.reason === 'no_secret') {
      logger.error(
        '[slack/events] REJECTING inbound: SLACK_MOVEMENTS_SIGNING_SECRET is unset, so ' +
          'nothing can prove this delivery came from Slack.',
      );
    } else {
      logger.warn('[slack/events] dropping inbound: Slack signature missing or invalid.');
    }
    res.status(admission.reason === 'no_secret' ? 500 : 401).json({ ok: false });
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
