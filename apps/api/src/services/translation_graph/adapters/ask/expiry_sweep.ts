// The ask service's expiry sweep. An answer wakes its awaiters the moment it is
// written (the settle notifier queues the wake); an expiry does not — a cancel
// is a plain lattice transition with no door behind it — so this periodic row
// finds expired asks that runs are still parked on and queues the same
// `wake_await` row an answer would. The engine then resumes each await, which
// re-checks the ask and resolves `empty`.

import { enqueueAwaitWake } from '../../../movement_engine/await_wake';
import { registerWorkHandler } from '../../../work/drain';
import type { WorkHandler } from '../../../work/kinds';
import { loadExpiredAskAwaits } from './await_store';
import { ASK_ADAPTER_TYPE } from './type';

export const askExpirySweepHandler: WorkHandler = {
  async run() {
    for (const { teamId, askId } of await loadExpiredAskAwaits()) {
      // One row per ask, however many sweeps see it before the drain gets to
      // it; once it runs the correlation is gone and no sweep finds the ask.
      await enqueueAwaitWake(
        { adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: askId },
        { coalesceKey: `ask_expired:${askId}` },
      );
    }
  },
};

export function registerAskExpiryWork(): void {
  registerWorkHandler('ask_expiry_sweep', askExpirySweepHandler);
}
