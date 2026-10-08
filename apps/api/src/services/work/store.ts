import { sql, type QueryExecutorProvider } from 'kysely';

import type { Work } from '../../generated/kysely/automations/Work';

import { getAutomationsQb } from '../../lib/kysely';
import { claimableWorkKinds, isWorkKind, type WorkKind, type WorkRow } from './kinds';

function toWorkRow(row: Work): WorkRow {
  if (!isWorkKind(row.kind))
    throw new Error(`automations.work row ${row.id} has unknown kind '${row.kind}'`);
  return {
    id: row.id,
    teamId: row.team_id,
    kind: row.kind,
    key: row.key,
    payload: row.payload,
    dueAt: row.due_at,
    intervalMs: row.interval_ms,
    attempts: row.attempts,
    deferrals: row.deferrals,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    leaseToken: row.lease_token,
    updatedAt: row.updated_at,
  };
}

// Leases are compared with the database clock (enqueueWork's "is it leased?"),
// so they are written with it too; one clock decides.
function leaseFromNow(leaseMs: number) {
  return sql`now() + ${leaseMs}::integer * interval '1 millisecond'`;
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value ?? {})}::jsonb`;
}

// updated_at is the row's version: completeWork deletes only if it is unchanged
// since claim. JS Dates carry milliseconds, so the version is millisecond-exact
// and strictly increases even when two writes land in the same millisecond.
const FIRST_VERSION = sql`date_trunc('milliseconds', clock_timestamp())`;

function nextVersion(table: 'w' | 'work') {
  const current = sql.ref(`${table}.updated_at`);
  return sql`GREATEST(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', ${current}) + interval '1 millisecond')`;
}

export interface EnqueueWorkInput {
  kind: WorkKind;
  key: string;
  teamId?: string | null;
  payload?: unknown;
  dueAt?: Date;
}

/** Upsert by key. Against a row whose lease is live (by the database clock) the
 *  NEW due_at and payload win: a re-arm during the run, which completeWork then
 *  honours. Against an unleased row the EARLIEST due_at wins with the new payload
 *  (several leaves of one run share a key). */
export async function enqueueWork(
  input: EnqueueWorkInput,
  /** Enqueue inside a caller's transaction, so the row commits with whatever
   *  it is the work of. */
  opts: { db?: QueryExecutorProvider } = {},
): Promise<void> {
  const dueAt = input.dueAt ?? new Date();
  await sql`
    INSERT INTO automations.work (kind, key, team_id, payload, due_at, updated_at)
    VALUES (${input.kind}, ${input.key}, ${input.teamId ?? null}, ${jsonb(input.payload)}, ${dueAt}, ${FIRST_VERSION})
    ON CONFLICT (key) DO UPDATE
      SET due_at = CASE WHEN work.lease_until > now() THEN EXCLUDED.due_at ELSE LEAST(work.due_at, EXCLUDED.due_at) END,
          payload = EXCLUDED.payload,
          team_id = COALESCE(EXCLUDED.team_id, work.team_id),
          updated_at = ${nextVersion('work')}`.execute(opts.db ?? getAutomationsQb(['work']));
}

/** Upsert a self-rescheduling row (interval_ms set). Idempotent; call at boot. */
export async function ensurePeriodicWork(input: {
  kind: WorkKind;
  key: string;
  intervalMs: number;
  dueAt?: Date;
}): Promise<void> {
  const dueAt = input.dueAt ?? new Date();
  // A redeploy may change the interval; it must not push back a due_at already set.
  await sql`
    INSERT INTO automations.work (kind, key, interval_ms, due_at, updated_at)
    VALUES (${input.kind}, ${input.key}, ${input.intervalMs}, ${dueAt}, ${FIRST_VERSION})
    ON CONFLICT (key) DO UPDATE
      SET interval_ms = EXCLUDED.interval_ms, updated_at = ${nextVersion('work')}
      WHERE work.interval_ms IS DISTINCT FROM EXCLUDED.interval_ms`.execute(
    getAutomationsQb(['work']),
  );
}

/** Claim up to `limit` due rows (due_at <= now AND (lease_until IS NULL OR lease_until < now))
 *  with FOR UPDATE SKIP LOCKED, setting lease_owner/lease_until/lease_token and attempts+1.
 *  `now` drives only the due_at filter; leases live on the database clock. `teamId`
 *  narrows the claim to one tenant's rows. */
export async function claimDueWork(input: {
  owner: string;
  limit: number;
  leaseMs: number;
  now?: Date;
  teamId?: string;
}): Promise<WorkRow[]> {
  const now = input.now ?? new Date();
  const ofTeam = input.teamId === undefined ? sql`` : sql`AND team_id = ${input.teamId}::uuid`;
  // One statement so two drainers cannot race: SKIP LOCKED hands each a disjoint
  // set. MATERIALIZED fixes the locked selection before the update; as an inlined
  // IN-subquery the planner may re-evaluate it and claim more than `limit`.
  const { rows } = await sql<Work>`
    WITH c AS MATERIALIZED (
      SELECT id FROM automations.work
      WHERE due_at <= ${now} AND (lease_until IS NULL OR lease_until < now())
        AND kind = ANY(${claimableWorkKinds()}::text[])
        ${ofTeam}
      ORDER BY due_at
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE automations.work w
    SET lease_owner = ${input.owner}, lease_until = ${leaseFromNow(input.leaseMs)}, lease_token = gen_random_uuid(), attempts = attempts + 1, updated_at = ${nextVersion('w')}
    FROM c
    WHERE w.id = c.id
    RETURNING w.*`.execute(getAutomationsQb(['work']));
  return rows.map(toWorkRow);
}

// A claim is identified by its token, not its owner: one drain loop is one owner,
// so after a lapse the same owner may re-claim its own row, and the stale
// handler's calls must not touch the new claim.
function heldBy(input: { id: string; leaseToken: string }) {
  return sql`id = ${input.id} AND lease_token = ${input.leaseToken}::uuid`;
}

/** Extend lease_until for a row this claim holds. No-op (returns false) if the lease was lost. */
export async function heartbeatWork(input: {
  id: string;
  leaseToken: string;
  leaseMs: number;
}): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    UPDATE automations.work
    SET lease_until = ${leaseFromNow(input.leaseMs)}
    WHERE ${heldBy(input)}
    RETURNING id`.execute(getAutomationsQb(['work']));
  return rows.length > 0;
}

/** A one-shot row is deleted, unless it was re-armed since claim (updated_at moved
 *  past `claimedUpdatedAt`): then its lease clears and it runs again at its due_at.
 *  A periodic row (interval_ms set) clears its lease and is due at now + interval. */
export async function completeWork(input: {
  id: string;
  leaseToken: string;
  claimedUpdatedAt: Date;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const qb = getAutomationsQb(['work']);
  await sql`
    DELETE FROM automations.work
    WHERE ${heldBy(input)} AND interval_ms IS NULL
      AND updated_at = ${input.claimedUpdatedAt}`.execute(qb);
  // attempts resets so the next claim is a first run, not a recover: the re-armed
  // row is new work, and a periodic row's next tick is too.
  await sql`
    UPDATE automations.work
    SET lease_owner = NULL, lease_until = NULL, lease_token = NULL, attempts = 0, deferrals = 0,
        due_at = CASE WHEN interval_ms IS NULL THEN due_at
                      ELSE ${now}::timestamptz + interval_ms * interval '1 millisecond' END
    WHERE ${heldBy(input)}`.execute(qb);
}

/** Clear the lease so the row retries: at `dueAt` when given (backoff), else at its due_at.
 *  A re-arm since claim (updated_at moved past `claimedUpdatedAt`) wins over `dueAt`, as it
 *  does in completeWork. Not a re-arm itself, so updated_at is left alone. */
export async function releaseWork(input: {
  id: string;
  leaseToken: string;
  claimedUpdatedAt: Date;
  dueAt?: Date;
}): Promise<void> {
  const dueAt = input.dueAt ?? null;
  await sql`
    UPDATE automations.work
    SET lease_owner = NULL, lease_until = NULL, lease_token = NULL,
        due_at = CASE WHEN updated_at = ${input.claimedUpdatedAt}
                      THEN COALESCE(${dueAt}::timestamptz, due_at) ELSE due_at END
    WHERE ${heldBy(input)}`.execute(getAutomationsQb(['work']));
}

/** Release a row whose work cannot happen yet (its run is busy elsewhere):
 *  the lease clears, the claim's attempt is given back — a deferral is not an
 *  attempt, so the next claim is the same first run, never a recover — and
 *  the deferral is counted. Due at `dueAt` unless re-armed since claim, as in
 *  releaseWork. */
export async function deferWork(input: {
  id: string;
  leaseToken: string;
  claimedUpdatedAt: Date;
  dueAt: Date;
}): Promise<void> {
  await sql`
    UPDATE automations.work
    SET lease_owner = NULL, lease_until = NULL, lease_token = NULL,
        attempts = GREATEST(attempts - 1, 0), deferrals = deferrals + 1,
        due_at = CASE WHEN updated_at = ${input.claimedUpdatedAt}
                      THEN ${input.dueAt}::timestamptz ELSE due_at END
    WHERE ${heldBy(input)}`.execute(getAutomationsQb(['work']));
}

/** Delete every row of kinds this build no longer handles. Takes plain strings:
 *  a retired kind is by definition not a `WorkKind` any more. */
export async function removeRetiredWork(kinds: readonly string[]): Promise<void> {
  if (kinds.length === 0) return;
  await getAutomationsQb(['work']).deleteFrom('work').where('kind', 'in', [...kinds]).execute();
}

/** Delete by key (reconcile removes rows for triggers that went away). */
export async function removeWork(input: { key: string }): Promise<void> {
  await getAutomationsQb(['work']).deleteFrom('work').where('key', '=', input.key).execute();
}

export async function listWorkByKind(kind: WorkKind): Promise<WorkRow[]> {
  const rows = await getAutomationsQb(['work'])
    .selectFrom('work')
    .selectAll()
    .where('kind', '=', kind)
    .orderBy('due_at')
    .execute();
  return rows.map(toWorkRow);
}

/** Wait until none of the team's rows is due or leased (by the database clock),
 *  polling every `pollMs`. True once settled, false if `timeoutMs` passes first.
 *  For a door that must answer only after its rows ran, whichever drainer
 *  claimed them. */
export async function awaitTeamWorkSettled(input: {
  teamId: string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<boolean> {
  const pollMs = input.pollMs ?? 50;
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM automations.work
      WHERE team_id = ${input.teamId}::uuid
        AND (due_at <= now() OR lease_until > now())
      LIMIT 1`.execute(getAutomationsQb(['work']));
    if (rows.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
