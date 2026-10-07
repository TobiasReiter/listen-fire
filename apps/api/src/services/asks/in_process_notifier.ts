// The composition root's asks wiring: the composed deployment's answer to "an
// ask settled, now what".
//
// Asks publishes a notifier interface and nothing more — it does not know the
// movement engine, parked runs, or `adapter_await` exist. Automations knows all
// three and nothing about how an answer got written. This module is the only
// place that knows both, which is the same shape as the knowledge mutation
// subscriber and the knowledge usage sink: the two products meet here and
// nowhere else.
//
// A settle queues the engine's wake for the ask's id — the same `wake_await`
// row an inbound signal queues — so every answer door (the link page, Slack,
// MCP, the control tower, a Response write in movement code) wakes its run
// through one durable door, and the wake outlives this process. The kick asks
// this process's drain for a pass now rather than on its next tick.

import { registerAskSettledNotifier } from '../translation_graph/adapters/ask/notifier';
import { ASK_ADAPTER_TYPE } from '../translation_graph/adapters/ask/type';
import { enqueueAwaitWake } from '../movement_engine/await_wake';
import { notifyWork } from '../work/drain';

export function notifyEngineOfSettledAsks(): void {
  registerAskSettledNotifier({
    async notify(ask) {
      await enqueueAwaitWake({ adapterType: ASK_ADAPTER_TYPE, teamId: ask.teamId, correlationKey: ask.id });
      notifyWork();
    },
  });
}
