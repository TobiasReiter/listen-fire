// Immutable movement source snapshots (`automations.movement_version`).
//
// Every shipped save mints a version IF the source changed —
// content-deduped by a sha256 of the text, so an idempotent re-save adds no
// row (versioning decision D1). The movement's `current_version_id` points at
// the latest minted version; a run pins THAT at start (D3,
// trigger_run.movement_version_id) and a parked run resumes by re-parsing the
// pinned version's source — never the live `movement.source`, which may have
// drifted while the run waited (P11).
//
// A version also carries the movement's LANGUAGE version when it was minted,
// so a parked run resumes under the version it started with even after the
// deploy check advances the movement's pin. A pin that moves mints a fresh
// snapshot of the same text, so new runs pin a version carrying the new one.
//
// See plans/2026-06-21-movement-versioning/1_decisions.md and
// plans/2026-06-19-async-user-interaction/ (Layer 5, the durable engine).

import { createHash, randomUUID } from 'node:crypto';

import type { LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { MovementVersionId } from '../../../generated/kysely/automations/MovementVersion';

import { getAutomationsQb } from '../../../lib/kysely';

export interface MovementVersionRow {
  id: string;
  movementId: string;
  teamId: string;
  versionNumber: number;
  source: string;
  contentHash: string;
  /** The language version runs of this snapshot compile and execute under. */
  languageVersion: LanguageVersion;
}

/** The content-address of a movement's source — the equivalence that decides
 *  whether a save mints a new version. Byte-identity is the only safe
 *  equivalence: a resume navigates the re-parsed AST by lexical address, so
 *  any text change (even whitespace) is a distinct version (D1). */
export function movementSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/**
 * Mint a new version for a movement IF its source differs from the current
 * version (by content hash) or its language version does, and repoint
 * `movement.current_version_id` at it. A no-op when both match the current
 * version — returns the existing version, `minted: false`. Called from the shipped-save path;
 * an unshipped (needsConfirmation) save mints nothing (a version is a
 * runnable snapshot).
 */
export async function mintMovementVersionIfChanged(input: {
  teamId: string;
  movementId: string;
  source: string;
  /** The movement's pin at mint time. */
  languageVersion: LanguageVersion;
}): Promise<{ versionId: string; versionNumber: number; minted: boolean }> {
  const hash = movementSourceHash(input.source);

  const movement = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('id', '=', input.movementId as MovementId)
    .select(['current_version_id'])
    .executeTakeFirst();

  if (movement?.current_version_id) {
    const current = await getAutomationsQb(['movement_version'])
      .selectFrom('movement_version')
      .where('id', '=', movement.current_version_id)
      .select(['id', 'version_number', 'content_hash', 'language_version'])
      .executeTakeFirst();
    if (
      current &&
      current.content_hash === hash &&
      current.language_version === input.languageVersion
    ) {
      return {
        versionId: current.id as unknown as string,
        versionNumber: current.version_number,
        minted: false,
      };
    }
  }

  // Next version_number = max+1 for this movement. Computed read-then-write
  // (not a SQL subquery) — saves of one movement are serial in practice (a
  // single editor), and the UNIQUE(movement_id, version_number) constraint is
  // the backstop against a rare concurrent collision.
  const existing = await getAutomationsQb(['movement_version'])
    .selectFrom('movement_version')
    .where('movement_id', '=', input.movementId as MovementId)
    .select(['version_number'])
    .execute();
  const versionNumber =
    existing.reduce((max, row) => Math.max(max, row.version_number), 0) + 1;

  const id = randomUUID() as MovementVersionId;
  await getAutomationsQb(['movement_version'])
    .insertInto('movement_version')
    .values({
      id,
      movement_id: input.movementId as MovementId,
      team_id: input.teamId as TeamId,
      version_number: versionNumber,
      source: input.source,
      content_hash: hash,
      language_version: input.languageVersion,
    })
    .execute();

  await getAutomationsQb(['movement'])
    .updateTable('movement')
    .set({ current_version_id: id })
    .where('id', '=', input.movementId as MovementId)
    .execute();

  return { versionId: id as unknown as string, versionNumber, minted: true };
}

/** Read a single version's full row (the resume path re-parses
 *  `source`). Null when the id doesn't resolve. */
export async function getMovementVersion(input: {
  id: string;
}): Promise<MovementVersionRow | null> {
  const row = await getAutomationsQb(['movement_version'])
    .selectFrom('movement_version')
    .where('id', '=', input.id as MovementVersionId)
    .select([
      'id',
      'movement_id',
      'team_id',
      'version_number',
      'source',
      'content_hash',
      'language_version',
    ])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    movementId: row.movement_id as unknown as string,
    teamId: row.team_id as unknown as string,
    versionNumber: row.version_number,
    source: row.source,
    contentHash: row.content_hash,
    languageVersion: row.language_version,
  };
}

/**
 * Re-mint the movement's current snapshot under a moved pin: same text, new
 * language version. A no-op for a movement with no snapshot yet (its first
 * clean save mints one under whatever the pin is then).
 */
export async function repinCurrentVersion(input: {
  teamId: string;
  movementId: string;
  languageVersion: LanguageVersion;
}): Promise<void> {
  const current = await getAutomationsQb(['movement', 'movement_version'])
    .selectFrom('movement')
    .innerJoin('movement_version', 'movement_version.id', 'movement.current_version_id')
    .where('movement.id', '=', input.movementId as MovementId)
    .select('movement_version.source as source')
    .executeTakeFirst();
  if (!current) return;
  await mintMovementVersionIfChanged({
    teamId: input.teamId,
    movementId: input.movementId,
    source: current.source,
    languageVersion: input.languageVersion,
  });
}

/** What a parked run re-enters: the snapshot's source (P11 — the stored
 *  addresses name THAT AST) and the language version it runs under. Null when
 *  the id doesn't resolve. */
export async function loadPinnedVersion(
  versionId: string,
): Promise<{ source: string; languageVersion: LanguageVersion } | null> {
  const row = await getAutomationsQb(['movement_version'])
    .selectFrom('movement_version')
    .where('id', '=', versionId as MovementVersionId)
    .select(['source', 'language_version'])
    .executeTakeFirst();
  return row ? { source: row.source, languageVersion: row.language_version } : null;
}

/** Which saved version a run executed, against the one that would run
 *  today. A run pins its version at start, so a firing from before the
 *  last save ran OLDER logic than the editor shows — the thing that
 *  otherwise takes a database query to notice. */
export interface ExecutedMovementVersion {
  /** The version this run executed. */
  number: number;
  /** The version a run started now would execute. */
  currentNumber: number;
  isCurrent: boolean;
}

/** Resolve a run's pinned version id into `ExecutedMovementVersion`. Null
 *  for runs that carry no pin (pre-versioning, or non-movement runs). */
export async function describeExecutedVersion(input: {
  versionId: string | null | undefined;
}): Promise<ExecutedMovementVersion | null> {
  if (!input.versionId) return null;
  const executed = await getAutomationsQb(['movement_version'])
    .selectFrom('movement_version')
    .where('id', '=', input.versionId as MovementVersionId)
    .select(['version_number', 'movement_id'])
    .executeTakeFirst();
  if (!executed) return null;

  // The movement's OWN pointer, not max(version_number) — `current` is
  // whatever new runs would pin, and only that pointer says so.
  const current = await getAutomationsQb(['movement', 'movement_version'])
    .selectFrom('movement')
    .innerJoin('movement_version', 'movement_version.id', 'movement.current_version_id')
    .where('movement.id', '=', executed.movement_id)
    .select('movement_version.version_number as current_number')
    .executeTakeFirst();
  const currentNumber = current?.current_number ?? executed.version_number;
  return {
    number: executed.version_number,
    currentNumber,
    isCurrent: executed.version_number === currentNumber,
  };
}

/** List a movement's versions, newest first (version history). */
export async function listMovementVersions(input: {
  movementId: string;
}): Promise<MovementVersionRow[]> {
  const rows = await getAutomationsQb(['movement_version'])
    .selectFrom('movement_version')
    .where('movement_id', '=', input.movementId as MovementId)
    .select([
      'id',
      'movement_id',
      'team_id',
      'version_number',
      'source',
      'content_hash',
      'language_version',
    ])
    .orderBy('version_number', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id as unknown as string,
    movementId: row.movement_id as unknown as string,
    teamId: row.team_id as unknown as string,
    versionNumber: row.version_number,
    source: row.source,
    contentHash: row.content_hash,
    languageVersion: row.language_version,
  }));
}
