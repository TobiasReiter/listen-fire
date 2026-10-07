// The cooperative cancel gate (runs-and-cancel spec §cancel). The engine checks
// it at statement boundaries AND at the boundaries inside a statement — every
// LLM call and every plugin invocation of an extraction — because cancel means
// "stop doing things", not just "stop spending", and one `extract` statement can
// be minutes of work. All of them share this ONE debounced read, so the extra
// check sites cost nothing: within POLL_MS the answer is served from memory, and
// once cancelled it latches and never reads again. Fail-open: a read fault reads
// as not-cancelled, the same posture as the dispatch gates (a DB blip must not
// kill healthy runs).

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { CancelGate } from './run';

import { getAutomationsQb, getQb } from '../../lib/kysely';
import { RunLeaseLost, type HeldRunLease } from './run_lease';

const POLL_MS = 3_000;

/** The run's gate as its host holds it: what the engine checks, and the
 *  stamped reason the host reports once the run stops cancelled. The reason
 *  never crosses to the engine; it reads only whether to stop. */
export interface DbCancelGate extends CancelGate {
  reason(): string | null;
}

/**
 * `lease`: the run lease this segment runs under. Once it is lost the gate
 * throws `RunLeaseLost` at the next boundary — the same places a cancel
 * stops the run — rather than letting a segment carry on that another
 * instance may now be stepping. Checked before the debounce: it costs nothing.
 */
export function makeDbCancelGate(runId: TriggerRunId, opts: { lease?: Pick<HeldRunLease, 'isLost'> } = {}): DbCancelGate {
  const { lease } = opts;
  const assertLeaseHeld = (): void => {
    if (lease?.isLost()) throw new RunLeaseLost(runId);
  };
  let lastCheckedMs = -Infinity;
  let latchedCancelled = false;
  let latchedReason: string | null = null;

  async function read(): Promise<boolean> {
    lastCheckedMs = Date.now();
    try {
      const row = await getAutomationsQb(['trigger_run'])
        .selectFrom('trigger_run')
        .select(['cancel_requested_at', 'cancel_reason'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (row?.cancel_requested_at != null) {
        latchedCancelled = true;
        latchedReason = row.cancel_reason ?? null;
      }
    } catch {
      // Fail open — a read fault must never stop a healthy run.
    }
    return latchedCancelled;
  }

  return {
    async cancelled(): Promise<boolean> {
      assertLeaseHeld();
      if (latchedCancelled) return true;
      if (Date.now() - lastCheckedMs < POLL_MS) return false;
      return read();
    },
    async cancelledNow(): Promise<boolean> {
      assertLeaseHeld();
      if (latchedCancelled) return true;
      return read();
    },
    reason(): string | null {
      return latchedReason;
    },
  };
}

