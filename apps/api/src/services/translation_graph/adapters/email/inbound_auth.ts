// The email doors' auth, owned by the product that receives the mail.
//
// Core's funnel used to carry both branches inline. Neither is a credential
// core can check: the callback door authenticates a Mailgun signature and then
// decides whose team the message is for from the SENDER (D31/D32), and the
// event door authenticates a different Mailgun signature over a delivery
// telemetry payload. Core keeps the tail — the acting-team membership gate and
// the access level still apply to whatever identity these resolve.

import type { Request, Response } from 'express';
import type { InboundDoor } from '../../../../lib/middleware/authentication/doors';
import type { ResolvedIdentity } from '../../../principal/core_provider';

import { handleError } from '../../../../lib/errors';
import { logger } from 'movement-engine/public/log';
import { getEnvVar } from '../../../../lib/utils/environment';
import { judgeMailgunEvent } from 'movement-engine/public/inbound';
import { verifyInboundEmailRequest } from './inbound_door';
import { verifyResendInboundRequest } from './resend_inbound';

/**
 * Inbound mail. Mailgun produces no header that reliably identifies it, so
 * anything hitting the callback route wants to authenticate as if it were
 * Mailgun — and the door decides everything else about the message: that it is
 * really Mailgun, whose team it is, and which trigger (if any) it routes to.
 */
const inboundEmailDoor: InboundDoor = {
  name: 'mailgun-inbound',

  matches: (req) => /^\/api\/mailgun(\/.+)?\/callback$/.test(req.originalUrl),

  async authenticate(req: Request, res: Response): Promise<ResolvedIdentity | null> {
    const decision = await verifyInboundEmailRequest(req.body);
    if (decision.outcome === 'refused') {
      res.status(decision.status).send();
      return null;
    }
    // The handler reads the route the door already resolved rather than
    // deciding it twice (`interfaces/rest/private.ts`).
    req.inboundEmailRoute = decision.route;
    return { userId: decision.userId, requestedTeamId: decision.teamId };
  },
};

/**
 * The same mail, carried by Resend. Its webhook is signed with Svix over the
 * exact bytes it sent and says almost nothing about the message — so the door
 * believes the signature and then routes on the envelope, and the handler goes
 * and fetches what an author actually reads.
 */
const resendInboundDoor: InboundDoor = {
  name: 'resend-inbound',

  matches: (req) => /^\/api\/resend(\/.+)?\/callback$/.test(req.originalUrl),

  async authenticate(req: Request, res: Response): Promise<ResolvedIdentity | null> {
    const decision = await verifyResendInboundRequest(req);
    if (decision.outcome === 'refused') {
      res.status(decision.status).send();
      return null;
    }
    req.inboundEmailRoute = decision.route;
    return { userId: decision.userId, requestedTeamId: decision.teamId };
  },
};

/** The key the event signature is checked with: null when this deployment is
 *  misconfigured and has none. */
function eventSigningKey(): string | null {
  try {
    return getEnvVar('MAILGUN_API_KEY', { devDefault: 'fake_mailgun_key' });
  } catch (e) {
    handleError(e);
    return null;
  }
}

/**
 * Outbound-delivery telemetry (bounces, opens) coming back from Mailgun. It is
 * about mail WE sent, so there is no sender to resolve: it runs as the public
 * identity, exactly as it always has.
 */
const mailgunEventDoor: InboundDoor = {
  name: 'mailgun-events',

  matches: (req) => req.originalUrl.startsWith('/api/webhook/mailgun/'),

  async authenticate(req: Request, res: Response): Promise<ResolvedIdentity | null> {
    const verdict = judgeMailgunEvent({ signature: req.body?.signature, apiKey: eventSigningKey() });
    if (verdict === 'misconfigured') {
      logger.error('Mailgun API key not configured.');
      res.status(500).send();
      return null;
    }
    if (verdict === 'refused') {
      // Terminate early with a 406 (Not acceptable) or Mailgun will retry many
      // times. https://documentation.mailgun.com/en/latest/user_manual.html#webhooks
      res.status(406).send();
      return null;
    }

    return { userId: getEnvVar('PUBLIC_USER_ID') };
  },
};

export { inboundEmailDoor, mailgunEventDoor, resendInboundDoor };
