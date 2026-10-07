// The per-frame pending-count completion mechanism (async user interaction §5.4,
// chunk 3.2b). A parallel / fan-out JOIN frame holds a count of its unresolved
// child branches; resolving a child is the atomic
//   UPDATE join_pending SET pending = pending - 1 … RETURNING pending
// and the decrement that returns 0 is the UNIQUE, race-free completer (no
// read-then-claim, no separate marker — the counter IS the claim). The completer
// deletes the row, hoists the join, and runs the enclosing sequence forward,
// which may complete the parent frame and decrement ITS join, cascading up.
//
// This dissolves "join completion" into the decrement: "am I the last child?" is
// answered by the row-level UPDATE, so two siblings answered in the same window
// never both complete the join. A leaf with no enclosing join (a single linear
// ask) has no row — `decrementJoin` is never called for it; it completes directly.

import { sql } from 'kysely';
import { getAutomationsQb, getQb } from '../../lib/kysely';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

/** The outcome of decrementing a join's pending-count. */
export interface JoinDecrement {
  /** True when this decrement took the count to 0 — this caller is the unique
   *  completer (the row was deleted). The caller hoists the join + runs the
   *  enclosing sequence forward. */
  completed: boolean;
  /** The pending count AFTER the decrement (0 when completed). */
  pending: number;
}

/**
 * Atomically decrement a join frame's pending-count by one (§5.4). Returns
 * `completed: true` exactly once — for the decrement that reaches 0 — and deletes
 * the row in the same transaction so the completion can't fire twice. A missing
 * row (no such join — the leaf had no enclosing join, or a prior crash already
 * completed it) returns `completed: false, pending: 0` so the caller treats it as
 * "nothing to wait on" (a directly-completing leaf).
 */
// superseded by decrementJoinClose (§6.4); no prod callers after the
// resume-unwind switch — retire in cleanup.
export async function decrementJoin(input: {
  runId: TriggerRunId;
  frameAddress: string;
}): Promise<JoinDecrement> {
  return getAutomationsQb(['join_pending'])
    .transaction()
    .execute(async (trx) => {
      // The race-free completer: one UPDATE … RETURNING pending. Row-level lock
      // serialises concurrent decrements; exactly one observes 0.
      const updated = await trx
        .updateTable('join_pending')
        .set((eb) => ({ pending: eb('pending', '-', 1), updated_at: new Date() }))
        .where('run_id', '=', input.runId)
        .where('frame_address', '=', input.frameAddress as never)
        .where('pending', '>', 0)
        .returning('pending')
        .executeTakeFirst();

      if (updated === undefined) {
        // No row (or already at 0) — nothing to wait on.
        return { completed: false, pending: 0 };
      }
      if (updated.pending === 0) {
        await trx
          .deleteFrom('join_pending')
          .where('run_id', '=', input.runId)
          .where('frame_address', '=', input.frameAddress as never)
          .execute();
        return { completed: true, pending: 0 };
      }
      return { completed: false, pending: updated.pending };
    });
}

/**
 * The mark-closed decrement (design §6.4) — the engine-side replacement for
 * `decrementJoin` used by the resume unwind. Unlike the delete-on-zero
 * `decrementJoin` above, this KEEPS the join_pending row on close and marks the
 * closing leaf's address in `closed_by_address`, so the closer is durably
 * identifiable across a crash (§7): the closer re-scanned after a crash sees its
 * own address and re-runs the continuation; a sibling never does.
 *
 * Per-leaf EXACTLY-ONCE (§7 residual, now CLOSED). Each branch's decrement is
 * claimed atomically against its own `join_branch_export` row (written
 * persist-before-decrement, run.ts) via `decremented = true`. A non-closer
 * re-scanned in the crash window between its decrement and its `parked_run`
 * delete would otherwise decrement the join a SECOND time → close it EARLY (the
 * closer folds an incomplete aggregate; the genuinely-last sibling hits a closed
 * join and loses its export + continuation). The claim guards against exactly
 * that: only the FIRST decrement per branch touches the pending count.
 *
 * In one transaction:
 *  - CLAIM: `UPDATE join_branch_export SET decremented = true WHERE … AND
 *    branch_address = :branchAddress AND decremented = false RETURNING 1`.
 *  - if CLAIMED (first time for this branch) → the existing decrement logic:
 *    `UPDATE join_pending … pending - 1 … WHERE pending > 0 RETURNING pending`;
 *    reached 0 → mark `closed_by_address` (row retained) → `{ closed: true }`;
 *    still > 0 → `{ closed: false }`.
 *  - if NOT claimed (already decremented on a prior run — crash retry) → DO NOT
 *    decrement again; re-scan `closed_by_address`: the re-scanned closer (its own
 *    address) ⇒ `{ closed: true }`; a sibling / missing row ⇒ `{ closed: false }`.
 *
 * The claim requires the export row to exist first — it always does
 * (persist-before-decrement, run.ts unwindSpine). Claim + decrement are in one
 * transaction so they are atomic together.
 */
export async function decrementJoinClose(input: {
  runId: TriggerRunId;
  frameAddress: string;
  branchAddress: string;
  leafAddress: string;
}): Promise<{ closed: boolean }> {
  return getAutomationsQb(['join_pending', 'join_branch_export'])
    .transaction()
    .execute(async (trx) => {
      // Per-leaf exactly-once claim: atomically flip THIS branch's export row
      // from decremented=false to true. A row is returned only the FIRST time
      // this branch decrements; a crash-retry re-scan finds decremented already
      // true → no row → we must NOT decrement the join again.
      const claimed = await trx
        .updateTable('join_branch_export')
        .set({ decremented: true })
        .where('run_id', '=', input.runId)
        .where('frame_address', '=', input.frameAddress as never)
        .where('branch_address', '=', input.branchAddress as never)
        .where('decremented', '=', false)
        .returning(sql<number>`1`.as('one'))
        .executeTakeFirst();

      if (claimed !== undefined) {
        // First decrement for this branch — do the real pending decrement.
        const updated = await trx
          .updateTable('join_pending')
          .set((eb) => ({ pending: eb('pending', '-', 1), updated_at: new Date() }))
          .where('run_id', '=', input.runId)
          .where('frame_address', '=', input.frameAddress as never)
          .where('pending', '>', 0)
          .returning('pending')
          .executeTakeFirst();

        if (updated !== undefined) {
          if (updated.pending === 0) {
            // Mark the closer — do NOT delete the row (crash-safe closer identity).
            await trx
              .updateTable('join_pending')
              .set({ closed_by_address: input.leafAddress })
              .where('run_id', '=', input.runId)
              .where('frame_address', '=', input.frameAddress as never)
              .execute();
            return { closed: true };
          }
          return { closed: false };
        }
        // Claimed but pending already 0 (frame closed by another branch first) —
        // fall through to the closer-identity read below.
      }

      // Not claimed (already decremented — crash retry), or claimed-after-close:
      // the frame already resolved. Is it MY close?
      const row = await trx
        .selectFrom('join_pending')
        .where('run_id', '=', input.runId)
        .where('frame_address', '=', input.frameAddress as never)
        .select('closed_by_address')
        .executeTakeFirst();
      return { closed: row?.closed_by_address === input.leafAddress };
    });
}

/** Persist one COMPLETED branch's export contribution at its join frame (§12.1).
 *  UPSERT on (run_id, frame_address, branch_address) — idempotent under the
 *  at-least-once resume retry (a re-scanned branch re-writes the same row). The
 *  closer folds every branch's row into the parent aggregate at close (§12.4).
 *
 *  CRITICAL: the ON CONFLICT set-list updates `exports` / `branch_index` /
 *  `updated_at` only — it MUST NOT touch `decremented`. That column is the
 *  per-leaf exactly-once decrement claim (decrementJoinClose); a re-persist on a
 *  crash-retry must never reset an already-taken claim, or the branch would
 *  decrement the join a second time. */
export async function persistBranchExport(input: {
  runId: TriggerRunId;
  frameAddress: string;
  branchAddress: string;
  branchIndex: number;
  exports: unknown;
}): Promise<void> {
  await getAutomationsQb(['join_branch_export'])
    .insertInto('join_branch_export')
    .values({
      run_id: input.runId,
      frame_address: input.frameAddress as never,
      branch_address: input.branchAddress as never,
      branch_index: input.branchIndex,
      exports: jsonb(input.exports),
    })
    .onConflict((oc) =>
      oc.columns(['run_id', 'frame_address', 'branch_address']).doUpdateSet({
        exports: jsonb(input.exports),
        branch_index: input.branchIndex,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** Collect every persisted branch export for a join frame, ordered by
 *  `branch_index` (§12.4) — the deterministic fold order the closer uses to
 *  reconstruct the parent aggregate. */
export async function collectBranchExports(input: {
  runId: TriggerRunId;
  frameAddress: string;
}): Promise<Array<{ branchAddress: string; branchIndex: number; exports: unknown }>> {
  const rows = await getAutomationsQb(['join_branch_export'])
    .selectFrom('join_branch_export')
    .where('run_id', '=', input.runId)
    .where('frame_address', '=', input.frameAddress as never)
    .orderBy('branch_index')
    .select(['branch_address', 'branch_index', 'exports'])
    .execute();
  return rows.map((r) => ({
    branchAddress: r.branch_address,
    branchIndex: r.branch_index,
    exports: r.exports,
  }));
}

/** Whether a run still has any pending join (a parked spine) — used by settle to
 *  decide the run is fully complete only when no join is waiting. A CLOSED frame
 *  (pending 0, `closed_by_address` set) no longer counts as waiting (§6.4). */
export async function runHasPendingJoins(runId: TriggerRunId): Promise<boolean> {
  const row = await getAutomationsQb(['join_pending'])
    .selectFrom('join_pending')
    .where('run_id', '=', runId)
    .where('pending', '>', 0)
    .select(sql<number>`1`.as('one'))
    .executeTakeFirst();
  return row !== undefined;
}

/** Drop every pending-count AND every branch export for a run (run failure /
 *  completion cleanup — live state, not history). Given the run lease's
 *  token, only while the lease is still that token's: a holder whose lease
 *  lapsed must not clear the new holder's joins. */
export async function clearJoins(runId: TriggerRunId, opts: { leaseToken?: string } = {}): Promise<void> {
  const { leaseToken } = opts;
  await getAutomationsQb(['join_pending', 'join_branch_export', 'trigger_run'])
    .transaction()
    .execute(async (trx) => {
      if (leaseToken !== undefined) {
        // Held for the transaction: the lease cannot change hands between
        // the check and the deletes.
        const held = await trx
          .selectFrom('trigger_run')
          .where('id', '=', runId)
          .where('lease_token', '=', leaseToken)
          .select('id')
          .forUpdate()
          .executeTakeFirst();
        if (held === undefined) return;
      }
      await trx.deleteFrom('join_pending').where('run_id', '=', runId).execute();
      await trx.deleteFrom('join_branch_export').where('run_id', '=', runId).execute();
    });
}

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}
