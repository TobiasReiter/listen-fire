// The slice of a hop's WHERE that Slack's own history API can answer: a time
// window on the message timestamp. `conversations.history` takes `oldest` /
// `latest` and nothing else, so a bound on `Timestamp` is the ONE predicate
// worth pushing — everything else stays in memory where the engine already
// evaluates it.
//
// The contract is one-way: the window must be a SUPERSET of what the predicate
// admits. The engine re-applies the whole WHERE over whatever comes back
// (`walkAdapterPositions`), so over-fetching costs a page and under-fetching
// loses messages the author asked for. Every judgement call below resolves in
// favour of fetching more.

import type { Expression } from '#shared/expression/types';

/** Slack's history window. Both bounds are EXCLUSIVE (Slack's default —
 *  `inclusive` is not sent, so a message exactly on a bound is dropped). */
export interface SlackHistoryWindow {
  /** `oldest` — Slack returns messages after this ts. */
  oldest?: string;
  /** `latest` — Slack returns messages before this ts. */
  latest?: string;
}

/**
 * A bound the author wrote INCLUSIVELY (`>=`, `<=`, and WITHIN's own boundary)
 * has to be pushed out past Slack's exclusive bound, or the message sitting
 * exactly on it never comes back. A millisecond is the smallest widening that
 * survives double precision at Slack's epoch scale (~1.79e9 seconds already
 * spends 10 of a double's ~16 significant digits), and one extra millisecond of
 * history is free — the engine filters it back out.
 */
const WIDEN_SECONDS = 0.001;

/** Which end of the window a conjunct moves. */
type BoundSide = 'oldest' | 'latest';

export function historyWindowFromWhere(input: {
  where: Expression | undefined;
  /** True for the property name that reads the message timestamp — the
   *  adapter resolves the author's natural name against its own schema. */
  isTimestampRead: (propertyTypeId: string) => boolean;
  /** The wall clock WITHIN and the `@current_*` keys read. Injected so the
   *  extraction stays a pure function of its inputs. */
  now?: number;
}): SlackHistoryWindow {
  if (input.where === undefined) return {};
  const now = input.now ?? Date.now();
  let oldest: number | undefined;
  let latest: number | undefined;
  for (const conjunct of andConjuncts(input.where)) {
    const bound = boundFromConjunct(conjunct, input.isTimestampRead, now);
    if (bound === undefined) continue;
    // ANDed bounds intersect: the LATEST lower bound and the EARLIEST upper
    // one. Both narrowings are still supersets of the predicate's own answer.
    if (bound.side === 'oldest') oldest = oldest === undefined ? bound.seconds : Math.max(oldest, bound.seconds);
    else latest = latest === undefined ? bound.seconds : Math.min(latest, bound.seconds);
  }
  return {
    ...(oldest !== undefined ? { oldest: oldest.toFixed(6) } : {}),
    ...(latest !== undefined ? { latest: latest.toFixed(6) } : {}),
  };
}

/** Top-level AND operands — the only conjuncts we may push. An OR (or a NOT)
 *  is NOT decomposable this way: pushing one of its branches would drop rows
 *  the other branch admits, so the whole node is ignored. */
function andConjuncts(expr: Expression): Expression[] {
  if (expr.type === 'logical' && expr.op === 'and') return expr.operands.flatMap(andConjuncts);
  return [expr];
}

function boundFromConjunct(
  expr: Expression,
  isTimestampRead: (propertyTypeId: string) => boolean,
  now: number,
): { side: BoundSide; seconds: number } | undefined {
  if (expr.type !== 'compare') return undefined;

  // `Timestamp WITHIN "7d"` — recency against the wall clock, so only ever a
  // lower bound. The engine's own WITHIN reads the clock LATER (after the
  // fetch), which makes its window a subset of this one.
  if (expr.op === 'within') {
    if (!isFieldRead(expr.left, isTimestampRead)) return undefined;
    const ms = durationToMs(literalValue(expr.right, now));
    if (ms === null) return undefined;
    return { side: 'oldest', seconds: (now - ms) / 1000 - WIDEN_SECONDS };
  }

  const oriented = isFieldRead(expr.left, isTimestampRead)
    ? { op: expr.op, other: expr.right }
    : isFieldRead(expr.right, isTimestampRead)
      ? { op: mirrorOp(expr.op), other: expr.left }
      : undefined;
  if (oriented === undefined) return undefined;

  const ms = toEpochMs(literalValue(oriented.other, now));
  if (ms === null) return undefined;
  const seconds = ms / 1000;
  switch (oriented.op) {
    case 'gt':
      return { side: 'oldest', seconds };
    case 'gte':
      return { side: 'oldest', seconds: seconds - WIDEN_SECONDS };
    case 'lt':
      return { side: 'latest', seconds };
    case 'lte':
      return { side: 'latest', seconds: seconds + WIDEN_SECONDS };
    // Equality, membership, presence and text operators say nothing about a
    // window; the engine answers them over what the window returns.
    default:
      return undefined;
  }
}

/** `a < b` read from b's side is `b > a` — so a comparison written with the
 *  timestamp on the right still yields the bound it means. */
function mirrorOp(op: Extract<Expression, { type: 'compare' }>['op']) {
  switch (op) {
    case 'gt': return 'lt' as const;
    case 'gte': return 'lte' as const;
    case 'lt': return 'gt' as const;
    case 'lte': return 'gte' as const;
    default: return op;
  }
}

/**
 * An UNQUALIFIED read of the timestamp on the record this hop lands on. A hop's
 * WHERE spells a bare backticked field as `edge_property` and a body-level one
 * as `property`; either way the name denotes the landing record, which is what
 * the window bounds.
 *
 * An alias-qualified read (`m.\`Timestamp\``, a zero-step traverse) is
 * deliberately NOT one: the alias may name an outer position entirely, and a
 * window built from another record's timestamp would drop messages the author
 * asked for. Not pushing costs a page; pushing the wrong bound costs results.
 */
function isFieldRead(
  expr: Expression,
  isTimestampRead: (propertyTypeId: string) => boolean,
): boolean {
  return (
    (expr.type === 'property' || expr.type === 'edge_property')
    && isTimestampRead(expr.propertyTypeId)
  );
}

/**
 * The constant an operand denotes, or undefined when it isn't one. Only a
 * literal and the two universal time keys qualify — anything the engine has to
 * resolve (an alias, another field, an AI() call) has no value here, and the
 * hop simply doesn't narrow.
 *
 * The `@current_*` shapes mirror the engine's `resolveMovementMetaKey`, so a
 * pushed bound and the engine's re-filtering agree on what the key meant.
 */
function literalValue(expr: Expression, now: number): unknown {
  if (expr.type === 'static') return expr.value;
  if (expr.type === 'meta' && expr.key === 'current_date') {
    return new Date(now).toISOString().slice(0, 10);
  }
  if (expr.type === 'meta' && expr.key === 'current_timestamp') {
    return new Date(now).toISOString();
  }
  return undefined;
}

// `durationToMs` / `toEpochMs` mirror the shared filter unit's own private
// helpers (`#shared/expression/filter`) so a bound we push and the predicate
// the engine re-applies read the same literal the same way.

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function durationToMs(spec: unknown): number | null {
  if (typeof spec === 'number') return Number.isFinite(spec) ? spec : null;
  if (typeof spec !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(spec.trim());
  if (!match) return null;
  return parseFloat(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()];
}

function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
