// The park family of the local host: the run host core's park sink over the
// SQLite backend (state.ts), the library texts its parks pin, the core's await
// wake, the callbacks a run mints, and record bindings. And what lf keeps
// about a run beyond its live state (its run records).

import type { CancelGate } from 'movement-engine/services/movement_engine/run';
import type { EngineHost } from 'movement-engine/services/movement_engine/host';
import { callbackSink, callbackUrl } from 'movement-engine/services/run_host/callbacks';
import { parkSources, queueAwaitWake, runParkSink, type RunHost, type RunRecords } from 'movement-engine/services/run_host/rules';
import type { State } from './state';

/** What lf keeps about a run beyond its live state: its row (status and an
 *  operator's cancel request) and its callbacks, revoked when it ends. */
export function localRunRecords(state: State): RunRecords {
  return {
    cancelRequest: async ({ runId }) => state.cancelRequest(runId),
    markFailed: async ({ runId, message }) => state.markFailed(runId, message),
    closeRun: async ({ runId }) => state.callbacks.revokeRun({ runId }),
  };
}

/** The run's cancel gate: the engine stops at its next boundary once an
 *  operator stamped a cancel on the run's row (`lf cancel`, from any lf
 *  process sharing the state file). A read is one indexed SQLite lookup, so
 *  every boundary reads; once cancelled it latches. */
export function localCancelGate(state: State, runId: string): CancelGate {
  let cancelled = false;
  const read = async (): Promise<boolean> => {
    if (!cancelled) cancelled = state.cancelRequest(runId) !== null;
    return cancelled;
  };
  return { cancelled: read, cancelledNow: read };
}

export function localParkFamily(input: {
  state: State;
  host: RunHost;
  runId: string;
  teamId: string;
  /** The run lease the segment holds: a park lands only while it is still this. */
  fence?: string;
  /** Where the host is reached from outside: a callback's url is under it. */
  publicUrl: string;
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
    callbacks: callbackSink(state.callbacks, { runId, teamId, url: (id) => callbackUrl(input.publicUrl, id) }),
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
