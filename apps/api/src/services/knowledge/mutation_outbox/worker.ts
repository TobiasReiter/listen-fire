// The drainer: the only thing that carries a graph mutation out of knowledge.
//
// The write door enqueues events inside the write transaction; this worker
// hands each one to the ONE delivery path this deployment is configured for —
// a locally-registered subscriber, or signed POSTs to the team's registered
// destinations. Neither is a privileged fast path: the outbox row is written
// either way, so the ordering and latency semantics are the same shape in every
// deployment (D25, M-38). Running both would be two deliveries of one graph
// write, which is why the mode is a choice and not two switches (D39c, D41b).
//
// The composed wiring is deliberately INVERTED: knowledge does not know the
// movement engine exists. The composition root registers a subscriber at
// startup; a standalone knowledge simply has none, and its consumers register
// webhooks like any other client.

import { createHmac } from 'node:crypto';

import type { MutationEventEnvelope } from '../../../lib/knowledge/store/events';
import type { MutationOutboxId } from '../../../generated/kysely/knowledge/MutationOutbox';

import { SECOND } from '../../../constants';
import { getKnowledgeQb } from '../../../lib/kysely';
import { worker } from '../../../lib/worker';
import { handleError } from '../../../lib/errors';
import { logger } from '../../logger';
import { neverAsAny } from '../../../lib/utils/types';
import { mutationDelivery } from './delivery_mode';

const DRAIN_INTERVAL = 2 * SECOND;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 10 * SECOND;

export const OUTBOX_DRAINER = 'knowledge.mutation_outbox';

/**
 * A consumer inside this process. The composed Listen-Fire deployment registers the
 * movement engine's mutation dispatch here; nothing else may — a second
 * in-process subscriber would be a second delivery path, which is exactly what
 * the outbox exists to prevent.
 */
export interface LocalMutationSubscriber {
  (input: { teamId: string; envelope: MutationEventEnvelope }): Promise<void>;
}

let localSubscriber: LocalMutationSubscriber | null = null;

export function registerLocalMutationSubscriber(subscriber: LocalMutationSubscriber): void {
  localSubscriber = subscriber;
}

function outboxQb() {
  return getKnowledgeQb(['mutation_outbox', 'webhook_endpoint', 'worker_heartbeat']);
}

/** Retry spacing borrowed from the outbound-webhook worker: 7s, 49s, ~6m, ~40m. */
function backoffMs(attempts: number): number {
  return Math.pow(7, attempts) * 1000;
}

export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

interface OutboxRow {
  id: MutationOutboxId;
  team_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

async function claimBatch(): Promise<OutboxRow[]> {
  const rows = await outboxQb()
    .selectFrom('mutation_outbox')
    .where('delivered_at', 'is', null)
    .where('attempts', '<', MAX_ATTEMPTS)
    .where((eb) =>
      eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', new Date())]),
    )
    .orderBy('created_at', 'asc')
    .limit(BATCH_SIZE)
    .select(['id', 'team_id', 'event_type', 'payload', 'attempts'])
    .execute();
  return rows as OutboxRow[];
}

async function destinationsFor(input: { teamId: string; eventType: string }) {
  const rows = await outboxQb()
    .selectFrom('webhook_endpoint')
    .where('team_id', '=', input.teamId)
    .select(['id', 'url', 'event_types', 'secret'])
    .execute();
  // An empty selection means "everything this graph emits" — the same
  // convention the registration endpoint documents.
  return rows.filter((row) => row.event_types.length === 0 || row.event_types.includes(input.eventType));
}

async function postTo(input: { url: string; secret: string; body: string }): Promise<void> {
  const response = await fetch(input.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signPayload(input.body, input.secret),
    },
    body: input.body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST ${input.url} → ${response.status} ${text.slice(0, 200)}`);
  }
}

async function deliver(row: OutboxRow): Promise<void> {
  const envelope = row.payload as MutationEventEnvelope;
  const mode = mutationDelivery();

  switch (mode) {
    case 'local': {
      // No subscriber in a deployment configured to deliver in-process means
      // the consumer never booted, or stopped. That is a listener that will not
      // fire, so the row fails and retries rather than being marked delivered
      // into nowhere — the same reason the drainer keeps a heartbeat at all.
      if (!localSubscriber) {
        throw new Error(
          'No local mutation subscriber is registered, but KNOWLEDGE_MUTATION_DELIVERY is "local"',
        );
      }
      await localSubscriber({ teamId: row.team_id, envelope });
      return;
    }
    case 'webhook': {
      const body = JSON.stringify(envelope);
      for (const destination of await destinationsFor({
        teamId: row.team_id,
        eventType: row.event_type,
      })) {
        await postTo({ url: destination.url, secret: destination.secret, body });
      }
      return;
    }
    default:
      throw new Error(`Unknown mutation delivery mode: ${neverAsAny(mode)}`);
  }
}

async function markDelivered(id: MutationOutboxId): Promise<void> {
  await outboxQb()
    .updateTable('mutation_outbox')
    .set({ delivered_at: new Date(), last_error: null })
    .where('id', '=', id)
    .execute();
}

async function markFailed(row: OutboxRow, err: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  await outboxQb()
    .updateTable('mutation_outbox')
    .set({
      attempts,
      last_error: message.slice(0, 1000),
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)),
    })
    .where('id', '=', row.id)
    .execute();

  // Exhausted retries are a listener that will never fire. Say so once, loudly,
  // rather than letting a row rot silently in a table nobody reads.
  if (attempts >= MAX_ATTEMPTS) {
    logger.error('[knowledge outbox] giving up on a mutation event', {
      outboxId: row.id,
      teamId: row.team_id,
      eventType: row.event_type,
      attempts,
      lastError: message,
    });
  }
}

export interface OutboxHealth {
  worker: string;
  lastBeatAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  oldestPendingAt: string | null;
  undeliverable: number;
}

/** What the pulse is worth reading for: is it beating, and is anything stuck. */
export async function readOutboxHealth(): Promise<OutboxHealth> {
  const [beat, pending, undeliverable] = await Promise.all([
    outboxQb()
      .selectFrom('worker_heartbeat')
      .where('worker', '=', OUTBOX_DRAINER)
      .select(['last_beat_at', 'last_success_at', 'last_error'])
      .executeTakeFirst(),
    outboxQb()
      .selectFrom('mutation_outbox')
      .where('delivered_at', 'is', null)
      .where('attempts', '<', MAX_ATTEMPTS)
      .select(({ fn }) => [fn.countAll<string>().as('count'), fn.min('created_at').as('oldest')])
      .executeTakeFirst(),
    outboxQb()
      .selectFrom('mutation_outbox')
      .where('delivered_at', 'is', null)
      .where('attempts', '>=', MAX_ATTEMPTS)
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirst(),
  ]);

  return {
    worker: OUTBOX_DRAINER,
    lastBeatAt: beat?.last_beat_at ? new Date(beat.last_beat_at).toISOString() : null,
    lastSuccessAt: beat?.last_success_at ? new Date(beat.last_success_at).toISOString() : null,
    lastError: beat?.last_error ?? null,
    pending: Number(pending?.count ?? 0),
    oldestPendingAt: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
    undeliverable: Number(undeliverable?.count ?? 0),
  };
}

async function beat(input: { delivered: number; failed: number; lastError: string | null }): Promise<void> {
  const now = new Date();
  await outboxQb()
    .insertInto('worker_heartbeat')
    .values({
      worker: OUTBOX_DRAINER,
      last_beat_at: now,
      ...(input.failed === 0 ? { last_success_at: now } : {}),
      last_error: input.lastError,
      detail: JSON.stringify({ delivered: input.delivered, failed: input.failed }),
    })
    .onConflict((oc) =>
      oc.column('worker').doUpdateSet({
        last_beat_at: now,
        ...(input.failed === 0 ? { last_success_at: now } : {}),
        last_error: input.lastError,
        detail: JSON.stringify({ delivered: input.delivered, failed: input.failed }),
      }),
    )
    .execute();
}

export async function drainOnce(): Promise<{ delivered: number; failed: number }> {
  const rows = await claimBatch();
  let delivered = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const row of rows) {
    try {
      await deliver(row);
      await markDelivered(row.id);
      delivered += 1;
    } catch (err) {
      failed += 1;
      lastError = err instanceof Error ? err.message : String(err);
      await markFailed(row, err);
    }
  }

  await beat({ delivered, failed, lastError });
  return { delivered, failed };
}

export function startKnowledgeOutboxDrainer(): void {
  worker(async () => {
    try {
      await drainOnce();
    } catch (err) {
      handleError(err);
    }
  }, DRAIN_INTERVAL);
}
