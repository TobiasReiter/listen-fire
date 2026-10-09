// The email doors' auth, owned by the product that receives the mail.
//
// Core's funnel used to carry both branches inline. Neither is a credential
// core can check: the callback door authenticates a Mailgun signature and then
// decides whose team the message is for from the SENDER (D31/D32), and the
// event door authenticates a different Mailgun signature over a delivery
// telemetry payload. Core keeps the tail — the acting-team membership gate and
// the access level still apply to whatever identity these resolve.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Request, Response } from 'express';
import type { InboundDoor } from '../../../../lib/middleware/authentication/doors';
import type { ResolvedIdentity } from '../../../principal/core_provider';

import { handleError } from '../../../../lib/errors';
import { getEnvVar } from '../../../../lib/utils/environment';
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
    const decision = await verifyInboundEmailRequest(req);
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

function eventSignatureVerifies({
  token,
  timestamp,
  signature,
}: {
  token: string;
  timestamp: string;
  signature: string;
}): 'VERIFIED' | 'NOT_VERIFIED' | 'MISCONFIGURED' {
  let apiKey;
  try {
    apiKey = getEnvVar('MAILGUN_API_KEY', { devDefault: 'fake_mailgun_key' });
  } catch (e) {
    handleError(e);
    return 'MISCONFIGURED';
  }

  const hmacSignature = createHmac('sha256', apiKey)
    .update(timestamp + token)
    .digest('hex');

  return timingSafeEqual(Buffer.from(signature), Buffer.from(hmacSignature))
    ? 'VERIFIED'
    : 'NOT_VERIFIED';
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
    const status = eventSignatureVerifies(req.body.signature);

    if (status === 'MISCONFIGURED') {
      res.status(500).send();
      throw new Error('Mailgun API key not configured.');
    }
    if (status === 'NOT_VERIFIED') {
      // Terminate early with a 406 (Not acceptable) or Mailgun will retry many
      // times. https://documentation.mailgun.com/en/latest/user_manual.html#webhooks
      res.status(406).send();
      throw new Error('Could not authenticate inbound email.');
    }

    return { userId: getEnvVar('PUBLIC_USER_ID') };
  },
};

export { inboundEmailDoor, mailgunEventDoor, resendInboundDoor };
