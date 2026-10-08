// Shared, low-dependency ORDER BY / LIMIT evaluation — the first slice of the
// reusable filter unit (plan: 2026-06-15-adapter-capability-contract). Pure
// sorting/slicing over a yielded set; the only impurity (reading an item's
// order key) is INJECTED via `options.value`, so this stays free of engine, KG,
// adapter, and AI dependencies. The engine uses it for in-engine values; local
// adapters can import it to self-service ordering/limiting over a bounded set.

import { isPurePredicate } from './filter';
import type { EdgeCapability, EdgeStep, Expression, NaturalOrder } from './types';

/** Total order for ORDER BY keys: numbers numerically, else lexicographically;
 *  empty (null/undefined) sorts last regardless of direction. */
export function compareOrderValues(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** The hop cardinality shape the bracket grammar produces. */
export type HopCardinality = EdgeStep['cardinality'];

/** The ORDER BY key a hop carries, when it carries one — an expression over the
 *  element, evaluated once per element before the sort. */
export function hopOrderKey(cardinality: HopCardinality): Expression | undefined {
  return cardinality?.orderBy;
}

/**
 * The bare property of the LANDED RECORD an ordering key names, when it names
 * one. That is the only key shape an adapter can be asked to sort by: anything
 * else (a path through the element's own alias, a computed key) is a walk of
 * this engine's, not a column of the source's.
 *
 */
export function orderKeyProperty(key: Expression | undefined): string | undefined {
  return key !== undefined && key.type === 'property' ? key.propertyTypeId : undefined;
}

/**
 * Whether an ORDER BY asks for exactly the order the edge already delivers its
 * records in (`EdgeCapability.naturalOrder`) — same field, same direction. Such
 * an ORDER BY is satisfied at the source: nothing to sort afterwards, so a
 * LIMIT taken there keeps the right records. Anything else — another field, the
 * opposite direction, an edge that declares no natural order — is not.
 *
 * `order.field` must already be in the surface spelling the declaration uses;
 * the checker holds that spelling, an adapter resolves to it first.
 */
export function isNaturalOrder(
  capability: Pick<EdgeCapability, 'naturalOrder'> | undefined,
  order: NaturalOrder,
): boolean {
  const natural = capability?.naturalOrder;
  return natural !== undefined && natural.field === order.field && natural.direction === order.direction;
}

/** The ORDER BY property a hop cardinality names, when its key is a bare
 *  property of the landed record. */
export function hopOrderProperty(cardinality: HopCardinality): string | undefined {
  return orderKeyProperty(hopOrderKey(cardinality));
}

/**
 * Sort `items` by an ASYNCHRONOUS key read, stably. Empty keys sort last
 * regardless of direction (an element nobody can rank goes to the end either
 * way), and ties keep the order the items arrived in.
 */
export async function sortByOrderKey<T>(
  items: T[],
  direction: 'asc' | 'desc' | undefined,
  options: { value: (item: T) => Promise<unknown> },
): Promise<T[]> {
  // Every key read settles before any failure is thrown, and the failure is
  // the earliest by position, not the first to arrive: the Rust engine and
  // apps/api's settle-all (fans.ts, which this package cannot import) fail the
  // same way, so a run fails identically whatever order the reads land in.
  const outcomes = await Promise.allSettled(
    items.map(async (item, index) => ({ item, index, key: await options.value(item) })),
  );
  const keyed: Array<{ item: T; index: number; key: unknown }> = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason;
    keyed.push(outcome.value);
  }
  const sign = direction === 'desc' ? -1 : 1;
  keyed.sort((a, b) => {
    const byKey = compareOrderValues(a.key, b.key);
    if (byKey !== 0) {
      const aEmpty = a.key === null || a.key === undefined;
      const bEmpty = b.key === null || b.key === undefined;
      if (aEmpty || bEmpty) return byKey;
      return byKey * sign;
    }
    return a.index - b.index;
  });
  return keyed.map((k) => k.item);
}

/**
 * Apply one hop's ORDER BY / LIMIT to the records it yielded from ONE origin
 * position. `value` evaluates the hop's ordering KEY against an item — a
 * property of the landed record, a short path off it, anything the element
 * scope can answer — through whatever seam the item reads by.
 */
export async function applyHopOrderLimit<T>(
  items: T[],
  cardinality: HopCardinality,
  options: { value: (item: T) => Promise<unknown> },
): Promise<T[]> {
  if (!cardinality) return items;
  let result = items;
  if (cardinality.orderBy !== undefined) {
    result = await sortByOrderKey(result, cardinality.orderDirection, options);
  }
  if (cardinality.limit !== undefined) {
    result = result.slice(0, cardinality.limit);
  }
  return result;
}

/**
 * What ONE hop pushes to the adapter for its fetch — the WHERE (only when
 * pure), the ORDER BY the bracket names, and the LIMIT. Every walker builds
 * its adapter call from this, so a hop fetches the same way wherever it is
 * written: at the head of a block, inside an expression, or inside EXISTS.
 *
 * Pushing is an OPTIMISATION, never the guarantee: an adapter may honour any,
 * all or none of it, and each walker still post-filters, then sorts and slices
 * through `applyHopOrderLimit` over whatever came back. The one rule an adapter
 * must keep is the contract on `limit` (see `GetRelatedInput.limit`): a limit
 * may only be honoured alongside the sort it came with.
 */
export function hopPushdown(step: Pick<EdgeStep, 'cardinality' | 'expressionFilter'>): {
  where?: Expression;
  orderBy?: { fieldId: string; direction: 'asc' | 'desc' };
  limit?: number;
} {
  // An IMPURE WHERE (an `AI()`, a sub-traversal) can't cross the seam — no
  // adapter can evaluate it — so it stays entirely with the engine's
  // post-filter. The checker gates those to bounded edges.
  const where =
    step.expressionFilter !== undefined && isPurePredicate(step.expressionFilter)
      ? step.expressionFilter
      : undefined;
  // A key that is not a bare property of the landed record cannot cross the
  // seam — the adapter has no such column to sort by — so the sort stays here,
  // and with it the LIMIT: a truncated fetch followed by an engine sort would
  // answer the wrong records (`GetRelatedInput.limit`'s contract, D1).
  const orderKey = hopOrderKey(step.cardinality);
  const orderProperty = orderKeyProperty(orderKey);
  const pushesOrder = orderKey === undefined || orderProperty !== undefined;
  return {
    ...(where !== undefined ? { where } : {}),
    ...(orderProperty !== undefined
      ? {
          orderBy: {
            fieldId: orderProperty,
            direction: step.cardinality?.orderDirection ?? 'asc',
          },
        }
      : {}),
    ...(pushesOrder && step.cardinality?.limit !== undefined
      ? { limit: step.cardinality.limit }
      : {}),
  };
}
