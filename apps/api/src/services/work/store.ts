import { sql } from 'kysely';

import type { Work } from '../../generated/kysely/automations/Work';

import { getAutomationsQb } from '../../lib/kysely';
import { isWorkKind, WORK_KINDS, type WorkKind, type WorkRow } from './kinds';

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
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    updatedAt: row.updated_at,
  };
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value ?? {})}::jsonb`;
}

// updated_at is the row's version: completeWork deletes only if it is unchanged
// since claim. JS Dates carry milliseconds, so the version is millisecond-exact
// and strictly increases even when two writes land in the same millisecond.
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
export async function enqueueWork(input: EnqueueWorkInput): Promise<void> {
  const dueAt = input.dueAt ?? new Date();
  await sql`
    INSERT INTO automations.work (kind, key, team_id, payload, due_at)
    VALUES (${input.kind}, ${input.key}, ${input.teamId ?? null}, ${jsonb(input.payload)}, ${dueAt})
    ON CONFLICT (key) DO UPDATE
      SET due_at = CASE WHEN work.lease_until > now() THEN EXCLUDED.due_at ELSE LEAST(work.due_at, EXCLUDED.due_at) END,
          payload = EXCLUDED.payload,
          team_id = EXCLUDED.team_id,
          updated_at = ${nextVersion('work')}`.execute(getAutomationsQb(['work']));
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
    INSERT INTO automations.work (kind, key, interval_ms, due_at)
    VALUES (${input.kind}, ${input.key}, ${input.intervalMs}, ${dueAt})
    ON CONFLICT (key) DO UPDATE
      SET interval_ms = EXCLUDED.interval_ms, updated_at = now()
      WHERE work.interval_ms IS DISTINCT FROM EXCLUDED.interval_ms`.execute(
    getAutomationsQb(['work']),
  );
}

/** Claim up to `limit` due rows (due_at <= now AND (lease_until IS NULL OR lease_until < now))
 *  with FOR UPDATE SKIP LOCKED, setting lease_owner/lease_until and attempts+1. */
export async function claimDueWork(input: {
  owner: string;
  limit: number;
  leaseMs: number;
  now?: Date;
}): Promise<WorkRow[]> {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + input.leaseMs);
  // One statement so two drainers cannot race: SKIP LOCKED hands each a disjoint set.
  const { rows } = await sql<Work>`
    UPDATE automations.work w
    SET lease_owner = ${input.owner}, lease_until = ${leaseUntil}, attempts = attempts + 1, updated_at = ${nextVersion('w')}
    WHERE w.id IN (
      SELECT id FROM automations.work
      WHERE due_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
        AND kind = ANY(${[...WORK_KINDS]}::text[])
      ORDER BY due_at
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`.execute(getAutomationsQb(['work']));
  return rows.map(toWorkRow);
}

/** Extend lease_until for a row this owner holds. No-op (returns false) if the lease was lost. */
export async function heartbeatWork(input: {
  id: string;
  owner: string;
  leaseMs: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + input.leaseMs);
  const { rows } = await sql<{ id: string }>`
    UPDATE automations.work
    SET lease_until = ${leaseUntil}
    WHERE id = ${input.id} AND lease_owner = ${input.owner}
    RETURNING id`.execute(getAutomationsQb(['work']));
  return rows.length > 0;
}

/** A one-shot row is deleted, unless it was re-armed since claim (updated_at moved
 *  past `claimedUpdatedAt`): then its lease clears and it runs again at its due_at.
 *  A periodic row (interval_ms set) clears its lease and is due at now + interval. */
export async function completeWork(input: {
  id: string;
  owner: string;
  claimedUpdatedAt: Date;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const qb = getAutomationsQb(['work']);
  await sql`
    DELETE FROM automations.work
    WHERE id = ${input.id} AND lease_owner = ${input.owner} AND interval_ms IS NULL
      AND updated_at = ${input.claimedUpdatedAt}`.execute(qb);
  // attempts resets so the next claim is a first run, not a recover: the re-armed
  // row is new work, and a periodic row's next tick is too.
  await sql`
    UPDATE automations.work
    SET lease_owner = NULL, lease_until = NULL, attempts = 0,
        due_at = CASE WHEN interval_ms IS NULL THEN due_at
                      ELSE ${now}::timestamptz + interval_ms * interval '1 millisecond' END
    WHERE id = ${input.id} AND lease_owner = ${input.owner}`.execute(qb);
}

/** Clear the lease without rescheduling (handler threw and wants a retry at due_at). */
export async function releaseWork(input: { id: string; owner: string }): Promise<void> {
  await sql`
    UPDATE automations.work
    SET lease_owner = NULL, lease_until = NULL
    WHERE id = ${input.id} AND lease_owner = ${input.owner}`.execute(getAutomationsQb(['work']));
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
