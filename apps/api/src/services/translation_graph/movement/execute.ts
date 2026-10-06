// Movement firings on the movement engine.
//
// Movements execute from their CANONICAL TEXT through `runMovement`
// (services/movement_engine/run.ts), against the team catalog. The one
// consumer is `dispatchTriggerByIdEvent` (triggers/router.ts): every
// movement-derived trigger (trigger.movement_id set) fires through
// `runMovementFiring` — live events, kg mutations, cron ticks, and
// "Run now"'s manual-channel injections alike (run_now.ts dispatches
// through the router; there is no separate execution entry).
//
// Failure containment: engine errors record a FAILED trigger_run (never
// crash dispatch); a construct outside the engine's slice surfaces as
// MOVENG_UNSUPPORTED naming the construct. The save-time dry
// interpretability check (movement_engine/interpretable.ts) makes that a
// last line of defence, not the discovery mechanism.

import type { LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import { describeError } from '../../../lib/utils/error';
import { logger } from '../../logger';
import {
  runMovement,
  resumeMovement,
  settleRaceFrame,
  fireCallbackBody,
  MovementRunFailed,
  runFailureCause,
  type CancelGate,
  type MovementRunResult,
} from '../../movement_engine/run';
import type { MovementTraceEntry } from '../../movement_engine/expression';
import { makeDbCancelGate } from '../../movement_engine/cancel_gate';
import { failRunAndCancelRequests } from '../../interaction/run_failure';
import { LlmUsageContext } from '../../../lib/llm_usage';
import type { ParkedScopeState } from '../../movement_engine/serialize';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import { TriggerRunRecorder, type TriggerRunTriggerType } from '../runs/trigger_run';
import type { TriggerEvent } from '../triggers/types';
import { movementCatalogForTeam } from './catalog';
import { getMovementRow, recordValidityOutcome, type MovementRow } from './store';
import { assessMovementValidity, validateMovementForTeam } from './authoring';
import { movementSourceHash } from './version_store';
import { recordMovementFailureIssue, resolveMovementIssues } from './issues';
import { clearIntrospectionCache } from './instance_cache';
import { withFiringContext } from './firing_context';
import { productionEngineHost } from './engine_host';

// ── The shared engine invocation (catalog assembly + runMovement) ───────────

/**
 * Run one movement firing: assemble the team catalog for exactly the
 * (adapter, credential) pairs the SAVED source constructs, then hand
 * `runMovement` the canonical text. Natural-name → internal-id translation
 * is the adapter layer's job — the engine derives each instance's
 * `AdapterNameResolver` from its own introspection (the default `resolveNames`
 * seam, behind the same cache the catalog's schemas come from); the host
 * holds no naming map.
 */
async function interpretMovementFiring(input: {
  teamId: TeamId;
  movementRow: MovementRow;
  /** Which movement in the file to run; absent = the file's only one. */
  movementName?: string;
  event: TriggerEvent;
  /** When the run fired — the recorder's `firedAt`, which is the run row's
   *  `started_at`. Every clock read in the run answers from it. */
  firedAt: Date;
  dryRun?: boolean;
  /** The recorder the run's parks and callbacks persist through — present for
   *  live firings (an `ask` parks into the recorder's run). Absent under dry
   *  runs: a test run never parks and mints nothing durable. */
  parksInto?: TriggerRunRecorder;
  /** The cooperative cancel gate (runs-and-cancel spec §cancel) — stops the run
   *  at the next statement / LLM-call boundary on a user cancel. */
  cancelGate: CancelGate;
  /** The array the run appends its decision trace to — supplied so a caller can
   *  publish the trace WHILE the run is going, not only once it settles. */
  trace?: MovementTraceEntry[];
}): Promise<MovementRunResult> {
  const teamCatalog = await movementCatalogForTeam(input.teamId, {
    source: input.movementRow.source,
    languageVersion: input.movementRow.languageVersion,
  });
  return runMovement({
    source: input.movementRow.source,
    // Compile and run under the movement's pin, never the current version.
    languageVersion: input.movementRow.languageVersion,
    ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
    event: input.event,
    teamId: input.teamId,
    firedAt: input.firedAt,
    catalog: teamCatalog.catalog,
    host: productionEngineHost({
      teamId: input.teamId,
      catalog: teamCatalog,
      ...(input.parksInto !== undefined ? { parksInto: input.parksInto } : {}),
      cancel: input.cancelGate,
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
    }),
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
  });
}

// ── Entry point (a): trigger dispatch ───────────────────────────────────────

/**
 * Split a thrown run error into the ORIGINAL error — what the log and the run's
 * failure reason must say, unchanged — and the partial write ledger the engine
 * carried out with it. A non-engine throw (catalog assembly) has no ledger and
 * reads exactly as before.
 */
function unwrapRunFailure(err: unknown): { error: unknown; partial?: MovementRunResult } {
  const error = runFailureCause(err);
  return err instanceof MovementRunFailed ? { error, partial: err.partial } : { error };
}

export interface MovementFiringOutcome {
  /** Null when the firing failed (the failure is recorded + returned). */
  result: MovementRunResult | null;
  /** The firing's error, when it failed. */
  error?: string;
}

/**
 * The dispatcher-side movement firing: one trigger_run for the firing
 * (recorded from `MovementRunResult`, per-field provenance summaries on
 * the step), failure contained — a thrown engine error records a FAILED
 * trigger_run and returns it as a value, never propagating into dispatch.
 */
/**
 * Prediction-rule hook (plans/2026-07-13-movement-validity-lifecycle): the
 * stored validity is a prediction; a run whose outcome CONTRADICTS it refreshes
 * it. Best-effort and post-`finish()` — a re-check error must never mask the run
 * outcome. Gated two ways:
 *   - version-match (decision 7): only a run of the CURRENT source may
 *     (in)validate it, so a stale run (source edited since dispatch) is ignored;
 *   - contradiction only: a `valid` run succeeding, or a non-`valid` run failing,
 *     is expected — no re-check, no adapter hit.
 */
async function refreshValidityOnContradiction(input: {
  teamId: TeamId;
  /** The movement that ran: its id + the SOURCE THAT EXECUTED (the live row's
   *  source on a firing; the pinned version's source on a resume). */
  movement: { id: string; source: string };
  outcome: 'success' | 'failure';
}): Promise<void> {
  try {
    const fresh = await getMovementRow({
      teamId: input.teamId as unknown as string,
      id: input.movement.id,
    });
    if (!fresh) return;
    // Version-match: byte-identity is the version equivalence (content-hash
    // dedup). If the source moved on since this run executed, the run is stale
    // evidence about a program that no longer exists.
    if (fresh.source !== input.movement.source) return;
    const contradiction =
      (input.outcome === 'success' && fresh.validityStatus !== 'valid') ||
      (input.outcome === 'failure' && fresh.validityStatus === 'valid');
    if (!contradiction) return;
    // A drift re-check that reads the introspection CACHE can't see drift —
    // the cached schema still describes the pre-drift adapter. Clear it so the
    // re-validation introspects fresh. Scoped to THIS team: a failure here says
    // nothing about anybody else's connections, and busting theirs made every
    // other tenant in the process re-introspect their whole surface.
    if (input.outcome === 'failure') clearIntrospectionCache(input.teamId);
    const validation = await validateMovementForTeam({
      teamId: input.teamId as unknown as string,
      source: fresh.source,
      languageVersion: fresh.languageVersion,
    });
    const assessment = assessMovementValidity({
      diagnostics: validation.diagnostics,
      gaps: validation.gaps,
    });
    await recordValidityOutcome({
      id: fresh.id,
      status: assessment.status,
      reason: assessment.reason,
      sourceHash: movementSourceHash(fresh.source),
      checkedAgainst: fresh.languageVersion,
    });
  } catch (err) {
    logger.warn('[MovementEngine] validity re-check failed', {
      movementId: input.movement.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type MovementFiringInput = {
  teamId: TeamId;
  triggerId: string;
  /** The trigger row's display name (a `listen as "…"` label when aliased) —
   *  recorded on the run, NOT parsed for the fired movement. */
  triggerName: string;
  /** The movement this listener fires (`trigger.fired_movement_name`) — picks
   *  the movement in a multi-movement file. Absent ⇒ fall back to the legacy
   *  name convention, then the file's sole declaration. */
  firedMovementName?: string;
  movementRow: MovementRow;
  event: TriggerEvent;
  recordingTriggerType: TriggerRunTriggerType;
  dryRun?: boolean;
  /** Adopt a pre-created `running` trigger_run row (async manual run — the
   *  caller minted the id so it could return it before this firing started).
   *  Absent ⇒ the recorder mints its own id, as before. */
  existingRunId?: TriggerRunId;
  /** The stored inbound receipt this firing came from, recorded on the run. */
  triggerEventId?: TriggerEventId;
};

/** A fresh firing of a listener's movement. */
export async function runMovementFiring(
  input: MovementFiringInput,
): Promise<MovementFiringOutcome> {
  return withFiringContext(input, () => runMovementFiringInContext(input));
}

async function runMovementFiringInContext(
  input: MovementFiringInput,
): Promise<MovementFiringOutcome> {
  const recorder = new TriggerRunRecorder({
    teamId: input.teamId,
    triggerId: input.triggerId,
    triggerName: input.triggerName,
    triggerType: input.recordingTriggerType,
    triggerEvent: input.event,
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    // Pin the version the run executes against (P11). Null for movements not
    // yet versioned (saved before versioning, or never cleanly saved since).
    movementVersionId: input.movementRow.currentVersionId,
    ...(input.existingRunId !== undefined ? { existingRunId: input.existingRunId } : {}),
    ...(input.triggerEventId !== undefined ? { triggerEventId: input.triggerEventId } : {}),
  });
  await recorder.startOpsRun();
  const movementName = input.firedMovementName ?? firedMovementNameFromTriggerName(input.triggerName);
  // The cooperative cancel gate (runs-and-cancel spec §cancel): reads
  // trigger_run.cancel_requested_at (debounced) so a user-requested cancel stops
  // the run at the next statement / LLM-call boundary. Fail-open — a read fault
  // reads as not-cancelled, so it never stops a healthy run.
  const cancelGate = makeDbCancelGate(recorder.triggerRunId);
  // The run's trace, held here so the recorder can publish it WHILE the run is
  // going. Without this the trace reached the row only at settle, so the one
  // run anybody needs to inspect — the slow one — was the one showing nothing.
  const trace: MovementTraceEntry[] = [];
  try {
    if (!input.dryRun) {
      // A non-parking firing used to create no row at all until it settled, so
      // there was nothing to inspect and nothing for a restart sweep to find.
      // The row now exists as `running` for the life of the firing.
      await recorder.ensureStarted();
      recorder.beginLiveTrace(trace);
    }
    const runFiring = () =>
      interpretMovementFiring({
        teamId: input.teamId,
        movementRow: input.movementRow,
        ...(movementName !== undefined ? { movementName } : {}),
        event: input.event,
        firedAt: recorder.firedAt,
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        // A live firing can park at an `ask`; a dry run never does (test runs
        // don't create durable interactions). The park rows are written + the
        // run flipped to `parked` through this same recorder.
        ...(input.dryRun ? {} : { parksInto: recorder }),
        cancelGate,
        trace,
      });
    const result = await new LlmUsageContext({
      teamId: input.teamId as unknown as string,
      triggerRunId: recorder.triggerRunId as unknown as string,
      cancelGate,
    }).runAsync(runFiring);
    if (result.cancelled) {
      // The user cancelled the run: the engine stopped at a statement / LLM-call
      // boundary (never mid-write, P14). Settle it `failed` + cancel its open
      // asks — do NOT finish() (that would overwrite `failed` with a terminal
      // success/partial, exactly as a parked outcome must skip finish()). Earlier
      // writes stand and still re-dispatch their mutation events — so they go
      // onto the step channel first, or the run settles `failed` claiming it
      // wrote nothing while the records sit in the external systems.
      recorder.recordMovementStep({
        movementId: input.movementRow.id,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      await failRunAndCancelRequests({
        runId: recorder.triggerRunId,
        message: cancelGate.reason() ?? 'Cancelled by an operator',
      }).catch((err) =>
        logger.warn('[MovementEngine] cancel settle failed', {
          runId: recorder.triggerRunId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { result };
    }
    if (result.parked) {
      // The run is parked (the sink already wrote interaction_request +
      // parked_run and marked trigger_run `parked`). Do NOT finish() — that
      // would overwrite the live `parked` row with a terminal status. The run
      // resumes when the answer arrives (a later chunk).
      // The pre-park writes are already in the external systems, so they belong
      // on the firing record NOW: snapshot them onto the run's append-only step
      // channel. The resuming recorder appends its own segment rather than
      // replacing this one.
      recorder.recordMovementStep({
        movementId: input.movementRow.id,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      return { result };
    }
    recorder.recordMovementStep({
      movementId: input.movementRow.id,
      movementName: result.movementName,
      sourceAdapterType: input.event.adapterType,
      result,
    });
    await recorder.finish();
    if (!input.dryRun) {
      await refreshValidityOnContradiction({
        teamId: input.teamId,
        movement: { id: input.movementRow.id, source: input.movementRow.source },
        outcome: 'success',
      });
      // A clean live run closes the movement's open issues (the quiet half
      // of the surprise-success path).
      await resolveMovementIssues({ movementId: input.movementRow.id }).catch(() => {});
    }
    return { result };
  } catch (err) {
    const { error, partial } = unwrapRunFailure(err);
    const message = describeError(error);
    logger.error('[MovementEngine] movement firing failed', {
      triggerId: input.triggerId,
      movementId: input.movementRow.id,
      error: message,
    });
    // A live failure lands in its Sentry-shaped ISSUE (one row per
    // fingerprint) — alerts fire on new/regression/threshold transitions,
    // never per occurrence (layer 2; replaces the old per-failure ping).
    // Test runs (dryRun) are the user experimenting; they stay quiet.
    if (!input.dryRun) {
      await recordMovementFailureIssue({
        teamId: input.teamId as unknown as string,
        movementId: input.movementRow.id,
        movementName: input.movementRow.name,
        triggerName: input.triggerName,
        runId: recorder.triggerRunId as unknown as string,
        message,
      }).catch((issueErr) =>
        logger.warn('[MovementEngine] failed to record failure issue', {
          error: issueErr instanceof Error ? issueErr.message : String(issueErr),
        }),
      );
    }
    recorder.recordStepFailure({
      tgId: `movement:${input.movementRow.id}`,
      tgName: movementName ?? input.movementRow.name,
      sourceAdapterType: input.event.adapterType,
      message,
      ...(partial !== undefined ? { partial } : {}),
    });
    await recorder.finish();
    if (!input.dryRun) {
      await refreshValidityOnContradiction({
        teamId: input.teamId,
        movement: { id: input.movementRow.id, source: input.movementRow.source },
        outcome: 'failure',
      });
    }
    return { result: null, error: message };
  } finally {
    // Belt and braces: `finish()` and `snapshotSteps()` each stop it, but a
    // path that reaches neither must not leave a timer republishing the trace
    // of a firing that is over.
    recorder.endLiveTrace();
  }
}

// ── Entry point (b): resume a parked run (async user interaction §4.7) ───────

/**
 * Resume one parked movement run forward from its parked `ask` leaf. The
 * source is the PINNED version (`pinnedSource` — re-parsed so the AST and every
 * lexical address are byte-identical, P11), NOT the live movement row. The
 * recorder ADOPTS the existing `trigger_run` id so settling UPSERTS that row to
 * its terminal status + records the post-resume movement step (nodes_written
 * reflects the post-ask writes — the deferred step-recording, chunk 3.1 → here).
 *
 * Settle (§5.4): completed → record step + `finish()` (`success`); re-parked
 * deeper → leave the run parked (a new park row was written by the resumed
 * interpreter); an engine `ERROR`/throw → record the failure + `finish()`
 * (`failed`) — the caller cancels the run's open requests (P14: prior writes
 * stand).
 */
type ResumeFiringInput = {
  teamId: TeamId;
  triggerId: string;
  triggerName: string;
  /** The movement this listener fires (`trigger.fired_movement_name`) — picks
   *  the movement in a multi-movement file; falls back to the name convention. */
  firedMovementName?: string;
  /** The pinned version's source (P11) — what resume re-parses + executes. */
  pinnedSource: string;
  /** The pinned version's language version — the one the run STARTED under,
   *  never the movement's pin now (the deploy check may have advanced it
   *  while the run was parked). */
  pinnedLanguageVersion: LanguageVersion;
  movementVersionId: string | null;
  /** The parked run's id — the recorder adopts it so the resume settles the
   *  same row. */
  runId: TriggerRunId;
  movementId: string;
  event: TriggerEvent;
  recordingTriggerType: TriggerRunTriggerType;
  /** The parked leaf's serialised scope (`parked_run.state`). */
  state: ParkedScopeState;
  /** The validated answer to bind as the ask's result. Absent under `reenter`
   *  (an await / recurring-timer resume re-enters at its statement, binding
   *  nothing). */
  answer?: unknown;
  /**
   * Re-enter AT the parked statement (§4.4) rather than stepping past an ask.
   * The await-resume driver passes `true`: the parked statement must be
   * re-evaluated against live data. Defaults to the ask behaviour (false).
   */
  reenter?: boolean;
  /**
   * Multi-leaf settle decision (fan-out / parallel, §5.4). After the engine
   * completes a branch (no re-park, no error), this decides whether the RUN as a
   * whole is now complete: it decrements the leaf's enclosing join's
   * pending-count and reports whether the run still has open siblings. Returns
   * `runComplete: false` ⇒ the leaf finished but the join is still pending →
   * record the step but KEEP the run `parked`. Returns `runComplete: true` ⇒ this
   * was the last open branch → finalise the run `success`. Absent ⇒ the
   * single-ask path (the engine completing IS the run completing — finalise).
   */
  settleBranchComplete?: () => Promise<{ runComplete: boolean }>;
  /** Batch mode (asks-as-adapter chunk C, F18/F21): defer race settlement so the
   *  worker settles once post-batch with all winners. */
  deferRaceSettlement?: boolean;
  /** Post-batch race settlement: when set, this firing SETTLES the named race
   *  frame (build receipt from all winners, cancel losers, run the continuation)
   *  instead of resuming a parked leaf. `state` is any completed branch's state. */
  settleRaceFrameAddress?: string;
};

/** A parked run stepping forward: an ask answered, an await settled, a timer
 *  woken, or a race frame settling its winners. */
export async function resumeMovementFiring(
  input: ResumeFiringInput,
): Promise<MovementFiringOutcome> {
  return withFiringContext(input, () => resumeMovementFiringInContext(input));
}

async function resumeMovementFiringInContext(
  input: ResumeFiringInput,
): Promise<MovementFiringOutcome> {
  const recorder = new TriggerRunRecorder({
    teamId: input.teamId,
    triggerId: input.triggerId,
    triggerType: input.recordingTriggerType,
    triggerEvent: input.event,
    movementVersionId: input.movementVersionId,
    existingRunId: input.runId,
  });
  // Take back the ops feed run the parked firing opened, so finishing here
  // CLOSES it. Without this the recorder's `opsRunId` is null for the whole
  // resumed run and the event stays `running` after the user has answered.
  await recorder.adoptOpsRun();
  const movementName = input.firedMovementName ?? firedMovementNameFromTriggerName(input.triggerName);
  // A resumed run is cancellable too — same cooperative gate, keyed to the
  // adopted run id (runs-and-cancel spec §cancel).
  const cancelGate = makeDbCancelGate(recorder.triggerRunId);
  try {
    const languageVersion = input.pinnedLanguageVersion;
    const teamCatalog = await movementCatalogForTeam(input.teamId, {
      source: input.pinnedSource,
      languageVersion,
    });
    const commonInput = {
      source: input.pinnedSource,
      languageVersion,
      ...(movementName !== undefined ? { movementName } : {}),
      event: input.event,
      teamId: input.teamId,
      // The ORIGINAL firing's instant, read back off the run row by
      // `adoptOpsRun()` above: a run that waited a day on an answer still
      // computes the window it started with.
      firedAt: recorder.firedAt,
      // What the run spent before it parked, read back with its clock: the
      // cost cap is the run's, not the segment's — counted from the run's last
      // resume from a limit pause, which reset its usage.
      priorSpentMicrodollars: recorder.priorSpentMicrodollars,
      capBaselineMicrodollars: recorder.capBaselineMicrodollars,
      // A run paused at its cost limit stays paused: a branch woken by its own
      // event takes it, then suspends before its next statement.
      limitPaused: recorder.limitPaused,
      catalog: teamCatalog.catalog,
      // A resumed run can re-park at a deeper ask — it gets live parks too.
      host: productionEngineHost({
        teamId: input.teamId,
        catalog: teamCatalog,
        parksInto: recorder,
        cancel: cancelGate,
      }),
      state: input.state,
    };
    const resumeFiring = () =>
      input.settleRaceFrameAddress !== undefined
        ? settleRaceFrame({ ...commonInput, frameAddress: input.settleRaceFrameAddress })
        : resumeMovement({
            ...commonInput,
            ...(input.answer !== undefined ? { answer: input.answer } : {}),
            ...(input.reenter !== undefined ? { reenter: input.reenter } : {}),
            ...(input.deferRaceSettlement !== undefined
              ? { deferRaceSettlement: input.deferRaceSettlement }
              : {}),
          });
    const result = await new LlmUsageContext({
      teamId: input.teamId as unknown as string,
      triggerRunId: input.runId as unknown as string,
      cancelGate,
    }).runAsync(resumeFiring);
    if (result.cancelled) {
      // Cancelled mid-resume: settle the run `failed` + cancel its open asks,
      // skipping finish()/markParked() (mirrors the parked/re-park early return).
      // Earlier writes stand (P14) — this segment's go onto the step channel
      // before the settle, appending to whatever the park left there.
      recorder.recordMovementStep({
        movementId: input.movementId,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      await failRunAndCancelRequests({
        runId: input.runId,
        message: cancelGate.reason() ?? 'Cancelled by an operator',
      }).catch((err) =>
        logger.warn('[MovementEngine] cancel settle failed', {
          runId: input.runId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { result };
    }
    if (result.parked) {
      // Re-parked at a deeper ask — the new park rows + `parked` status were
      // written by the sink. Do NOT finish (it resumes again on its answer).
      // This segment's writes go onto the step channel now, same as the first
      // park's: a re-parking resume is not a run that wrote nothing.
      recorder.recordMovementStep({
        movementId: input.movementId,
        movementName: result.movementName,
        sourceAdapterType: input.event.adapterType,
        result,
      });
      await recorder.snapshotSteps();
      return { result };
    }
    // The branch completed. In a fan-out / parallel, completing ONE branch does
    // not complete the run — `settleBranchComplete` decrements the join and tells
    // us whether siblings remain. The step is recorded either way (its writes
    // belong on the firing record); the run is only FINALISED when the last
    // branch closes (§5.4).
    recorder.recordMovementStep({
      movementId: input.movementId,
      movementName: result.movementName,
      sourceAdapterType: input.event.adapterType,
      result,
    });
    const settle = input.settleBranchComplete
      ? await input.settleBranchComplete()
      : { runComplete: true };
    if (settle.runComplete) {
      await recorder.finish();
      // Prediction-rule hook on the resume's terminal success. The executed
      // source is the PINNED version's — the version-match guard inside skips
      // the re-check when the live source has moved on. Parked runs are always
      // live (dry runs never park), so no dryRun gate here.
      await refreshValidityOnContradiction({
        teamId: input.teamId,
        movement: { id: input.movementId, source: input.pinnedSource },
        outcome: 'success',
      });
      await resolveMovementIssues({ movementId: input.movementId }).catch(() => {});
    } else {
      // The branch finished but the join is still pending — persist what this
      // resume wrote (the step channel appends, so a sibling settling at the
      // same moment can't swallow it), but keep the run observably `parked`
      // (other siblings open).
      await recorder.snapshotSteps();
      await recorder.markParked();
    }
    return { result };
  } catch (err) {
    const { error, partial } = unwrapRunFailure(err);
    const message = describeError(error);
    logger.error('[MovementEngine] resume firing failed', {
      triggerId: input.triggerId,
      movementId: input.movementId,
      runId: input.runId,
      error: message,
    });
    recorder.recordStepFailure({
      tgId: `movement:${input.movementId}`,
      tgName: movementName ?? input.movementId,
      sourceAdapterType: input.event.adapterType,
      message,
      ...(partial !== undefined ? { partial } : {}),
    });
    await recorder.finish();
    await refreshValidityOnContradiction({
      teamId: input.teamId,
      movement: { id: input.movementId, source: input.pinnedSource },
      outcome: 'failure',
    });
    await recordMovementFailureIssue({
      teamId: input.teamId as unknown as string,
      movementId: input.movementId,
      movementName: movementName ?? input.movementId,
      triggerName: input.triggerName,
      runId: input.runId as unknown as string,
      message,
    }).catch(() => {});
    return { result: null, error: message };
  }
}

/**
 * Run a fired callback's body as a SEGMENT of its owning run (callback-primitive
 * layer 2). Attribution is the plan's ruling verbatim: the run's team, the run's
 * billing, the run's step ledger — no new run identity anywhere.
 *
 * What this deliberately does NOT do is settle the run. The main continuation is
 * parked and wakes only through its own mechanism, so a completed body records
 * its segment and stops; a body that parks deeper writes its own leaf; and a
 * body that THROWS marks the SEGMENT failed and stops there — a failed side
 * entry must not kill the primary await (the whole point of running off-request
 * on the append-only step channel).
 */
type CallbackFiringInput = {
  teamId: TeamId;
  triggerId: string;
  triggerName: string;
  firedMovementName?: string;
  /** The pinned version's source (P11) — what the stored entry point addresses. */
  pinnedSource: string;
  /** The language version the run started under (see ResumeFiringInput). */
  pinnedLanguageVersion: LanguageVersion;
  movementVersionId: string | null;
  runId: TriggerRunId;
  movementId: string;
  event: TriggerEvent;
  recordingTriggerType: TriggerRunTriggerType;
  /** The CALLBACK row's captured continuation (a `ParkedScopeState` whose
   *  `address` is the callback expression). */
  state: ParkedScopeState;
  /** The fire-time values, already validated against the stored signature. */
  values: Record<string, unknown>;
  /** This call's index in the ledger — the body's own address frame, so
   *  repeated fires of a repeatable callback never collide. */
  callIndex: number;
};

/** A stored callback being fired against its captured continuation. */
export async function fireCallbackFiring(
  input: CallbackFiringInput,
): Promise<MovementFiringOutcome> {
  return withFiringContext(input, () => fireCallbackFiringInContext(input));
}

async function fireCallbackFiringInContext(
  input: CallbackFiringInput,
): Promise<MovementFiringOutcome> {
  const recorder = new TriggerRunRecorder({
    teamId: input.teamId,
    triggerId: input.triggerId,
    triggerType: input.recordingTriggerType,
    triggerEvent: input.event,
    movementVersionId: input.movementVersionId,
    existingRunId: input.runId,
  });
  await recorder.adoptOpsRun();
  const movementName =
    input.firedMovementName ?? firedMovementNameFromTriggerName(input.triggerName);
  const cancelGate = makeDbCancelGate(recorder.triggerRunId);
  try {
    const languageVersion = input.pinnedLanguageVersion;
    const teamCatalog = await movementCatalogForTeam(input.teamId, {
      source: input.pinnedSource,
      languageVersion,
    });
    const fire = () =>
      fireCallbackBody({
        source: input.pinnedSource,
        languageVersion,
        ...(movementName !== undefined ? { movementName } : {}),
        event: input.event,
        teamId: input.teamId,
        // The run's original firing instant (see the resume path) — a callback
        // body belongs to the run that minted it, clock included.
        firedAt: recorder.firedAt,
        priorSpentMicrodollars: recorder.priorSpentMicrodollars,
        capBaselineMicrodollars: recorder.capBaselineMicrodollars,
        catalog: teamCatalog.catalog,
        host: productionEngineHost({
          teamId: input.teamId,
          catalog: teamCatalog,
          parksInto: recorder,
          cancel: cancelGate,
        }),
        state: input.state,
        values: input.values,
        callIndex: input.callIndex,
      });
    const result = await new LlmUsageContext({
      teamId: input.teamId as unknown as string,
      triggerRunId: input.runId as unknown as string,
      cancelGate,
    }).runAsync(fire);
    recorder.recordMovementStep({
      movementId: input.movementId,
      movementName: result.movementName,
      sourceAdapterType: input.event.adapterType,
      result,
    });
    await recorder.snapshotSteps();
    return { result };
  } catch (err) {
    const { error, partial } = unwrapRunFailure(err);
    const message = describeError(error);
    logger.error('[MovementEngine] callback body failed', {
      triggerId: input.triggerId,
      movementId: input.movementId,
      runId: input.runId,
      error: message,
    });
    // The SEGMENT fails; the run does not. `recordStepFailure` + `snapshotSteps`
    // (never `finish()`) is exactly that distinction on the append-only channel.
    recorder.recordStepFailure({
      tgId: `movement:${input.movementId}`,
      tgName: movementName ?? input.movementId,
      sourceAdapterType: input.event.adapterType,
      message,
      ...(partial !== undefined ? { partial } : {}),
    });
    await recorder.snapshotSteps();
    return { result: null, error: message };
  }
}

/** Legacy fallback: recover the fired movement from the old name convention
 *  (`movement/<file>/<movement>`) for rows provisioned before
 *  `fired_movement_name` existed and not yet re-saved. A `listen as "…"`
 *  alias has no movement in its name, so this returns undefined there — the
 *  reason the column is now the source of truth. Undefined ⇒ `runMovement`
 *  requires the file to declare exactly one movement. */
function firedMovementNameFromTriggerName(triggerName: string): string | undefined {
  const parts = triggerName.split('/');
  return parts.length >= 3 ? parts[parts.length - 1] : undefined;
}

/**
 * Load the movement row a movement-derived trigger fires. Null = the row
 * is gone (the FK clears `trigger.movement_id` on delete, so this is a
 * narrow race) — the caller reports it rather than dispatching nothing.
 */
export async function movementForTrigger(input: {
  teamId: TeamId;
  movementId: string;
}): Promise<MovementRow | null> {
  return getMovementRow({
    teamId: input.teamId as unknown as string,
    id: input.movementId,
  });
}
