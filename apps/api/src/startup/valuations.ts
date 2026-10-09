// Valuations' background workers: its own two-step delivery pipeline (V-16).
// Changes become deliveries, deliveries become signed POSTs.

import type { WorkerRegistry } from './registry';

import { startValuationsOutboxWorker } from '../services/valuations_outbox/worker';
import {
  DELIVERY_WORKER,
  readDeliveryHealth,
  startValuationsDeliveryWorker,
} from '../services/valuations_outbox/delivery';

const valuationsWorkers: WorkerRegistry = {
  unit: 'valuations',
  workers: [
    { id: 'valuations.change_outbox', start: startValuationsOutboxWorker },
    {
      id: DELIVERY_WORKER,
      start: startValuationsDeliveryWorker,
      pulse: async () => {
        const health = await readDeliveryHealth();
        return {
          lastBeatAt: health.lastBeatAt,
          lastSuccessAt: health.lastSuccessAt,
          failing: health.lastError !== null,
          queue: {
            pending: health.pending,
            oldestPendingAt: health.oldestPendingAt,
            stuck: health.undeliverable,
          },
          idleReason: null,
        };
      },
    },
  ],
};

export { valuationsWorkers };
