// Operator actions for the control tower — run-level cancel / resume (§5.7 P9,
// runs-cancel tasks 3/6). An operator looking at what's parked or running can:
//
//   • abortRun          → failRunAndCancelRequests (trigger_run → failed, parked
//                         rows cleared, await correlations dropped). The §5.7
//                         must-have: an indefinitely-parked run stays visible AND
//                         manually abortable.
//   • resumeRun         → resumeLimitPausedRun: a run paused at its cost limit
//                         resumes every branch it suspended, with its usage
//                         reset (movement_engine/limit_pause.ts).
//
// (Ask answering / re-delivery are NOT operator run-actions any more — an ask is
// an adapter record answered through the ONE answer door; see ask_records.ts.)
//
// Each verifies the target run belongs to the acting team (a cross-team id reads
// as not-found).

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../lib/kysely';
import { MovementEngineError } from 'movement-engine/public/errors';
import { failRunAndCancelRequests, stampCancelRequested } from './run_failure';
import { resumeLimitPausedRun } from '../movement_engine/limit_resume';
import { runResumeSlot } from '../movement_engine/await_resume';
import { RunBusy, withRunLease } from '../movement_engine/run_lease';

/**
 * Resume a run paused at its cost limit — every branch it suspended carries on
 * from the statement it stopped before, and the limit applies afresh (the run's
 * usage resets). Team-scoped like `abortRun`. Throws when the run is not paused
 * at a limit. Serialised with the run's other resumes (its awaits, its fired
 * callbacks), in this process by the run's slot and across processes by its
 * lease: a run another process is stepping right now throws `RunBusy`, which
 * the doors answer as a conflict to retry.
 */
export async function resumeRun(input: {
  runId: string;
  teamId: TeamId;
}): Promise<{ runId: string; resumed: number }> {
  const runId = await assertOwnedRun(input.runId, input.teamId);
  let resumed = 0;
  let failure: unknown;
  await runResumeSlot.exclusive(runId as unknown as string, async () => {
    try {
      const stepped = await withRunLease(runId, (lease) => resumeLimitPausedRun(runId, lease));
      if (stepped.kind === 'busy') throw new RunBusy(runId);
      resumed = stepped.value.resumed;
    } catch (err) {
      failure = err;
    }
  });
  if (failure !== undefined) throw failure;
  return { runId: runId as unknown as string, resumed };
}

/**
 * Abort a parked/running run — cancel it and all its open asks. Team-scopes the
 * run, then branches on its current status (runs-cancel task 3):
 *
 *   • `parked` → the original immediate path: `failRunAndCancelRequests`
 *     (trigger_run → failed, open requests → cancelled with their tokens dead,
 *     parked_run + join_pending cleared; prior external writes stand, P14).
 *     Safe to tear down synchronously — nothing is mid-flight.
 *   • `running` → a write COULD be mid-flight, so we don't touch the run
 *     directly. Instead we STAMP `cancel_requested_at`/`cancel_reason` via a
 *     guarded update (`WHERE status = 'running' AND cancel_requested_at IS
 *     NULL`) and let the engine's cooperative cancel gate
 *     (movement_engine/cancel_gate.ts) settle it at its next check-in — or, if
 *     the run parks before that check, the park sink's own tail check
 *     (park_sink.ts) settles it instead.
 *   • the guarded update can lose the race (the run parked or finished between
 *     our status read and the stamp attempt) — when it does, we re-read status
 *     and fall back: now-`parked` → the immediate path; terminal → no-op, the
 *     run already settled on its own.
 *
 * Tearing a parked run down takes the run's lease, so it never races a resume
 * in another process. A parked run that some process is resuming right now is
 * as good as running: it is stamped instead, and that resume's cancel gate (or
 * the park sink's tail check, should it park again) settles it.
 *
 * Reuses the cancel path rather than a dedicated `aborted` outcome: the run
 * status machine (§5.3) terminates at `failed`, and the failure_reason records
 * that the abort was operator-initiated.
 */
export async function abortRun(input: {
  runId: string;
  teamId: TeamId;
  abortedBy?: string;
}): Promise<{ runId: string }> {
  const runId = await assertOwnedRun(input.runId, input.teamId);
  const reason = input.abortedBy
    ? `Cancelled by ${input.abortedBy}`
    : 'Cancelled by an operator';

  const status = await readRunStatus(runId);

  if (status === 'running') {
    const stamped = await stampCancelRequested(runId, { reason });
    if (stamped) {
      return { runId: runId as unknown as string };
    }
    // Raced — the run moved before our guarded update landed. Re-read and
    // fall back rather than blindly failing an already-settled run.
    const racedStatus = await readRunStatus(runId);
    if (racedStatus === 'parked') await failParkedRun(runId, reason);
    // else: terminal — the run already finished on its own; no-op.
    return { runId: runId as unknown as string };
  }

  if (status === 'parked') await failParkedRun(runId, reason);
  // else: terminal (or the row vanished between the ownership check and this
  // read) — no-op, nothing left to cancel.

  return { runId: runId as unknown as string };
}

/** Fail a parked run under its lease; one being resumed elsewhere is stamped
 *  for that resume to settle. */
async function failParkedRun(runId: TriggerRunId, reason: string): Promise<void> {
  const failed = await withRunLease(runId, () => failRunAndCancelRequests({ runId, message: reason }));
  if (failed.kind === 'held') return;
  await stampCancelRequested(runId, { reason, statuses: ['running', 'parked'] });
}

/** Read the run's current status (a separate read from `assertOwnedRun` — that
 *  check only needs the id). */
async function readRunStatus(runId: TriggerRunId): Promise<string | undefined> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select('status')
    .executeTakeFirst();
  return row?.status;
}

/** Verify the run belongs to the team; return its branded id. */
async function assertOwnedRun(runId: string, teamId: TeamId): Promise<TriggerRunId> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId as TriggerRunId)
    .where('team_id', '=', teamId)
    .select('id')
    .executeTakeFirst();
  if (!row) {
    throw new MovementEngineError('MOVENG_RUNTIME', `run ${runId} not found`);
  }
  return row.id;
}
