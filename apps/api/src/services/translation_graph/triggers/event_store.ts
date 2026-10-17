// The trigger-event door — every inbound event a trigger receives is
// STORED before any processing runs:
//
//   receive  → insert a `trigger_event` row ('received') and return —
//              the HTTP handler can ack the sender immediately;
//   dispatch → `dispatchStoredTriggerEvent` runs the normal trigger
//              dispatch from the stored row and records the outcome
//              ('dispatched' | 'failed' + failure_reason);
//   replay   → `replayTriggerEvent` re-dispatches any stored event —
//              the recovery path for events that failed, or that a
//              crash left at 'received'.
//
// The row is the durable record of WHAT ARRIVED, independent of whether
// processing ever ran — `trigger_run.trigger_payload` only exists once a
// firing recorded, so a crash between receipt and recording used to lose
// the event entirely (and the sender waited on the whole run before its
// ack).

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { dispatchTriggerByIdEvent } from './router';

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

/**
 * Persist a received event. Synchronous part of the receive path — the
 * caller acks the sender right after this returns, then hands the id to
 * `dispatchStoredTriggerEvent` off the request cycle (setImmediate).
 *
 * Idempotent when the event carries an `idempotencyKey` (the source's own
 * per-delivery id): the partial unique index on (trigger_id, external_event_id)
 * makes an at-least-once redelivery a no-op insert. `duplicate: true` signals
 * the caller to SKIP dispatch — the first delivery already owns the run.
 */
export async function storeTriggerEvent(input: {
  teamId: TeamId;
  triggerId: string;
  event: TriggerEvent;
}): Promise<{ id: TriggerEventId; duplicate: boolean }> {
  const externalEventId = input.event.idempotencyKey ?? null;
  const inserted = await getAutomationsQb(['trigger_event'])
    .insertInto('trigger_event')
    .values({
      team_id: input.teamId,
      trigger_id: input.triggerId,
      adapter_type: input.event.adapterType,
      trigger_type: input.event.triggerType,
      payload: jsonb(JSON.parse(JSON.stringify(input.event))) as never,
      external_event_id: externalEventId,
      ...(input.event.occurredAt !== undefined
        ? { occurred_at: new Date(input.event.occurredAt) }
        : {}),
    })
    .onConflict((oc) =>
      oc.columns(['trigger_id', 'external_event_id']).where('external_event_id', 'is not', null).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  if (inserted) return { id: inserted.id, duplicate: false };

  // Conflict: this delivery id was already received for this trigger (only
  // reachable when externalEventId is non-null — the partial index). Return the
  // first delivery's row id so the receipt is still addressable, flagged dup.
  const existing = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('trigger_id', '=', input.triggerId)
    .where('external_event_id', '=', externalEventId)
    .select('id')
    .executeTakeFirstOrThrow();
  return { id: existing.id, duplicate: true };
}

/**
 * Run the normal trigger dispatch from a stored event and record the
 * outcome on the row. Never throws — a dispatch failure is data
 * ('failed' + reason), not an unhandled rejection in a fire-and-forget
 * context.
 */
export async function dispatchStoredTriggerEvent(eventId: string): Promise<void> {
  const row = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', '=', eventId as TriggerEventId)
    .selectAll()
    .executeTakeFirst();
  if (!row) {
    logger.error('[TriggerEvents] stored event vanished before dispatch', { eventId });
    return;
  }
  try {
    const result = await dispatchTriggerByIdEvent({
      triggerId: row.trigger_id,
      event: row.payload as unknown as TriggerEvent,
      teamId: row.team_id as TeamId,
      // This dispatch IS the stored receipt — let the guard hold-and-release it.
      storedEventId: row.id,
    });
    // A dropped event means the router already owns the receipt's outcome —
    // marked 'suppressed' with a reason where applicable, or left held for a
    // guard release. Only a dispatch that actually ran gets marked
    // 'dispatched'; overwriting a drop would clobber the audit trail (status
    // back to 'dispatched', failure_reason nulled) even though nothing ran.
    if (result.droppedReason === undefined) {
      await getAutomationsQb(['trigger_event'])
        .updateTable('trigger_event')
        .set({ status: 'dispatched', dispatched_at: new Date(), failure_reason: null })
        .where('id', '=', row.id)
        .execute();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[TriggerEvents] stored event dispatch failed', {
      eventId,
      triggerId: row.trigger_id,
      error: message,
    });
    await getAutomationsQb(['trigger_event'])
      .updateTable('trigger_event')
      .set({ status: 'failed', dispatched_at: new Date(), failure_reason: message })
      .where('id', '=', row.id)
      .execute()
      .catch(() => {});
  }
}

/**
 * Receive = store + ack-ready + async dispatch. The returned id is in
 * hand before any processing starts; dispatch runs on the next tick so
 * the HTTP response never waits on a movement run.
 */
export async function receiveTriggerEvent(input: {
  teamId: TeamId;
  triggerId: string;
  event: TriggerEvent;
}): Promise<{ eventId: string; duplicate: boolean }> {
  const { id: eventId, duplicate } = await storeTriggerEvent(input);
  // A redelivery of an already-received event: the first delivery already
  // dispatched (or is about to). Skip — don't double-run.
  if (!duplicate) {
    setImmediate(() => {
      void dispatchStoredTriggerEvent(eventId);
    });
  }
  return { eventId, duplicate };
}

/**
 * Outcome markers for callers that keep dispatch INLINE (webhook-sync
 * needs synchronous evaluation results for the test-harness error
 * surface and the echo-drop registry) but still want the event durable
 * and replayable: store first, dispatch yourself, then mark.
 */
export async function markTriggerEventDispatched(eventId: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'dispatched', dispatched_at: new Date(), failure_reason: null })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}

export async function markTriggerEventFailed(eventId: string, reason: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'failed', dispatched_at: new Date(), failure_reason: reason })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}

/**
 * Mark a stored event SUPPRESSED — the opt-in `suppress_self` echo-suppression
 * recognised it as the author's own write echoing back (see
 * `echo_suppression.ts`). The event is RECORDED, not dropped: it stays in the
 * table at status='suppressed' with the reason, fully auditable and replayable
 * by hand (a self-echo the author later decides they want is just a replay).
 * Best-effort — recording the disposition must never block the door.
 */
export async function markTriggerEventSuppressed(eventId: string, reason: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'suppressed', dispatched_at: new Date(), failure_reason: reason })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}

/**
 * Reset a stored event back to 'received' so it can be re-dispatched. Used by
 * the loop guard's queue-don't-drop deferred-release path: an event held by a
 * rate throttle is reset and re-dispatched after the rate window. Best-effort —
 * the event is replayable by hand regardless.
 */
export async function resetTriggerEventToReceived(eventId: string): Promise<void> {
  await getAutomationsQb(['trigger_event'])
    .updateTable('trigger_event')
    .set({ status: 'received', dispatched_at: null, failure_reason: null })
    .where('id', '=', eventId as TriggerEventId)
    .execute()
    .catch(() => {});
}

/** Re-dispatch a stored event (playback). Team-scoped. */
export async function replayTriggerEvent(input: {
  teamId: TeamId;
  eventId: string;
}): Promise<{ replayed: boolean }> {
  const row = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', '=', input.eventId as TriggerEventId)
    .where('team_id', '=', input.teamId)
    .select('id')
    .executeTakeFirst();
  if (!row) return { replayed: false };
  await dispatchStoredTriggerEvent(input.eventId);
  return { replayed: true };
}

/** The stored events for one trigger, newest first (playback picker). */
export async function listTriggerEvents(input: {
  teamId: TeamId;
  triggerId: string;
  limit?: number;
}) {
  return getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('team_id', '=', input.teamId)
    .where('trigger_id', '=', input.triggerId)
    .select([
      'id',
      'trigger_id',
      'adapter_type',
      'trigger_type',
      'status',
      'dispatched_at',
      'failure_reason',
      'occurred_at',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .limit(Math.min(input.limit ?? 25, 100))
    .execute();
}
