// The shared inbound-dispatch tail. Both the webhook handler
// (`webhook_sync/handler.ts`) and the poll-source worker
// (`poll_source/worker.ts`) produce `DiscriminableEvent`s — one from an
// async `Adapter.preprocessInbound` intercept, the other from a
// `PollSource.getEvents` pull — and from here on the path is identical:
// discriminate the event into a concrete root type, build the `TriggerEvent`,
// store a durable receipt, and dispatch to the movement engine. This module is
// that common tail, so the two front doors stay the only difference between the
// webhook and poll inbound paths.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from '../../logger';
import type { WorkHandler } from '../../work/kinds';
import { registerWorkHandler } from '../../work/drain';
import { enqueueWork } from '../../work/store';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { DiscriminableEvent, EventType } from '../adapter';
import type { TriggerType } from '../mutation_context';
import { triggerEventSchema, type TriggerEvent } from './types';
import { discriminateEvent } from '../engine/inbound/discriminate';
import { dispatchTriggerByIdEvent } from './router';
import {
  storeTriggerEvent,
  markTriggerEventDispatched,
  markTriggerEventFailed,
} from './event_store';
import { platformTokenRegistry } from '../engine/platform_token_registry_db';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { SECOND } from '../../../constants';
import { isOrphanedRunningRun } from '../runs/trigger_run';
import { settleUnresumableRun } from '../../interaction/run_failure';

/** One trigger's durable receipt for one inbound event — the handoff between
 *  the capture half (pre-ack) and the dispatch half (post-ack), carried as the
 *  `dispatch_event` work payload, so it stays plain JSON. */
export interface CapturedTriggerEvent {
  triggerId: TriggerId;
  teamId: TeamId;
  triggerEvent: TriggerEvent;
  /** Absent when the receipt store itself failed — dispatch still runs, just
   *  unreceipted (losing the event entirely would be worse than losing its
   *  audit row). */
  storedEventId?: string;
  /** A redelivery whose receipt already exists — dispatch MUST be skipped. */
  duplicate: boolean;
}

export interface DiscriminableEventInput {
  triggerId: TriggerId;
  movementId: string | null;
  event: DiscriminableEvent;
  /** Resolved adapter slug. */
  adapterType: string;
  triggerType: TriggerType;
  /** The adapter's `listEventTypes()` union, fetched once by the caller. */
  eventTypes: readonly EventType[];
  teamId: TeamId;
  now?: Date;
  /**
   * Re-throw a dispatch failure after recording it, so the test-harness inject
   * response can surface the engine error synchronously. The webhook handler
   * sets this for test-harness teams; the poll worker leaves it false (its
   * per-row try/catch already isolates failures and it has no live caller to
   * surface to).
   */
  surfaceErrors?: boolean;
}

/**
 * Dispatch ONE normalized inbound event to ONE movement-derived trigger.
 *
 * Movement-derived triggers (`movementId` set) are the only inbound execution
 * surface — a trigger with no movement is dropped here. The caller owns
 * fan-out: the webhook handler loops (event × candidate trigger); the poll
 * worker loops (event) over the single polled trigger.
 *
 * Capture-then-dispatch back to back. A front door that acks its sender before
 * running the movement (the webhook_sync door) calls the two halves separately
 * instead — `captureDiscriminableEvent` and `enqueueCapturedEvents` pre-ack, the
 * `dispatch_event` work row running `dispatchCapturedTriggerEvent` after — so the
 * receipt and its row are durable before the 200 and no movement runs inside
 * the request.
 */
export async function dispatchDiscriminableEvent(
  input: DiscriminableEventInput,
): Promise<void> {
  const captured = await captureDiscriminableEvent(input);
  if (captured === null) return;
  await dispatchCapturedTriggerEvent({
    captured,
    ...(input.surfaceErrors ? { surfaceErrors: true } : {}),
  });
}

/**
 * Capture half: discriminate the event, build the `TriggerEvent`, and store the
 * durable receipt. Everything here is cheap and local — no movement runs — so
 * an acking front door can complete this inside the request cycle.
 *
 * `null` means there is nothing to dispatch (no movement bound to the trigger).
 */
export async function captureDiscriminableEvent(
  input: DiscriminableEventInput,
): Promise<CapturedTriggerEvent | null> {
  const {
    triggerId,
    movementId,
    event,
    adapterType,
    triggerType,
    eventTypes,
    teamId,
  } = input;
  const now = input.now ?? new Date();

  if (movementId === null) return null;

  // Discriminate into a concrete root type (honours a pre-set `tag`) so the
  // engine seeds a typed record position rather than the raw payload.
  let rootRecordType: string | undefined;
  if (eventTypes.length > 0) {
    const discriminated = discriminateEvent({ adapterType, event, eventTypes });
    if (discriminated) {
      rootRecordType = discriminated.eventType.positionType;
    } else {
      logger.info('[InboundDispatch] event matched no declared event type', {
        triggerId,
        adapterType,
      });
    }
  }

  // The external-side record type: the source's own type id when the adapter
  // names it directly (Attio's object id), else the discriminated position
  // type (the poll path's behaviour).
  const externalRecordRefType = event.recordType ?? rootRecordType;

  const triggerEvent: TriggerEvent = {
    pipelineInputId: `trigger:${triggerId}`,
    adapterType,
    triggerType,
    payload: event.payload,
    ...(event.changeType ? { changeType: event.changeType } : {}),
    ...(rootRecordType ? { rootRecordType } : {}),
    ...(event.externalId !== undefined
      ? {
          externalRecordRef: {
            adapterType,
            externalId: event.externalId,
            ...(externalRecordRefType ? { recordType: externalRecordRefType } : {}),
          },
        }
      : {}),
    ...(event.actor ? { actor: event.actor } : {}),
    ...(event.changedFields ? { changedFields: event.changedFields } : {}),
    ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    occurredAt: event.occurredAt ?? now.toISOString(),
  };

  // Durable receipt before dispatch — a crash mid-run loses nothing and any
  // event can be played back. Idempotent on the source's delivery id: a
  // redelivery (Slack retries an event it didn't 200 in time) comes back
  // `duplicate` and the dispatch half skips it — the first delivery already
  // owns the run. A store failure yields no id: the event still dispatches,
  // unreceipted, because losing the run is worse than losing its audit row.
  const stored = await storeTriggerEvent({
    teamId,
    triggerId,
    event: triggerEvent,
  }).catch((err) => {
    logger.error('[InboundDispatch] failed to store trigger event', {
      triggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  });
  if (stored?.duplicate) {
    logger.info('[InboundDispatch] duplicate delivery ignored', {
      triggerId,
      idempotencyKey: event.idempotencyKey,
    });
  }

  return {
    triggerId,
    teamId,
    triggerEvent,
    ...(stored?.id !== undefined ? { storedEventId: stored.id } : {}),
    duplicate: stored?.duplicate === true,
  };
}

/**
 * Dispatch half: hand a captured receipt to the movement engine and record the
 * outcome on the receipt. This is the expensive part — it runs movements — so
 * the acking front door calls it after its 200.
 *
 * A duplicate capture never dispatches: the first delivery already owns the run.
 */
export async function dispatchCapturedTriggerEvent(input: {
  captured: CapturedTriggerEvent;
  /** See `DiscriminableEventInput.surfaceErrors`. */
  surfaceErrors?: boolean;
}): Promise<void> {
  const { captured } = input;
  const { triggerId, teamId, triggerEvent, storedEventId } = captured;
  if (captured.duplicate) return;

  try {
    const result = await dispatchTriggerByIdEvent({
      triggerId,
      event: triggerEvent,
      teamId,
      platformTokenRegistry,
      storedEventId,
    });
    // A dropped event (actor-unregistered ownership gate, opt-in echo
    // suppression, or any other `droppedReason`) means the router already
    // owns the receipt's outcome — it marked it 'suppressed' with a reason
    // where applicable, or otherwise never touched it. Only a dispatch that
    // actually ran gets marked 'dispatched' here; overwriting a drop would
    // clobber the audit trail (status back to 'dispatched', reason nulled)
    // even though nothing ran.
    if (storedEventId !== undefined && result.droppedReason === undefined) {
      await markTriggerEventDispatched(storedEventId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (storedEventId !== undefined) await markTriggerEventFailed(storedEventId, message);
    logger.error('[InboundDispatch] dispatch failed', { triggerId, error: message });
    if (input.surfaceErrors) throw err;
  }
}

const capturedTriggerEventSchema = z.object({
  triggerId: z.custom<TriggerId>((value) => typeof value === 'string'),
  teamId: z.custom<TeamId>((value) => typeof value === 'string'),
  // A source's own timestamp may carry an offset; the receipt is replayed as
  // received, so the row must accept whatever capture accepted.
  triggerEvent: triggerEventSchema.extend({
    occurredAt: z.string().datetime({ offset: true }).optional(),
  }),
  storedEventId: z.string().optional(),
  duplicate: z.boolean(),
});

function parseCapturedTriggerEvent(payload: unknown): CapturedTriggerEvent {
  const parsed = capturedTriggerEventSchema.parse(payload);
  return {
    triggerId: parsed.triggerId,
    teamId: parsed.teamId,
    // The schema's `recordId` is a plain string; every reader of a stored
    // TriggerEvent names it as the branded node id the same way.
    triggerEvent: parsed.triggerEvent as TriggerEvent,
    ...(parsed.storedEventId !== undefined ? { storedEventId: parsed.storedEventId } : {}),
    duplicate: parsed.duplicate,
  };
}

async function receiptStatus(storedEventId: string): Promise<string | undefined> {
  const row = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', '=', storedEventId as TriggerEventId)
    .select('status')
    .executeTakeFirst();
  return row?.status;
}

/** One work row per receipt that still needs a run. Keyed on the receipt, so a
 *  re-enqueue of the same receipt collapses onto the row already waiting. A
 *  redelivery of a receipt that never ran (still `received`) queues it again:
 *  its row may have been lost after the receipt landed. */
export async function enqueueCapturedEvents(captured: CapturedTriggerEvent[]): Promise<void> {
  for (const receipt of captured) {
    if (receipt.duplicate) {
      if (receipt.storedEventId === undefined) continue;
      if ((await receiptStatus(receipt.storedEventId)) !== 'received') continue;
    }
    await enqueueWork({
      kind: 'dispatch_event',
      key: `dispatch_event:${receipt.storedEventId ?? randomUUID()}`,
      teamId: receipt.teamId,
      // The row runs the stored receipt, which is not itself a redelivery.
      payload: { ...receipt, duplicate: false },
    });
  }
}

// A segment beats every 5s (the recorder's live-trace tick); a minute of
// silence is a dead process, not a slow one. Same rule as timer_resume.ts.
const ORPHAN_AFTER = 60 * SECOND;

const UNFINISHED_SEGMENT = 'segment did not complete: lease lapsed or the previous attempt failed';

/** The latest run started from this receipt (a replay starts another). */
async function runForReceipt(
  storedEventId: string,
): Promise<{ id: TriggerRunId; status: string } | undefined> {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('trigger_event_id', '=', storedEventId as TriggerEventId)
    .orderBy('started_at', 'desc')
    .select(['id', 'status'])
    .executeTakeFirst();
}

/** Runs one captured receipt. A dispatch failure is recorded on the receipt,
 *  not thrown, so the row completes rather than re-running a failed movement. */
export const dispatchEventHandler: WorkHandler = {
  async run(payload) {
    const captured = parseCapturedTriggerEvent(payload);
    // A row re-armed by a redelivery while its first run was going runs again
    // once that run settles; by then the receipt says it already ran.
    if (
      captured.storedEventId !== undefined &&
      (await receiptStatus(captured.storedEventId)) !== 'received'
    ) {
      return;
    }
    await dispatchCapturedTriggerEvent({ captured });
  },

  // A re-claim after a lapsed lease or a throw. The first attempt may have
  // started a run: an orphaned one fails with its receipt, a live one is left
  // to finish where it runs, and a settled or parked one means the dispatch
  // happened and only the receipt's mark was lost.
  async recover(payload, ctx) {
    const captured = parseCapturedTriggerEvent(payload);
    const { storedEventId } = captured;
    if (storedEventId === undefined) {
      await dispatchEventHandler.run(payload, ctx);
      return;
    }
    if ((await receiptStatus(storedEventId)) === 'dispatched') return;
    const run = await runForReceipt(storedEventId);
    if (run === undefined) {
      await dispatchEventHandler.run(payload, ctx);
      return;
    }
    if (run.status === 'running') {
      if (await isOrphanedRunningRun(run.id, { now: ctx.now, staleAfterMs: ORPHAN_AFTER })) {
        await settleUnresumableRun({ runId: run.id, reason: UNFINISHED_SEGMENT });
        await markTriggerEventFailed(storedEventId, UNFINISHED_SEGMENT);
      }
      return;
    }
    await markTriggerEventDispatched(storedEventId);
  },
};

export function registerDispatchWork(): void {
  registerWorkHandler('dispatch_event', dispatchEventHandler);
}

/** The failure reason of each receipt that settled `failed`, by receipt id. For
 *  the test-harness doors, which drain before acking and report what failed. */
export async function loadFailedReceipts(storedEventIds: string[]): Promise<Map<string, string>> {
  if (storedEventIds.length === 0) return new Map();
  const rows = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', 'in', storedEventIds.map((id) => id as TriggerEventId))
    .where('status', '=', 'failed')
    .select(['id', 'failure_reason'])
    .execute();
  return new Map(rows.map((row) => [row.id, row.failure_reason ?? 'dispatch failed']));
}
