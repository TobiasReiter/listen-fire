// The hosted product's run-host backend: the core's backend families
// (movement-engine run_host/store.ts) served from Postgres. The rules that
// read and write this state are the core's; what is written here is only how
// Postgres holds it:
//
//   parks         automations.parked_run (one row per run and address)
//   joins         automations.join_pending + join_branch_export
//   correlations  automations.adapter_await
//   leases        the lease columns of automations.trigger_run
//   work          automations.work, through work/store.ts (the drain claims
//                 it richer than the core needs, so its queries live there)
//   sources       automations.park_library_source (one row per team and hash)
//
// The run lease is a fence on every live-state write: a write that names the
// token it holds lands only while the run's lease is still that token's.
// Branded ids (a run's, a team's) are converted at this boundary only.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql, type ExpressionBuilder } from 'kysely';
import { z } from 'zod';
import { RunLeaseLost } from 'movement-engine/services/movement_engine/errors';

import type { ParkReason } from 'engine-contracts';
import type { ClaimedWork, CorrelatedAwait, LeafRow, RunHostStore } from 'movement-engine/services/run_host/store';
import type AutomationsSchema from '../../generated/kysely/automations/AutomationsSchema';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { JoinPendingFrameAddress } from '../../generated/kysely/automations/JoinPending';
import type { JoinBranchExportFrameAddress, JoinBranchExportBranchAddress } from '../../generated/kysely/automations/JoinBranchExport';
import type { ParkLibrarySourceTeamId, ParkLibrarySourceHash } from '../../generated/kysely/automations/ParkLibrarySource';

import { getAutomationsQb } from '../../lib/kysely';
import { isWorkKind } from '../work/kinds';
import { claimDueWork, completeWork, enqueueWork, releaseWork } from '../work/store';

// ── Boundary conversions ────────────────────────────────────────────────────

/** A library source's key (a team and a sha256, plain text) as the
 *  source row's key. */
function librarySourceKeyOf(teamId: string, hash: string): { team_id: ParkLibrarySourceTeamId; hash: ParkLibrarySourceHash } {
  return { team_id: teamId as ParkLibrarySourceTeamId, hash: hash as ParkLibrarySourceHash };
}

/** A run id from the core (plain text) as the run's row id. */
export function triggerRunIdOf(runId: string): TriggerRunId {
  return runId as TriggerRunId;
}

// The join tables' address columns carry codegen brands of their own.
const frameOfJoin = (address: string) => address as JoinPendingFrameAddress;
const frameOfExport = (address: string) => address as JoinBranchExportFrameAddress;
const branchOfExport = (address: string) => address as JoinBranchExportBranchAddress;

function jsonb(value: unknown) {
  return sql<unknown>`${JSON.stringify(value ?? null)}::jsonb`;
}

// ── The run lease as a fence ────────────────────────────────────────────────

type ParkedRunScope = ExpressionBuilder<Pick<AutomationsSchema, 'parked_run' | 'trigger_run'>, 'parked_run'>;

/** A `parked_run` predicate: the row's run is still leased under `token`. */
function runLeasedTo(token: string) {
  return (eb: ParkedRunScope) =>
    eb.exists(
      eb
        .selectFrom('trigger_run')
        .select('trigger_run.id')
        .whereRef('trigger_run.id', '=', 'parked_run.run_id')
        .where(leaseTokenIs(token)),
    );
}

/** The run's lease is under `token`. Compared as text: a token is opaque to
 *  the core, and one that is not a uuid (a lease this backend never handed
 *  out) holds nothing rather than failing the statement. */
function leaseTokenIs(token: string) {
  return sql<boolean>`trigger_run.lease_token::text = ${token}`;
}

/** Why a fenced write wrote nothing: the lease is another's now, or (with no
 *  lease to fence by) the run has no row to write against. */
function notWritten(runId: string, fence: string | undefined): Error {
  return fence !== undefined ? new RunLeaseLost(runId) : new Error(`run ${runId} has no trigger_run row to park on`);
}

// One process is one owner. The owner is only informational (the token
// fences), so a stable name makes the column readable.
const LEASE_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

function leaseFromNow(ttlMs: number) {
  return sql<Date>`now() + ${ttlMs}::integer * interval '1 millisecond'`;
}

// ── Leaves ──────────────────────────────────────────────────────────────────

const LeafStatus = z.enum(['parked', 'resuming']);

function leafOf(row: { address: string; park_reason: string; status: string; wake_at: Date | null }): LeafRow {
  return {
    address: row.address,
    reason: row.park_reason,
    status: LeafStatus.parse(row.status),
    wakeAt: row.wake_at === null ? null : new Date(row.wake_at).toISOString(),
  };
}

// ── Work claims ─────────────────────────────────────────────────────────────

/** A work claim's handle: the lease it took and the row version it saw, which
 *  is what tells a completion that the row was re-armed since. */
const WorkClaim = z.object({ leaseToken: z.string(), claimedUpdatedAt: z.iso.datetime() });

function claimOf(work: ClaimedWork): { id: string; leaseToken: string; claimedUpdatedAt: Date } {
  const claim = WorkClaim.parse(JSON.parse(work.claim));
  return { id: work.id, leaseToken: claim.leaseToken, claimedUpdatedAt: new Date(claim.claimedUpdatedAt) };
}

// ── The families ────────────────────────────────────────────────────────────

export const postgresRunHostStore: RunHostStore = {
  parks: {
    async putLeaf({ runId, address, reason, wakeAt, state, rewritten, fence }) {
      const run = triggerRunIdOf(runId);
      const written = await getAutomationsQb(['parked_run', 'trigger_run'])
        .insertInto('parked_run')
        .columns(['run_id', 'address', 'status', 'park_reason', 'wake_at', 'state'])
        .expression((eb) => {
          let row = eb
            .selectFrom('trigger_run')
            .select([
              'trigger_run.id as run_id',
              sql<string>`${address}::text`.as('address'),
              sql<string>`'parked'`.as('status'),
              sql<string>`${reason}::text`.as('park_reason'),
              sql<Date | null>`${wakeAt}::timestamptz`.as('wake_at'),
              jsonb(state).as('state'),
            ])
            .where('trigger_run.id', '=', run);
          if (fence !== undefined) row = row.where(leaseTokenIs(fence));
          return row;
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'address']).doUpdateSet({
            state: jsonb(state),
            status: 'parked',
            park_reason: reason,
            wake_at: wakeAt,
            // How the limit resume tells a flow that suspended again at once
            // from the one it stepped.
            ...(rewritten === true ? { updated_at: sql<Date>`now()` } : {}),
          }),
        )
        .returning('id')
        .executeTakeFirst();
      if (written === undefined) throw notWritten(runId, fence);
    },

    async claimLeaf({ runId, address, reason }) {
      let claim = getAutomationsQb(['parked_run'])
        .updateTable('parked_run')
        .set({ status: 'resuming', updated_at: sql`now()` })
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('address', '=', address)
        .where('status', '=', 'parked');
      if (reason !== undefined) claim = claim.where('park_reason', '=', reason);
      const row = await claim.returning(['state', 'park_reason']).executeTakeFirst();
      if (row === undefined) return null;
      const claimedReason: ParkReason = row.park_reason;
      return { state: row.state, reason: claimedReason };
    },

    async finishLeaf({ runId, address, fence }) {
      let finish = getAutomationsQb(['parked_run', 'trigger_run'])
        .deleteFrom('parked_run')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('address', '=', address)
        .where('status', '=', 'resuming');
      if (fence !== undefined) finish = finish.where(runLeasedTo(fence));
      await finish.execute();
    },

    async leaves({ runId, parkedOnly, reason, dueBy }) {
      let rows = getAutomationsQb(['parked_run'])
        .selectFrom('parked_run')
        .where('run_id', '=', triggerRunIdOf(runId));
      if (parkedOnly === true) rows = rows.where('status', '=', 'parked');
      if (reason !== undefined) rows = rows.where('park_reason', '=', reason);
      if (dueBy !== undefined) rows = rows.where('park_reason', '=', 'timer').where('wake_at', '<=', new Date(dueBy));
      const found = await rows
        .select(['address', 'park_reason', 'status', 'wake_at'])
        .orderBy('created_at')
        .orderBy('address')
        .execute();
      return found.map(leafOf);
    },

    async deleteLeaves({ runId, addresses }) {
      if (addresses.length === 0) return;
      await getAutomationsQb(['parked_run'])
        .deleteFrom('parked_run')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('address', 'in', [...addresses])
        .execute();
    },
  },

  joins: {
    async recordJoin({ runId, frameAddress, pending, fence }) {
      // A re-reached frame overwrites to the same deterministic count, never
      // double-counting.
      const recorded = await getAutomationsQb(['join_pending', 'trigger_run'])
        .insertInto('join_pending')
        .columns(['run_id', 'frame_address', 'pending'])
        .expression((eb) => {
          let row = eb
            .selectFrom('trigger_run')
            .select([
              'trigger_run.id as run_id',
              sql<JoinPendingFrameAddress>`${frameAddress}::text`.as('frame_address'),
              sql<number>`${pending}::integer`.as('pending'),
            ])
            .where('trigger_run.id', '=', triggerRunIdOf(runId));
          if (fence !== undefined) row = row.where(leaseTokenIs(fence));
          return row;
        })
        .onConflict((oc) => oc.columns(['run_id', 'frame_address']).doUpdateSet({ pending, updated_at: new Date() }))
        .returning('run_id')
        .executeTakeFirst();
      if (recorded === undefined) throw notWritten(runId, fence);
    },

    /**
     * The mark-closed decrement. The join row is KEPT on close with the closing
     * leaf's address in `closed_by_address`, so a closer re-scanned after a
     * crash sees its own address and re-runs the continuation; a sibling never
     * does. Each branch decrements exactly once: its decrement is claimed
     * against its own export row (written before the decrement) via
     * `decremented`, so a non-closer re-scanned between its decrement and its
     * leaf's delete never closes the frame early. Claim and decrement are one
     * transaction.
     */
    async decrementJoin({ runId, frameAddress, branchAddress, leafAddress }) {
      const run = triggerRunIdOf(runId);
      return getAutomationsQb(['join_pending', 'join_branch_export'])
        .transaction()
        .execute(async (trx) => {
          const claimed = await trx
            .updateTable('join_branch_export')
            .set({ decremented: true })
            .where('run_id', '=', run)
            .where('frame_address', '=', frameOfExport(frameAddress))
            .where('branch_address', '=', branchOfExport(branchAddress))
            .where('decremented', '=', false)
            .returning(sql<number>`1`.as('one'))
            .executeTakeFirst();
          if (claimed !== undefined) {
            const updated = await trx
              .updateTable('join_pending')
              .set((eb) => ({ pending: eb('pending', '-', 1), updated_at: new Date() }))
              .where('run_id', '=', run)
              .where('frame_address', '=', frameOfJoin(frameAddress))
              .where('pending', '>', 0)
              .returning('pending')
              .executeTakeFirst();
            if (updated !== undefined) {
              if (updated.pending > 0) return { closed: false };
              await trx
                .updateTable('join_pending')
                .set({ closed_by_address: leafAddress })
                .where('run_id', '=', run)
                .where('frame_address', '=', frameOfJoin(frameAddress))
                .execute();
              return { closed: true };
            }
            // Claimed, but another branch already closed the frame: whose close
            // it was is read below.
          }
          // Already decremented (a crash retry), or claimed after the close:
          // the frame resolved. Is the close this leaf's?
          const row = await trx
            .selectFrom('join_pending')
            .where('run_id', '=', run)
            .where('frame_address', '=', frameOfJoin(frameAddress))
            .select('closed_by_address')
            .executeTakeFirst();
          return { closed: row?.closed_by_address === leafAddress };
        });
    },

    async persistBranchExport({ runId, frameAddress, branchAddress, branchIndex, exports }) {
      // The conflict update must never touch `decremented`: a re-persist on a
      // crash retry would otherwise reset the branch's decrement claim.
      await getAutomationsQb(['join_branch_export'])
        .insertInto('join_branch_export')
        .values({
          run_id: triggerRunIdOf(runId),
          frame_address: frameOfExport(frameAddress),
          branch_address: branchOfExport(branchAddress),
          branch_index: branchIndex,
          exports: jsonb(exports),
        })
        .onConflict((oc) =>
          oc.columns(['run_id', 'frame_address', 'branch_address']).doUpdateSet({
            exports: jsonb(exports),
            branch_index: branchIndex,
            updated_at: new Date(),
          }),
        )
        .execute();
    },

    async collectBranchExports({ runId, frameAddress }) {
      const rows = await getAutomationsQb(['join_branch_export'])
        .selectFrom('join_branch_export')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('frame_address', '=', frameOfExport(frameAddress))
        .orderBy('branch_index')
        .select(['branch_address', 'branch_index', 'exports'])
        .execute();
      return rows.map((r) => ({ branchAddress: r.branch_address, branchIndex: r.branch_index, exports: r.exports }));
    },

    async hasPendingJoins({ runId }) {
      const row = await getAutomationsQb(['join_pending'])
        .selectFrom('join_pending')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('pending', '>', 0)
        .select(sql<number>`1`.as('one'))
        .executeTakeFirst();
      return row !== undefined;
    },

    async frames({ runId }) {
      const rows = await getAutomationsQb(['join_pending'])
        .selectFrom('join_pending')
        .where('run_id', '=', triggerRunIdOf(runId))
        .select('frame_address')
        .orderBy('frame_address')
        .execute();
      return rows.map((r) => r.frame_address);
    },

    async deleteFrames({ runId, frameAddresses }) {
      if (frameAddresses.length === 0) return;
      const run = triggerRunIdOf(runId);
      await getAutomationsQb(['join_pending', 'join_branch_export'])
        .transaction()
        .execute(async (trx) => {
          await trx
            .deleteFrom('join_pending')
            .where('run_id', '=', run)
            .where('frame_address', 'in', frameAddresses.map(frameOfJoin))
            .execute();
          await trx
            .deleteFrom('join_branch_export')
            .where('run_id', '=', run)
            .where('frame_address', 'in', frameAddresses.map(frameOfExport))
            .execute();
        });
    },
  },

  correlations: {
    async correlate({ runId, teamId, address, adapterType, correlationKey }) {
      await getAutomationsQb(['adapter_await'])
        .insertInto('adapter_await')
        .values({ adapter_type: adapterType, correlation_key: correlationKey, run_id: triggerRunIdOf(runId), team_id: teamId, address })
        .onConflict((oc) =>
          oc.columns(['run_id', 'address']).doUpdateSet({
            adapter_type: adapterType,
            correlation_key: correlationKey,
            updated_at: new Date(),
          }),
        )
        .execute();
    },

    async correlated({ adapterType, teamId, correlationKey }) {
      const rows = await getAutomationsQb(['adapter_await'])
        .selectFrom('adapter_await')
        .where('adapter_type', '=', adapterType)
        .where('team_id', '=', teamId)
        .where('correlation_key', '=', correlationKey)
        .select(['run_id', 'team_id', 'address'])
        .orderBy('created_at')
        .execute();
      return rows.map((r): CorrelatedAwait => ({ runId: r.run_id, teamId: r.team_id, address: r.address }));
    },

    async ofRun({ runId, adapterType }) {
      const rows = await getAutomationsQb(['adapter_await'])
        .selectFrom('adapter_await')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('adapter_type', '=', adapterType)
        .select(['run_id', 'team_id', 'address', 'correlation_key'])
        .orderBy('address')
        .execute();
      return rows.map((r) => ({ runId: r.run_id, teamId: r.team_id, address: r.address, correlationKey: r.correlation_key }));
    },

    async drop({ runId, address }) {
      await getAutomationsQb(['adapter_await'])
        .deleteFrom('adapter_await')
        .where('run_id', '=', triggerRunIdOf(runId))
        .where('address', '=', address)
        .execute();
    },

    async dropRun({ runId }) {
      await getAutomationsQb(['adapter_await']).deleteFrom('adapter_await').where('run_id', '=', triggerRunIdOf(runId)).execute();
    },
  },

  leases: {
    /** One statement: the lease is taken only while free or lapsed, and in
     *  the same statement every leaf a dead holder left claimed (`resuming`)
     *  goes back to `parked`, before anything reads the run's leaves. */
    async claim({ runId, ttlMs }) {
      const token = randomUUID();
      const { rows } = await sql<{ id: string }>`
        WITH claimed AS (
          UPDATE automations.trigger_run
          SET lease_owner = ${LEASE_OWNER}, lease_until = ${leaseFromNow(ttlMs)}, lease_token = ${token}
          WHERE id = ${runId}::uuid AND (lease_until IS NULL OR lease_until < now())
          RETURNING id
        ), returned AS (
          UPDATE automations.parked_run SET status = 'parked'
          WHERE run_id IN (SELECT id FROM claimed) AND status = 'resuming'
        )
        SELECT id FROM claimed`.execute(getAutomationsQb(['trigger_run', 'parked_run']));
      return rows.length === 0 ? null : { token };
    },

    /** Also stamps the run's heartbeat: a holder renewing is a segment alive.
     *  A lapsed lease is free for anyone to claim, and renewing it would
     *  revive it under a holder that lost it. */
    async renew({ runId, token, ttlMs }) {
      const row = await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ lease_until: leaseFromNow(ttlMs), last_heartbeat_at: sql<Date>`now()` })
        .where('id', '=', triggerRunIdOf(runId))
        .where(leaseTokenIs(token))
        .where('lease_until', '>', sql<Date>`now()`)
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    },

    async release({ runId, token }) {
      await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ lease_owner: null, lease_until: null, lease_token: null })
        .where('id', '=', triggerRunIdOf(runId))
        .where(leaseTokenIs(token))
        .execute();
    },

    async dropRunState({ runId, fence }) {
      const run = triggerRunIdOf(runId);
      return getAutomationsQb(['parked_run', 'join_pending', 'join_branch_export', 'trigger_run'])
        .transaction()
        .execute(async (trx) => {
          if (fence !== undefined) {
            // Held for the transaction: the lease cannot change hands between
            // the check and the deletes.
            const held = await trx
              .selectFrom('trigger_run')
              .where('id', '=', run)
              .where(leaseTokenIs(fence))
              .select('id')
              .forUpdate()
              .executeTakeFirst();
            if (held === undefined) return false;
          }
          await trx.deleteFrom('parked_run').where('run_id', '=', run).execute();
          await trx.deleteFrom('join_pending').where('run_id', '=', run).execute();
          await trx.deleteFrom('join_branch_export').where('run_id', '=', run).execute();
          return true;
        });
    },
  },

  work: {
    async enqueue({ kind, key, payload, dueAt, teamId }) {
      if (!isWorkKind(kind)) throw new Error(`'${kind}' is not a work kind this process knows`);
      await enqueueWork({ kind, key, payload, ...(teamId !== undefined ? { teamId } : {}), ...(dueAt !== undefined ? { dueAt: new Date(dueAt) } : {}) });
    },

    async claimDue({ limit, leaseMs, dueBy }) {
      const rows = await claimDueWork({ owner: LEASE_OWNER, limit, leaseMs, ...(dueBy !== undefined ? { now: new Date(dueBy) } : {}) });
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        key: row.key,
        payload: row.payload,
        claim: JSON.stringify({ leaseToken: row.leaseToken, claimedUpdatedAt: row.updatedAt.toISOString() }),
      }));
    },

    async complete(work) {
      await completeWork(claimOf(work));
    },

    async release(work) {
      await releaseWork({ ...claimOf(work), ...(work.dueAt !== undefined ? { dueAt: new Date(work.dueAt) } : {}) });
    },
  },

  sources: {
    async put({ teamId, hash, source }) {
      await getAutomationsQb(['park_library_source'])
        .insertInto('park_library_source')
        .values({ ...librarySourceKeyOf(teamId, hash), source })
        .onConflict((oc) => oc.columns(['team_id', 'hash']).doNothing())
        .execute();
    },

    async get({ teamId, hash }) {
      const key = librarySourceKeyOf(teamId, hash);
      const row = await getAutomationsQb(['park_library_source'])
        .selectFrom('park_library_source')
        .select('source')
        .where('team_id', '=', key.team_id)
        .where('hash', '=', key.hash)
        .executeTakeFirst();
      return row?.source ?? null;
    },
  },
};

/** The orphan sweep's half: every `resuming` leaf whose run's lease is free or
 *  lapsed was left by a dead holder, and is parked again. Returns how many. */
export async function returnLeavesOfLapsedLeases(): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    UPDATE automations.parked_run p
    SET status = 'parked'
    FROM automations.trigger_run r
    WHERE p.run_id = r.id AND p.status = 'resuming'
      AND (r.lease_until IS NULL OR r.lease_until < now())
    RETURNING p.id`.execute(getAutomationsQb(['parked_run', 'trigger_run']));
  return rows.length;
}
