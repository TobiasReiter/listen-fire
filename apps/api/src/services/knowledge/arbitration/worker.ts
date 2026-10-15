// The arbiter: the only thing that answers an `evaluation_strategy: llm`
// question.
//
// The write door enqueues one row per contested property inside the write
// transaction; this worker drains them afterwards and writes each ruling back
// through the door as a second, evidenced, change-logged write (D42). Same shape
// as the mutation outbox next door, for the same reason — a work item that
// exists exactly when the write that raised it committed, drained by a worker
// with a pulse you can read from outside the process.
//
// WITHOUT A KEY THE QUEUE GROWS, LOUDLY. A self-hosted store with no model key
// is a supported deployment, not a broken one — so the worker does not burn
// attempts on a call it knows cannot succeed. It leaves every row pending,
// records the reason on its heartbeat, and `/health` publishes both the depth
// and the missing key. Losing arbitration is visible; it is never silent.

import type { PropertyArbitrationId } from '../../../generated/kysely/knowledge/PropertyArbitration';
import type { PropertyId } from '../../../generated/kysely/knowledge/Property';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { SECOND } from '../../../constants';
import { getKnowledgeQb } from '../../../lib/kysely';
import { worker } from '../../../lib/worker';
import { handleError } from '../../../lib/errors';
import { logger } from 'movement-engine/services/logger';
import { isKnowledgeLlmConfigured } from '../../../lib/knowledge/llm';
import { arbitrateProperty } from './evaluate';

const ARBITRATE_INTERVAL = 5 * SECOND;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;

export const ARBITRATION_WORKER = 'knowledge.property_arbitration';

const NO_KEY_REASON =
  'No LLM key is configured for knowledge — llm-strategy properties hold their incoming value and the arbitration queue is growing.';

function arbitrationQb() {
  return getKnowledgeQb(['property_arbitration', 'worker_heartbeat']);
}

/** Same spacing as the outbox drainer: 7s, 49s, ~6m, ~40m. */
function backoffMs(attempts: number): number {
  return Math.pow(7, attempts) * 1000;
}

interface QueueRow {
  id: PropertyArbitrationId;
  team_id: string;
  property_id: string;
  attempts: number;
}

async function claimBatch(): Promise<QueueRow[]> {
  const rows = await arbitrationQb()
    .selectFrom('property_arbitration')
    .where('resolved_at', 'is', null)
    .where('attempts', '<', MAX_ATTEMPTS)
    .where((eb) =>
      eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', new Date())]),
    )
    .orderBy('enqueued_at', 'asc')
    .limit(BATCH_SIZE)
    .select(['id', 'team_id', 'property_id', 'attempts'])
    .execute();
  return rows as QueueRow[];
}

async function markResolved(id: PropertyArbitrationId): Promise<void> {
  await arbitrationQb()
    .updateTable('property_arbitration')
    .set({ resolved_at: new Date(), last_error: null })
    .where('id', '=', id)
    .execute();
}

async function markFailed(row: QueueRow, err: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  await arbitrationQb()
    .updateTable('property_arbitration')
    .set({
      attempts,
      last_error: message.slice(0, 1000),
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)),
    })
    .where('id', '=', row.id)
    .execute();

  // Exhausted retries mean a property keeps a value its own ontology says was
  // never arbitrated. Say so once, loudly.
  if (attempts >= MAX_ATTEMPTS) {
    logger.error('[knowledge arbitration] giving up on a contested property', {
      arbitrationId: row.id,
      teamId: row.team_id,
      propertyId: row.property_id,
      attempts,
      lastError: message,
    });
  }
}

export interface ArbitrationHealth {
  worker: string;
  /** Whether this deployment can arbitrate at all. `false` explains a growing queue. */
  llmConfigured: boolean;
  lastBeatAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  oldestPendingAt: string | null;
  unresolvable: number;
}

export async function readArbitrationHealth(): Promise<ArbitrationHealth> {
  const [beat, pending, unresolvable] = await Promise.all([
    arbitrationQb()
      .selectFrom('worker_heartbeat')
      .where('worker', '=', ARBITRATION_WORKER)
      .select(['last_beat_at', 'last_success_at', 'last_error'])
      .executeTakeFirst(),
    arbitrationQb()
      .selectFrom('property_arbitration')
      .where('resolved_at', 'is', null)
      .where('attempts', '<', MAX_ATTEMPTS)
      .select(({ fn }) => [fn.countAll<string>().as('count'), fn.min('enqueued_at').as('oldest')])
      .executeTakeFirst(),
    arbitrationQb()
      .selectFrom('property_arbitration')
      .where('resolved_at', 'is', null)
      .where('attempts', '>=', MAX_ATTEMPTS)
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirst(),
  ]);

  return {
    worker: ARBITRATION_WORKER,
    llmConfigured: isKnowledgeLlmConfigured(),
    lastBeatAt: beat?.last_beat_at ? new Date(beat.last_beat_at).toISOString() : null,
    lastSuccessAt: beat?.last_success_at ? new Date(beat.last_success_at).toISOString() : null,
    lastError: beat?.last_error ?? null,
    pending: Number(pending?.count ?? 0),
    oldestPendingAt: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
    unresolvable: Number(unresolvable?.count ?? 0),
  };
}

async function beat(input: {
  resolved: number;
  failed: number;
  lastError: string | null;
}): Promise<void> {
  const now = new Date();
  const detail = JSON.stringify({ resolved: input.resolved, failed: input.failed });
  const success = input.failed === 0 && input.lastError === null;
  await arbitrationQb()
    .insertInto('worker_heartbeat')
    .values({
      worker: ARBITRATION_WORKER,
      last_beat_at: now,
      ...(success ? { last_success_at: now } : {}),
      last_error: input.lastError,
      detail,
    })
    .onConflict((oc) =>
      oc.column('worker').doUpdateSet({
        last_beat_at: now,
        ...(success ? { last_success_at: now } : {}),
        last_error: input.lastError,
        detail,
      }),
    )
    .execute();
}

export async function arbitrateOnce(): Promise<{
  resolved: number;
  failed: number;
  skipped: number;
}> {
  // No key: beat, say why, and touch nothing. Attempts stay at zero so the
  // backlog drains the moment a key appears, rather than having burned itself
  // into `unresolvable` while nobody could have succeeded.
  if (!isKnowledgeLlmConfigured()) {
    const { pending } = await readArbitrationHealth();
    await beat({ resolved: 0, failed: 0, lastError: NO_KEY_REASON });
    return { resolved: 0, failed: 0, skipped: pending };
  }

  const rows = await claimBatch();
  let resolved = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const row of rows) {
    try {
      const { outcome } = await arbitrateProperty({
        teamId: row.team_id as TeamId,
        propertyId: row.property_id as PropertyId,
      });
      await markResolved(row.id);
      resolved += 1;
      logger.debug('[knowledge arbitration] resolved', {
        propertyId: row.property_id,
        outcome,
      });
    } catch (err) {
      failed += 1;
      lastError = err instanceof Error ? err.message : String(err);
      await markFailed(row, err);
    }
  }

  await beat({ resolved, failed, lastError });
  return { resolved, failed, skipped: 0 };
}

export function startKnowledgeArbitrationWorker(): void {
  worker(async () => {
    try {
      await arbitrateOnce();
    } catch (err) {
      handleError(err);
    }
  }, ARBITRATE_INTERVAL);
}
