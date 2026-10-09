// The change outbox: valuations' row changes become deliveries.
//
// A database trigger captures every insert/update/delete into
// `valuations_change_outbox` with the actor GUCs of the transaction that caused
// it (V-17). This worker turns each unprocessed row into one
// `outbound_delivery` per matching subscription, and marks it processed — in
// ONE transaction, so a crash between the two cannot duplicate a notification
// or lose one.
//
// It used to write into the shared `webhook`/`outbound_webhook_request` pair
// drained by another unit's worker, and to nudge it over an in-process message
// queue. Both are gone (V-16): the destination tables are valuations' own, the
// drain is `delivery.ts` beside this file, and the nudge is a poll — so the
// unit carries no message-queue dependency out of the carve.

import type NativeDatabaseOperation from '../../generated/kysely/valuations/NativeDatabaseOperation';
import type { ValuationsChangeOutboxId } from '../../generated/kysely/valuations/ValuationsChangeOutbox';

import { SECOND } from '../../constants';
import { handleError } from '../../lib/errors';
import { getValuationsQb } from '../../lib/kysely';
import { worker } from '../../lib/worker';

const BATCH_SIZE = 100;

type Actor =
  | { type: 'user'; id: string }
  | { type: 'api-token'; id: string }
  | { type: 'system'; id: null };

const CHANGE_TYPE_MAP: Record<NativeDatabaseOperation, 'create' | 'update' | 'delete'> = {
  INSERT: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
};

interface OutboxRow {
  id: ValuationsChangeOutboxId;
  entity: string;
  change_type: NativeDatabaseOperation;
  row_id: string;
  team_id: string;
  actor_type: string | null;
  actor_id: string | null;
  before: unknown;
  after: unknown;
  occurred_at: Date;
}

/** Attribution as the trigger captured it. An unrecognised or absent actor is
 *  `system` — the change happened, and saying "we don't know who" beats
 *  asserting a person. */
function buildActor(row: OutboxRow): Actor {
  if (row.actor_type === 'api-token' && row.actor_id) return { type: 'api-token', id: row.actor_id };
  if (row.actor_type === 'user' && row.actor_id) return { type: 'user', id: row.actor_id };
  return { type: 'system', id: null };
}

/** The wire shape integrators already consume — unchanged by the move. */
function buildPayload(row: OutboxRow, eventType: string) {
  return {
    event: eventType,
    timestamp: row.occurred_at.toISOString(),
    actor: buildActor(row),
    data: { id: row.row_id, before: row.before ?? null, after: row.after ?? null },
  };
}

function qb() {
  return getValuationsQb([
    'valuations_change_outbox',
    'webhook_subscription',
    'outbound_delivery',
  ]);
}

async function processOutboxRow(row: OutboxRow): Promise<number> {
  const eventType = `valuations:${row.entity}:${CHANGE_TYPE_MAP[row.change_type]}`;

  return qb()
    .transaction()
    .execute(async (tx) => {
      // `tx` inherits the schema plugin from the builder it came from, so table
      // names stay unqualified here exactly as they are outside it.
      const subscriptions = await tx
        .selectFrom('webhook_subscription')
        .where('team_id', '=', row.team_id)
        .where('event_type', '=', eventType)
        .where('deleted_at', 'is', null)
        .where('disabled_at', 'is', null)
        .select(['id'])
        .execute();

      if (subscriptions.length > 0) {
        const payload = JSON.stringify(buildPayload(row, eventType));
        await tx
          .insertInto('outbound_delivery')
          .values(
            subscriptions.map((s) => ({
              subscription_id: s.id,
              team_id: row.team_id,
              event_type: eventType,
              payload,
            })),
          )
          .execute();
      }

      // Marked processed in the SAME transaction as the deliveries it produced:
      // the two facts are one fact, and splitting them is how a crash becomes a
      // duplicate notification or a lost one.
      await tx
        .updateTable('valuations_change_outbox')
        .set({ processed_at: new Date() })
        .where('id', '=', row.id)
        .execute();

      return subscriptions.length;
    });
}

function startValuationsOutboxWorker() {
  worker(async () => {
    const rows = (await qb()
      .selectFrom('valuations_change_outbox')
      .where('processed_at', 'is', null)
      .orderBy('occurred_at', 'asc')
      .limit(BATCH_SIZE)
      .select([
        'id',
        'entity',
        'change_type',
        'row_id',
        'team_id',
        'actor_type',
        'actor_id',
        'before',
        'after',
        'occurred_at',
      ])
      .execute()) as OutboxRow[];

    for (const row of rows) {
      try {
        await processOutboxRow(row);
      } catch (err) {
        handleError(err);
      }
    }
  }, 5 * SECOND);
}

export { startValuationsOutboxWorker };
