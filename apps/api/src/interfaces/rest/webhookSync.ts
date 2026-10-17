// The webhook door, POST /api/public/webhook-sync/:provider/:subscriptionId:
// the shared inbound core (`answerDelivery`) over the platform's store. It
// brings its own raw parser — signatures are over the exact bytes — so a body
// over the limit is answered here, in the door's JSON shape.
import express, { Router } from 'express';

import type { Request, Response } from 'express';
import type { DeliveryHost, InboundStore } from 'movement-engine/public/inbound';

import { answerDelivery } from 'movement-engine/public/inbound';
import { platformInboundStore, queueForHarness, type CapturedReceipts } from '../../services/webhook_sync/handler';
import { notifyWork } from '../../services/work/drain';
import { runHarnessDelivery } from '../../services/work/harness';
import { inboundBodyRefusals, sendInboundAnswer } from './inbound_answer';

/**
 * The movements run off the request, so a provider that times out its
 * delivery (Slack's 3s, Attio's retry budget) never sees a slow run as a
 * failed delivery. A test-harness subscription is the exception: the dev-loop
 * inject CLI reads dispatch errors out of the answer, so it drains first.
 */
const platformDeliveryHost: DeliveryHost<CapturedReceipts> = {
  notify: () => notifyWork(),
  drainBeforeAck: (queue) => runHarnessDelivery(() => queueForHarness(queue)),
};

/** The door over any store: the platform's below, an in-memory one in the
 *  inbound contract suite. */
export function createWebhookSyncRouter<Captured>(
  store: InboundStore<Captured>,
  host: DeliveryHost<Captured>,
): ReturnType<typeof Router> {
  const router: ReturnType<typeof Router> = Router();
  router.use(express.raw({ type: 'application/json' }));
  router.post('/:provider/:subscriptionId', async (req: Request, res: Response) => {
    // A body of another content type is left unparsed; it verifies as `{}`.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const answer = await answerDelivery(store, host, {
      provider: req.params.provider,
      subscriptionId: req.params.subscriptionId,
      rawBody,
      headers: req.headers,
    });
    sendInboundAnswer(res, answer);
  });
  router.use(inboundBodyRefusals);
  return router;
}

const webhookSyncRouter = createWebhookSyncRouter(platformInboundStore, platformDeliveryHost);

export { webhookSyncRouter };
