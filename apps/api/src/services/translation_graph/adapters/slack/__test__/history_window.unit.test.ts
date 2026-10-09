// The time bound a hop's WHERE hands to `conversations.history`. Pure: no
// client, no adapter — an Expression in, Slack's `oldest`/`latest` out.

import { parseMovementExpression } from 'movement-lang';

import type { Expression } from '#shared/expression/types';

import { historyWindowFromWhere } from '../history_window';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const isTimestampRead = (name: string) => name === 'Timestamp';

function windowOf(where: Expression | undefined) {
  return historyWindowFromWhere({ where, isTimestampRead, now: NOW });
}

const read = (name: string): Expression => ({ type: 'property', propertyTypeId: name });
const lit = (value: string | number): Expression => ({ type: 'static', value });

describe('historyWindowFromWhere', () => {
  it('yields no bound when there is no WHERE', () => {
    expect(windowOf(undefined)).toEqual({});
  });

  it('`Timestamp > <iso>` lowers the window (Slack `oldest` is exclusive, like `>`)', () => {
    const window = windowOf({
      type: 'compare',
      op: 'gt',
      left: read('Timestamp'),
      right: lit('2026-08-13T00:00:00.000Z'),
    });
    expect(window).toEqual({ oldest: '1786579200.000000' });
  });

  it('`>=` widens the bound outwards so the boundary message survives Slack exclusivity', () => {
    const window = windowOf({
      type: 'compare',
      op: 'gte',
      left: read('Timestamp'),
      right: lit('2026-08-13T00:00:00.000Z'),
    });
    expect(window).toEqual({ oldest: '1786579199.999000' });
  });

  it('`<` / `<=` bound the window from above', () => {
    expect(
      windowOf({ type: 'compare', op: 'lt', left: read('Timestamp'), right: lit('2026-08-13T00:00:00.000Z') }),
    ).toEqual({ latest: '1786579200.000000' });
    expect(
      windowOf({ type: 'compare', op: 'lte', left: read('Timestamp'), right: lit('2026-08-13T00:00:00.000Z') }),
    ).toEqual({ latest: '1786579200.001000' });
  });

  it('reads the comparison written the other way round (`<literal> < Timestamp`)', () => {
    expect(
      windowOf({ type: 'compare', op: 'lt', left: lit('2026-08-13T00:00:00.000Z'), right: read('Timestamp') }),
    ).toEqual({ oldest: '1786579200.000000' });
  });

  it('resolves `@current_date` / `@current_timestamp` the way the engine does', () => {
    expect(
      windowOf({
        type: 'compare',
        op: 'gt',
        left: read('Timestamp'),
        right: { type: 'meta', key: 'current_date' },
      }),
    ).toEqual({ oldest: '1787184000.000000' });
    expect(
      windowOf({
        type: 'compare',
        op: 'gt',
        left: read('Timestamp'),
        right: { type: 'meta', key: 'current_timestamp' },
      }),
    ).toEqual({ oldest: '1787227200.000000' });
  });

  it('`Timestamp WITHIN "7d"` lowers the window to now minus the duration', () => {
    const window = windowOf({
      type: 'compare',
      op: 'within',
      left: read('Timestamp'),
      right: lit('7d'),
    });
    expect(window).toEqual({ oldest: '1786622399.999000' });
  });

  it('an AND of bounds keeps the tightest of each side', () => {
    const window = windowOf({
      type: 'logical',
      op: 'and',
      operands: [
        { type: 'compare', op: 'gt', left: read('Timestamp'), right: lit('2026-08-01T00:00:00.000Z') },
        { type: 'compare', op: 'gt', left: read('Timestamp'), right: lit('2026-08-13T00:00:00.000Z') },
        { type: 'compare', op: 'lt', left: read('Timestamp'), right: lit('2026-08-19T00:00:00.000Z') },
      ],
    });
    expect(window).toEqual({ oldest: '1786579200.000000', latest: '1787097600.000000' });
  });

  it('ignores everything it cannot push — the engine re-applies the predicate anyway', () => {
    // Another field, a non-ordering operator, a non-literal right side, an
    // unparseable date, an OR, a NOT: each yields no bound at all.
    const ignored: Expression[] = [
      { type: 'compare', op: 'gt', left: read('Message'), right: lit('2026-08-13T00:00:00.000Z') },
      { type: 'compare', op: 'eq', left: read('Timestamp'), right: lit('2026-08-13T00:00:00.000Z') },
      { type: 'compare', op: 'gt', left: read('Timestamp'), right: read('Message') },
      { type: 'compare', op: 'gt', left: read('Timestamp'), right: lit('last tuesday') },
      { type: 'compare', op: 'within', left: read('Timestamp'), right: lit('7 fortnights') },
      {
        type: 'logical',
        op: 'or',
        operands: [
          { type: 'compare', op: 'gt', left: read('Timestamp'), right: lit('2026-08-13T00:00:00.000Z') },
          { type: 'compare', op: 'eq', left: read('Message'), right: lit('hi') },
        ],
      },
      {
        type: 'not',
        expression: { type: 'compare', op: 'gt', left: read('Timestamp'), right: lit('2026-08-13T00:00:00.000Z') },
      },
    ];
    for (const where of ignored) expect(windowOf(where)).toEqual({});
  });

  it('keeps the pushable conjunct of an AND that also holds unpushable ones', () => {
    const window = windowOf({
      type: 'logical',
      op: 'and',
      operands: [
        { type: 'compare', op: 'contains', left: read('Message'), right: lit('Acme') },
        { type: 'compare', op: 'gt', left: read('Timestamp'), right: lit('2026-08-13T00:00:00.000Z') },
      ],
    });
    expect(window).toEqual({ oldest: '1786579200.000000' });
  });
});

// The shapes the LANGUAGE actually produces. A hop's WHERE spells a bare
// backticked field as `edge_property`, not `property` — hand-built ASTs above
// would keep passing while every real movement pushed nothing.
describe('the window a real hop WHERE yields', () => {
  function hopFilter(where: string): Expression | undefined {
    const traverse = parseMovementExpression(`ch-[m:Messages WHERE ${where}]->.\`Message\``);
    if (traverse.type !== 'traverse') return undefined;
    const [step] = traverse.steps;
    return step?.type === 'edge' ? step.expressionFilter : undefined;
  }

  it('`WHERE `Timestamp` > @current_date` bounds the window at midnight today', () => {
    expect(windowOf(hopFilter('`Timestamp` > @current_date'))).toEqual({ oldest: '1787184000.000000' });
  });

  it('`WHERE `Timestamp` WITHIN 7d` bounds it seven days back', () => {
    expect(windowOf(hopFilter('`Timestamp` WITHIN 7d'))).toEqual({ oldest: '1786622399.999000' });
  });

  it('an ANDed text predicate rides along without disturbing the bound', () => {
    expect(
      windowOf(hopFilter('`Timestamp` WITHIN 7d AND `Message` CONTAINS "Acme"')),
    ).toEqual({ oldest: '1786622399.999000' });
  });

  it('an alias-qualified read is left to the engine — the alias may not be this hop', () => {
    expect(windowOf(hopFilter('m.`Timestamp` > @current_date'))).toEqual({});
  });
});
