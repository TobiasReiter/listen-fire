// The park family of the local host: where a run's parks, joins, branch
// exports, await wakes and record bindings go — the SQLite state, with the
// semantics the hosted Postgres sink has (state.ts).

import { randomUUID } from 'node:crypto';
import type { EngineHost } from 'movement-engine/services/movement_engine/host';
import type { State } from './state';

/** The work key a run's timer wake is queued under: one row per run, due at
 *  its earliest parked timer. */
export function timerWorkKey(runId: string): string {
  return `resume_timer:${runId}`;
}

/** Queue the wake of whatever is parked on one adapter's correlation key. A
 *  signal's wake is never coalesced: a second signal while the first wake
 *  runs must still drive the parks the first pass looked past. */
export function enqueueAwaitWake(state: State, wake: { adapterType: string; correlationKey: string }): void {
  state.enqueue({ kind: 'wake_await', key: `wake_await:${randomUUID()}`, payload: wake });
}

export function localParkFamily(input: { state: State; runId: string; engine: 'rust' }): EngineHost['park'] {
  const { state, runId, engine } = input;
  return {
    sink: {
      recordJoin: async ({ frameAddress, parkedChildren }) => state.recordJoin(runId, frameAddress, parkedChildren),
      commitTimerPark: async ({ address, state: parked, wakeAt }) => {
        state.upsertPark({ run_id: runId, address, kind: 'timer', wake_at: wakeAt, adapter_type: null, correlation_key: null, state: JSON.stringify(parked), engine });
        // The park row is the truth; the work row only says when to look.
        state.enqueue({ kind: 'resume_timer', key: timerWorkKey(runId), payload: { runId }, dueAt: wakeAt });
      },
      commitAwaitPark: async ({ address, state: parked, adapterType, correlationKey }) => {
        state.upsertPark({ run_id: runId, address, kind: 'await', wake_at: null, adapter_type: adapterType, correlation_key: correlationKey, state: JSON.stringify(parked), engine });
      },
      commitSuspension: async ({ address, state: parked }) => {
        state.upsertPark({ run_id: runId, address, kind: 'suspension', wake_at: null, adapter_type: null, correlation_key: null, state: JSON.stringify(parked), engine });
      },
      decrementJoin: async ({ frameAddress, branchAddress, leafAddress }) =>
        state.decrementJoin({ runId, frameAddress, branchAddress, leafAddress }),
      persistBranchExport: async ({ frameAddress, branchAddress, branchIndex, exports }) =>
        state.persistBranchExport({ runId, frameAddress, branchAddress, branchIndex, exports }),
      collectBranchExports: async ({ frameAddress }) => state.collectBranchExports(runId, frameAddress),
      cancelSubtrees: async ({ subtreeAddresses, excludeLeaf }) =>
        state.cancelSubtrees({ runId, subtreeAddresses, ...(excludeLeaf !== undefined ? { excludeLeaf } : {}) }),
    },
    wake: async ({ adapterType, correlationKey }) => enqueueAwaitWake(state, { adapterType, correlationKey }),
    bindings: {
      record: async ({ from, to }) => state.recordBinding({ from, to }),
      findBoundCounterpart: async ({ endpoint, counterpart }) =>
        state.findBoundCounterpart({ endpoint, ...(counterpart !== undefined ? { counterpart } : {}) }),
      delete: async ({ from, to }) => state.deleteBinding({ from, to }),
    },
  };
}
