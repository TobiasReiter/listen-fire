// The park family of the local host: the run host core's park sink over the
// SQLite backend (state.ts), the library texts its parks pin, the core's await
// wake, and record bindings.

import type { EngineHost } from 'movement-engine/services/movement_engine/host';
import { parkSources, queueAwaitWake, runParkSink, type RunHost } from 'movement-engine/services/run_host/rules';
import type { State } from './state';

export function localParkFamily(input: {
  state: State;
  host: RunHost;
  runId: string;
  teamId: string;
  /** The run lease the segment holds: a park lands only while it is still this. */
  fence?: string;
}): EngineHost['park'] {
  const { state, host, runId, teamId } = input;
  return {
    sink: runParkSink(host, {
      runId,
      teamId,
      ...(input.fence !== undefined ? { fence: input.fence } : {}),
      records: {
        // The run's row is written before its first segment runs.
        ensureRun: async () => {},
        markParked: async () => state.markParked(runId),
      },
    }),
    // The library texts its parks pin, once each by their hash.
    sources: parkSources(host.store.sources, teamId),
    wake: ({ adapterType, correlationKey }) => queueAwaitWake(host.store, { adapterType, teamId, correlationKey }),
    bindings: {
      record: async ({ from, to }) => state.recordBinding({ from, to }),
      findBoundCounterpart: async ({ endpoint, counterpart }) =>
        state.findBoundCounterpart({ endpoint, ...(counterpart !== undefined ? { counterpart } : {}) }),
      delete: async ({ from, to }) => state.deleteBinding({ from, to }),
    },
  };
}
