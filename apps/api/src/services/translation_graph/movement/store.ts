// Text-canonical movement storage (`automations.movement`).
//
// The movement row's `source` column is THE persisted program — execution
// (dispatch and "Run now") reads this text directly through the movement
// engine (services/movement_engine/run.ts). The only derived artifacts
// are the file's LISTENER triggers — one `automations.trigger` row per
// `listen` statement, linked back via `trigger.movement_id` and named
// `movement/<file>/<movement>` (see ./provision.ts reconciliation).
// `trigger_id` on the row is a legacy first-listener convenience (null
// for library files).
//
// The row's health axis is runtime VALIDITY (`validity_*` columns) —
// whether the current source is expected to run against the adapters'
// current live shape. See plans/2026-07-13-movement-validity-lifecycle.
//
// See plans/2026-06-10-data-movement-language/6_engine.md.

import { randomUUID } from 'node:crypto';

import { CURRENT_LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';

import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { AuthoringDiagnostic } from './authoring';

import { getAutomationsQb } from '../../../lib/kysely';
import { parseRunMode, type TriggerRunMode } from '../triggers/run_mode';
import { repinCurrentVersion } from './version_store';

/** Runtime validity of the CURRENT source against the adapters' CURRENT live
 *  shape. Null = never checked.
 *  See plans/2026-07-13-movement-validity-lifecycle. */
export type MovementValidityStatus = 'valid' | 'invalid' | 'unverified';

export interface MovementRow {
  id: string;
  teamId: string;
  name: string;
  source: string;
  description: string;
  triggerId: string | null;
  /** The version a new run pins (versioning D2/D3); null until the movement's
   *  first clean save mints one. */
  currentVersionId: string | null;
  /** Runtime validity — null until the first check. `validitySourceHash` is the
   *  `movementSourceHash` of the source the status describes; the status is
   *  trustworthy only while it matches the current `source` (version-match rule). */
  validityStatus: MovementValidityStatus | null;
  validityReason: unknown;
  validitySourceHash: string | null;
  validityCheckedAt: Date | null;
  validityConsentedAt: Date | null;
  /** The language version the last validity check ran under; null until the
   *  first check since versioning. */
  validityCheckedAgainst: LanguageVersion | null;
  /** The language version this movement is written against — stamped at first
   *  save, never moved by an edit. Validation and runs of it use this. */
  languageVersion: LanguageVersion;
  /** What stands between this movement and `upgradeCheckedAgainst`: the error
   *  and warning diagnostics validating it under that version found. Null =
   *  nothing recorded (never checked, or already on that version). */
  upgradeDiagnostics: AuthoringDiagnostic[] | null;
  upgradeCheckedAgainst: LanguageVersion | null;
  createdAt: Date;
  updatedAt: Date;
}

const movementColumns = [
  'id',
  'team_id',
  'name',
  'source',
  'description',
  'trigger_id',
  'current_version_id',
  'validity_status',
  'validity_reason',
  'validity_source_hash',
  'validity_checked_at',
  'validity_consented_at',
  'validity_checked_against',
  'language_version',
  'upgrade_diagnostics',
  'upgrade_checked_against',
  'created_at',
  'updated_at',
] as const;

function toMovementRow(row: {
  id: MovementId;
  team_id: string;
  name: string;
  source: string;
  description: string;
  trigger_id: TriggerId | null;
  current_version_id: unknown;
  validity_status: string | null;
  validity_reason: unknown;
  validity_source_hash: string | null;
  validity_checked_at: Date | null;
  validity_consented_at: Date | null;
  validity_checked_against: number | null;
  language_version: number;
  upgrade_diagnostics: unknown;
  upgrade_checked_against: number | null;
  created_at: Date;
  updated_at: Date;
}): MovementRow {
  return {
    id: row.id as unknown as string,
    teamId: row.team_id,
    name: row.name,
    source: row.source,
    description: row.description,
    triggerId: (row.trigger_id as unknown as string | null) ?? null,
    currentVersionId: (row.current_version_id as string | null) ?? null,
    validityStatus: (row.validity_status as MovementValidityStatus | null) ?? null,
    validityReason: row.validity_reason ?? null,
    validitySourceHash: row.validity_source_hash ?? null,
    validityCheckedAt: row.validity_checked_at,
    validityConsentedAt: row.validity_consented_at,
    validityCheckedAgainst: row.validity_checked_against,
    languageVersion: row.language_version,
    upgradeDiagnostics: Array.isArray(row.upgrade_diagnostics)
      ? (row.upgrade_diagnostics as AuthoringDiagnostic[])
      : null,
    upgradeCheckedAgainst: row.upgrade_checked_against,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getMovementRow(input: {
  teamId: string;
  id: string;
}): Promise<MovementRow | null> {
  const row = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('team_id', '=', input.teamId)
    .where('id', '=', input.id as MovementId)
    .select(movementColumns)
    .executeTakeFirst();
  return row ? toMovementRow(row) : null;
}

export async function getMovementRowByName(input: {
  teamId: string;
  name: string;
}): Promise<MovementRow | null> {
  const row = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('team_id', '=', input.teamId)
    .where('name', '=', input.name)
    .select(movementColumns)
    .executeTakeFirst();
  return row ? toMovementRow(row) : null;
}

/** What keeps a movement off the release's current language version, as last
 *  recorded — null when it is already on it, when nothing was recorded, or
 *  when what was recorded was checked against an older current version. */
export function pendingUpgradeDiagnostics(
  row: Pick<MovementRow, 'languageVersion' | 'upgradeDiagnostics' | 'upgradeCheckedAgainst'>,
): AuthoringDiagnostic[] | null {
  if (row.languageVersion === CURRENT_LANGUAGE_VERSION) return null;
  if (row.upgradeCheckedAgainst !== CURRENT_LANGUAGE_VERSION) return null;
  return row.upgradeDiagnostics;
}

/** Every team's movements — the deploy check's sweep, oldest first. */
export async function listAllMovementRows(): Promise<MovementRow[]> {
  const rows = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .select(movementColumns)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(toMovementRow);
}

export async function listMovementRows(teamId: string): Promise<MovementRow[]> {
  const rows = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('team_id', '=', teamId)
    .select(movementColumns)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toMovementRow);
}

/**
 * Upsert the canonical source row — BEFORE any compile runs, so the text
 * is never lost to a failed compile. Keyed by `id` when provided (the
 * editor's re-save path, which may rename), else by `(team_id, name)`.
 *
 * The FIRST save stamps the movement's language version with the current
 * one; an update never touches it, so an edit keeps the movement's pin.
 */
export async function upsertMovementRow(input: {
  teamId: string;
  id?: string;
  name: string;
  source: string;
  description?: string;
  userId?: string;
}): Promise<MovementRow> {
  const qb = getAutomationsQb(['movement']);
  const existing = input.id
    ? await getMovementRow({ teamId: input.teamId, id: input.id })
    : await getMovementRowByName({ teamId: input.teamId, name: input.name });

  if (existing) {
    await qb
      .updateTable('movement')
      .set({
        name: input.name,
        source: input.source,
        ...(input.description !== undefined ? { description: input.description } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', existing.id as MovementId)
      .execute();
    const updated = await getMovementRow({ teamId: input.teamId, id: existing.id });
    if (!updated) throw new Error(`movement ${existing.id} disappeared during upsert`);
    return updated;
  }

  const id = randomUUID() as MovementId;
  await qb
    .insertInto('movement')
    .values({
      id,
      team_id: input.teamId,
      name: input.name,
      source: input.source,
      description: input.description ?? '',
      language_version: CURRENT_LANGUAGE_VERSION,
      created_by_user_id: (input.userId ?? null) as UserId | null,
    })
    .execute();
  const created = await getMovementRow({ teamId: input.teamId, id: id as unknown as string });
  if (!created) throw new Error(`movement ${id} not found after insert`);
  return created;
}

/**
 * Record the legacy first-listener link (`trigger_id`) after a shipped
 * save reconciles the file's listeners. Pass `null` to clear it (a save
 * with zero listens derives no trigger). The link is a legacy convenience:
 * the canonical trigger↔movement relation is `trigger.movement_id` (one
 * row per listen).
 */
export async function recordDerivedTriggerLink(input: {
  id: string;
  triggerId: string | null;
}): Promise<void> {
  await getAutomationsQb(['movement'])
    .updateTable('movement')
    .set({
      trigger_id: input.triggerId as TriggerId | null,
      updated_at: new Date(),
    })
    .where('id', '=', input.id as MovementId)
    .execute();
}

/**
 * Record the runtime validity outcome on the movement row. `sourceHash`
 * stamps the source the status describes (the version-match key): a later
 * run only trusts
 * this status while `sourceHash` still equals `movementSourceHash(source)`.
 * Pass `consentedAt` when a non-`valid` save was shipped on explicit consent.
 */
export async function recordValidityOutcome(input: {
  id: string;
  status: MovementValidityStatus;
  reason: unknown;
  sourceHash: string;
  /** The language version the validation ran under. */
  checkedAgainst: LanguageVersion;
  consentedAt?: Date | null;
}): Promise<void> {
  await getAutomationsQb(['movement'])
    .updateTable('movement')
    .set({
      validity_status: input.status,
      validity_reason: (input.reason ?? null) as never,
      validity_source_hash: input.sourceHash,
      validity_checked_at: new Date(),
      validity_checked_against: input.checkedAgainst,
      ...(input.consentedAt !== undefined ? { validity_consented_at: input.consentedAt } : {}),
      updated_at: new Date(),
    })
    .where('id', '=', input.id as MovementId)
    .execute();
}

/** Record what validating a movement under `checkedAgainst` (a version newer
 *  than its pin) found — only its errors and warnings, the diagnostics that
 *  keep the pin where it is. An empty list is stored as nothing. */
export async function recordUpgradeCheck(input: {
  id: string;
  diagnostics: AuthoringDiagnostic[];
  checkedAgainst: LanguageVersion;
}): Promise<void> {
  await getAutomationsQb(['movement'])
    .updateTable('movement')
    .set({
      // A JS array would reach Postgres as an ARRAY literal, not JSON.
      upgrade_diagnostics:
        input.diagnostics.length > 0 ? JSON.stringify(input.diagnostics) : null,
      upgrade_checked_against: input.checkedAgainst,
      updated_at: new Date(),
    })
    .where('id', '=', input.id as MovementId)
    .execute();
}

/**
 * Move a movement's pin — the deploy check's auto-advance or an explicit
 * upgrade, never an edit. Clears what stood in the way, and re-mints the
 * movement's current snapshot under the new version so new runs pin it while
 * parked ones keep the version they started with.
 */
export async function advanceMovementLanguageVersion(input: {
  teamId: string;
  id: string;
  to: LanguageVersion;
}): Promise<void> {
  await getAutomationsQb(['movement'])
    .updateTable('movement')
    .set({
      language_version: input.to,
      upgrade_diagnostics: null,
      upgrade_checked_against: input.to,
      updated_at: new Date(),
    })
    .where('team_id', '=', input.teamId)
    .where('id', '=', input.id as MovementId)
    .execute();
  await repinCurrentVersion({ teamId: input.teamId, movementId: input.id, languageVersion: input.to });
}

export async function deleteMovementRow(input: { teamId: string; id: string }): Promise<void> {
  await getAutomationsQb(['movement'])
    .deleteFrom('movement')
    .where('team_id', '=', input.teamId)
    .where('id', '=', input.id as MovementId)
    .execute();
}

// ── Derived listener rows (trigger.movement_id → this movement) ────────────
//
// One `automations.trigger` row per `listen` statement, reconciled on every
// clean save (see ./provision.ts). These helpers are the reading side.

export interface DerivedTriggerRow {
  id: string;
  movementId: string;
  name: string;
  /** The movement this trigger's `listen … fire <name>` clause runs — the
   *  datum dispatch hands the engine to pick the movement in a multi-movement
   *  file. Null on legacy/single-movement rows. */
  firedMovementName: string | null;
  kind: string;
  credentialsId: string | null;
  config: Record<string, unknown>;
  /** The listen's resolved address (position path + config hops, names→ids) —
   *  DERIVED at provisioning, separate from the authored `config`. Undefined on
   *  legacy rows and on adapters that declare no address hops. */
  resolvedAddress?: Record<string, string>;
  runMode: TriggerRunMode;
}

const derivedTriggerColumns = [
  'id',
  'movement_id',
  'name',
  'fired_movement_name',
  'kind',
  'credentials_id',
  'config',
  'resolved_address',
  'run_mode',
] as const;

function toDerivedTriggerRow(row: {
  id: TriggerId;
  movement_id: MovementId | null;
  name: string;
  fired_movement_name: string | null;
  kind: string;
  credentials_id: unknown;
  config: unknown;
  resolved_address: unknown;
  run_mode: string;
}): DerivedTriggerRow {
  const resolvedAddress = stringRecordOf(row.resolved_address);
  return {
    id: row.id as unknown as string,
    movementId: row.movement_id as unknown as string,
    name: row.name,
    firedMovementName: row.fired_movement_name ?? null,
    kind: row.kind,
    credentialsId: (row.credentials_id as string | null) ?? null,
    config: configRecordOf(row.config),
    ...(resolvedAddress !== undefined ? { resolvedAddress } : {}),
    runMode: parseRunMode(row.run_mode),
  };
}

/** A jsonb cell → a flat string map, or undefined (null cell / malformed). */
function stringRecordOf(value: unknown): Record<string, string> | undefined {
  const record = configRecordOf(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'string') return undefined;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function configRecordOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listDerivedTriggerRows(movementId: string): Promise<DerivedTriggerRow[]> {
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', '=', movementId as MovementId)
    .select(derivedTriggerColumns)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(toDerivedTriggerRow);
}

export async function listDerivedTriggerRowsForMovements(
  movementIds: string[],
): Promise<Map<string, DerivedTriggerRow[]>> {
  const result = new Map<string, DerivedTriggerRow[]>();
  if (movementIds.length === 0) return result;
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', 'in', movementIds as MovementId[])
    .select(derivedTriggerColumns)
    .orderBy('created_at', 'asc')
    .execute();
  for (const raw of rows) {
    const row = toDerivedTriggerRow(raw);
    const list = result.get(row.movementId) ?? [];
    list.push(row);
    result.set(row.movementId, list);
  }
  return result;
}

/** One listener in this team that fires a movement of a given name, and the
 *  file it belongs to. */
export interface ListenerFiringMovementName {
  /** The movement ROW (the file) whose listener this is. */
  movementId: string;
  /** That file's display name. */
  movementFileName: string;
  /** The movement name it fires — one of the queried names. */
  firedMovementName: string;
  runMode: TriggerRunMode;
}

/**
 * Which of this team's listeners fire a movement under one of `movementNames`.
 *
 * A movement name is unique only WITHIN its file — trigger identity is
 * `movement/<file>/<movement>` — so two files can each declare `notify` and
 * each keeps its own listener. The trigger table is therefore the team's
 * INDEX of which file currently fires which movement name, and this is the
 * lookup that answers "is someone else already running this name?".
 *
 * Two team/id-indexed reads (`trigger_team_id_idx`, then the movement rows by
 * primary key) — never a scan of the other files' sources.
 */
export async function listenersFiringMovementNames(input: {
  teamId: string;
  movementNames: string[];
  /** The movement doing the asking — its own listeners are not a collision. */
  excludeMovementId?: string;
}): Promise<ListenerFiringMovementName[]> {
  if (input.movementNames.length === 0) return [];
  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', input.teamId as never)
    .where('fired_movement_name', 'in', input.movementNames)
    .select(['movement_id', 'fired_movement_name', 'run_mode'])
    .execute();

  const foreign = triggers.filter((row) => {
    const movementId = row.movement_id as unknown as string | null;
    return movementId !== null && movementId !== input.excludeMovementId;
  });
  if (foreign.length === 0) return [];

  const fileNames = await movementNamesByIds([
    ...new Set(foreign.map((row) => row.movement_id as unknown as string)),
  ]);
  return foreign.flatMap((row) => {
    const movementId = row.movement_id as unknown as string;
    const movementFileName = fileNames.get(movementId);
    const firedMovementName = row.fired_movement_name;
    // A trigger whose movement row vanished is an orphan, not a collision.
    if (movementFileName === undefined || firedMovementName === null) return [];
    return [
      {
        movementId,
        movementFileName,
        firedMovementName,
        runMode: parseRunMode(row.run_mode),
      },
    ];
  });
}

/** Display names for movement rows, by primary key. */
export async function movementNamesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('id', 'in', ids as MovementId[])
    .select(['id', 'name'])
    .execute();
  return new Map(rows.map((row) => [row.id as unknown as string, row.name]));
}

// `setTriggerRunMode` was here. run_mode has no writer outside the
// movement-text reconciliation in provision.ts: the dry_run⇄live axis is
// derived from the script on every save, and the operator pause that owned
// `off` is retired in favour of commenting the `listen` line out.
// See triggers/run_mode.ts.
