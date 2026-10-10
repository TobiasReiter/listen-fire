// Moving a movement's language version pin — the only two ways it moves.
//
//   1. THE DEPLOY CHECK, once per release, over every team's movements
//      (`runDeployCheck`). Each movement is validated under its own pin, which
//      must pass (the release preserves every supported version's behaviour, so
//      a failure there is a bug in that preservation), then under the release's
//      current version. Clean there — no errors, and no diagnostic the checker
//      raised because the check is a move up (one marking a construct whose
//      meaning changed) — advances the pin. Any other warning (a cost note,
//      say) reads the same under either version: it is printed as a note and
//      never blocks. Anything else keeps the pin, stores what stood in the way
//      on the movement, and tells the team through a `Validation Issue`.
//   2. AN EXPLICIT UPGRADE of one movement (`upgradeMovement`): the same
//      validation under the current version, shown to the caller first; the pin
//      moves only when the caller acknowledges a clean result.
//
// An edit or re-save never moves the pin (store.ts).
//
// See plans/language-versioning-2026-09-29/1_design.md, "Deploy check".

import {
  CURRENT_LANGUAGE_VERSION,
  THIS_RELEASE,
  before,
  describeLanguageVersion,
  languageVersionDiagnostic,
  languageVersionStanding,
  languageVersionView,
  type LanguageRelease,
  type LanguageVersion,
  type LanguageVersionView,
} from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from '../../logger';
import {
  automationUrl,
  automationsUrl,
  recordSystemEvent,
} from '../adapters/system/events';
import {
  DEPRECATED_VERSION,
  RELEASE_APPLIED,
  VALIDATION_ISSUE,
  type SystemEventKind,
  type SystemEventPayload,
} from '../adapters/system/types';
import {
  assessMovementValidity,
  validateMovementForTeam,
  type AuthoringDiagnostic,
  type TeamMovementValidation,
} from './authoring';
import { withTeamContext } from './firing_context';
import {
  advanceMovementLanguageVersion,
  getMovementRow,
  listAllMovementRows,
  recordUpgradeCheck,
  recordValidityOutcome,
  type MovementRow,
} from './store';
import { movementSourceHash } from './version_store';

// ── What a validation says about a pin ──────────────────────────────────────

/** The diagnostics that keep a pin where it is: errors, and the ones the
 *  checker tagged as marking a construct whose meaning changed between the
 *  versions. Any other warning or info says nothing about the move. */
export function blockingDiagnostics(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error' || d.upgrade === true);
}

/** What `upgradeMovement` refuses outright. A move-up warning is not here: the
 *  deploy check holds the pin on it (nothing advances behind the author's
 *  back), but it fires on every use of a construct whose meaning changed
 *  whether or not the author edits, so the explicit upgrade lets the author
 *  acknowledge it, or the pin could never move. */
function hardErrors(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}

/** The warnings under the newer version that do NOT block the move — shown
 *  beside the outcome so nothing is hidden, never stored as upgrade
 *  diagnostics. */
function noteDiagnostics(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'warning' && d.upgrade !== true);
}

function errorsOf(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}

/** The validation seam the check and the upgrade share — the real one checks
 *  against the team's live catalog. `upgradingFrom` is set exactly when this
 *  is an UPGRADE check (see `validationUnder`). */
export type ValidateUnder = (input: {
  movement: MovementRow;
  languageVersion: LanguageVersion;
  upgradingFrom?: LanguageVersion;
}) => Promise<Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>>;

/** A validation of `movement` under `languageVersion`. A version newer than
 *  the movement's pin makes it an UPGRADE check: the checker is told the pin
 *  and then also warns on the constructs whose meaning changed between the
 *  two — which is what keeps an unsafe pin from advancing. A check under the
 *  pin itself is an ordinary one. */
export function validationUnder(
  movement: MovementRow,
  languageVersion: LanguageVersion,
): Parameters<ValidateUnder>[0] {
  return before(movement.languageVersion, languageVersion)
    ? { movement, languageVersion, upgradingFrom: movement.languageVersion }
    : { movement, languageVersion };
}

/** At most this many diagnostics are spelled out in an event's reason; the
 *  automation's page shows them all. */
const REASON_DIAGNOSTICS = 5;

function diagnosticsText(diagnostics: AuthoringDiagnostic[]): string {
  const shown = diagnostics
    .slice(0, REASON_DIAGNOSTICS)
    .map((d) => `line ${d.line}: ${d.message}`)
    .join('; ');
  const more = diagnostics.length - REASON_DIAGNOSTICS;
  return more > 0 ? `${shown}; and ${more} more` : shown;
}

// ── The deploy check ─────────────────────────────────────────────────────────

/** What the check did with one movement. */
export type DeployCheckOutcome =
  /** Clean under the current version: the pin moved to it. */
  | 'advanced'
  /** Already on the current version, and validates under it. */
  | 'current'
  /** Validates under its pin but not cleanly under the current version: the
   *  pin stays, the diagnostics are stored, a `Validation Issue` is emitted. */
  | 'warned'
  /** Does not validate under its own pin — the release failed to preserve that
   *  version's behaviour. Logged loudly; the pin stays. */
  | 'refused'
  /** Could not be checked (a connected system could not be read, or the check
   *  itself failed): the pin stays and nothing is claimed. */
  | 'unverified';

export const DEPLOY_CHECK_OUTCOMES: readonly DeployCheckOutcome[] = [
  'advanced',
  'current',
  'warned',
  'refused',
  'unverified',
];

export interface DeployCheckEntry {
  id: string;
  teamId: string;
  name: string;
  outcome: DeployCheckOutcome;
  /** The pin before the check. */
  from: LanguageVersionView;
  /** The pin after it. */
  to: LanguageVersionView;
  /** Whether the pin (after the check) is one the release deprecates. */
  deprecated: boolean;
  /** Why it did not advance: the blocking diagnostics, or what went wrong. */
  detail: string;
  /** Warnings under the current version that did not block the move. Absent
   *  when there were none (and on summaries recorded before v0.8.1). */
  notes?: string;
}

export interface DeployCheckSummary {
  release: string;
  languageRelease: string;
  current: LanguageVersionView;
  ranAt: string;
  counts: Record<DeployCheckOutcome, number>;
  automations: DeployCheckEntry[];
}

/** The release a check ran for: the release tag AND the language versions it
 *  declares, so an untagged build (`dev`) that changes the language is swept
 *  again rather than taken for one already done. */
export interface DeployCheckRelease {
  tag: string;
  language: LanguageRelease;
}

export function languageReleaseKey(release: LanguageRelease): string {
  const list = (set: ReadonlySet<LanguageVersion>) => [...set].sort((a, b) => a - b).join(',');
  return `current=${release.current};supported=${list(release.supported)};deprecated=${list(release.deprecated)}`;
}

export interface DeployCheckDeps {
  release: DeployCheckRelease;
  /** Whether a check already ran for this release. */
  alreadyRan(input: { tag: string; languageRelease: string }): Promise<boolean>;
  listMovements(): Promise<MovementRow[]>;
  validate: ValidateUnder;
  /** The content hash validity records name their source by. */
  sourceHash(source: string): string;
  /** Store a validation as the movement's validity under `checkedAgainst`. */
  recordValidity(input: {
    movement: MovementRow;
    validation: Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>;
    checkedAgainst: LanguageVersion;
  }): Promise<void>;
  recordUpgradeCheck(input: {
    movement: MovementRow;
    diagnostics: AuthoringDiagnostic[];
    checkedAgainst: LanguageVersion;
  }): Promise<void>;
  advance(input: { movement: MovementRow; to: LanguageVersion }): Promise<void>;
  emit(input: { teamId: string; kind: SystemEventKind; payload: SystemEventPayload }): Promise<void>;
  /** Record the run — what makes a second run on this release a no-op. */
  recordRun(input: { tag: string; languageRelease: string; summary: DeployCheckSummary }): Promise<void>;
  now(): Date;
}

/**
 * Sweep every saved movement once for this release. Returns null when this
 * release was already swept. Never throws for one movement's sake: a movement
 * the check cannot finish is `unverified`, and the sweep goes on.
 */
export async function runDeployCheck(deps: DeployCheckDeps): Promise<DeployCheckSummary | null> {
  const { release } = deps;
  const languageRelease = languageReleaseKey(release.language);
  if (await deps.alreadyRan({ tag: release.tag, languageRelease })) return null;

  const at = deps.now().toISOString();
  const current = release.language.current;
  const entries: DeployCheckEntry[] = [];

  for (const movement of await deps.listMovements()) {
    let entry: DeployCheckEntry;
    try {
      entry = await checkOne({ deps, movement, current, at });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[DeployCheck] could not check an automation — its pin stays', {
        movementId: movement.id,
        teamId: movement.teamId,
        error: message,
      });
      entry = entryFor(movement, 'unverified', movement.languageVersion, release.language, message);
    }
    entries.push(entry);
  }

  const summary: DeployCheckSummary = {
    release: release.tag,
    languageRelease,
    current: languageVersionView(current),
    ranAt: at,
    counts: countOutcomes(entries),
    automations: entries,
  };

  // One per workspace that has automations — a listener lives in a team, and
  // a team is told only about its own.
  for (const teamId of [...new Set(entries.map((e) => e.teamId))]) {
    const counts = countOutcomes(entries.filter((e) => e.teamId === teamId));
    await emitSafely(deps, () => ({
      teamId,
      kind: RELEASE_APPLIED,
      payload: {
        automation: '',
        automationId: '',
        runId: '',
        version: summary.current.name,
        reason: releaseAppliedReason(release.tag, current, counts),
        url: automationsUrl(),
        at,
      },
    }));
  }

  await deps.recordRun({ tag: release.tag, languageRelease, summary });
  return summary;
}

async function checkOne(input: {
  deps: DeployCheckDeps;
  movement: MovementRow;
  current: LanguageVersion;
  at: string;
}): Promise<DeployCheckEntry> {
  const { deps, movement, current, at } = input;
  const releaseLanguage = deps.release.language;
  const pin = movement.languageVersion;

  // (a) Under its own pin — what it runs as today. It must pass.
  const underPin = await deps.validate(validationUnder(movement, pin));
  await deps.recordValidity({ movement, validation: underPin, checkedAgainst: pin });
  const pinErrors = errorsOf(underPin.diagnostics);
  if (pinErrors.length > 0) {
    // Text already recorded as failing under this same version was broken
    // before the release (saved with errors, or a connected system changed
    // shape) — the release preserved it faithfully. Anything else is a
    // release that failed to preserve a version's behaviour.
    const alreadyFailing =
      movement.validityStatus === 'invalid' &&
      movement.validityCheckedAgainst === pin &&
      movement.validitySourceHash === deps.sourceHash(movement.source);
    const log = {
      movementId: movement.id,
      teamId: movement.teamId,
      name: movement.name,
      languageVersion: pin,
      diagnostics: pinErrors,
    };
    if (alreadyFailing) {
      logger.warn('[DeployCheck] an automation that already failed validation still does', log);
    } else {
      logger.error(
        '[DeployCheck] PRESERVATION FAILURE: an automation no longer validates under its own language version',
        log,
      );
    }
    const detail = `${alreadyFailing ? 'already failing before this release: ' : ''}${diagnosticsText(pinErrors)}`;
    await emitSafely(deps, () => ({
      teamId: movement.teamId,
      kind: VALIDATION_ISSUE,
      payload: payloadFor(movement, pin, at, {
        reason:
          `Does not validate under its own language version ${describeLanguageVersion(pin)} ` +
          `after release ${deps.release.tag}: ${detail}`,
      }),
    }));
    await emitDeprecation(deps, movement, pin, at);
    return entryFor(movement, 'refused', pin, releaseLanguage, detail);
  }

  if (pin === current) {
    if (underPin.gaps.length > 0) {
      return entryFor(movement, 'unverified', pin, releaseLanguage, gapsText(underPin.gaps));
    }
    return entryFor(movement, 'current', pin, releaseLanguage, '');
  }

  // (b) Under the current version — whether the pin may move.
  const underCurrent = await deps.validate(validationUnder(movement, current));
  const blocking = blockingDiagnostics(underCurrent.diagnostics);
  await deps.recordUpgradeCheck({ movement, diagnostics: blocking, checkedAgainst: current });
  const notes = noteDiagnostics(underCurrent.diagnostics);
  const withNotes = (entry: DeployCheckEntry): DeployCheckEntry =>
    notes.length > 0 ? { ...entry, notes: diagnosticsText(notes) } : entry;

  if (blocking.length > 0) {
    const detail = diagnosticsText(blocking);
    await emitSafely(deps, () => ({
      teamId: movement.teamId,
      kind: VALIDATION_ISSUE,
      payload: payloadFor(movement, pin, at, {
        reason:
          `Stays on ${describeLanguageVersion(pin)}: under ${describeLanguageVersion(current)} ` +
          `it reports ${detail}`,
      }),
    }));
    await emitDeprecation(deps, movement, pin, at);
    return withNotes(entryFor(movement, 'warned', pin, releaseLanguage, detail));
  }
  if (underCurrent.gaps.length > 0) {
    await emitDeprecation(deps, movement, pin, at);
    return withNotes(entryFor(movement, 'unverified', pin, releaseLanguage, gapsText(underCurrent.gaps)));
  }

  await deps.advance({ movement, to: current });
  await deps.recordValidity({ movement, validation: underCurrent, checkedAgainst: current });
  await emitDeprecation(deps, movement, current, at);
  return withNotes(entryFor(movement, 'advanced', current, releaseLanguage, ''));
}

/** A movement left on a deprecated version is told so, once per release. */
async function emitDeprecation(
  deps: DeployCheckDeps,
  movement: MovementRow,
  version: LanguageVersion,
  at: string,
): Promise<void> {
  if (languageVersionStanding(version, deps.release.language) !== 'deprecated') return;
  const diagnostic = languageVersionDiagnostic(version, deps.release.language);
  await emitSafely(deps, () => ({
    teamId: movement.teamId,
    kind: DEPRECATED_VERSION,
    payload: payloadFor(movement, version, at, {
      reason: diagnostic?.message ?? `${describeLanguageVersion(version)} is deprecated.`,
    }),
  }));
}

/** An event that cannot be built or recorded is logged, never allowed to
 *  stop the sweep: the stored diagnostics are the fact, the event only its
 *  notice. */
async function emitSafely(
  deps: DeployCheckDeps,
  build: () => { teamId: string; kind: SystemEventKind; payload: SystemEventPayload },
): Promise<void> {
  try {
    await deps.emit(build());
  } catch (err) {
    logger.error('[DeployCheck] could not record a system event', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function payloadFor(
  movement: MovementRow,
  version: LanguageVersion,
  at: string,
  input: { reason: string },
): SystemEventPayload {
  return {
    automation: movement.name,
    automationId: movement.id,
    runId: '',
    version: languageVersionView(version).name,
    reason: input.reason,
    url: automationUrl(movement.id),
    at,
  };
}

function entryFor(
  movement: MovementRow,
  outcome: DeployCheckOutcome,
  to: LanguageVersion,
  release: LanguageRelease,
  detail: string,
): DeployCheckEntry {
  return {
    id: movement.id,
    teamId: movement.teamId,
    name: movement.name,
    outcome,
    from: languageVersionView(movement.languageVersion),
    to: languageVersionView(to),
    deprecated: languageVersionStanding(to, release) === 'deprecated',
    detail,
  };
}

function gapsText(gaps: TeamMovementValidation['gaps']): string {
  return `could not read ${gaps.length} connected system(s) to check against`;
}

function countOutcomes(entries: DeployCheckEntry[]): Record<DeployCheckOutcome, number> {
  const counts: Record<DeployCheckOutcome, number> = {
    advanced: 0,
    current: 0,
    warned: 0,
    refused: 0,
    unverified: 0,
  };
  for (const entry of entries) counts[entry.outcome] += 1;
  return counts;
}

function releaseAppliedReason(
  tag: string,
  current: LanguageVersion,
  counts: Record<DeployCheckOutcome, number>,
): string {
  return (
    `Release ${tag} applied. Moved to ${describeLanguageVersion(current)}: ${counts.advanced}. ` +
    `Already on it: ${counts.current}. Stayed on an older version with warnings: ${counts.warned}. ` +
    `Not validating: ${counts.refused}. Could not be checked: ${counts.unverified}.`
  );
}

// ── The real dependencies ───────────────────────────────────────────────────

/** Validate against the team's live catalog, inside the team. */
export const validateUnderLiveCatalog: ValidateUnder = ({ movement, languageVersion, upgradingFrom }) =>
  withTeamContext(movement.teamId as TeamId, () =>
    validateMovementForTeam({
      teamId: movement.teamId,
      source: movement.source,
      languageVersion,
      // Reaches imported library files too: the checker checks them under the
      // importer's version and move, and surfaces their warnings.
      ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    }),
  );

export function liveDeployCheckDeps(release: DeployCheckRelease): DeployCheckDeps {
  return {
    release,
    alreadyRan: async ({ tag, languageRelease }) => {
      const row = await getAutomationsQb(['deploy_check'])
        .selectFrom('deploy_check')
        .where('release_tag', '=', tag)
        .where('language_release', '=', languageRelease)
        .select('id')
        .executeTakeFirst();
      return row !== undefined;
    },
    listMovements: listAllMovementRows,
    validate: validateUnderLiveCatalog,
    sourceHash: movementSourceHash,
    recordValidity: async ({ movement, validation, checkedAgainst }) => {
      const assessment = assessMovementValidity({
        diagnostics: validation.diagnostics,
        gaps: validation.gaps,
      });
      await recordValidityOutcome({
        id: movement.id,
        status: assessment.status,
        reason: assessment.reason,
        sourceHash: movementSourceHash(movement.source),
        checkedAgainst,
      });
    },
    recordUpgradeCheck: ({ movement, diagnostics, checkedAgainst }) =>
      recordUpgradeCheck({ id: movement.id, diagnostics, checkedAgainst }),
    advance: ({ movement, to }) =>
      advanceMovementLanguageVersion({ teamId: movement.teamId, id: movement.id, to }),
    emit: recordSystemEvent,
    recordRun: async ({ tag, languageRelease, summary }) => {
      await getAutomationsQb(['deploy_check'])
        .insertInto('deploy_check')
        .values({ release_tag: tag, language_release: languageRelease, summary })
        .onConflict((oc) => oc.columns(['release_tag', 'language_release']).doNothing())
        .execute();
    },
    now: () => new Date(),
  };
}

/** The most recent check's summary — what `deploy/up.sh` prints. */
export async function latestDeployCheckSummary(): Promise<DeployCheckSummary | null> {
  const row = await getAutomationsQb(['deploy_check'])
    .selectFrom('deploy_check')
    .select('summary')
    .orderBy('ran_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? (row.summary as DeployCheckSummary) : null;
}

// ── The explicit upgrade ────────────────────────────────────────────────────

export type UpgradeMovementResult =
  | { status: 'not_found' }
  | {
      status: 'already_current' | 'upgraded' | 'needs_acknowledgement' | 'blocked' | 'unverified';
      automation: { id: string; name: string };
      from: LanguageVersionView;
      to: LanguageVersionView;
      /** The blocking diagnostics under the target version — empty when clean. */
      diagnostics: AuthoringDiagnostic[];
    };

/**
 * Validate one movement under the current version and report what that finds.
 * The pin moves only when the result is clean AND the caller acknowledged it —
 * so the first call shows the diagnostics, and a second, acknowledged one acts.
 */
export async function upgradeMovement(input: {
  teamId: string;
  id: string;
  acknowledge: boolean;
  validate?: ValidateUnder;
}): Promise<UpgradeMovementResult> {
  const movement = await getMovementRow({ teamId: input.teamId, id: input.id });
  if (!movement) return { status: 'not_found' };
  const to = CURRENT_LANGUAGE_VERSION;
  const base = {
    automation: { id: movement.id, name: movement.name },
    from: languageVersionView(movement.languageVersion),
    to: languageVersionView(to),
  };
  if (movement.languageVersion === to) {
    return { status: 'already_current', ...base, diagnostics: [] };
  }

  const validation = await (input.validate ?? validateUnderLiveCatalog)(
    validationUnder(movement, to),
  );
  const diagnostics = blockingDiagnostics(validation.diagnostics);
  await recordUpgradeCheck({ id: movement.id, diagnostics, checkedAgainst: to });
  if (hardErrors(diagnostics).length > 0) return { status: 'blocked', ...base, diagnostics };
  if (validation.gaps.length > 0) return { status: 'unverified', ...base, diagnostics };
  if (!input.acknowledge) return { status: 'needs_acknowledgement', ...base, diagnostics };

  await advanceMovementLanguageVersion({ teamId: movement.teamId, id: movement.id, to });
  const assessment = assessMovementValidity({ diagnostics: validation.diagnostics, gaps: [] });
  await recordValidityOutcome({
    id: movement.id,
    status: assessment.status,
    reason: assessment.reason,
    sourceHash: movementSourceHash(movement.source),
    checkedAgainst: to,
  });
  return { status: 'upgraded', ...base, diagnostics };
}

/** The standing release, for the entry points. */
export function thisDeployCheckRelease(tag: string): DeployCheckRelease {
  return { tag, language: THIS_RELEASE };
}
