// The workers no product owns.
//
// D8 keeps what belongs to Listen-Fire-the-business out of every export and D36
// leaves it in `public` — so this is not a sixth product's registry, it is the
// part of the composed deployment that belongs to no product. It runs no
// background loops: what used to live here (the billing-notice scan and the
// cost-resume driver) went with billing, and the one thing left is a wire
// between two products rather than a worker.

import type { WorkerRegistry } from './registry';

import { meterKnowledgeLlmUsage } from '../services/knowledge/arbitration/meter_usage';

const residualWorkers: WorkerRegistry = {
  unit: 'residual',
  workers: [],
  wire() {
    // Knowledge's model calls are recorded as usage in the composed
    // deployment, and knowledge knows nothing about `llm_usage`. Registering
    // the sink is safe here because the residual only runs where knowledge does.
    meterKnowledgeLlmUsage();
  },
};

export { residualWorkers };
