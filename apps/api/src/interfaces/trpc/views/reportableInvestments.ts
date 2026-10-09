import { sql } from 'kysely';

import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import type ValuationsSchema from '../../../generated/kysely/valuations/ValuationsSchema';

import EventType from '../../../generated/kysely/valuations/EventType';
import InvestmentType from '../../../generated/kysely/valuations/InvestmentType';

// The predicate needs to reach `event` and `transaction` to recognise a
// consideration position, so any query applying it must have listed both in
// its accessor call. Which names they go by depends on the accessor:
// `getValuationsQb` is already bound to the schema and calls them `event` /
// `transaction`, while a cross-schema `getQb` spells the crossing out as
// `valuations.event` / `valuations.transaction`. Both tables come from the
// same accessor call, so the caller states the event table's name and the
// transaction table's name is read off it — the way every other schema
// crossing on this branch is stated rather than assumed.
type EventReadable = {
  event: ValuationsSchema['event'];
  'valuations.event': ValuationsSchema['event'];
  transaction: ValuationsSchema['transaction'];
  'valuations.transaction': ValuationsSchema['transaction'];
};
type EventTableName = 'event' | 'valuations.event';
type TransactionTableNameFor<Name extends EventTableName> = Name extends 'valuations.event'
  ? 'valuations.transaction'
  : 'transaction';

/**
 * "Is this investment row one we report figures for?"
 *
 * Recording an acquisition mints a hidden position for the equity taken as
 * consideration: one investment INTO the acquirer per selling fund, standing
 * for the stock handed over in the swap. The cash leg of a mixed deal is booked
 * on that hidden row's transaction, and the same cash also reaches the acquired
 * company's line through the roll-up — so any surface that values both rows
 * counts the realisation twice, and any surface that lists companies gives the
 * acquirer a line as if we had bought into it.
 *
 * Three mechanisms mark such a row, and a row is reportable only if it carries
 * none of them:
 *
 *  - tagged to a DISTRIBUTION event (`event_id`), which is how the acquisition
 *    command has minted its consideration position since it was built;
 *    `event_id` is NULL on every other investment-creation path.
 *  - typed EQUITY_TRANSFER, the type an API author gives a share-for-share
 *    position that carries no event of its own.
 *  - reached by a transaction that settles ANOTHER company's exit: the swap's
 *    transaction names both this position and that exit. This is the only tie
 *    the exit flow that predates the acquisition command left behind, and the
 *    positions it wrote are still in the data — an untagged position on an
 *    acquirer, which is what put acquirers we never invested into on the
 *    portfolio list. A position settled by its OWN company's distribution is
 *    the ordinary exit and stays reportable, which is what the entity
 *    comparison is for.
 *
 * This governs which rows are VALUED, not which events are listed: an
 * acquisition event belongs to the company, not to the hidden investment, so
 * event listings still show it — only its per-row valuation lines disappear.
 */
export function isReportableInvestment<
  Name extends EventTableName,
  T extends Pick<EventReadable, Name | TransactionTableNameFor<Name>>,
  U extends keyof T,
>(
  $: ExpressionBuilder<T, U>,
  { event, investment = 'investment' }: { event: Name; investment?: string },
): Expression<SqlBool> {
  // The caller's table set is generic, so kysely cannot resolve
  // `consideration_event.*` / `consideration_transaction.*` references
  // through it. The subqueries only ever read the event and transaction
  // tables, so build them against that slice — a type-only narrowing of the
  // very same builder, which keeps the schema qualification kysely applies.
  const $exit = $ as unknown as ExpressionBuilder<
    EventReadable,
    EventTableName | 'transaction' | 'valuations.transaction'
  >;
  const considerationEvent =
    event === 'event' ? 'event as consideration_event' : 'valuations.event as consideration_event';
  const considerationTransaction =
    event === 'event'
      ? 'transaction as consideration_transaction'
      : 'valuations.transaction as consideration_transaction';
  const considerationExit =
    event === 'event' ? 'event as consideration_exit' : 'valuations.event as consideration_exit';

  return $.and([
    $(
      sql.ref<InvestmentType>(`${investment}.type`),
      'is distinct from',
      InvestmentType.EQUITY_TRANSFER,
    ),
    $.not(
      $.exists(
        $exit
          .selectFrom(considerationEvent)
          .select(sql.lit(1).as('one'))
          .whereRef('consideration_event.id', '=', sql.ref(`${investment}.event_id`))
          .where('consideration_event.type', '=', EventType.DISTRIBUTION),
      ),
    ),
    $.not(
      $.exists(
        $exit
          .selectFrom(considerationTransaction)
          .innerJoin(
            considerationExit,
            'consideration_exit.id',
            'consideration_transaction.event_id',
          )
          .select(sql.lit(1).as('one'))
          .whereRef(
            'consideration_transaction.investment_id',
            '=',
            sql.ref(`${investment}.id`),
          )
          .where('consideration_exit.type', '=', EventType.DISTRIBUTION)
          .where(($exitRow) =>
            $exitRow(
              sql.ref<string>('consideration_exit.legal_entity_id'),
              'is distinct from',
              sql.ref<string>(`${investment}.investment_profile_id`),
            ),
          ),
      ),
    ),
  ]);
}
