// The app the golden cases run against: the real inbound routers mounted the
// way server.ts mounts them (same paths, same body parsers, same order), with
// nothing between them and the request but the parsers. Doors that live behind
// the authentication funnel in production (the Resend and valuations routes)
// get the funnel's decision as a small shim, because the funnel itself is the
// platform's session machinery, not an inbound door.

import express from 'express';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { webhookSyncRouter } from '../../../interfaces/rest/webhookSync';
import { adapterDoorsRouter } from '../../../interfaces/rest/adapterDoors';
import { telegramBuiltinRouter } from '../../../interfaces/rest/telegramBuiltin';
import { slackEventsRouter } from '../../../interfaces/rest/slackEvents';
import { slackInteractivityRouter } from '../../../interfaces/rest/slackInteractivity';
import { callbacksRouter } from '../../../interfaces/rest/callbacks';
import { asksRouter } from '../../../interfaces/rest/asks';
import { whatsappRouter } from '../../../interfaces/rest/whatsapp';
import { receiveWebhook } from '../../../interfaces/whatsapp/webhook';
import { resendInboundEmailHandler } from '../../../interfaces/rest/private';
import { webhooksRouter as valuationsWebhooksRouter } from '../../../interfaces/rest/v1/valuations/webhooks';
import { resendInboundDoor } from '../../translation_graph/adapters/email/inbound_auth';
import { jsonBodyParser, urlencodedBodyParser } from '../../../lib/middleware/body_parser';

/** The authentication funnel's verdict for a door: the door answers a refusal
 *  itself, otherwise the request carries on as the identity the door resolved. */
function throughDoor(door: { authenticate(req: Request, res: Response): Promise<unknown> }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    door
      .authenticate(req, res)
      .then((identity) => {
        if (identity !== null) next();
      })
      .catch(next);
  };
}

export function buildGoldenApp(): express.Express {
  const app = express();
  // Production runs with NODE_ENV=production, which is what keeps express's
  // fallback error page free of stack traces.
  app.set('env', 'production');

  app.use('/api/public/webhook-sync', webhookSyncRouter);
  app.use('/api/public/adapter', adapterDoorsRouter);
  app.use('/api/public/telegram', express.raw({ type: 'application/json' }), telegramBuiltinRouter);
  app.use('/api/public/slack', express.raw({ type: 'application/json' }), slackEventsRouter);
  app.use('/api/public/slack-actions', express.raw({ type: '*/*' }), slackInteractivityRouter);
  app.use('/api/resend', express.raw({ type: 'application/json' }));
  app.use(jsonBodyParser);
  app.use(urlencodedBodyParser);
  app.use('/api/cb', callbacksRouter);
  app.use('/api/asks', asksRouter);
  app.use('/api/public/whatsapp', whatsappRouter);
  // Not a production path: the WhatsApp router reads its app secret when it is
  // imported, so the door as it behaves with no secret set is mounted here.
  app.post('/api/public/whatsapp-unsigned/webhook', receiveWebhook({ verifyToken: undefined, appSecret: undefined }));
  app.post('/api/resend/callback', throughDoor(resendInboundDoor), resendInboundEmailHandler);
  app.use('/api/v1/valuations/webhooks', valuationsWebhooksRouter);
  return app;
}
