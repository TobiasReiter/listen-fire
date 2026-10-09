// Asks' one background worker: the standalone settle-notification drainer.
// Under `local` delivery nothing ever enqueues, so it starts no loop at all —
// and the workers surface says so with a reason, because a registered worker
// that is not running must not read the same as one that is wedged.

import type { WorkerRegistry } from './registry';

import { askSettleDelivery } from '../services/translation_graph/adapters/ask/delivery_mode';
import {
  ASK_WEBHOOK_DRAINER,
  readAskDeliveryHealth,
  startAskWebhookDrainer,
} from '../services/asks/webhook_delivery/worker';

function idleReason(health: { signingConfigured: boolean }): string | null {
  if (askSettleDelivery() !== 'webhook') return 'settle notifications are delivered in-process';
  if (!health.signingConfigured) return 'no webhook signing secret configured';
  return null;
}

const asksWorkers: WorkerRegistry = {
  unit: 'asks',
  workers: [
    {
      id: ASK_WEBHOOK_DRAINER,
      start: startAskWebhookDrainer,
      pulse: async () => {
        const health = await readAskDeliveryHealth();
        return {
          lastBeatAt: health.lastBeatAt,
          lastSuccessAt: health.lastSuccessAt,
          failing: health.lastError !== null,
          queue: {
            pending: health.pending,
            oldestPendingAt: health.oldestPendingAt,
            stuck: health.failed,
          },
          idleReason: idleReason(health),
        };
      },
    },
  ],
};

export { asksWorkers };
