// Valuations' own outbound delivery loop (V-16, D12).
//
// A copy, deliberately. The shared `webhook`/`outbound_webhook_request` pair it
// replaces was built for several producers and only ever had this one (D18), so
// the generality was paying rent it never earned — and the worker draining it
// lived in another unit, which is the coupling the carve exists to remove. Two
// hundred lines of our own beats a dependency across the line.
//
// What is preserved exactly, because integrators depend on it: the payload
// shape, the `X-Webhook-Signature` HMAC-SHA256 over the raw body, and the
// exponential backoff on base 7 (~7s, 49s, 6m, 40m, 4.7h across five attempts).
// What is dropped: the per-row `maxRetries` (a constant that was never varied),
// the `version` column, and the in-process message-queue nudge — the loop polls,
// so the unit needs no message queue to stand alone.
//
// The destination is READ THROUGH the subscription rather than snapshotted onto
// the delivery, so removing a destination stops its queued deliveries in the
// same breath instead of retrying them to exhaustion.

import { createHmac } from 'node:crypto';

import type { OutboundDeliveryId } from '../../generated/kysely/valuations/OutboundDelivery';

import { SECOND } from '../../constants';
import { getValuationsQb } from '../../lib/kysely';
import { worker } from '../../lib/worker';
import { handleError } from '../../lib/errors';
import { logger } from 'movement-engine/public/log';

const DELIVERY_INTERVAL = 5 * SECOND;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 30 * SECOND;

export const DELIVERY_WORKER = 'valuations.outbound_delivery';

function qb() {
  return getValuationsQb(['outbound_delivery', 'webhook_subscription', 'worker_heartbeat']);
}

/** The base-7 exponential the legacy worker used: tried a few, 7 backed off
 *  best over a few hours. Kept because integrators' retry expectations are
 *  part of the contract this move promises not to change. */
function backoffMs(attempts: number): number {
  return Math.pow(7, attempts) * 1000;
}

export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

interface DeliveryRow {
  id: OutboundDeliveryId;
  url: string;
  secret: string | null;
  payload: unknown;
  attempts: number;
  event_type: string;
}

async function claimBatch(): Promise<DeliveryRow[]> {
  const rows = await qb()
    .selectFrom('outbound_delivery as d')
    .innerJoin('webhook_subscription as s', 's.id', 'd.subscription_id')
    .where('d.delivered_at', 'is', null)
    .where('d.attempts', '<', MAX_ATTEMPTS)
    // A removed or paused destination stops its queue immediately rather than
    // retrying into nothing — the legacy worker had to bolt this on after
    // deleting a subscription failed to stop delivery.
    .where('s.deleted_at', 'is', null)
    .where('s.disabled_at', 'is', null)
    .where((eb) =>
      eb.or([eb('d.next_attempt_at', 'is', null), eb('d.next_attempt_at', '<=', new Date())]),
    )
    .orderBy('d.created_at', 'asc')
    .limit(BATCH_SIZE)
    .select(['d.id', 's.url', 's.secret', 'd.payload', 'd.attempts', 'd.event_type'])
    .execute();
  return rows as DeliveryRow[];
}

async function postTo(row: DeliveryRow): Promise<void> {
  // BigInt-safe, as the legacy loop was: valuations payloads carry numeric ids
  // that JSON.stringify would otherwise throw on.
  const body = JSON.stringify(row.payload, (_key, value) =>
    typeof value === 'bigint' ? Number(value) : value,
  );
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (row.secret) headers['X-Webhook-Signature'] = signPayload(body, row.secret);

  const response = await fetch(row.url, {
    method: 'POST',
    body,
    headers,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST ${row.url} → ${response.status} ${text.slice(0, 200)}`);
  }
}

async function markDelivered(id: OutboundDeliveryId): Promise<void> {
  await qb()
    .updateTable('outbound_delivery')
    .set({ delivered_at: new Date(), last_error: null, updated_at: new Date() })
    .where('id', '=', id)
    .execute();
}

async function markAttemptFailed(row: DeliveryRow, err: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  await qb()
    .updateTable('outbound_delivery')
    .set({
      attempts,
      last_error: message.slice(0, 1000),
      updated_at: new Date(),
      ...(attempts >= MAX_ATTEMPTS
        ? { next_attempt_at: null }
        : { next_attempt_at: new Date(Date.now() + backoffMs(attempts)) }),
    })
    .where('id', '=', row.id)
    .execute();

  if (attempts >= MAX_ATTEMPTS) {
    logger.error('[valuations delivery] giving up on a change notification', {
      deliveryId: row.id,
      url: row.url,
      eventType: row.event_type,
      attempts,
      lastError: message,
    });
  }
}

export interface DeliveryHealth {
  worker: string;
  lastBeatAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  oldestPendingAt: string | null;
  undeliverable: number;
}

/** What the pulse is worth reading for: is it beating, and is anything stuck. */
export async function readDeliveryHealth(): Promise<DeliveryHealth> {
  const [beat, pending, undeliverable] = await Promise.all([
    qb()
      .selectFrom('worker_heartbeat')
      .where('worker', '=', DELIVERY_WORKER)
      .select(['last_beat_at', 'last_success_at', 'last_error'])
      .executeTakeFirst(),
    qb()
      .selectFrom('outbound_delivery')
      .where('delivered_at', 'is', null)
      .where('attempts', '<', MAX_ATTEMPTS)
      .select(({ fn }) => [fn.countAll<string>().as('count'), fn.min('created_at').as('oldest')])
      .executeTakeFirst(),
    qb()
      .selectFrom('outbound_delivery')
      .where('delivered_at', 'is', null)
      .where('attempts', '>=', MAX_ATTEMPTS)
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirst(),
  ]);

  return {
    worker: DELIVERY_WORKER,
    lastBeatAt: beat?.last_beat_at ? new Date(beat.last_beat_at).toISOString() : null,
    lastSuccessAt: beat?.last_success_at ? new Date(beat.last_success_at).toISOString() : null,
    lastError: beat?.last_error ?? null,
    pending: Number(pending?.count ?? 0),
    oldestPendingAt: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
    undeliverable: Number(undeliverable?.count ?? 0),
  };
}

async function beat(input: {
  delivered: number;
  failed: number;
  lastError: string | null;
}): Promise<void> {
  const now = new Date();
  const values = {
    last_beat_at: now,
    ...(input.failed === 0 ? { last_success_at: now } : {}),
    last_error: input.lastError,
    detail: JSON.stringify({ delivered: input.delivered, failed: input.failed }),
  };
  await qb()
    .insertInto('worker_heartbeat')
    .values({ worker: DELIVERY_WORKER, ...values })
    .onConflict((oc) => oc.column('worker').doUpdateSet(values))
    .execute();
}

export async function deliverOnce(): Promise<{ delivered: number; failed: number }> {
  const rows = await claimBatch();
  let delivered = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const row of rows) {
    try {
      await postTo(row);
      await markDelivered(row.id);
      delivered += 1;
    } catch (err) {
      failed += 1;
      lastError = err instanceof Error ? err.message : String(err);
      await markAttemptFailed(row, err);
    }
  }

  await beat({ delivered, failed, lastError });
  return { delivered, failed };
}

export function startValuationsDeliveryWorker(): void {
  worker(async () => {
    try {
      await deliverOnce();
    } catch (err) {
      handleError(err);
    }
  }, DELIVERY_INTERVAL);
}
