// The cooperative cancel gate (runs-and-cancel spec §cancel). The engine checks
// it at statement boundaries AND at the boundaries inside a statement — every
// LLM call and every plugin invocation of an extraction — because cancel means
// "stop doing things", not just "stop spending", and one `extract` statement can
// be minutes of work. All of them share this ONE debounced read, so the extra
// check sites cost nothing: within POLL_MS the answer is served from memory, and
// once cancelled it latches and never reads again. Fail-open: a read fault reads
// as not-cancelled, the same posture as the dispatch gates (a DB blip must not
// kill healthy runs).

import { getAutomationsQb, getQb } from '../../lib/kysely';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { CancelGate } from './run';

const POLL_MS = 3_000;

export function makeDbCancelGate(runId: TriggerRunId): CancelGate {
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
      if (latchedCancelled) return true;
      if (Date.now() - lastCheckedMs < POLL_MS) return false;
      return read();
    },
    async cancelledNow(): Promise<boolean> {
      if (latchedCancelled) return true;
      return read();
    },
    reason(): string | null {
      return latchedReason;
    },
  };
}

