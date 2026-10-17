// The standalone notification path's drainer — the only thing that carries a
// settled answer out of the asks unit when there is no engine in the process.
//
// The door enqueues one row per settle; this worker signs it and POSTs it,
// backing off across six attempts before marking it `failed`. Failing is
// survivable by construction: the answer is durable on the ask and readable
// over `GET /v1/asks/:id`, so a dead receiver loses a nudge and never the thing
// it was a nudge about. That is the same relationship the engine's in-process
// nudge has always had with its poll — which is why one can substitute for the
// other at all.
//
// The heartbeat is here because a stopped drainer is a SILENT outage in the
// standalone deployment: nothing errors, notifications simply stop. A liveness
// row makes "when did this last run" answerable from outside the process — the
// same reason knowledge's outbox keeps one (D30e).

import { createHmac } from 'node:crypto';

import type { AskId } from '../../../generated/kysely/asks/Ask';
import type { AskWebhookDeliveryId } from '../../../generated/kysely/asks/AskWebhookDelivery';

import { MINUTE, SECOND } from '../../../constants';
import { getAsksQb } from '../../../lib/kysely';
import { worker } from '../../../lib/worker';
import { handleError } from '../../../lib/errors';
import { logger } from 'movement-engine/public/log';
import { askSettleDelivery } from '../../translation_graph/adapters/ask/delivery_mode';

const DRAIN_INTERVAL = 30 * SECOND;
const BATCH_SIZE = 50;
const DELIVERY_TIMEOUT_MS = 10 * SECOND;

/** 1m, 5m, 30m, 2h, 12h — five waits, so the sixth attempt is the last (A-4). */
const BACKOFF_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 720 * MINUTE];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export const ASK_WEBHOOK_DRAINER = 'asks.ask_webhook_delivery';

export const ASK_SETTLED_EVENT = 'ask.settled';

function qb() {
  return getAsksQb(['ask_webhook_delivery', 'ask', 'worker_heartbeat']);
}

/** One deployment-wide secret, env-configured. Per-team key management is a
 *  registry, and a registry is core-shaped — deliberately not asks' job (A-4). */
function signingSecret(): string | null {
  const secret = process.env.ASKS_WEBHOOK_SIGNING_SECRET;
  return secret ? secret : null;
}

export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

interface DeliveryRow {
  id: AskWebhookDeliveryId;
  ask_id: AskId;
  url: string;
  attempt: number;
  team_id: string;
  state: string;
  family: string;
  answer: unknown;
  provenance: unknown;
  answered_at: Date | null;
  expired_at: Date | null;
}

async function claimBatch(): Promise<DeliveryRow[]> {
  const rows = await qb()
    .selectFrom('ask_webhook_delivery as d')
    .innerJoin('ask as a', 'a.id', 'd.ask_id')
    .where('d.status', '=', 'pending')
    .where('d.attempt', '<', MAX_ATTEMPTS)
    .where((eb) =>
      eb.or([eb('d.next_attempt_at', 'is', null), eb('d.next_attempt_at', '<=', new Date())]),
    )
    .orderBy('d.created_at', 'asc')
    .limit(BATCH_SIZE)
    .select([
      'd.id',
      'd.ask_id',
      'd.url',
      'd.attempt',
      'a.team_id',
      'a.state',
      'a.family',
      'a.answer',
      'a.provenance',
      'a.answered_at',
      'a.expired_at',
    ])
    .execute();
  return rows as DeliveryRow[];
}

/** The settled ask, as the receiver sees it. Composed from the ask row at
 *  DELIVERY time, which is safe precisely because a settled ask is terminal. */
function bodyFor(row: DeliveryRow): string {
  return JSON.stringify({
    event: ASK_SETTLED_EVENT,
    askId: row.ask_id,
    teamId: row.team_id,
    state: row.state,
    family: row.family,
    answer: row.answer ?? null,
    provenance: row.provenance ?? {},
    respondedAt: (row.answered_at ?? row.expired_at)?.toISOString() ?? null,
  });
}

async function postTo(row: DeliveryRow, secret: string): Promise<void> {
  const body = bodyFor(row);
  const response = await fetch(row.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Asks-Event': ASK_SETTLED_EVENT,
      // The receiver's idempotency key: the same delivery retried carries the
      // same id, so a duplicate is recognisable as one.
      'X-Asks-Delivery-Id': row.id,
      'X-Asks-Timestamp': new Date().toISOString(),
      'X-Asks-Signature': signPayload(body, secret),
    },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST ${row.url} → ${response.status} ${text.slice(0, 200)}`);
  }
}

async function markDelivered(id: AskWebhookDeliveryId): Promise<void> {
  await qb()
    .updateTable('ask_webhook_delivery')
    .set({ status: 'delivered', delivered_at: new Date(), last_error: null, updated_at: new Date() })
    .where('id', '=', id)
    .execute();
}

async function markAttemptFailed(row: DeliveryRow, err: unknown): Promise<void> {
  const attempt = row.attempt + 1;
  const message = err instanceof Error ? err.message : String(err);
  const exhausted = attempt >= MAX_ATTEMPTS;
  await qb()
    .updateTable('ask_webhook_delivery')
    .set({
      attempt,
      last_error: message.slice(0, 1000),
      updated_at: new Date(),
      ...(exhausted
        ? { status: 'failed', next_attempt_at: null }
        : { next_attempt_at: new Date(Date.now() + (BACKOFF_MS[attempt - 1] ?? 0)) }),
    })
    .where('id', '=', row.id)
    .execute();

  if (exhausted) {
    logger.error('[asks delivery] giving up on a settle notification (the answer is still readable)', {
      deliveryId: row.id,
      askId: row.ask_id,
      url: row.url,
      attempt,
      lastError: message,
    });
  }
}

export interface AskDeliveryHealth {
  worker: string;
  lastBeatAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** False when no signing secret is configured — the queue then holds at zero
   *  attempts rather than burning its retries on something nobody could sign. */
  signingConfigured: boolean;
  pending: number;
  oldestPendingAt: string | null;
  failed: number;
}

export async function readAskDeliveryHealth(): Promise<AskDeliveryHealth> {
  const [beat, pending, failed] = await Promise.all([
    qb()
      .selectFrom('worker_heartbeat')
      .where('worker', '=', ASK_WEBHOOK_DRAINER)
      .select(['last_beat_at', 'last_success_at', 'last_error'])
      .executeTakeFirst(),
    qb()
      .selectFrom('ask_webhook_delivery')
      .where('status', '=', 'pending')
      .select(({ fn }) => [fn.countAll<string>().as('count'), fn.min('created_at').as('oldest')])
      .executeTakeFirst(),
    qb()
      .selectFrom('ask_webhook_delivery')
      .where('status', '=', 'failed')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirst(),
  ]);

  return {
    worker: ASK_WEBHOOK_DRAINER,
    lastBeatAt: beat?.last_beat_at ? new Date(beat.last_beat_at).toISOString() : null,
    lastSuccessAt: beat?.last_success_at ? new Date(beat.last_success_at).toISOString() : null,
    lastError: beat?.last_error ?? null,
    signingConfigured: signingSecret() !== null,
    pending: Number(pending?.count ?? 0),
    oldestPendingAt: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
    failed: Number(failed?.count ?? 0),
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
    .values({ worker: ASK_WEBHOOK_DRAINER, ...values })
    .onConflict((oc) => oc.column('worker').doUpdateSet(values))
    .execute();
}

export async function drainOnce(): Promise<{ delivered: number; failed: number }> {
  const secret = signingSecret();
  if (!secret) {
    // Attempting without a key would spend all six retries on something nobody
    // could have signed, and the queue would burn itself down while the fix was
    // still an env var. So: attempt nothing, leave `attempt` at zero, and say
    // why on the pulse. The same shape knowledge's arbitration worker uses when
    // it has no model key.
    await beat({
      delivered: 0,
      failed: 0,
      lastError: 'ASKS_WEBHOOK_SIGNING_SECRET is not set — deliveries are held, not attempted',
    });
    return { delivered: 0, failed: 0 };
  }

  const rows = await claimBatch();
  let delivered = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const row of rows) {
    try {
      await postTo(row, secret);
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

/** Started only in `webhook` delivery: in a composed deployment nothing ever
 *  enqueues, so a drainer there would be a worker with no work whose heartbeat
 *  claimed a path that is not the active one. */
export function startAskWebhookDrainer(): void {
  if (askSettleDelivery() !== 'webhook') return;
  worker(async () => {
    try {
      await drainOnce();
    } catch (err) {
      handleError(err);
    }
  }, DRAIN_INTERVAL);
}
