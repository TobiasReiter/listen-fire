// Knowledge's background workers: the outbox drainer that is the only thing
// emptying `mutation_outbox`, and the post-commit property arbitration that
// keeps the store LLM-free at write time (D42).
//
// Which way a drained event travels is a delivery mode, not a worker: the
// drainer runs the same either way. Whether THIS process is also the consumer
// is the composition root's question, in `./index`.

import type { WorkerRegistry } from './registry';

import {
  OUTBOX_DRAINER,
  readOutboxHealth,
  startKnowledgeOutboxDrainer,
} from '../services/knowledge/mutation_outbox/worker';
import {
  ARBITRATION_WORKER,
  readArbitrationHealth,
  startKnowledgeArbitrationWorker,
} from '../services/knowledge/arbitration/worker';

const knowledgeWorkers: WorkerRegistry = {
  unit: 'knowledge',
  workers: [
    {
      id: OUTBOX_DRAINER,
      start: startKnowledgeOutboxDrainer,
      pulse: async () => {
        const health = await readOutboxHealth();
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
    {
      id: ARBITRATION_WORKER,
      start: startKnowledgeArbitrationWorker,
      pulse: async () => {
        const health = await readArbitrationHealth();
        return {
          lastBeatAt: health.lastBeatAt,
          lastSuccessAt: health.lastSuccessAt,
          failing: health.lastError !== null,
          queue: {
            pending: health.pending,
            oldestPendingAt: health.oldestPendingAt,
            stuck: health.unresolvable,
          },
          // A supported way to run the store, and the only thing that explains
          // a queue growing under a loop that is ticking normally (D42).
          idleReason: health.llmConfigured ? null : 'no model key configured',
        };
      },
    },
  ],
};

export { knowledgeWorkers };
