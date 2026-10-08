// The shared, low-dependency PREDICATE evaluator — the second slice of the
// reusable filter unit (plan: 2026-06-15-adapter-capability-contract). It is
// the pure mirror of the movement engine's `evalMovementExpr` value semantics,
// carved down to the subset that is genuinely PURE: no `AI()`, no traversal,
// no adapter, no KG, no async. A predicate over a record's own materialised
// fields and in-engine values, and nothing else.
//
// Used by BOTH:
//   - the engine, for hop-WHERE predicates over values it has already
//     materialised (it pre-resolves the leaf reads, then hands us a synchronous
//     scope reader);
//   - local adapters, to self-service bounded in-memory filtering over a set
//     they KNOW is small (one company's list entries) — they read fields off
//     the raw record through the same `read(name)` seam.
//
// The operator vocabulary this unit supports is the universe an adapter may
// claim filterable in its `describe()` capabilities: a kind/operator absent
// here is, by construction, never an adapter-filter capability — only an
// engine-over-local-values capability handled by the engine's async path.

import type { Expression, FilterOperator } from './types';
import { listElementExpression, mapListElement } from './types';

/** A synchronous reader for the leaf names a predicate references — a field of
 *  the record under evaluation, or an in-engine value the engine pre-resolved.
 *  Returns `undefined` for an unknown name (treated as a null read). */
export interface FilterScope {
  read(name: string): unknown;
  /** The instant `WITHIN` measures recency from (epoch milliseconds), read
   *  only when a `WITHIN` is evaluated; absent, the wall clock. The movement
   *  engine answers it from its host's `clock.now`. */
  now?: () => number;
}

/**
 * The Expression kinds this pure unit evaluates. Anything outside the set is
 * impure (needs the adapter, the LLM, the KG, or a traversal) and stays on the
 * engine's async evaluator. The checker (chunk 6) and adapters consult
 * `isPurePredicate` so the three never disagree about what's pushable.
 */
const PURE_KINDS: ReadonlySet<Expression['type']> = new Set<Expression['type']>([
  'static',
  'property',
  'edge_property',
  'alias_ref',
  // `@current_date` / `@user_email` / `@current_timestamp` — an ambient scalar
  // the engine resolves with no adapter, no AI, no traversal. A childless leaf,
  // so `isPurePredicate` admits it with no recursion (childExpressions → []).
  'meta',
  'list',
  'compare',
  'logical',
  'not',
  'negate',
  'concat',
  'conditional',
  'at',
  'arithmetic',
]);

/**
 * The top-level AND-ed conjuncts of a predicate — a bare predicate is one
 * conjunct, nested ANDs flatten, and OR / NOT / anything else stays whole.
 *
 * What every filter PUSHDOWN is built from: a source that can narrow by some
 * of a WHERE and not the rest needs the conjuncts separately, because an AND
 * is the one shape where satisfying part of it at the source and the rest here
 * still answers the question that was asked.
 */
export function flattenAndConjuncts(expr: Expression): Expression[] {
  if (expr.type === 'logical' && expr.op === 'and') {
    return expr.operands.flatMap(flattenAndConjuncts);
  }
  return [expr];
}

/**
 * True iff every node of `expr` is in the pure set — i.e. the shared unit (and
 * therefore an adapter, or the engine over local values) can evaluate it with
 * no async, no adapter, no AI. A single impure descendant (an `AI()`, a
 * traversal, a `meta` key, a `function` call) makes the whole predicate impure.
 */
export function isPurePredicate(expr: Expression): boolean {
  // An alias-rooted ZERO-STEP traverse (`t.firedAt`) is a pure synchronous
  // leaf read of a bound position value — semantically identical to
  // `property`/`alias_ref`, which are already pure. It parses to a `traverse`
  // node only because the bare alias was followed by `.field`. It is pure iff
  // its wrapped read is. A traverse with NON-EMPTY steps is a real graph walk
  // (adapter/KG) and stays impure.
  if (expr.type === 'traverse') {
    return expr.steps.length === 0 && isPurePredicate(expr.expression);
  }
  if (!PURE_KINDS.has(expr.type)) return false;
  return childExpressions(expr).every(isPurePredicate);
}

/**
 * The leaf read nodes a pure predicate references — the values a caller must
 * materialise BEFORE evaluation: the engine resolves them through its own read
 * seams, a local adapter reads them off the record. `property`/`edge_property`/
 * `alias_ref` read by their flat name; an alias-rooted ZERO-STEP traverse
 * (`t.firedAt`) is also a leaf — a synchronous read of a bound position's
 * field — keyed by `leafReadKey`. Order is traversal order; callers dedupe by
 * key.
 */
export type LeafRead =
  | Extract<Expression, { type: 'property' | 'edge_property' | 'alias_ref' }>
  | Extract<Expression, { type: 'traverse' }>
  | Extract<Expression, { type: 'meta' }>;

export function pureLeafReads(expr: Expression): LeafRead[] {
  if (expr.type === 'property' || expr.type === 'edge_property' || expr.type === 'alias_ref') {
    return [expr];
  }
  // A `meta` node is itself a leaf read — an ambient scalar resolved before
  // evaluation (the engine via its meta resolver, keyed by `leafReadKey`).
  if (expr.type === 'meta') {
    return [expr];
  }
  // A zero-step traverse is itself a leaf read — DON'T descend into its wrapped
  // expression (that field-read is alias-rooted, not a read of the subject).
  if (expr.type === 'traverse' && expr.steps.length === 0) {
    return [expr];
  }
  return childExpressions(expr).flatMap(pureLeafReads);
}

/**
 * The stable scope key for a pure leaf read — the name a caller resolves it
 * under and `evaluatePredicate` reads it back by. The two sides MUST agree, so
 * both go through here. A zero-step traverse is keyed by its alias-rooted path
 * (`t.firedAt`) so it never collides with a bare `firedAt` field read.
 */
export function leafReadKey(leaf: LeafRead): string {
  switch (leaf.type) {
    case 'alias_ref':
      return leaf.name;
    case 'property':
    case 'edge_property':
      return leaf.propertyTypeId;
    // `@`-prefixed so the ambient key never collides with a record field of
    // the same name (a field literally called `current_date` keys as
    // `current_date`).
    case 'meta':
      return `@${leaf.key}`;
    case 'traverse': {
      const inner = leaf.expression;
      const innerKey =
        inner.type === 'property' || inner.type === 'edge_property'
          ? inner.propertyTypeId
          : inner.type === 'alias_ref'
            ? inner.name
            : inner.type === 'traverse'
              ? leafReadKey(inner)
              : '';
      return `${leaf.aliasRoot ?? ''}.${innerKey}`;
    }
  }
}

/**
 * Rebuild a pure predicate with some of its leaf reads swapped for other
 * expressions, keyed by NODE IDENTITY — the very nodes `pureLeafReads`
 * returned. Identity rather than name because two leaves can share a name and
 * mean different things (the record's own field, a value bound around it), and
 * only the caller that told them apart can say which is which.
 *
 * A `traverse` leaf is opaque here, exactly as it is to `pureLeafReads`: its
 * wrapped read is alias-rooted, not a read of the subject.
 */
export function replacePureLeaves(
  expr: Expression,
  replacements: ReadonlyMap<Expression, Expression>,
): Expression {
  const replacement = replacements.get(expr);
  if (replacement !== undefined) return replacement;
  switch (expr.type) {
    case 'list':
      return { ...expr, elements: expr.elements.map((e) => mapListElement(e, (x) => replacePureLeaves(x, replacements))) };
    case 'compare':
      return {
        ...expr,
        left: replacePureLeaves(expr.left, replacements),
        right: replacePureLeaves(expr.right, replacements),
      };
    case 'arithmetic':
      return {
        ...expr,
        left: replacePureLeaves(expr.left, replacements),
        right: replacePureLeaves(expr.right, replacements),
      };
    case 'logical':
      return { ...expr, operands: expr.operands.map((o) => replacePureLeaves(o, replacements)) };
    case 'not':
      return { ...expr, expression: replacePureLeaves(expr.expression, replacements) };
    case 'negate':
      return { ...expr, expression: replacePureLeaves(expr.expression, replacements) };
    case 'concat':
      return { ...expr, parts: expr.parts.map((p) => replacePureLeaves(p, replacements)) };
    case 'conditional':
      return {
        ...expr,
        condition: replacePureLeaves(expr.condition, replacements),
        then: replacePureLeaves(expr.then, replacements),
        else: replacePureLeaves(expr.else, replacements),
      };
    case 'at':
      return {
        ...expr,
        expression: replacePureLeaves(expr.expression, replacements),
        index: replacePureLeaves(expr.index, replacements),
      };
    default:
      return expr;
  }
}

/** The direct sub-expressions of a pure-kinded node (empty for leaves). */
function childExpressions(expr: Expression): Expression[] {
  switch (expr.type) {
    case 'list':
      return expr.elements.map(listElementExpression);
    case 'compare':
    case 'arithmetic':
      return [expr.left, expr.right];
    case 'logical':
      return expr.operands;
    case 'not':
    case 'negate':
      return [expr.expression];
    case 'concat':
      return expr.parts;
    case 'conditional':
      return [expr.condition, expr.then, expr.else];
    case 'at':
      return [expr.expression, expr.index];
    default:
      return [];
  }
}

/**
 * Evaluate a PURE predicate to a value, reading leaf names through `scope`.
 * Mirrors `evalMovementExpr`'s value semantics construct-for-construct (the
 * provenance the engine carries is irrelevant to a filter decision, so this
 * unit returns plain values). An impure node throws — callers gate on
 * `isPurePredicate` first.
 */
export function evaluatePredicate(expr: Expression, scope: FilterScope): unknown {
  switch (expr.type) {
    case 'static':
      return expr.value;

    // A pure leaf read: a field of the record under evaluation, or an
    // in-engine value the caller pre-resolved. `property`, `edge_property` and
    // `alias_ref` all read by name through the one synchronous seam.
    case 'property':
    case 'edge_property':
      return scope.read(expr.propertyTypeId);
    case 'alias_ref':
      return scope.read(expr.name);

    // A `meta` node (`@current_date`) is a pure ambient scalar the caller
    // pre-resolved under `leafReadKey` (`@<key>`) — read it back through the
    // same key.
    case 'meta':
      return scope.read(leafReadKey(expr));

    // A zero-step alias-rooted traverse (`t.firedAt`) is a pure leaf read of a
    // bound position's field. `isPurePredicate` only admits the zero-step form;
    // the caller pre-resolved it under `leafReadKey`. A non-empty-steps
    // traverse is impure and falls to the throw below (gate on isPurePredicate
    // first).
    case 'traverse':
      if (expr.steps.length === 0) return scope.read(leafReadKey(expr));
      throw new Error(
        `evaluatePredicate: a multi-step traverse is not a pure predicate kind — gate on isPurePredicate() first`,
      );

    case 'list':
      return expr.elements.flatMap((e) => {
        if (e.type !== 'spread') return [evaluatePredicate(e, scope)];
        // `...xs` splices the members in. Spreading anything but a list is a
        // mistake the checker refuses where it can see the type; here, at run
        // time, it fails loudly rather than splicing nothing.
        const spread = evaluatePredicate(e.expression, scope);
        if (!Array.isArray(spread)) {
          throw new Error(`'...' spreads a list into a list, and this value is ${spread === null || spread === undefined ? 'null' : typeof spread}`);
        }
        return spread;
      });

    case 'concat':
      return expr.parts
        .map((p) => {
          const v = evaluatePredicate(p, scope);
          return v == null ? '' : String(v);
        })
        .join('');

    case 'conditional':
      return evaluatePredicate(expr.condition, scope)
        ? evaluatePredicate(expr.then, scope)
        : evaluatePredicate(expr.else, scope);

    case 'compare': {
      const left = evaluatePredicate(expr.left, scope);
      const right = evaluatePredicate(expr.right, scope);
      if (isNullLiteral(expr.left)) return compareToNull(expr.op, right);
      if (isNullLiteral(expr.right)) return compareToNull(expr.op, left);
      return compareValues(left, expr.op, right, expr.op === 'within' && scope.now !== undefined ? { now: scope.now() } : {});
    }

    case 'logical': {
      if (expr.op === 'and') {
        for (const operand of expr.operands) {
          if (!evaluatePredicate(operand, scope)) return false;
        }
        return true;
      }
      for (const operand of expr.operands) {
        if (evaluatePredicate(operand, scope)) return true;
      }
      return false;
    }

    case 'not':
      return !evaluatePredicate(expr.expression, scope);

    case 'negate':
      return -Number(evaluatePredicate(expr.expression, scope));

    case 'arithmetic': {
      const l = Number(evaluatePredicate(expr.left, scope));
      const r = Number(evaluatePredicate(expr.right, scope));
      switch (expr.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return r === 0 ? null : l / r;
        case '%':
          return r === 0 ? null : l % r;
      }
      return null;
    }

    case 'at': {
      // Engine `at` semantics verbatim: non-integer index → null; a scalar
      // acts as a one-element list (index 0 or -1 yield it); negatives count
      // from the end; out of bounds → null.
      const value = evaluatePredicate(expr.expression, scope);
      const index = Number(evaluatePredicate(expr.index, scope));
      if (!Number.isInteger(index)) return null;
      if (!Array.isArray(value)) {
        if (value === null || value === undefined) return null;
        return index === 0 || index === -1 ? value : null;
      }
      const resolved = index < 0 ? value.length + index : index;
      if (resolved < 0 || resolved >= value.length) return null;
      return value[resolved];
    }

    default:
      throw new Error(
        `evaluatePredicate: '${expr.type}' is not a pure predicate kind — gate on isPurePredicate() first`,
      );
  }
}

/** The `null` LITERAL, as authored (`x == NULL`) — the one operand that turns a
 *  comparison into a presence question. */
export function isNullLiteral(expr: Expression): boolean {
  return expr.type === 'static' && expr.value === null;
}

/**
 * `x == null` / `x != null` — the ONE loose comparison, TypeScript's own
 * carve-out and the language's guard idiom. A read that isn't there arrives as
 * `undefined` (an unknown name, a field the record lacks) or as `null` (an
 * explicit empty); the author wrote one word for both, so both answer it.
 *
 * Scoped to the null LITERAL deliberately: value-to-value equality stays strict
 * `===`, so nothing else in the language gains a coercion.
 *
 * Any other operator against null is asking to order or match against nothing,
 * which nothing satisfies — false (the checker reports it at author time).
 */
export function compareToNull(op: FilterOperator, value: unknown): boolean {
  const absent = value === null || value === undefined;
  if (op === 'eq') return absent;
  if (op === 'neq') return !absent;
  return false;
}

/**
 * Scalar comparison semantics — moved verbatim from the movement engine
 * (`movement_engine/expression.ts`) so the engine, this shared unit, and
 * adapters all decide a comparison identically. The engine re-imports this.
 */
export function compareValues(
  left: unknown,
  op: FilterOperator,
  right: unknown,
  options: { now?: number } = {},
): boolean {
  switch (op) {
    case 'eq':
      if (Array.isArray(left) && Array.isArray(right)) return setEquals(left, right);
      return left === right;
    case 'neq':
      if (Array.isArray(left) && Array.isArray(right)) return !setEquals(left, right);
      return left !== right;
    case 'gt': {
      const c = relationalOrder(left, right);
      return c !== null && c > 0;
    }
    case 'gte': {
      const c = relationalOrder(left, right);
      return c !== null && c >= 0;
    }
    case 'lt': {
      const c = relationalOrder(left, right);
      return c !== null && c < 0;
    }
    case 'lte': {
      const c = relationalOrder(left, right);
      return c !== null && c <= 0;
    }
    case 'exists':
      return left !== null && left !== undefined;
    case 'in':
      return Array.isArray(right) && right.includes(left);
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
      if (Array.isArray(left)) return left.includes(right);
      return false;
    case 'within': {
      // `field WITHIN 30d` — the field's timestamp is at most `30d` old, as
      // of `options.now` (the wall clock when absent). Recency needs a clock,
      // so this is the one operator that isn't a pure function of its
      // operands. A non-timestamp left or an
      // unparseable duration filters the row OUT (false), never throws.
      const ts = toEpochMs(left);
      const ms = durationToMs(right);
      if (ts === null || ms === null) return false;
      return (options.now ?? Date.now()) - ts <= ms;
    }
    default:
      return false;
  }
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** A duration literal (`"30d"`, `"12h"`, `"1w"`) → milliseconds. A raw number
 *  is taken as milliseconds already. Anything else → null. */
function durationToMs(spec: unknown): number | null {
  if (typeof spec === 'number') return Number.isFinite(spec) ? spec : null;
  if (typeof spec !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(spec.trim());
  if (!match) return null;
  return parseFloat(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()];
}

/** A field value → epoch milliseconds: a number is taken as-is, a string is
 *  parsed as a date (ISO timestamps included). Unparseable → null. */
function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = new Date(value as string | Date).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** A value as a finite number — a number as-is, a numeric string parsed.
 *  null/undefined/booleans/objects and non-numeric strings → null. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Order two operands for `< <= > >=`: numerically when both are numbers,
 *  else chronologically when both parse as dates (so `Snoozed Until <=
 *  @current_date` works — a date string isn't a finite Number()), else
 *  lexically when both are strings. Returns -1/0/1, or null when the operands
 *  aren't comparable (then the operator yields false rather than NaN-coercing). */
function relationalOrder(left: unknown, right: unknown): number | null {
  const ln = toFiniteNumber(left);
  const rn = toFiniteNumber(right);
  if (ln !== null && rn !== null) return Math.sign(ln - rn);

  const ld = toEpochMs(left);
  const rd = toEpochMs(right);
  if (ld !== null && rd !== null) return Math.sign(ld - rd);

  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return null;
}

/** Order-insensitive equality of two lists treated as sets. */
function setEquals(a: unknown[], b: unknown[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  return a.every((v) => sb.has(v));
}
