// The ask service's safety sweep. An answer and a cancel each wake the run
// parked on the ask at their own door; this periodic row covers a wake that was
// lost on the way (a crash between the ask's write and the wake row, a composed
// deployment that never registered its notifier). It finds closed asks that
// runs are still parked on and queues the same `wake_await` row the door would
// have. The engine then resumes each await, which re-checks the ask live.

import { enqueueAwaitWake, wakeAwaitPayloadSchema } from '../../../movement_engine/await_wake';
import { SECOND } from '../../../../constants';
import { registerWorkKinds, type WorkKindRegistration } from '../../../work/drain';
import type { WorkHandler } from '../../../work/kinds';
import { loadClosedAskAwaitPage } from './await_store';
import { ASK_ADAPTER_TYPE } from './type';

const PAGE_SIZE = 500;

export const askClosedSweepHandler: WorkHandler = {
  async run() {
    let after: string | undefined;
    do {
      const page = await loadClosedAskAwaitPage({ limit: PAGE_SIZE, ...(after !== undefined ? { after } : {}) });
      for (const { teamId, askId } of page.wakes) {
        // One row per ask, however many sweeps see it before the drain gets to
        // it; once it runs the correlation is gone and no sweep finds the ask.
        await enqueueAwaitWake(
          wakeAwaitPayloadSchema.parse({ adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: askId }),
          { coalesceKey: `ask_closed:${askId}` },
        );
      }
      after = page.next;
    } while (after !== undefined);
  },
};

// The ask unit's own periodic kind.

declare module '../../../work/kinds' {
  interface UnitWorkKinds {
    ask_closed_sweep: true;
  }
}

export const ASK_WORK_KINDS: readonly WorkKindRegistration[] = [
  { kind: 'ask_closed_sweep', handler: askClosedSweepHandler, intervalMs: 30 * SECOND },
];

export function registerAskClosedSweepWork(): void {
  registerWorkKinds(ASK_WORK_KINDS);
}
