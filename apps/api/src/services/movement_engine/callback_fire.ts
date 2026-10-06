// The callback ROUTER — the one path every door hands a `cb_` payload to
// (callback-primitive layer 2). Platform doors keep only their genuinely
// platform-shaped plumbing (signature verification, capture-then-ack, the
// after-effects); recognition and execution converge here.
//
// CAPTURE, RESPOND, THEN RUN. `fireCallback` validates + CLAIMS synchronously
// so the caller gets a true outcome to ack with, and returns. Execution — the
// body segment and the wake of whoever awaits `Called` — happens OFF-REQUEST,
// under the SAME per-run single-flight slot the await-resume worker uses, so a
// fire and a resume of one run never overlap.

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { TriggerRunTriggerType } from '../translation_graph/runs/trigger_run';

import { getQb, getAutomationsQb } from '../../lib/kysely';
import type { LanguageVersion } from 'movement-lang';
import { loadPinnedVersion } from '../translation_graph/movement/version_store';
import { logger } from '../logger';
import { loadTriggerById } from '../translation_graph/storage/tg_table';
import { triggerEventSchema, type TriggerEvent } from '../translation_graph/triggers/types';
import { fireCallbackFiring } from '../translation_graph/movement/execute';
import { loadCorrelatedParks } from '../translation_graph/adapters/await_correlation';
import { drainRunAwaits, runResumeSlot } from './await_resume';
import { CALLBACK_AWAIT_TYPE } from './callback_sink';
import { claimCallbackFire, coerceCallbackValues, getCallback, type CallbackRecord } from './callback_store';
import type { CallbackParamSpec } from './callback_types';

/** What the caller acks with. Every non-`recorded` outcome is a REFUSAL the door
 *  reports as such — never a silent no-op. */
export type CallbackFireOutcome =
  | { kind: 'recorded'; callback: CallbackRecord }
  | { kind: 'not_found' }
  /** Revoked (its run ended, was cancelled, or its movement was deleted) or
   *  already fired (single-use). The closed-request-wins ack. */
  | { kind: 'closed'; callback: CallbackRecord }
  | { kind: 'expired'; callback: CallbackRecord }
  | { kind: 'mismatch'; callback: CallbackRecord; message: string };

/**
 * Fire a callback by id. Returns as soon as the claim settles; the body runs
 * off-request unless `awaitExecution` is set (tests and the dev CLI want the
 * whole round trip).
 */
export async function fireCallback(input: {
  id: string;
  /** Raw supplied values — validated against the stored signature BEFORE the
   *  claim, so a bad payload never consumes a single-use callback. */
  values: Record<string, unknown>;
  /** ONE value a platform captured at tap time under a name of its own (Slack's
   *  `selected_date`, an entered `value`) — see {@link bindSuppliedValue}. */
  suppliedValue?: unknown;
  awaitExecution?: boolean;
}): Promise<CallbackFireOutcome> {
  const existing = await getCallback(input.id);
  if (existing === null) return { kind: 'not_found' };

  const bound = bindSuppliedValue(existing.params, input.values, input.suppliedValue);
  if (!bound.ok) return { kind: 'mismatch', callback: existing, message: bound.message };

  const coerced = coerceCallbackValues(existing.params, bound.values);
  if (!coerced.ok) {
    return { kind: 'mismatch', callback: existing, message: coerced.message };
  }

  const claim = await claimCallbackFire({ id: input.id, values: coerced.values });
  switch (claim.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'closed':
      return { kind: 'closed', callback: claim.callback };
    case 'expired':
      return { kind: 'expired', callback: claim.callback };
    case 'recorded': {
      // The ledger already carries this call, so an awaiter woken at any point
      // from here on sees it. The index is the body's own address frame.
      const callIndex = claim.callback.calls.length - 1;
      // EXCLUSIVE, never coalesced: this body belongs to THIS recorded call. The
      // slot's coalescing entry replays its task whenever an arrival lands
      // mid-flight (that is what makes the await drain re-gather), and a replayed
      // body applies its writes a second time under a ledger that still shows one
      // call — exactly the double-write this entry point exists to make
      // structurally impossible.
      const execution = runResumeSlot.exclusive(claim.callback.runId, () =>
        executeFire(claim.callback, callIndex),
      );
      if (input.awaitExecution) await execution;
      else void execution.catch(() => {}); // logged inside; never breaks the ack
      return { kind: 'recorded', callback: claim.callback };
    }
  }
}

// ── What every door shares ────────────────────────────────────────────────
//
// Recognition (`isCallbackId`), execution (`fireCallback`) and the two rules
// below are the whole of a door's callback knowledge. What stays platform-shaped
// is only the plumbing: signature verification, the ack channel, and HOW a
// message is edited.

/**
 * Bind the ONE value a platform captured at tap time. A platform that supplies
 * a value names it in its OWN vocabulary (`selected_date`, `selected_time`, an
 * entered `value`) — never in the callback's — so the router binds it to the
 * FIRST parameter the caller did not already supply by name. Declaration order
 * is the only ordering an author and a platform share, and one anonymous value
 * is all any platform offers, so "first unsupplied" is total.
 *
 * Nowhere to put it is a MISMATCH, not a silent drop: an author who wired a
 * date picker to a callback that takes nothing needs to hear it.
 */
export function bindSuppliedValue(
  params: CallbackParamSpec[],
  values: Record<string, unknown>,
  supplied: unknown,
): { ok: true; values: Record<string, unknown> } | { ok: false; message: string } {
  if (supplied === undefined) return { ok: true, values };
  const target = params.find((p) => !Object.prototype.hasOwnProperty.call(values, p.name));
  if (target === undefined) {
    return {
      ok: false,
      message:
        params.length === 0
          ? 'this control sent a value, but the action it fires takes none'
          : `this control sent a value, but every value the action takes (${params
              .map((p) => `${p.name} (${p.type})`)
              .join(', ')}) was already supplied`,
    };
  }
  return { ok: true, values: { ...values, [target.name]: supplied } };
}

/**
 * Whether a fire has SERVED the interactive purpose of the message it came
 * from — the shared predicate behind every door's platform after-effect (Slack's
 * `replace_original`, Telegram's keyboard clear, WhatsApp's to come). Each door
 * implements its own edit; the rule for WHETHER to edit is this one.
 *
 * A recorded fire on a SINGLE-USE callback means the message has done its job:
 * the controls on it can never do anything again, so leaving them is a lie. A
 * repeatable callback is the opposite — the message stays live and untouched,
 * and the tapper gets a toast only. Every refusal (closed / expired / mismatch)
 * leaves the message alone too: closed-request-wins, so whoever acted first
 * still owns what they see.
 *
 * PROVISIONAL (subject to revision). It preserves today's shipped two-button ask
 * UX exactly — both buttons are single-use, the first tap retires the message,
 * the sibling's later tap gets its own closed ack.
 *
 */
export function interactionServed(outcome: CallbackFireOutcome): boolean {
  return outcome.kind === 'recorded' && outcome.callback.singleUse;
}

/** What a door tells the tapper. Platform-neutral by construction — a toast, an
 *  ephemeral message and a rendered page all want the same sentence. */
export function callbackAckText(outcome: CallbackFireOutcome): string {
  switch (outcome.kind) {
    case 'recorded':
      return 'Thanks — that has been recorded.';
    case 'expired':
      return 'This is no longer available — the time window for it has passed.';
    case 'mismatch':
      // LOUD, never a silent default: the refusal says exactly what was wrong.
      return `That could not be recorded: ${outcome.message}`;
    case 'closed':
    case 'not_found':
      // A callback this store never minted reads exactly like a settled one:
      // nothing moved, and the message says so.
      return 'This request was already closed.';
  }
}

/**
 * The off-request half, under the run's single-flight slot: run the body, then
 * wake whoever awaits `Called`. A body-less `callback()` is not special-cased —
 * it runs an EMPTY body, which is exactly the recorded call plus the wake, and
 * still leaves its segment on the step channel so the tap is visible in the run
 * inspector. Drains awaits DIRECTLY rather than through the slot — we are
 * already inside it.
 */
async function executeFire(callback: CallbackRecord, callIndex: number): Promise<void> {
  try {
    const context = await loadRunContext(callback.runId);
    if (context === null) {
      logger.error('[Callback] fired callback has no resumable run context', {
        callbackId: callback.id,
        runId: callback.runId,
      });
    } else {
      const outcome = await fireCallbackFiring({
        teamId: callback.teamId,
        triggerId: context.triggerId,
        triggerName: context.triggerName,
        ...(context.firedMovementName !== null
          ? { firedMovementName: context.firedMovementName }
          : {}),
        pinnedSource: context.pinnedSource,
        pinnedLanguageVersion: context.pinnedLanguageVersion,
        movementVersionId: context.movementVersionId,
        runId: callback.runId,
        movementId: context.movementId,
        event: context.event,
        recordingTriggerType: context.triggerType,
        state: callback.state,
        values: callback.calls[callIndex]?.values ?? {},
        callIndex,
      });
    }
  } catch (err) {
    // A failing side entry never kills the primary await — it is already
    // recorded on the step channel by the firing wrapper.
    logger.error('[Callback] fire execution failed', {
      callbackId: callback.id,
      runId: callback.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Wake the awaiters LAST: the call is on the ledger, and a body that wrote
  // something the awaiting continuation reads has already written it.
  try {
    const parks = await loadCorrelatedParks({
      adapterType: CALLBACK_AWAIT_TYPE,
      teamId: callback.teamId,
      correlationKey: callback.id,
    });
    if (parks.length > 0) await drainRunAwaits(callback.runId, parks);
  } catch (err) {
    logger.error('[Callback] await wake failed (the poll worker will retry)', {
      callbackId: callback.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface RunContext {
  triggerId: string;
  triggerName: string;
  firedMovementName: string | null;
  movementId: string;
  movementVersionId: string | null;
  pinnedSource: string;
  pinnedLanguageVersion: LanguageVersion;
  event: TriggerEvent;
  triggerType: TriggerRunTriggerType;
}

/** Everything a fire needs to re-enter the run: its pinned source (P11 — the
 *  stored entry point addresses THAT AST), its trigger, its inbound event. */
async function loadRunContext(runId: TriggerRunId): Promise<RunContext | null> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['trigger_id', 'trigger_type', 'trigger_payload', 'movement_version_id'])
    .executeTakeFirst();
  if (!run || !run.trigger_payload) return null;
  const trigger = await loadTriggerById(run.trigger_id);
  if (!trigger || !trigger.movementId) return null;
  if (!run.movement_version_id) return null;
  const version = await loadPinnedVersion(run.movement_version_id);
  if (!version) return null;
  return {
    triggerId: run.trigger_id,
    triggerName: trigger.name,
    firedMovementName: trigger.firedMovementName,
    movementId: trigger.movementId,
    movementVersionId: run.movement_version_id,
    pinnedSource: version.source,
    pinnedLanguageVersion: version.languageVersion,
    event: triggerEventSchema.parse(run.trigger_payload) as TriggerEvent,
    triggerType: run.trigger_type as TriggerRunTriggerType,
  };
}
