// The callback ROUTER — the one path every door hands a `cb_` payload to
// (callback-primitive layer 2). Platform doors keep only their genuinely
// platform-shaped plumbing (signature verification, capture-then-ack, the
// after-effects); recognition and execution converge here.
//
// CAPTURE, RESPOND, THEN RUN. `fireCallback` validates + CLAIMS synchronously
// so the caller gets a true outcome to ack with, and returns. The claim writes
// the call's `fire_callback` row in the same transaction, so a recorded call's
// body is never lost. Execution — the body segment and the wake of whoever
// awaits `Called` — happens OFF-REQUEST, under the run's lease (taken before
// the ack) and the SAME per-run single-flight slot the await-resume worker
// uses, so a fire and a resume of one run never overlap, in this process or
// across processes. A run another process is stepping leaves the body to its
// row, made due at once, which runs it once the run is free; a row whose body
// already started does nothing.

import { logger } from 'movement-engine/services/logger';
import { CALLBACK_AWAIT_TYPE } from 'engine-contracts';

import type { WorkHandler } from '../work/kinds';
import type { CallbackParamSpec } from 'engine-contracts';

import { getAutomationsQb } from '../../lib/kysely';
import { SECOND } from '../../constants';
import { fireCallbackFiring } from '../translation_graph/movement/execute';
import { awaitStepper, runResumeSlot } from './await_resume';
import { loadRunContext } from './resume_step';
import { hostedRunHost } from './run_host';
import { triggerRunIdOf } from './run_host_store';
import { takeRunLease, withRunLease, type HeldRunLease } from './run_lease';
import { notifyWork, registerWorkHandler, WorkDeferred } from '../work/drain';
import { enqueueAwaitWake } from './await_wake';
import {
  CallbackBodyPayload,
  runCallbackBody,
  type CallbackBodyOutcome,
  type CallbackBodyRun,
} from 'movement-engine/public/run-host';
import {
  claimCallbackFireWithBody,
  coerceCallbackValues,
  enqueueCallbackBody,
  getCallback,
  callbackRefusal,
  postgresCallbackStore,
  type CallbackRecord,
} from './callback_store';


/** How long after a fire its durable rows (the body's, the wake's) come due.
 *  The body and the prompt wake run in this process right after the claim;
 *  these rows only matter if the process dies before they finish, so they wait
 *  well past a normal body. */
const CALLBACK_BACKSTOP_MS = 30 * SECOND;

/** What the caller acks with. Every non-`recorded` outcome is a REFUSAL the door
 *  reports as such — never a silent no-op. */
export type CallbackFireOutcome =
  /** `queued`: the run was being stepped elsewhere, so the body waits on a
   *  `fire_callback` row rather than starting now (the HTTP door answers 202). */
  | { kind: 'recorded'; callback: CallbackRecord; queued?: true }
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

  // The claim and its body's work row commit together: once a call is on the
  // ledger, its body is durable work, whatever this process does next. The
  // row is due only once the body would long since have run here; the queued
  // row that finds the body started does nothing.
  const claim = await claimCallbackFireWithBody({
    id: input.id,
    values: coerced.values,
    bodyDueAt: new Date(Date.now() + CALLBACK_BACKSTOP_MS),
  });
  switch (claim.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'closed':
      return { kind: 'closed', callback: claim.callback };
    case 'expired':
      return { kind: 'expired', callback: claim.callback };
    case 'recorded': {
      // The ledger already carries this call, so an awaiter woken once its
      // body has started sees it. The index is the body's own address frame.
      // Nothing from here on may refuse the tap: the call is recorded and its
      // body is queued, so a failure only delays the body to its row.
      const callIndex = claim.callback.calls.length - 1;
      await queueWakeBackstop(claim.callback);
      const lease = await takeLeaseOrQueue(claim.callback, callIndex);
      if (lease === null) return { kind: 'recorded', callback: claim.callback, queued: true };
      // EXCLUSIVE, never coalesced: this body belongs to THIS recorded call. The
      // slot's coalescing entry replays its task whenever an arrival lands
      // mid-flight (that is what makes the await drain re-gather), and a replayed
      // body applies its writes a second time under a ledger that still shows one
      // call — exactly the double-write this entry point exists to make
      // structurally impossible.
      const execution = runResumeSlot.exclusive(claim.callback.runId, async () => {
        try {
          await executeFire(claim.callback, callIndex, lease);
        } finally {
          await lease.release();
        }
      });
      if (input.awaitExecution) await execution;
      else void execution.catch(() => {}); // logged inside; never breaks the ack
      return { kind: 'recorded', callback: claim.callback };
    }
  }
}

/** The run's lease for the body to run under now, or null when the body
 *  waits for its row: the run is held elsewhere (the row is made due at
 *  once), or the lease could not be asked for (the row runs at its backstop
 *  time). */
async function takeLeaseOrQueue(callback: CallbackRecord, callIndex: number): Promise<HeldRunLease | null> {
  try {
    const lease = await takeRunLease(callback.runId);
    if (lease === null) {
      await enqueueCallbackBody({ callback, callIndex }, { dueAt: new Date() });
      notifyWork();
    }
    return lease;
  } catch (err) {
    logger.error('[Callback] could not start the body now; its queued row will run it', {
      callbackId: callback.id,
      callIndex,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Whether the run can still take a body: in case revocation has not caught
 *  up with the run's end, a run that is gone or over runs no more of its
 *  bodies. */
async function runIsOpen(runId: string): Promise<boolean> {
  const run = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', triggerRunIdOf(runId))
    .select('status')
    .executeTakeFirst();
  return run !== undefined && (run.status === 'running' || run.status === 'parked');
}

/** A queued body: run it under the run's lease, or defer while the run is
 *  still held. Everything that decides whether it runs is read again under
 *  the lease, where nothing else can change the run. */
export const fireCallbackHandler: WorkHandler = {
  async run(payload) {
    const { callbackId, callIndex } = CallbackBodyPayload.parse(payload);
    const queued = await getCallback(callbackId);
    if (queued === null || queued.calls[callIndex] === undefined) return;
    // The lease first, as `fireCallback` takes it: an entry of this very
    // process stepping the run holds it too, so the row defers rather than
    // queueing in the slot behind a segment that may run for hours.
    const fired = await withRunLease(queued.runId, (lease) =>
      runResumeSlot.exclusive(queued.runId, async () => {
        const callback = await getCallback(callbackId);
        if (callback === null) return;
        // Everything that decides whether it runs is the core's, read again
        // under the lease. Not started because the lease was lost before the
        // body began: the row stays, deferred, for whoever holds the run next.
        const ran = await executeFire(callback, callIndex, lease);
        if (ran.kind === 'refused') {
          logger.info('[Callback] queued body not run', { callbackId, callIndex, reason: ran.reason });
        } else if (ran.kind === 'not_started') {
          throw new WorkDeferred(`run ${queued.runId}'s lease was lost before the body started`);
        }
      }),
    );
    if (fired.kind === 'busy') throw new WorkDeferred(`run ${queued.runId} is held by another process`);
  },
};

export function registerCallbackFireWork(): void {
  registerWorkHandler('fire_callback', fireCallbackHandler);
}


/**
 * Queue the durable half of the wake before the body starts. The prompt wake
 * at the end of `executeFire` is in-process and is lost if the process dies
 * between the claim and the wake; this row is not, and the call is already on
 * the ledger, so the parked await still resolves. When the prompt wake did run,
 * the correlation is gone and this row is a no-op. Coalesced per callback, so a
 * reusable callback tapped many times holds one pending row.
 */
async function queueWakeBackstop(callback: CallbackRecord): Promise<void> {
  try {
    await enqueueAwaitWake(
      { adapterType: CALLBACK_AWAIT_TYPE, teamId: callback.teamId, correlationKey: callback.id },
      {
        coalesceKey: `callback_backstop:${callback.id}`,
        dueAt: new Date(Date.now() + CALLBACK_BACKSTOP_MS),
      },
    );
  } catch (err) {
    // The call is recorded and the prompt wake still runs; only the crash cover
    // is missing, which is worth an error but not a refused tap.
    logger.error('[Callback] could not queue the wake backstop', {
      callbackId: callback.id,
      error: err instanceof Error ? err.message : String(err),
    });
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
 * The off-request half, under the run's lease and single-flight slot: the
 * core's body runner (`runCallbackBody`, the one lf runs) re-checks the call,
 * marks its body started, runs the body, then wakes whoever awaits `Called`.
 * A body-less `callback()` runs an EMPTY body, so the tap is still visible in
 * the run inspector. The wake drains awaits directly, never through the slot
 * (we are already inside it).
 */
async function executeFire(
  callback: CallbackRecord,
  callIndex: number,
  lease: HeldRunLease,
): Promise<CallbackBodyRun> {
  try {
    return await runCallbackBody(hostedRunHost(), postgresCallbackStore, {
      id: callback.id,
      callIndex,
      lease,
      now: new Date().toISOString(),
      runOpen: runIsOpen,
      body: ({ values }) => runBodySegment(callback, { callIndex, values, lease }),
      stepper: awaitStepper,
    });
  } catch (err) {
    // A failing side entry never kills the primary await; a failed wake is
    // covered by the queued backstop wake.
    logger.error('[Callback] fire execution failed (the queued backstop wake will retry)', {
      callbackId: callback.id,
      runId: callback.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'ran', outcome: { kind: 'failed', error: err instanceof Error ? err.message : String(err) } };
  }
}

/** The body: one engine segment entered at the callback, recorded on the run's
 *  step channel. A body that fails fails its segment, never the run. */
async function runBodySegment(
  callback: Pick<CallbackRecord, 'id' | 'teamId' | 'runId' | 'state'>,
  input: { callIndex: number; values: Record<string, unknown>; lease: HeldRunLease },
): Promise<CallbackBodyOutcome> {
  const context = await loadRunContext(callback.runId);
  if ('unresumable' in context) {
    logger.error('[Callback] fired callback has no resumable run context', {
      callbackId: callback.id,
      runId: callback.runId,
      reason: context.unresumable,
    });
    return { kind: 'failed', error: context.unresumable };
  }
  const outcome = await fireCallbackFiring({
    teamId: callback.teamId,
    triggerId: context.triggerId,
    triggerName: context.triggerName,
    ...(context.firedMovementName !== null ? { firedMovementName: context.firedMovementName } : {}),
    pinnedSource: context.pinnedSource,
    pinnedLanguageVersion: context.pinnedLanguageVersion,
    movementVersionId: context.movementVersionId,
    runId: callback.runId,
    movementId: context.movementId,
    event: context.event,
    recordingTriggerType: context.triggerType,
    state: callback.state,
    values: input.values,
    callIndex: input.callIndex,
    lease: input.lease,
  });
  if (outcome.leaseLost) return { kind: 'leaseLost' };
  if (outcome.error !== undefined) return { kind: 'failed', error: outcome.error };
  return { kind: 'ran' };
}
