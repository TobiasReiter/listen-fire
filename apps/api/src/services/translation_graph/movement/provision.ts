// Text-canonical movement persistence + listener reconciliation.
//
// `saveMovement` is the public entry point: it upserts the canonical
// `automations.movement` row FIRST (the program text survives any failed
// gate), then provisions the file's DERIVED trigger rows and records the
// legacy first-listener link on the row.
//
// Trigger semantics live in the .mvt text ("the file declares its
// listeners", plans/2026-06-10-data-movement-language/6_engine.md):
//
//   listen to inbox { key: "dealflow" } fire dealflow_intake
//
// One `automations.trigger` row per `listen` statement, fully derived and
// not otherwise editable — kind/credentials come from the listened
// instance's construction, `config` from the listen's config block, the
// name from the stable `movement/<file>/<movement>` convention, and the
// row is linked to its movement via `trigger.movement_id`. The single
// hand-editable field is `run_mode` (operational pause state): it
// defaults to 'live' on creation and reconciliation NEVER touches it
// afterwards. A file with zero listens is a library — saving it retires
// any previously derived triggers.
//
// EXECUTION reads the canonical text: a movement-derived trigger always
// dispatches through `runMovement` (the movement engine,
// services/movement_engine/run.ts) — see ./execute.ts and
// triggers/router.ts. The trigger row is purely the dispatch index; it
// carries NO orchestration / object code (reconciliation clears any),
// and the authored-liveness gate derives a movement trigger's liveness
// from the movement row (storage/authored.ts).
//
// The save gate is the runtime-validity consent gate (decision 3b,
// plans/2026-07-13-movement-validity-lifecycle): a non-`valid` save
// without consent returns `needsConfirmation` (text saved, nothing
// shipped); a `valid` or consented save SHIPS — listeners reconciled,
// version minted — and is what runs from then on.
//
// Consent covers the CONSEQUENCE, including the worst one. A consented
// save whose source cannot be PARSED yields no listener set at all, so
// there is nothing to reconcile against: every listener the movement had
// is retired (runs parked on them settled, not stranded) and the save
// comes back with a warning saying the automation no longer fires until a
// parseable source restores them. The alternative — leaving the old rows
// firing text that no longer exists — is what shipped before, and it made
// the saved file and the running behaviour silently disagree.
//
// Reconciliation preserves row identity: an unchanged listen keeps its
// trigger id (and therefore its trigger_run history — `trigger_run` rows
// carry `trigger_id` without an FK, so retiring a listener orphans its
// history rather than deleting it).
//
// "Run now" is a LISTENER too: a manual-channel listen (`listen to
// manual() {} fire backfill`) derives an ordinary trigger row, and
// `runMovementNow` (./run_now.ts) injects an invocation event on it
// through normal dispatch — uniform run_mode gating, uniform trigger_run
// recording. `listen` is the only invoker; the former `run` entry is
// retired.

import { randomUUID } from 'node:crypto';

import {
  MovementParseError,
  checkProgram,
  parseProgram,
  scanName,
} from 'movement-lang';

import type {
  Diagnostic,
  LanguageVersion,
  MovementDeclaration,
  Program,
} from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerRunMode } from '../triggers/run_mode';

import { mq } from '../../../lib/message_queue';
import { unsafeCurrentContext } from '../../../services/context';
import { logger } from 'movement-engine/public/log';
import { collectFileListeners, type FileListener } from 'movement-engine/public/inbound';
import { recordUserMilestone, recordTeamMilestone } from '../../../lib/journey';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { getAdapterManifest, inboundAddressFor } from '../adapters/registry';
import { syncListenSubscriptions } from './listen_subscriptions';
import { addressHops, resolveListenAddress } from './listen_address';
import { cachedAdapterInstance } from './instance_cache';
import { positionArgValues } from './catalog';
import { movementWriteRunMode } from './dry_run';
import {
  manualListenerMovements,
  movementFileFacets,
  type MovementFileFacets,
} from './files';
import { movementCatalogForTeam, type TeamMovementCatalog } from './catalog';
import {
  deleteMovementRow,
  getMovementRow,
  listDerivedTriggerRows,
  listDerivedTriggerRowsForMovements,
  listMovementRows,
  listenersFiringMovementNames,
  pendingUpgradeDiagnostics,
  recordDerivedTriggerLink,
  recordValidityOutcome,
  upsertMovementRow,
  type DerivedTriggerRow,
  type MovementRow,
  type MovementValidityStatus,
} from './store';
import { mintMovementVersionIfChanged, movementSourceHash } from './version_store';
import { stepTimer, type StepTimer } from './timing';
import { settleRunsParkedOnTriggers } from '../../interaction/run_failure';
import { revokeCallbacksForRuns } from '../../movement_engine/callback_store';
import {
  assessMovementValidity,
  diagnoseMovementSource,
  type AuthoringDiagnostic,
  type MovementValidityAssessment,
} from './authoring';

/** Resource-change hint for a movement save/delete — fired from the
 *  shared service so UI and agent callers both propagate. The actor isn't
 *  reliably known here; 'user' is the default (the agent's saveMovement
 *  tool flows through this same service). Best-effort. */
function emitMovementChange(input: {
  teamId: string;
  movementId: string;
  action: string;
  /** Who authored this change. Agent saves run inside the user's request
   *  origin, so the open editor would dedup them by originId and miss the
   *  live fill-in — marking them 'agent' lets the page reflect them anyway. */
  source?: 'agent' | 'user';
}): void {
  const originId = unsafeCurrentContext()?.originId;
  mq.resourceChanges.changed
    .publish({
      kind: 'movement',
      teamId: input.teamId,
      source: input.source ?? 'user',
      action: input.action,
      resourceId: input.movementId,
      ...(originId ? { originId } : {}),
    })
    .catch(() => {});
}

// ── Provisioning result shapes ──────────────────────────────────────────────

export interface ProvisionedListener {
  triggerId: string;
  /** The movement this listener fires. */
  movementName: string;
  /** `automations.trigger.kind` — the source adapter slug (the channel). */
  kind: string;
  credentialsId: string | null;
  config: Record<string, unknown>;
  /** `config.key`, when the listen declares one. */
  configKey: string | null;
  /** `<local>+<key>@<domain>` for adapters with an inbound routing key, else null. */
  inboundAddress: string | null;
  /** The one hand-editable listener field (never touched by reconciliation). */
  runMode: TriggerRunMode;
  /** Whether an existing derived row was kept (identity + run history preserved). */
  reused: boolean;
}

export interface ProvisionedMovement {
  ok: true;
  /** The file's primary movement name (the row's name source). */
  movementName: string;
  /** One per `listen` statement, in file order. Empty = library file. */
  listeners: ProvisionedListener[];
  /** Info-severity diagnostics (e.g. MOV_LISTEN_MISSING) — never blocking. */
  infos: Diagnostic[];
  /** Catalog assembly notes (honest gaps — untyped adapters, collisions). */
  catalogNotes: string[];
  /** The save SUCCEEDED, but something about what now runs would surprise the
   *  author — listeners retired by a consented unparseable save, a movement
   *  name another automation already fires. Never blocking; always shown. */
  warnings: string[];
}

export interface ProvisionMovementFailure {
  ok: false;
  /** Parse/check diagnostics, when the check failed. */
  diagnostics?: Diagnostic[];
  /** Unsupported-construct or provisioning errors. */
  errors?: string[];
  catalogNotes: string[];
}

export type ProvisionMovementResult = ProvisionedMovement | ProvisionMovementFailure;

// ── Listener reconciliation ─────────────────────────────────────────────────

interface DesiredListener extends FileListener {
  /** The text-derived dry_run⇄live axis (the universal `dry_run`
   *  construction parameter). */
  textRunMode: Extract<TriggerRunMode, 'live' | 'dry_run'>;
  credentialsId: string | null;
  /** The listen's FULL resolved address — the position's path + the config's
   *  hops, names→ids (listen_address.ts). Persisted on the trigger row as a
   *  DERIVED field beside the authored config; the subscription channel keys
   *  on it. Absent when the adapter declares no address hops, or when a
   *  consented-broken save couldn't resolve it (the reconciler then refuses
   *  the channel rather than minting a half-scoped one). */
  resolvedAddress?: Record<string, string>;
}

/** The routing discriminator inside a (kind, credentials) channel:
 *  inbound-routing-key listens route by `key`; cron listens by their
 *  `schedule` (two schedules = two listeners);
 *  address-hop listens (Airtable) by their RESOLVED address (two tables =
 *  two listeners). The resolved spelling deliberately matches the legacy
 *  config-derived `base:table` string — key-sorted values, `:`-joined — so
 *  pre-resolution rows keep their identity (and their run history) across
 *  the transition. */
function configKeyOf(
  config: Record<string, unknown>,
  resolvedAddress?: Record<string, string>,
): string | null {
  if (resolvedAddress !== undefined && Object.keys(resolvedAddress).length > 0) {
    return Object.entries(resolvedAddress)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value)
      .join(':');
  }
  if (typeof config['key'] === 'string') return config['key'] as string;
  if (typeof config['node_type_id'] === 'string') return config['node_type_id'] as string;
  if (typeof config['type'] === 'string') return config['type'] as string;
  if (typeof config['schedule'] === 'string') return config['schedule'] as string;
  if (typeof config['base'] === 'string' && typeof config['table'] === 'string') {
    return `${config['base']}:${config['table']}`;
  }
  return null;
}

/** The discriminator in SURFACE spelling — what the listener summary
 *  reports, and what the editor's listeners panel matches the script's
 *  own `listen` statements against (the script knows `type: "company"`,
 *  never the resolved node-type UUID; `identityKeyOf` keeps using the
 *  UUID-preferring chain so trigger identity is unaffected). */
function surfaceConfigKeyOf(config: Record<string, unknown>): string | null {
  if (typeof config['key'] === 'string') return config['key'] as string;
  if (typeof config['type'] === 'string') return config['type'] as string;
  if (typeof config['schedule'] === 'string') return config['schedule'] as string;
  if (typeof config['base'] === 'string' && typeof config['table'] === 'string') {
    return `${config['base']}:${config['table']}`;
  }
  return null;
}

/** Row identity: (movement, adapter kind, credentials, config key). A derived
 *  trigger belongs to the MOVEMENT it fires, never to a file position — so an
 *  unchanged listen keeps its trigger id and run history across saves EVEN when
 *  a new movement is inserted ahead of it or the movements are reordered. Two
 *  listens that fire different movements over the same channel+config are two
 *  identities (the old key conflated them, and the reconciler then reassigned
 *  ids positionally by `listen`-statement order). */
function identityKeyOf(listener: {
  movementName: string | null;
  kind: string;
  credentialsId: string | null;
  configKey: string | null;
}): string {
  return `${listener.movementName ?? ''}::${listener.kind}::${listener.credentialsId ?? ''}::${listener.configKey ?? ''}`;
}

/** The movement-BLIND identity: (adapter kind, credentials, config key). Used
 *  only as a fallback after every exact (movement-scoped) match is claimed — it
 *  reunites a listen with its row across a movement RENAME, and adopts a legacy
 *  row minted before per-movement addressing (`fired_movement_name` null). It
 *  can never steal a surviving listener's row: those are all claimed first. */
function channelConfigKeyOf(listener: {
  kind: string;
  credentialsId: string | null;
  configKey: string | null;
}): string {
  return `${listener.kind}::${listener.credentialsId ?? ''}::${listener.configKey ?? ''}`;
}

/** Looser bucket for the changed-config-updates-in-place rule. */
function channelKeyOf(listener: { kind: string; credentialsId: string | null }): string {
  return `${listener.kind}::${listener.credentialsId ?? ''}`;
}

interface ReconciliationPlan {
  /** desired[i] → the existing row it keeps, or undefined (create). */
  matches: Array<DerivedTriggerRow | undefined>;
  retired: DerivedTriggerRow[];
}

/**
 * Match desired listeners to existing derived rows:
 *   1a. exact (movement, kind, credentials, config key) identity → keep the
 *       row. A surviving listen claims its OWN row before any looser pass, so
 *       inserting/reordering movements can never reassign it.
 *   1b. movement-blind (kind, credentials, config key) → keep the row across a
 *       movement RENAME or adopt a legacy (`fired_movement_name` null) row.
 *   2.  otherwise, when exactly ONE unmatched desired listener and ONE
 *       unmatched row share (kind, credentials), the config changed in an
 *       unambiguous way → update that row in place;
 *   3.  leftover desired listeners → new rows; leftover rows → retired.
 */
export function planListenerReconciliation(input: {
  desired: Array<{
    movementName: string;
    kind: string;
    credentialsId: string | null;
    configKey: string | null;
  }>;
  existing: DerivedTriggerRow[];
}): ReconciliationPlan {
  const matches: Array<DerivedTriggerRow | undefined> = input.desired.map(() => undefined);
  const remaining = [...input.existing];

  const claim = (index: number, row: DerivedTriggerRow): void => {
    matches[index] = row;
    remaining.splice(remaining.indexOf(row), 1);
  };

  const rowConfigKeyOf = (r: DerivedTriggerRow): string | null =>
    configKeyOf(r.config, r.resolvedAddress);

  // Pass 1a — exact identity, scoped to the movement the trigger fires.
  for (let i = 0; i < input.desired.length; i++) {
    const key = identityKeyOf(input.desired[i]);
    const row = remaining.find(
      (r) =>
        identityKeyOf({
          movementName: r.firedMovementName,
          kind: r.kind,
          credentialsId: r.credentialsId,
          configKey: rowConfigKeyOf(r),
        }) === key,
    );
    if (row) claim(i, row);
  }

  // Pass 1b — movement-blind fallback: a listen whose movement was renamed (or
  // whose row predates per-movement addressing) reunites with its row here,
  // AFTER every unchanged listen has claimed its own row above.
  for (let i = 0; i < input.desired.length; i++) {
    if (matches[i]) continue;
    const key = channelConfigKeyOf(input.desired[i]);
    const row = remaining.find(
      (r) =>
        channelConfigKeyOf({
          kind: r.kind,
          credentialsId: r.credentialsId,
          configKey: rowConfigKeyOf(r),
        }) === key,
    );
    if (row) claim(i, row);
  }

  // Pass 2 — unambiguous config change within a (kind, credentials) channel.
  const unmatchedByChannel = new Map<string, number[]>();
  for (let i = 0; i < input.desired.length; i++) {
    if (matches[i]) continue;
    const key = channelKeyOf(input.desired[i]);
    unmatchedByChannel.set(key, [...(unmatchedByChannel.get(key) ?? []), i]);
  }
  for (const [channel, indexes] of unmatchedByChannel) {
    const candidates = remaining.filter((r) => channelKeyOf(r) === channel);
    if (indexes.length === 1 && candidates.length === 1) {
      claim(indexes[0], candidates[0]);
    }
  }

  return { matches, retired: remaining };
}

async function reconcileDerivedTriggers(input: {
  teamId: TeamId;
  /** Required whenever `desired` is non-empty (new rows need the FK). */
  pipelineConfigurationId: string | null;
  movementRow: MovementRow;
  desired: DesiredListener[];
  /** What to tell a run parked on a listener this reconciliation retires.
   *  Defaults to the ordinary case (the `listen` line went away). */
  retirementReason?: string;
}): Promise<ProvisionedListener[]> {
  const qb = getAutomationsQb(['trigger']);
  const existing = await listDerivedTriggerRows(input.movementRow.id);
  const plan = planListenerReconciliation({
    desired: input.desired.map((d) => ({
      movementName: d.movementName,
      kind: d.adapter,
      credentialsId: d.credentialsId,
      configKey: configKeyOf(d.config, d.resolvedAddress),
    })),
    existing,
  });

  // Retire rows whose listen disappeared: delete the trigger row itself.
  // `trigger_run` history rows reference the trigger id WITHOUT an FK, so
  // they survive as orphans — the firing record outlives the listener, it
  // just no longer resolves to a row.
  //
  // A run PARKED against a retired trigger can never resume: every resume
  // driver (await/timer/callback) loads the trigger row first and bails when
  // it is gone, leaving the run parked forever with nothing said. This save
  // is the last actor that knows the work is being dropped, so settle those
  // runs first — the same duty `deleteMovement` discharges, for the same
  // reason (../../interaction/run_failure.ts).
  if (plan.retired.length > 0) {
    await settleRunsParkedOnTriggers({
      triggerIds: plan.retired.map((row) => row.id),
      reason:
        input.retirementReason ??
        'This run was still waiting to continue when its listener was removed from the automation, so it was stopped.',
    });
  }
  for (const row of plan.retired) {
    await qb
      .deleteFrom('trigger')
      .where('id', '=', row.id as TriggerId)
      .execute();
  }

  const listeners: ProvisionedListener[] = [];
  for (let i = 0; i < input.desired.length; i++) {
    const desired = input.desired[i];
    const kept = plan.matches[i];
    const name = desired.alias ?? `movement/${input.movementRow.name}/${desired.movementName}`;

    // run_mode semantics: the dry_run⇄live axis is TEXT-DERIVED — a listener
    // whose movement writes only `dry_run: true` instances rehearses (engine
    // dryRun via the trigger run_mode mechanism), and removing the dry_run
    // flags returns it to live on the next save. This reconciliation is now
    // the ONLY writer of run_mode: the operator pause that also owned this
    // column was retired, so pausing is commenting the `listen` line out.
    const textRunMode: TriggerRunMode = desired.textRunMode;
    let triggerId: string;
    let runMode: TriggerRunMode;
    if (kept) {
      // Routing identity refreshes in place; a pre-existing 'off' is KEPT.
      // Nothing can set 'off' any more, but rows predating the retirement of
      // the operator pause must not silently resume — a save is not consent
      // to start running again. See triggers/run_mode.ts.
      triggerId = kept.id;
      runMode =
        kept.runMode === 'off' ? 'off'
        : textRunMode === 'dry_run' ? 'dry_run'
        : kept.runMode === 'dry_run' ? 'live'
        : kept.runMode;
      await qb
        .updateTable('trigger')
        .set({
          name,
          kind: desired.adapter,
          credentials_id: (desired.credentialsId ?? null) as never,
          config: desired.config as never,
          resolved_address: (desired.resolvedAddress ?? null) as never,
          movement_id: input.movementRow.id as MovementId,
          fired_movement_name: desired.movementName,
          run_mode: runMode,
          updated_at: new Date(),
        })
        .where('id', '=', triggerId as TriggerId)
        .execute();
    } else {
      if (input.pipelineConfigurationId === null) {
        throw new Error('reconcileDerivedTriggers: pipelineConfigurationId required to create rows');
      }
      triggerId = randomUUID();
      runMode = textRunMode;
      await qb
        .insertInto('trigger')
        .values({
          id: triggerId as TriggerId,
          team_id: input.teamId,
          pipeline_configuration_id: input.pipelineConfigurationId,
          name,
          kind: desired.adapter,
          config: desired.config as never,
          resolved_address: (desired.resolvedAddress ?? null) as never,
          credentials_id: (desired.credentialsId ?? null) as never,
          movement_id: input.movementRow.id as MovementId,
          fired_movement_name: desired.movementName,
          run_mode: runMode,
          provisioned_by_setup_agent: false,
        } as never)
        .execute();
    }

    // The trigger row is purely the dispatch index — dispatch executes the
    // canonical text. It carries no orchestration / object code; liveness
    // derives from `movement_id` being set (storage/authored.ts).
    const configKey = surfaceConfigKeyOf(desired.config);
    listeners.push({
      triggerId,
      movementName: desired.movementName,
      kind: desired.adapter,
      credentialsId: desired.credentialsId,
      config: desired.config,
      configKey,
      inboundAddress: inboundAddressFor(desired.adapter, desired.config),
      runMode,
      reused: kept !== undefined,
    });
  }
  return listeners;
}

// ── Provision: check the program, then reconcile the listeners ──────────────

async function provisionListeners(input: {
  teamId: TeamId;
  movementRow: MovementRow;
  source: string;
  teamCatalog: TeamMovementCatalog;
  /** A CONSENTED non-valid save still SHIPS (decision 3b) — derive its
   *  listeners from the parse despite check errors, so the declared listens
   *  exist and the movement genuinely fires-and-fails. Collection is already
   *  defensive: unresolvable pieces are skipped. */
  provisionDespiteErrors?: boolean;
  /** The save's timer, when this runs under one — the two network-backed
   *  halves (address resolution, subscription sync) are reported inside the
   *  `listeners` step rather than hidden in it (./timing.ts). */
  timer?: StepTimer;
}): Promise<ProvisionMovementResult> {
  const { teamCatalog } = input;
  const within = <T>(name: string, run: () => Promise<T>): Promise<T> =>
    input.timer ? input.timer.within(name, run) : run();

  let program: Program;
  try {
    program = parseProgram(input.source, { languageVersion: input.movementRow.languageVersion });
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    return {
      ok: false,
      diagnostics: [
        { code: 'MOV_PARSE', message: e.message, span: { start: e.loc, end: e.loc } },
      ],
      catalogNotes: teamCatalog.notes,
    };
  }

  const checkDiagnostics = await within('listenCheck', async () =>
    checkProgram(program, teamCatalog.catalog, {
      resolveFile: teamCatalog.resolveFile,
      languageVersion: input.movementRow.languageVersion,
    }),
  );
  const errors = checkDiagnostics.filter((d) => (d.severity ?? 'error') === 'error');
  const infos = checkDiagnostics.filter((d) => (d.severity ?? 'error') !== 'error');
  if (errors.length > 0 && input.provisionDespiteErrors !== true) {
    return { ok: false, diagnostics: checkDiagnostics, catalogNotes: teamCatalog.notes };
  }

  /** The text-derived dry_run⇄live axis. */
  const textRunModeOf = (
    movementName: string,
  ): Extract<TriggerRunMode, 'live' | 'dry_run'> =>
    movementWriteRunMode(program, movementName).mode === 'dry_run' ? 'dry_run' : 'live';

  const fileListeners = collectFileListeners(program);

  const desired: DesiredListener[] = fileListeners.map((listener) => ({
    ...listener,
    textRunMode: textRunModeOf(listener.movementName),
    credentialsId:
      listener.credentialName !== undefined
        ? (teamCatalog.resolveCredentialId(listener.credentialName) ?? null)
        : null,
  }));

  // Resolve each listen's FULL address — the position's path + the config's
  // hops, names→ids — before any trigger row is touched. The channel key and
  // the external registration both read this (listen_subscriptions.ts), so a
  // listen whose address doesn't resolve must NOT quietly derive a trigger
  // whose subscription can never register (the measured silently-dead state).
  // Failure is a save error; on a consented-broken save (fires-and-fails by
  // design) the listener ships without an address and the reconciler refuses
  // its channel with a note instead.
  const addressFailures: string[] = [];
  await within('listenAddress', async () => {
    for (const listener of desired) {
      const manifest = getAdapterManifest(listener.adapter);
      if (!manifest || addressHops(manifest.listenConfig).length === 0) continue;
      try {
        const instance = await cachedAdapterInstance({
          adapterType: listener.adapter,
          teamId: input.teamId,
          ...(listener.credentialsId !== null ? { credentialsId: listener.credentialsId } : {}),
          types: [],
        });
        const resolution = await resolveListenAddress({
          listenConfig: manifest.listenConfig,
          config: listener.config,
          positionValues: positionArgValues(manifest, listener.constructionArgs),
          membersAt: instance.membersAt,
        });
        if (resolution.ok) {
          listener.resolvedAddress = resolution.address;
        } else {
          addressFailures.push(
            `the '${listener.adapter}' listener firing '${listener.movementName}': ${resolution.reason}`,
          );
        }
      } catch (err) {
        addressFailures.push(
          `the '${listener.adapter}' listener firing '${listener.movementName}': address resolution failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  });
  if (addressFailures.length > 0 && input.provisionDespiteErrors !== true) {
    return {
      ok: false,
      errors: addressFailures,
      catalogNotes: teamCatalog.notes,
    };
  }

  // A library file (zero listens) derives no trigger rows, so it saves
  // fine on a team that was never seeded for dispatch.
  const pipelineConfigurationId =
    desired.length > 0 ? await activePipelineConfigurationId(input.teamId) : null;
  if (desired.length > 0 && !pipelineConfigurationId) {
    return {
      ok: false,
      errors: ['team has no active pipeline_configuration — seed the team first'],
      catalogNotes: teamCatalog.notes,
    };
  }

  const listeners = await within('reconcile', () =>
    reconcileDerivedTriggers({
      teamId: input.teamId,
      pipelineConfigurationId,
      movementRow: input.movementRow,
      desired,
    }),
  );

  // External event subscriptions follow the listens: the trigger table is
  // now the desired state, so the global per-team diff-sync (attio
  // webhooks et al — Adapter.ensureEventSubscription) runs after every
  // reconcile. Failures surface as notes, never block the save.
  const subscriptionSync = await within('subscriptionSync', () =>
    syncListenSubscriptions({ teamId: input.teamId }),
  );

  return {
    ok: true,
    movementName: input.movementRow.name,
    listeners,
    infos,
    catalogNotes: [...teamCatalog.notes, ...subscriptionSync.notes],
    // Save-time warnings are assembled by `saveMovement` — provisioning
    // itself has no view of the rest of the team's automations.
    warnings: [],
  };
}

// ── Text-canonical persistence (saveMovement & friends) ────────────────────

export interface SaveMovementInput {
  teamId: string;
  /** The movement program text — the canonical artifact. */
  source: string;
  /** Existing movement row id (the editor's re-save path). */
  id?: string;
  /** The row's name (the `<file>` half of the trigger-name convention).
   *  Defaults to the source's first movement declaration. */
  name?: string;
  description?: string;
  userId?: string;
  /** The `updatedAt` (ISO) the editor loaded. When set on a re-save and
   *  the stored row has moved on since — the assistant or another session
   *  saved in the meantime — the save is refused as a CONFLICT rather than
   *  silently overwriting. Omit to force an overwrite. */
  baseUpdatedAt?: string;
  /** Content-hash precondition (the `revision` a caller's earlier `getMovement`
   *  returned — `movementSourceHash` of the CURRENT source). When set on a
   *  re-save and the stored row's current source no longer hashes to it —
   *  someone else saved a newer version in the meantime — the save is refused
   *  as a CONFLICT, same shape as `baseUpdatedAt`'s guard, so the caller can
   *  re-read and merge rather than silently clobber it. Independent of
   *  `baseUpdatedAt`: this is the agent-facing precondition (an MCP caller has
   *  no editor "loaded at" timestamp to carry, but can always carry the last
   *  hash it read) — content-keyed rather than clock-keyed, and unaffected by
   *  clock skew. Omit for today's behaviour (no precondition, last write wins). */
  expectedRevision?: string;
  /** Marks the resource-change event so the open editor reflects agent
   *  saves live (default 'user' for direct edits). */
  changeSource?: 'agent' | 'user';
  /** Explicit consent to save a non-`valid` movement (invalid/unverified/
   *  incompilable) live anyway. Without it, such a save returns
   *  `needsConfirmation` so the caller can self-repair or confirm with the
   *  user. See plans/2026-07-13-movement-validity-lifecycle. */
  acknowledgeErrors?: boolean;
  /** Set only by the language upgrade (language_upgrade.ts): this text is the
   *  movement rewritten into version `to`, and it saves under that version —
   *  the pin and the text it is written in move in the one row update. An
   *  ordinary save never moves the pin. */
  languageUpgrade?: { to: LanguageVersion };
}

export interface SavedMovement extends ProvisionedMovement {
  movementId: string;
  /** The runtime validity the save shipped at — `valid`, or the consented
   *  non-`valid` state (decision 3b: a consented broken save replaces what
   *  runs and fires-and-fails). */
  validity: MovementValidityAssessment;
}

export interface SaveMovementFailure extends ProvisionMovementFailure {
  /** Absent only when no row could be saved (no derivable name). */
  movementId?: string;
  /** The stored row changed since the editor loaded — nothing was saved.
   *  The caller can show the current version and let the user reload it or
   *  overwrite (re-save with no baseUpdatedAt). */
  conflict?: {
    currentSource: string;
    currentUpdatedAt: string;
    /** Present when the conflict was detected by `expectedRevision` (or
     *  always computable regardless) — the CURRENT content hash, so a caller
     *  that wants to skip a redundant `getMovement` round-trip can re-save
     *  straight off it once it has merged. */
    currentRevision?: string;
  };
  /** The save landed non-`valid` and no consent was given: the source is
   *  persisted (retained artifact) but not shipped live. The caller either
   *  self-repairs off `validity.reason` or re-calls with `acknowledgeErrors`. */
  needsConfirmation?: boolean;
  /** The runtime validity the save was assessed at (present on a
   *  `needsConfirmation` return). */
  validity?: MovementValidityAssessment;
}

export type SaveMovementResult = SavedMovement | SaveMovementFailure;

/** One save, two milestones, gated differently — deliberately asymmetric
 *  (plans/2026-07-16-journey-instrumentation/design.md, "Monotonicity"):
 *
 *  - USER milestone: fires ONLY when this save arrived via MCP
 *    (`x-mcp-domain: automation`, stamped on the request Context by the auth
 *    middleware). The user journey measures *this person's* MCP adoption —
 *    an automation authored in the web UI never touches MCP, so counting it
 *    here could let `first_automation_saved` outrun `first_mcp_call` and
 *    render a negative drop-off. Gating to MCP-only keeps it monotonic by
 *    construction: an MCP save already stamped `first_mcp_call` earlier in
 *    this same request. Also skipped when no acting user is known (e.g. an
 *    unattended seed script).
 *  - TEAM milestone: fires on ANY route, unconditionally. The team journey
 *    measures the account coming to life regardless of how — gating it to
 *    MCP would reintroduce the same negative-drop-off problem one step
 *    later (a web-UI-authored automation that runs would show `first_run`
 *    with no save). The team-level event is silent by design — see
 *    lib/journey/types.ts:teamMilestoneTitle.
 *
 *  Fire-and-forget throughout: a journey failure must never fail a save. */
function recordAutomationSavedMilestones(input: {
  actingUserId?: string;
  teamId: string;
  viaMcp: boolean;
}): void {
  if (input.actingUserId && input.viaMcp) {
    void recordUserMilestone(input.actingUserId, {
      milestone: 'first_automation_saved',
      teamId: input.teamId,
    }).catch((e) => logger.warn('journey: first_automation_saved (user) failed', { error: e }));
  }
  void recordTeamMilestone(input.teamId, {
    milestone: 'first_automation_saved',
  }).catch((e) => logger.warn('journey: first_automation_saved (team) failed', { error: e }));
}

/** The source's own movement declarations — or NULL when the source cannot be
 *  read at all (an unparseable draft declares nothing we can trust, which is a
 *  different fact from declaring none). */
function declaredMovementNames(source: string): string[] | null {
  try {
    return parseProgram(source)
      .statements.filter((s): s is MovementDeclaration => s.kind === 'movement')
      .map((s) => s.name);
  } catch (e) {
    if (e instanceof MovementParseError) return null;
    throw e;
  }
}

/**
 * Warn when a movement name this file declares is ALREADY being fired by
 * another automation in the team.
 *
 * Nothing about registration is ambiguous: trigger identity is
 * `movement/<file>/<movement>` and reconciliation is scoped to the movement
 * ROW, so the two files' listeners are separate rows and neither shadows the
 * other. What breaks is the AUTHOR's mental model — they edit `notify` here,
 * watch the other file's `notify` listener keep firing, and conclude the save
 * did nothing (the live debugging session this came out of). So this is
 * purely visibility: a warning, never an error, and never a change to what
 * gets registered.
 */
async function movementNameCollisionWarnings(input: {
  teamId: string;
  movementId: string;
  declaredNames: string[];
}): Promise<string[]> {
  const collisions = await listenersFiringMovementNames({
    teamId: input.teamId,
    movementNames: input.declaredNames,
    excludeMovementId: input.movementId,
  });
  // One warning per (name, other file) — several listeners of the other file
  // firing the same name is one fact, not three.
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const collision of collisions) {
    const key = `${collision.firedMovementName} ${collision.movementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(
      collision.runMode === 'live'
        ? `The movement name "${collision.firedMovementName}" is also used by another automation, "${collision.movementFileName}", whose listener for it is live — that listener fires the other automation's version, not this one.`
        : `The movement name "${collision.firedMovementName}" is also used by another automation, "${collision.movementFileName}". Its listener for that name is not live, so nothing fires it from there today.`,
    );
  }
  return warnings;
}

/**
 * Save a movement file: upsert the canonical source row FIRST, then gate +
 * reconcile the derived listeners. The gate is the runtime-validity
 * consent gate (decision 3b) — execution reads THIS text through the
 * movement engine:
 *
 *   non-`valid`, no consent → `needsConfirmation` (text saved as a
 *     retained artifact; what's RUNNING is unchanged);
 *   `valid` or consented → the save SHIPS: derived triggers now mirror
 *     the file's listen statements exactly (zero listens = library, no
 *     triggers) and a version is minted.
 */
export async function saveMovement(input: SaveMovementInput): Promise<SaveMovementResult> {
  // One timing line per save, whatever gate it returns through — the authoring
  // loop's latency signal (./timing.ts). The steps live in `runSave`; the
  // emit lives here so no early return can skip it.
  const timer = stepTimer('authoring: save', { teamId: input.teamId });
  try {
    const result = await runSave(input, timer);
    timer.done({
      ok: result.ok,
      ...(result.movementId !== undefined ? { movementId: result.movementId } : {}),
      ...(result.ok ? {} : { needsConfirmation: result.needsConfirmation === true }),
    });
    return result;
  } catch (error) {
    timer.done({ ok: false, threw: true });
    throw error;
  }
}

async function runSave(
  input: SaveMovementInput,
  timer: StepTimer,
): Promise<SaveMovementResult> {
  const declaredName = movementNameFromSource(input.source);
  const existing = input.id
    ? await getMovementRow({ teamId: input.teamId, id: input.id })
    : null;
  if (input.id !== undefined && !existing) {
    return { ok: false, errors: [`movement ${input.id} not found`], catalogNotes: [] };
  }
  // Optimistic-concurrency guard: if the editor loaded an older version
  // than what's stored, something saved underneath it (the assistant, or
  // another tab/teammate). Refuse rather than clobber; hand back the
  // current version so the caller can reload or deliberately overwrite.
  if (input.id !== undefined && input.baseUpdatedAt !== undefined && existing) {
    if (existing.updatedAt.getTime() > new Date(input.baseUpdatedAt).getTime()) {
      return {
        ok: false,
        errors: [
          'This movement changed since you opened it — your save was held back so it doesn’t overwrite the newer version.',
        ],
        catalogNotes: [],
        movementId: existing.id,
        conflict: {
          currentSource: existing.source,
          currentUpdatedAt: existing.updatedAt.toISOString(),
          currentRevision: movementSourceHash(existing.source),
        },
      };
    }
  }
  // Content-hash precondition (the agent-facing analogue of the guard above —
  // see `expectedRevision` doc): reject a re-save whose caller's copy no
  // longer matches what's stored, rather than silently overwriting a newer
  // edit (the prod incident this guards against: a customer's agent held a
  // stale copy and clobbered a manual edit made in between).
  if (input.id !== undefined && input.expectedRevision !== undefined && existing) {
    const currentRevision = movementSourceHash(existing.source);
    if (currentRevision !== input.expectedRevision) {
      return {
        ok: false,
        errors: [
          'This automation changed since you read it — call getAutomation again, merge your changes into the latest version, and re-save with the new revision.',
        ],
        catalogNotes: [],
        movementId: existing.id,
        conflict: {
          currentSource: existing.source,
          currentUpdatedAt: existing.updatedAt.toISOString(),
          currentRevision,
        },
      };
    }
  }
  // The display name is durable and user-owned: an explicit name (a rename)
  // wins, then the stored name persists across re-saves, and the declaration
  // only SEEDS the name on first save. Editing the declaration changes the fire
  // target — never the saved movement's name. (`name` is undefined only when a
  // brand-new file declares no movement and the caller passed no name → the
  // guard below.)
  const name = input.name ?? existing?.name ?? declaredName;
  if (name === undefined) {
    return {
      ok: false,
      errors: [
        "Add a movement declaration — `movement <name>(item: source.<position>) { … }` — so this script can be saved under its name",
      ],
      catalogNotes: [],
    };
  }

  const row = await timer.step('persist', () =>
    upsertMovementRow({
      teamId: input.teamId,
      ...(input.id !== undefined ? { id: input.id } : {}),
      name,
      source: input.source,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.languageUpgrade !== undefined ? { languageVersion: input.languageUpgrade.to } : {}),
    }),
  );

  // The source row is now saved — emit the resource-change hint here (the
  // shared service layer), so UI saves and agent saves both propagate
  // regardless of the save's eventual gate outcome below.
  emitMovementChange({
    teamId: input.teamId,
    movementId: row.id,
    action: 'saveMovement',
    ...(input.changeSource !== undefined ? { source: input.changeSource } : {}),
  });

  // Referenced-set catalog: introspect only the (adapter, credential)
  // pairs this program (and its imported libraries) constructs, not the
  // whole workspace.
  const teamCatalog = await timer.step('catalog', () =>
    movementCatalogForTeam(input.teamId as TeamId, {
      source: input.source,
      languageVersion: row.languageVersion,
    }),
  );
  timer.note(teamCatalog.cost ?? {});

  // Runtime validity (plans/2026-07-13-movement-validity-lifecycle): assess the
  // source against the adapters' live shape using the catalog we just built (no
  // second introspection). Records the validity axis on the row. NOTHING
  // hard-blocks: a non-`valid` save without consent returns
  // `needsConfirmation` (source already persisted, so the broken movement is
  // retained as an artifact), never a wall.
  const { validation, validity } = await timer.step('diagnose', async () => {
    // Under the movement's pin — which a re-save never moves.
    const diagnosed = diagnoseMovementSource(input.source, {
      catalog: teamCatalog.catalog,
      resolveCredentialId: teamCatalog.resolveCredentialId,
      resolveFile: teamCatalog.resolveFile,
      languageVersion: row.languageVersion,
    });
    return {
      validation: diagnosed,
      validity: assessMovementValidity({
        diagnostics: diagnosed.diagnostics,
        gaps: teamCatalog.gaps,
      }),
    };
  });
  const sourceHash = movementSourceHash(input.source);

  // The acting user for journey milestones: a UI save threads it through
  // explicitly (`input.userId`); an agent/API-key save doesn't, but still
  // runs inside the authenticated request's context.
  const journeyContext = unsafeCurrentContext();
  const actingUserId =
    input.userId ?? (journeyContext?.authenticated ? journeyContext.user.id : undefined);
  // Monotonicity gate for the USER milestone only (see
  // `recordAutomationSavedMilestones` above) — did THIS request arrive via
  // MCP? Stamped on the Context by the auth middleware from `x-mcp-domain`.
  const viaMcp = journeyContext?.mcpDomain === 'automation';

  // Record the validity axis once. Stamp consent when we're shipping a
  // non-`valid` movement on acknowledgement.
  const consented = validity.status !== 'valid' && input.acknowledgeErrors === true;
  await recordValidityOutcome({
    id: row.id,
    status: validity.status,
    reason: validity.reason,
    sourceHash,
    checkedAgainst: row.languageVersion,
    ...(consented ? { consentedAt: new Date() } : {}),
  });

  // The consent gate (decision 3b — no draft limbo, no last-live-keeps-running):
  // EVERY non-`valid` save without consent stops here as needsConfirmation. The
  // source is persisted (retained artifact) but what's RUNNING is unchanged
  // until the caller either repairs or consents. A consented save falls through
  // and genuinely REPLACES what's running — even broken (it then fires and
  // fails; the prediction rule + issues take it from there).
  if (validity.status !== 'valid' && !consented) {
    const gapErrors = teamCatalog.gaps.map(
      (g) =>
        `couldn't verify this automation against "${g.adapter}" (${g.detail}) — its writes weren't checked`,
    );
    const diagnosticErrors = validation.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.message} (line ${d.line}, col ${d.col})`);
    // `needsConfirmation` still counts: the source is durably persisted and
    // the user authored an automation — that's the milestone, independent
    // of whether it shipped live.
    recordAutomationSavedMilestones({ actingUserId, teamId: input.teamId, viaMcp });
    return {
      ok: false,
      needsConfirmation: true,
      validity,
      // Structured diagnostics ride validity.reason; these strings carry the
      // human summary (message + position) for surfaces that just print.
      errors: validity.status === 'unverified' ? gapErrors : diagnosticErrors,
      catalogNotes: teamCatalog.notes,
      movementId: row.id,
    };
  }

  // Past the gate: the save SHIPS — it is now the movement that runs. Either
  // it's `valid`, or the caller consented to shipping it broken (decision 3b:
  // no draft limbo, no last-live-keeps-running). Reconcile listeners
  // best-effort: a consented-broken source may not compile far enough to
  // derive them, in which case the EXISTING trigger rows stay and now fire
  // this new source (which fails — fires-and-fails, by design).
  const provisioned = await timer.step('listeners', () => provisionListeners({
    teamId: input.teamId as TeamId,
    movementRow: row,
    source: input.source,
    teamCatalog,
    timer,
    // A consented non-valid save ships: derive its declared listens despite
    // check errors so it genuinely fires-and-fails (decision 3b).
    ...(consented ? { provisionDespiteErrors: true } : {}),
  }));

  // Every shipped save is what runs — mint its immutable version (deduped by
  // content hash) so runs pin it and the version-match rule has its anchor.
  await timer.step('versionMint', () =>
    mintMovementVersionIfChanged({
      teamId: input.teamId,
      movementId: row.id,
      source: input.source,
      languageVersion: row.languageVersion,
    }),
  );

  if (!provisioned.ok && validity.status === 'valid') {
    // A VALID program whose provisioning failed on infrastructure (config,
    // adapter resolution, …). Not a consent case — consent can't fix infra.
    // Surface the failure honestly. This DOES count as the authoring
    // milestone: the source is already durably persisted (upsertMovementRow,
    // above) and this branch's own guard proves it checked out `valid` — the
    // user did everything in their control. Only team-level infrastructure
    // stopped it shipping, which the user can't fix by authoring harder.
    // That failure is a distinct, later funnel step (first_run), not this one.
    recordAutomationSavedMilestones({ actingUserId, teamId: input.teamId, viaMcp });
    return { ...provisioned, movementId: row.id };
  }

  // Both remaining paths below ship the save (`ok: true`) — the definitive
  // success case.
  recordAutomationSavedMilestones({ actingUserId, teamId: input.teamId, viaMcp });

  const declaredNames = declaredMovementNames(input.source);
  const collisionWarnings = await timer.step('collisions', () =>
    movementNameCollisionWarnings({
      teamId: input.teamId,
      movementId: row.id,
      declaredNames: declaredNames ?? [],
    }),
  );

  if (!provisioned.ok) {
    // The source didn't reach a listener set. Two very different reasons:
    if (declaredNames === null) {
      // UNPARSEABLE, and consented (a valid source can't be unparseable, and
      // an unconsented non-valid save never got here). The file declares no
      // listeners we can read, so the authoritative listener set is EMPTY:
      // retire every row through the same settle-then-delete path
      // reconciliation uses, and say so. Leaving the old rows firing text
      // that no longer parses is the silent disagreement decision 3b exists
      // to avoid — consent covers this consequence.
      await reconcileDerivedTriggers({
        teamId: input.teamId as TeamId,
        pipelineConfigurationId: null,
        movementRow: row,
        desired: [],
        retirementReason:
          'This run was still waiting to continue when the automation was saved with a source that could not be read, so it was stopped.',
      });
      return {
        ok: true,
        movementId: row.id,
        movementName: name,
        listeners: [],
        infos: [],
        catalogNotes: teamCatalog.notes,
        warnings: [
          'This source could not be read, so no listeners could be derived from it. You saved it anyway, so every listener this automation had has been retired — it will not fire again until a source that reads cleanly restores them.',
          ...collisionWarnings,
        ],
        validity,
      };
    }
    // PARSEABLE but provisioning failed on infrastructure (no dispatch config
    // for the team). Consent can't fix infra and the file's listens are still
    // legible, so the existing rows stay pointed at this movement and fire the
    // new source (which fails — fires-and-fails, by design).
    return {
      ok: true,
      movementId: row.id,
      movementName: name,
      listeners: [],
      infos: [],
      catalogNotes: [
        ...teamCatalog.notes,
        'listeners could not be derived from this source — existing listeners (if any) keep firing it',
      ],
      warnings: collisionWarnings,
      validity,
    };
  }

  // Legacy convenience link: the first listener (or cleared when the file
  // declares none). The canonical relation is trigger.movement_id.
  const first = provisioned.listeners[0];
  await recordDerivedTriggerLink({
    id: row.id,
    triggerId: first?.triggerId ?? null,
  });
  return {
    ...provisioned,
    warnings: [...provisioned.warnings, ...collisionWarnings],
    movementId: row.id,
    validity,
  };
}

// ── Reading side: listeners projected per movement ──────────────────────────

export interface MovementListenerInfo {
  triggerId: string;
  /** `movement/<file>/<movement>`. */
  name: string;
  /** The channel — source adapter slug. */
  kind: string;
  config: Record<string, unknown>;
  configKey: string | null;
  /** `<local>+<key>@<domain>` for adapters with an inbound routing key, else null. */
  inboundAddress: string | null;
  /** The fired movement (the trigger-name convention's last segment). */
  movementName: string | null;
  /** Derived from the movement text on every save; not settable — see
   *  triggers/run_mode.ts. */
  runMode: TriggerRunMode;
}

function toListenerInfo(row: DerivedTriggerRow): MovementListenerInfo {
  const configKey = surfaceConfigKeyOf(row.config);
  // The fired movement is authoritative — an aliased listener's `name` is just
  // the alias (no `movement/<file>/<movement>` convention to parse), so deriving
  // the movement from the name string yields null and the editor can't match the
  // live row (it renders "Starts on save" on a listening trigger). Fall back to
  // the name convention only for legacy rows without a stored fired_movement_name.
  const nameParts = row.name.split('/');
  return {
    triggerId: row.id,
    name: row.name,
    kind: row.kind,
    config: row.config,
    configKey,
    inboundAddress: inboundAddressFor(row.kind, row.config),
    movementName:
      row.firedMovementName ??
      (nameParts.length >= 3 ? nameParts[nameParts.length - 1] : null),
    runMode: row.runMode,
  };
}

export interface MovementListItem {
  id: string;
  name: string;
  /** Runtime validity of the current source (null = never checked) — NOT
   *  whether the file runs on its own. A library checks clean and is
   *  'valid' without anything ever invoking it; see `facets` for what the
   *  file actually is. */
  validityStatus: MovementValidityStatus | null;
  validityCheckedAt: Date | null;
  /** The language version the last validity check ran under. */
  validityCheckedAgainst: LanguageVersion | null;
  /** The language version the movement is written against (its pin). */
  languageVersion: LanguageVersion;
  /** What keeps it off the current language version — the errors and warnings
   *  validating it under that version found (pendingUpgradeDiagnostics). Null
   *  when it is on it, or nothing is recorded. */
  upgradeDiagnostics: AuthoringDiagnostic[] | null;
  /** First listener's channel (null for libraries). */
  kind: string | null;
  /** Derived listeners — one per `listen` statement of the last shipped save. */
  listeners: MovementListenerInfo[];
  /** The source declares a manual-channel listener — "Run now" works. */
  runnable: boolean;
  /** What the file IS, derived from its text: an automation (something
   *  invokes it), a library (others import it), or both. */
  facets: MovementFileFacets;
  createdAt: Date;
  updatedAt: Date;
}

/** Whether "Run now" has anything to invoke: a MANUAL-channel listener
 *  in the SOURCE — execution injects an invocation event on its derived
 *  trigger row (uniform dispatch). */
function isRunnable(row: MovementRow): boolean {
  try {
    return (
      manualListenerMovements(parseProgram(row.source, { languageVersion: row.languageVersion }))
        .length > 0
    );
  } catch (e) {
    if (e instanceof MovementParseError) return false;
    throw e;
  }
}

export async function listMovements(teamId: string): Promise<MovementListItem[]> {
  const rows = await listMovementRows(teamId);
  const listenersByMovement = await listDerivedTriggerRowsForMovements(rows.map((r) => r.id));
  return rows.map((row) => {
    const listeners = (listenersByMovement.get(row.id) ?? []).map(toListenerInfo);
    return {
      id: row.id,
      name: row.name,
      validityStatus: row.validityStatus,
      validityCheckedAt: row.validityCheckedAt,
      validityCheckedAgainst: row.validityCheckedAgainst,
      languageVersion: row.languageVersion,
      upgradeDiagnostics: pendingUpgradeDiagnostics(row),
      kind: listeners[0]?.kind ?? null,
      listeners,
      runnable: isRunnable(row),
      facets: movementFileFacets(row.source),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

export interface MovementDetail extends MovementRow {
  /** Derived listeners — one per `listen` statement of the last shipped save. */
  listeners: MovementListenerInfo[];
  /** First listener's channel, kept for back-compat with the list shape. */
  kind: string | null;
  /** First listener's inbound address (adapters with an inbound routing key). */
  inboundAddress: string | null;
  /** The source declares a manual-channel listener — "Run now" works. */
  runnable: boolean;
  /** Content hash of the CURRENT `source` (`movementSourceHash`) — an
   *  optimistic-concurrency fingerprint. Pass it back as `expectedRevision` on
   *  a later `saveMovement` to guard against clobbering an edit made by
   *  someone (or something) else in the meantime; a mismatch there is refused
   *  as a conflict instead of silently overwriting. */
  revision: string;
}

export async function getMovement(input: {
  teamId: string;
  id: string;
}): Promise<MovementDetail | null> {
  const row = await getMovementRow(input);
  if (!row) return null;
  const listeners = (await listDerivedTriggerRows(row.id)).map(toListenerInfo);
  return {
    ...row,
    // Only what still stands between it and the current version.
    upgradeDiagnostics: pendingUpgradeDiagnostics(row),
    listeners,
    kind: listeners[0]?.kind ?? null,
    inboundAddress: listeners[0]?.inboundAddress ?? null,
    runnable: isRunnable(row),
    revision: movementSourceHash(row.source),
  };
}

/**
 * Delete a movement and every row derived from it (the listener triggers,
 * plus any legacy compiled mappings still attached) — the text is
 * canonical, so removing it removes everything derived from it. Returns
 * false when the movement doesn't exist.
 */
export async function deleteMovement(input: { teamId: string; id: string }): Promise<boolean> {
  const row = await getMovementRow(input);
  if (!row) return false;
  const qb = getAutomationsQb(['trigger']);

  const derived = await listDerivedTriggerRows(row.id);
  const triggerIds = new Set(derived.map((d) => d.id));
  if (row.triggerId !== null) triggerIds.add(row.triggerId); // legacy link

  // Deleting the movement cascades its `movement_version` rows away, which
  // nulls `trigger_run.movement_version_id` on every run parked against these
  // triggers — leaving them permanently unresumable. Settle them FIRST, while
  // the pin still resolves and we can still say why the work stopped.
  await settleRunsParkedOnTriggers({
    triggerIds: [...triggerIds],
    reason:
      'This run was still waiting to continue when the automation was deleted, so it was stopped.',
  });

  // A RUNNING run isn't parked, so the settle above doesn't reach it — but its
  // callbacks are just as unfireable once the version pin is gone (a fire has no
  // AST to resume into). Revoke every callback of every run of these triggers,
  // so a late tap gets the closed ack rather than a router error.
  await revokeCallbacksOfTriggers([...triggerIds]);

  for (const triggerId of triggerIds) {
    await qb
      .deleteFrom('trigger')
      .where('id', '=', triggerId as TriggerId)
      .execute();
  }
  await deleteMovementRow(input);
  // Retiring the file's listeners may have emptied an (adapter,
  // credential) channel — tear its external subscription down too.
  await syncListenSubscriptions({ teamId: input.teamId as TeamId });
  emitMovementChange({ teamId: input.teamId, movementId: input.id, action: 'deleteMovement' });
  return true;
}

/** Revoke every callback minted by any run of these triggers (movement delete).
 *  Scoped by run so it is one indexed read plus one update — the callback table
 *  keys on the run, never on the trigger. */
async function revokeCallbacksOfTriggers(triggerIds: string[]): Promise<void> {
  if (triggerIds.length === 0) return;
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_id', 'in', triggerIds)
    .select('id')
    .execute();
  await revokeCallbacksForRuns(runs.map((r) => r.id));
}

/** The first movement declaration's name. Uses the real parser — the AST name
 *  is grammar-correct by construction (backtick or bare). Only an *unparseable*
 *  draft falls back to a best-effort scan, which reads the name with the
 *  parser's own `scanName`, so the name grammar lives in exactly one place. */
export function movementNameFromSource(source: string): string | undefined {
  try {
    return parseProgram(source).statements.find(
      (s): s is MovementDeclaration => s.kind === 'movement',
    )?.name;
  } catch {
    // Unparseable draft: locate the first `movement` keyword and read the name
    // with the parser's primitive (never a bespoke name regex — that drifts).
    const keyword = /(?:^|\n)[^\S\n]*movement[^\S\n]+/.exec(source);
    if (keyword === null) return undefined;
    return scanName(source, keyword.index + keyword[0].length)?.name;
  }
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function activePipelineConfigurationId(teamId: TeamId): Promise<string | null> {
  const team = await getCoreQb(['team'])
    .selectFrom('team')
    .where('id', '=', teamId)
    .select(['active_pipeline_configuration_id'])
    .executeTakeFirst();
  return (team?.active_pipeline_configuration_id as unknown as string) ?? null;
}
