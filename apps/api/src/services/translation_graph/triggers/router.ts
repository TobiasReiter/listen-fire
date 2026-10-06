// Trigger router — the entry point for inbound trigger events. Resolves
// the pipeline_input's attachment mode (direct vs message), loads the
// translation graph, builds the mutation context, and dispatches to the
// engine.
//
// Existing trigger sources (polling workers, webhook handlers, mutation
// hooks) call into this module rather than constructing engine contexts
// themselves. This is the seam between "events arrive" and "engine runs".

import { handleError } from '../../../lib/errors';
import { logger } from '../../logger';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import { resolveAdapter } from '../adapters/resolve';
import type { EvaluationResult } from '../engine/types';
import {
  shouldDropAsNativeEcho,
  type PlatformTokenRegistry,
} from '../engine/platform_token_registry';
import { loadTriggerById } from '../storage/tg_table';
import {
  TriggerRunRecorder,
  type TriggerRunTriggerType,
} from '../runs/trigger_run';
import type { TriggerEvent } from './types';
import { runModeGate } from './run_mode';
import { consultEchoSuppression } from './echo_suppression';
import { consultActorGate } from './actor_gate';
import { markTriggerEventSuppressed } from './event_store';
import * as loopGuard from '../../loop_guard';
import { isWriteEffect } from '../../movement_engine/expression';
import { notifyBreach } from '../../loop_guard/notify';
import { resolveThresholds } from '../../loop_guard/thresholds';
import { neverAsAny } from '../../../lib/utils/types';
import {
  movementForTrigger,
  runMovementFiring,
} from '../movement/execute';

// ── Trigger-id dispatch (R, 2026-05-28) ───────────────────────────────────
//
// Inbound resolvers find a `automations.trigger` row and dispatch via this
// entry point. A movement-derived trigger fires through the movement engine;
// legacy (non-movement) triggers are dropped — the TG execution engine has
// been retired (plans/2026-06-14-kill-tg).

export interface TriggerIdDispatchInput {
  /** The pre-resolved trigger id (caller already looked this up). */
  triggerId: string;
  /** The inbound event to dispatch. */
  event: TriggerEvent;
  /** Team scope (matches the trigger's team_id). */
  teamId: TeamId;
  /** Layer 14.4 echo-drop registry. */
  platformTokenRegistry?: PlatformTokenRegistry;
  /** Optional override for the trigger_type recorded on tg_run rows. */
  recordingTriggerType?: TriggerRunTriggerType;
  /** Dry-run mode — captures writes instead of committing. */
  dryRun?: boolean;
  /**
   * The durable `trigger_event` receipt id for this event, when the caller
   * stored one upstream. Enables the loop guard's QUEUE-DON'T-DROP: on a rate
   * throttle the guard schedules a delayed re-dispatch of THIS stored receipt,
   * so the event is held and released later, never lost. Absent for
   * synchronous user-driven runs (run-now / web submission), which can't be
   * deferred — those degrade to record-and-skip-and-flag (the receipt stays at
   * status='received', replayable) rather than silently dropping.
   *
   * queue-don't-drop
   */
  storedEventId?: TriggerEventId;
  /**
   * Adopt an EXISTING `trigger_run` id for a movement firing rather than
   * minting a fresh one inside the recorder. The async manual-run path
   * (run_now.ts `runMovementAsync`) pre-creates a `running` trigger_run so it
   * can return the id to the caller IMMEDIATELY, then enqueues this dispatch
   * off the request cycle; the firing's recorder upserts THAT row to its
   * terminal status. Absent ⇒ the firing mints its own id, as before.
   */
  existingRunId?: TriggerRunId;
}

export interface TriggerIdDispatchResult {
  /** TG entries that ran. One element per non-placeholder binding. */
  evaluations: Array<{ triggerEntryId: string; result: EvaluationResult }>;
  /**
   * Movement firings this dispatch executed (movement-derived triggers
   * run through the movement engine, not the TG evaluations above).
   * Surfaced so direct injectors — Run-now's manual-channel injection —
   * can report what the firing did without a second source of truth.
   */
  movementFirings?: Array<{
    movementName: string;
    /** Writes the firing applied (program-order count). */
    writes: number;
    /** The firing rehearsed (run_mode dry_run or an explicit dry run). */
    dryRun: boolean;
  }>;
  /** Why the dispatch produced no evaluations, when applicable. */
  droppedReason?:
    | 'native_echo'
    | 'trigger_not_found'
    | 'no_bound_tgs'
    | 'run_mode_off'
    // Loop-guard dispositions (Phase 1). `loop_guard_paused`: a team-budget
    // breach already paused this automation; the run is skipped, the receipt
    // stays replayable. `loop_guard_throttled`: a per-trigger rate breach held
    // this run; the stored receipt is re-dispatched after a delay (queue-don't-
    // drop), or flagged for replay when no receipt was provided.
    | 'loop_guard_paused'
    | 'loop_guard_throttled'
    // Opt-in echo-suppression (Phase 2). `echo_suppressed`: this listen has
    // `suppress_self` on and the SOURCE adapter confirmed WE authored this
    // inbound change — the firing is skipped so the author's 2-way sync
    // doesn't self-echo. The event is RECORDED as suppressed (replayable),
    // not dropped. Distinct from `native_echo` (the always-on Layer 14.4
    // token-registry drop) — this one is opt-in and capability-gated.
    | 'echo_suppressed'
    // Ownership gate (§6.4b): the source adapter requires a REGISTERED actor
    // on inbound events, and this event's actor didn't resolve to one — the
    // bot's own echo and unregistered senders drop by the same rule. The
    // event is RECORDED as suppressed (replayable), never silent.
    | 'actor_unregistered'
    // The trigger carries no movementId — a legacy TG-orchestration binding.
    // The TG execution engine has been retired (plans/2026-06-14-kill-tg), so
    // only movement-derived triggers execute; there is nothing to dispatch.
    | 'no_movement';
  /**
   * Per-binding orchestration-walk failures. A bound, authored automation
   * that THREW (e.g. a missing target credential) lands here rather than
   * silently producing zero evaluations — so callers can tell "errored"
   * apart from "nothing to do" and surface the real reason.
   */
  errors?: Array<{ triggerEntryId: string; message: string }>;
}

/**
 * Dispatch an inbound event for a given trigger. Movement-derived triggers
 * fire through `runMovementFiring`; legacy (non-movement) triggers are
 * dropped — the TG execution engine has been retired
 * (plans/2026-06-14-kill-tg).
 */
export async function dispatchTriggerByIdEvent(
  input: TriggerIdDispatchInput,
): Promise<TriggerIdDispatchResult> {
  // 1. Layer 14.4 echo-drop at entry (matches `routeTrigger`).
  if (input.platformTokenRegistry && input.event.actor) {
    const drop = await shouldDropAsNativeEcho({
      registry: input.platformTokenRegistry,
      teamId: input.teamId,
      adapterType: input.event.adapterType,
      actor: input.event.actor,
    });
    if (drop) {
      logger.info('[TGRouter] dispatchTriggerByIdEvent dropped as Listen-Fire echo', {
        triggerId: input.triggerId,
        adapterType: input.event.adapterType,
      });
      return { evaluations: [], droppedReason: 'native_echo' };
    }
  }

  const triggerRow = await loadTriggerById(input.triggerId);
  if (!triggerRow) {
    logger.warn('[TGRouter] dispatchTriggerByIdEvent: trigger not found', {
      triggerId: input.triggerId,
    });
    return { evaluations: [], droppedReason: 'trigger_not_found' };
  }

  // run_mode gate (sits on top of `onlyAuthored`): `off` drops the event,
  // `dry_run` runs the orchestration but captures writes instead of
  // committing, `live` dispatches normally. An explicit `input.dryRun`
  // (e.g. a test-run) still forces dry-run regardless of the stored mode.
  const gate = runModeGate(triggerRow.runMode);
  if (!gate.dispatch) {
    logger.info('[TGRouter] dispatchTriggerByIdEvent dropped: run_mode off', {
      triggerId: input.triggerId,
    });
    return { evaluations: [], droppedReason: gate.droppedReason };
  }
  const dryRun = input.dryRun || gate.dryRun;

  // ── LOOP GUARD (Phase 1, the safety floor) ───────────────────────────────
  // The cause-agnostic backstop, consulted ONCE per run, composed with the
  // run_mode gate above (the established "don't run this" precedent). It does
  // two things, in order:
  //   (a) honour an EXISTING guard-pause — a prior team-budget breach already
  //       parked this automation; skip the run (the receipt is replayable).
  //   (b) EVALUATE this run against the floor — a team-budget breach pauses;
  //       a per-trigger rate breach throttles (queue-don't-drop).
  // Both are skipped under dry-run (a rehearsal can't loop in production) and
  // both FAIL OPEN — the evaluate() call and the paused-state read are
  // wrapped so any guard error allows the run.
  if (!dryRun) {
    const guardDisposition = await applyLoopGuard({
      triggerId: input.triggerId,
      teamId: input.teamId,
      triggerName: triggerRow.name,
      movementId: triggerRow.movementId,
      storedEventId: input.storedEventId,
    });
    if (guardDisposition) return { evaluations: [], droppedReason: guardDisposition };
  }

  // ── OPT-IN ECHO-SUPPRESSION (Phase 2, the 2-way-sync tool — NOT a guard) ──
  // Sits at the inbound boundary alongside the floor + run_mode gate. If this
  // listen has `suppress_self` on AND the source adapter confirms WE authored
  // this change, skip the firing so the author's A↔B sync doesn't self-echo.
  // Default off (no flag) → no consult. On but the adapter can't answer → a
  // clearly-logged no-op (the author asked for something this source can't do).
  // Skipped under dry-run (a rehearsal can't echo into production).
  if (!dryRun) {
    const sourceAdapter = await resolveAdapter({
      adapterType: input.event.adapterType,
      teamId: input.teamId,
      credentialsId: triggerRow.credentialsId ?? undefined,
    });
    const disposition = await consultEchoSuppression({
      triggerConfig: triggerRow.config,
      sourceAdapter,
      event: input.event,
      triggerId: input.triggerId,
    });
    if (disposition.kind === 'suppress') {
      logger.info('[TGRouter] dispatch suppressed as the author\'s own echo (suppress_self)', {
        triggerId: input.triggerId,
        adapterType: input.event.adapterType,
        reason: disposition.reason,
      });
      // Recorded, not dropped: the stored receipt is marked suppressed and
      // stays replayable. No receipt (synchronous run) → still skipped; the
      // disposition is surfaced to the caller.
      if (input.storedEventId !== undefined) {
        await markTriggerEventSuppressed(input.storedEventId, disposition.reason);
      }
      return { evaluations: [], droppedReason: 'echo_suppressed' };
    }
    if (disposition.kind === 'no-op') {
      logger.warn('[TGRouter] suppress_self on but unanswerable — firing as normal', {
        triggerId: input.triggerId,
        note: disposition.note,
      });
    }

    // ── OWNERSHIP GATE (§6.4b — registered actors only, where declared) ────
    // After echo suppression (both consult the source adapter; echo answers
    // "did WE write this", this answers "is the sender one of ours"). Slack
    // is the declaring adapter today: its parser forwards every inner event,
    // bots included, so without this a listen+reply movement replies to its
    // own replies forever. Fail closed; the suppressed receipt is replayable.
    const actorGate = await consultActorGate({
      teamId: input.teamId,
      sourceAdapter,
      event: input.event,
    });
    if (actorGate.kind === 'drop') {
      logger.info('[TGRouter] dispatch dropped — inbound actor is not a registered user (ownership gate)', {
        triggerId: input.triggerId,
        adapterType: input.event.adapterType,
        reason: actorGate.reason,
      });
      if (input.storedEventId !== undefined) {
        await markTriggerEventSuppressed(input.storedEventId, actorGate.reason);
      }
      return { evaluations: [], droppedReason: 'actor_unregistered' };
    }
  }

  const recordingTriggerType: TriggerRunTriggerType =
    input.recordingTriggerType ?? mapRecordingTriggerType(input.event.triggerType);

  // A movement-derived trigger (6_engine.md) fires through `runMovement`
  // on the canonical text — the movement engine is the only executor;
  // the trigger row is purely the dispatch index and carries no
  // orchestration. Hand-authored triggers fall through to the run_tg
  // path below, untouched. Failure containment lives inside
  // `runMovementFiring`: a thrown engine error records a FAILED
  // trigger_run and comes back as a value — dispatch never crashes.
  if (triggerRow.movementId !== null) {
    const movementRow = await movementForTrigger({
      teamId: input.teamId,
      movementId: triggerRow.movementId,
    });
    if (!movementRow) {
      logger.warn('[TGRouter] dispatchTriggerByIdEvent: movement row not found', {
        triggerId: input.triggerId,
        movementId: triggerRow.movementId,
      });
      return {
        evaluations: [],
        errors: [
          {
            triggerEntryId: input.triggerId,
            message: `movement ${triggerRow.movementId} not found for trigger ${input.triggerId}`,
          },
        ],
      };
    }
    const firing = await runMovementFiring({
      teamId: input.teamId,
      triggerId: input.triggerId,
      triggerName: triggerRow.name,
      ...(triggerRow.firedMovementName !== null
        ? { firedMovementName: triggerRow.firedMovementName }
        : {}),
      movementRow,
      event: input.event,
      recordingTriggerType,
      dryRun,
      ...(input.existingRunId !== undefined ? { existingRunId: input.existingRunId } : {}),
      ...(input.storedEventId !== undefined ? { triggerEventId: input.storedEventId } : {}),
    });
    if (firing.result) {
      // Feed the writes this firing applied into the team's external-write
      // budget (multi-dimensional floor). Fire-and-forget + fail-open — never
      // block dispatch on guard accounting. Skipped under dry-run (no writes
      // actually landed).
      // A record a `match` found is on the run log but wrote nothing.
      const written = firing.result.writes.filter(isWriteEffect).length;
      if (!dryRun && written > 0) {
        loopGuard
          .recordExternalWrites({
            teamId: input.teamId,
            count: written,
          })
          .catch(handleError);
      }
      return {
        evaluations: [],
        movementFirings: [
          {
            movementName: firing.result.movementName,
            writes: written,
            dryRun,
          },
        ],
      };
    }
    return {
      evaluations: [],
      errors: [
        { triggerEntryId: input.triggerId, message: firing.error ?? 'movement firing failed' },
      ],
    };
  }

  // A trigger with no movementId is a legacy TG-orchestration binding. The TG
  // execution engine has been retired (plans/2026-06-14-kill-tg) — only
  // movement-derived triggers execute. Nothing to dispatch.
  logger.warn('[TGRouter] dispatchTriggerByIdEvent: trigger has no movement; TG dispatch retired', {
    triggerId: input.triggerId,
  });
  return { evaluations: [], droppedReason: 'no_movement' };
}

/**
 * The loop-guard check for one dispatch. Returns a `droppedReason` when the run
 * must be SUPPRESSED (and arranges the queue-don't-drop / pause side effects),
 * or `undefined` to let dispatch proceed.
 *
 * Fail-open is enforced here too: the guard-paused read and `evaluate()` both
 * already swallow their own errors, but this wrapper additionally try/catches so
 * a guard fault can never crash dispatch — it allows the run.
 *
 */
async function applyLoopGuard(input: {
  triggerId: string;
  teamId: TeamId;
  triggerName: string;
  movementId: string | null;
  storedEventId?: string;
}): Promise<'loop_guard_paused' | 'loop_guard_throttled' | undefined> {
  try {
    // (a) Already guard-paused? Skip the run. The receipt was stored upstream,
    //     so the paused automation's backlog is the recorded trigger_events,
    //     replayable once a human resumes. We honour the pause even in observe
    //     mode — a human (or the guard in a prior enforce window) set it
    //     deliberately, and observe-mode only governs whether the guard sets
    //     NEW pauses, not whether it respects existing ones.
    const paused = await loopGuard.loadGuardPausedState(input.triggerId);
    if (paused.pausedAt !== null) {
      logger.info('[LoopGuard] dispatch skipped — automation guard-paused', {
        triggerId: input.triggerId,
        signal: paused.signal,
        reason: paused.reason,
      });
      return 'loop_guard_paused';
    }

    // (b) Evaluate this run against the floor.
    const decision = await loopGuard.evaluate({
      teamId: input.teamId,
      triggerId: input.triggerId,
      movementId: input.movementId,
      triggerName: input.triggerName,
    });

    if (decision.kind === 'allow') return undefined;

    if (decision.kind === 'pause') {
      // Observe mode: the decision was already logged as "would-pause" by
      // evaluate(); do nothing else and let the run proceed.
      if (!decision.enforced) return undefined;
      const { newlyPaused } = await loopGuard.setGuardPaused({
        triggerId: input.triggerId,
        reason: decision.reason,
        signal: decision.signal,
      });
      if (newlyPaused) {
        const t = resolveThresholds();
        // Fire-and-forget — a notify failure must never break dispatch.
        notifyBreach({
          teamId: input.teamId,
          triggerId: input.triggerId,
          triggerName: input.triggerName,
          signal: decision.signal,
          reason: decision.reason,
          observed: t.teamRunsPerWindow + 1,
          limit: t.teamRunsPerWindow,
          windowSeconds: t.teamWindowSeconds,
        }).catch(handleError);
      }
      return 'loop_guard_paused';
    }

    if (decision.kind === 'throttle') {
      if (!decision.enforced) return undefined;
      // QUEUE-DON'T-DROP. If the caller gave us a durable receipt id, schedule a
      // delayed re-dispatch of that stored event — held now, released after the
      // rate window, never lost. If not (synchronous user-driven runs have no
      // stored receipt to replay), degrade gracefully to record-and-skip: the
      // run is skipped but the event is NOT dropped — its trigger_event receipt
      // (stored upstream of dispatch) stays at status='received' and is
      // replayable. We log the degraded path explicitly.
      if (input.storedEventId !== undefined) {
        scheduleDeferredReplay({
          storedEventId: input.storedEventId,
          delayMs: decision.retryAfterMs,
          triggerId: input.triggerId,
        });
      } else {
        logger.warn(
          '[LoopGuard] throttled with no durable receipt — degrading to ' +
            'record-and-skip (event remains replayable, NOT dropped)',
          { triggerId: input.triggerId, reason: decision.reason },
        );
      }
      return 'loop_guard_throttled';
    }

    return neverAsAny(decision);
  } catch (err) {
    // FAIL-OPEN — never block a legitimate run on a guard fault.
    logger.warn('[LoopGuard] applyLoopGuard threw — failing open (allowing run)', {
      triggerId: input.triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Schedule a held event's release: after `delayMs`, re-dispatch the stored
 * trigger_event receipt through the normal replay path. The receipt's status is
 * reset to 'received' so the replay re-runs it. This is an in-process timer —
 * adequate for Phase 1's short rate windows; a durable scheduler (survives a
 * process restart) is a follow-up, and the receipt is always replayable by hand
 * meanwhile so nothing is lost even if the timer is dropped.
 */
function scheduleDeferredReplay(input: {
  storedEventId: string;
  delayMs: number;
  triggerId: string;
}): void {
  logger.info('[LoopGuard] event held — scheduling delayed release (queue-don\'t-drop)', {
    triggerId: input.triggerId,
    storedEventId: input.storedEventId,
    delayMs: input.delayMs,
  });
  // Lazy import to avoid a module cycle (event_store imports router).
  setTimeout(() => {
    void (async () => {
      try {
        const { dispatchStoredTriggerEvent, resetTriggerEventToReceived } =
          await import('./event_store');
        await resetTriggerEventToReceived(input.storedEventId);
        await dispatchStoredTriggerEvent(input.storedEventId);
      } catch (err) {
        logger.error('[LoopGuard] deferred replay failed (event still replayable by hand)', {
          storedEventId: input.storedEventId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, input.delayMs).unref?.();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapRecordingTriggerType(eventTriggerType: string): TriggerRunTriggerType {
  if (eventTriggerType === 'snapshot') return 'snapshot';
  if (eventTriggerType === 'mutation') return 'mutation';
  return 'webhook';
}
