// The shared, low-dependency predicate evaluator (chunk 2 of the
// adapter-capability-contract plan). These tests pin its value semantics —
// the pure mirror of the engine's `evalMovementExpr` — and the `isPurePredicate`
// gate the engine, checker, and adapters all consult. No engine, no Prisma:
// the unit imports only the AST types, so it runs standalone.

import {
  compareValues,
  evaluatePredicate,
  isPurePredicate,
  leafReadKey,
  pureLeafReads,
} from '#shared/expression/filter';
import type { Expression, FilterOperator } from '#shared/expression/types';
import { parse, serialize } from '#shared/expression/formula';

const scopeOf = (fields: Record<string, unknown>) => ({
  read: (name: string) => fields[name],
});

describe('isPurePredicate', () => {
  const prop = (id: string): Expression => ({ type: 'property', propertyTypeId: id });

  it('accepts a comparison over leaf reads', () => {
    const expr: Expression = {
      type: 'compare',
      op: 'eq',
      left: prop('stage'),
      right: { type: 'static', value: 'Seed' },
    };
    expect(isPurePredicate(expr)).toBe(true);
  });

  it('accepts nested logical / not / arithmetic / conditional / at / list', () => {
    const expr: Expression = {
      type: 'logical',
      op: 'and',
      operands: [
        { type: 'not', expression: { type: 'compare', op: 'eq', left: prop('a'), right: { type: 'static', value: 1 } } },
        { type: 'compare', op: 'in', left: prop('b'), right: { type: 'list', elements: [{ type: 'static', value: 'x' }] } },
        { type: 'compare', op: 'gt', left: { type: 'arithmetic', op: '+', left: prop('c'), right: { type: 'static', value: 1 } }, right: { type: 'static', value: 0 } },
      ],
    };
    expect(isPurePredicate(expr)).toBe(true);
  });

  it('rejects a predicate containing an impure node (AI, function, traversal)', () => {
    const withAi: Expression = {
      type: 'compare',
      op: 'eq',
      left: prop('x'),
      right: { type: 'llm', prompt: 'hi' },
    };
    const withFn: Expression = { type: 'compare', op: 'eq', left: { type: 'function', fn: 'lower', args: [prop('x')] }, right: { type: 'static', value: 'a' } };
    const withTraverse: Expression = { type: 'exists', steps: [{ type: 'edge', edgeTypeId: 'e', direction: 'outgoing' }] };
    expect(isPurePredicate(withAi)).toBe(false);
    expect(isPurePredicate(withFn)).toBe(false);
    expect(isPurePredicate(withTraverse)).toBe(false);
  });

  it('accepts a meta node (`@current_date` etc.) — a pure ambient scalar', () => {
    // A meta leaf is engine-resolvable with no adapter / AI / traversal, so a
    // pure scalar WHERE that compares a field to it stays pushable.
    const withMeta: Expression = { type: 'compare', op: 'lte', left: prop('snoozed_until'), right: { type: 'meta', key: 'current_date' } };
    expect(isPurePredicate({ type: 'meta', key: 'current_date' })).toBe(true);
    expect(isPurePredicate(withMeta)).toBe(true);
  });

  it('accepts an alias-rooted ZERO-STEP traverse (a parameter field read like `t.firedAt`)', () => {
    // The AST a bare alias followed by `.field` parses to — a pure synchronous
    // leaf read of a bound position, like `property`/`alias_ref`.
    const paramRead: Expression = {
      type: 'traverse',
      aliasRoot: 't',
      steps: [],
      expression: { type: 'property', propertyTypeId: 'firedAt' },
    };
    expect(isPurePredicate(paramRead)).toBe(true);
    expect(
      isPurePredicate({
        type: 'compare',
        op: 'lte',
        left: prop('snoozed_until'),
        right: paramRead,
      }),
    ).toBe(true);
  });

  it('rejects a MULTI-step traverse (a real graph walk)', () => {
    const walk: Expression = {
      type: 'traverse',
      aliasRoot: 'c',
      steps: [{ type: 'edge', edgeTypeId: 'company', direction: 'outgoing' }],
      expression: { type: 'property', propertyTypeId: 'name' },
    };
    expect(isPurePredicate(walk)).toBe(false);
  });
});

describe('pureLeafReads', () => {
  it('collects property / edge_property / alias_ref leaves in traversal order', () => {
    const expr: Expression = {
      type: 'logical',
      op: 'or',
      operands: [
        { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'a' }, right: { type: 'edge_property', propertyTypeId: 'b' } },
        { type: 'not', expression: { type: 'alias_ref', name: 'c' } },
      ],
    };
    expect(pureLeafReads(expr).map(leafReadKey)).toEqual(['a', 'b', 'c']);
  });

  it('surfaces a zero-step traverse as a leaf, keyed by its alias-rooted path', () => {
    const traverse: Expression = {
      type: 'traverse',
      aliasRoot: 't',
      steps: [],
      expression: { type: 'property', propertyTypeId: 'firedAt' },
    };
    const expr: Expression = { type: 'compare', op: 'lte', left: { type: 'property', propertyTypeId: 'snoozed_until' }, right: traverse };
    // The traverse node surfaces whole — NOT descended into (its inner read is
    // alias-rooted, not a read of the subject record).
    expect(pureLeafReads(expr)).toEqual([{ type: 'property', propertyTypeId: 'snoozed_until' }, traverse]);
    expect(pureLeafReads(expr).map(leafReadKey)).toEqual(['snoozed_until', 't.firedAt']);
  });

  it('surfaces a meta leaf, keyed `@<key>` (distinct from a same-named field)', () => {
    const meta: Expression = { type: 'meta', key: 'current_date' };
    const expr: Expression = { type: 'compare', op: 'lte', left: { type: 'property', propertyTypeId: 'snoozed_until' }, right: meta };
    expect(pureLeafReads(expr)).toEqual([{ type: 'property', propertyTypeId: 'snoozed_until' }, meta]);
    expect(pureLeafReads(expr).map(leafReadKey)).toEqual(['snoozed_until', '@current_date']);
    // A field literally named `current_date` keys without the `@`.
    expect(leafReadKey({ type: 'property', propertyTypeId: 'current_date' })).toBe('current_date');
  });
});

describe('evaluatePredicate — value semantics mirror the engine', () => {
  it('reads property / edge_property / alias_ref through the scope', () => {
    expect(evaluatePredicate({ type: 'property', propertyTypeId: 'x' }, scopeOf({ x: 7 }))).toBe(7);
    expect(evaluatePredicate({ type: 'edge_property', propertyTypeId: 'role' }, scopeOf({ role: 'lead' }))).toBe('lead');
    expect(evaluatePredicate({ type: 'alias_ref', name: 'y' }, scopeOf({ y: 'z' }))).toBe('z');
  });

  it('reads a zero-step traverse leaf back through its alias-rooted scope key', () => {
    const traverse: Expression = {
      type: 'traverse',
      aliasRoot: 't',
      steps: [],
      expression: { type: 'property', propertyTypeId: 'firedAt' },
    };
    // Caller pre-resolved it under leafReadKey(traverse) === 't.firedAt'.
    expect(evaluatePredicate(traverse, scopeOf({ 't.firedAt': 1234 }))).toBe(1234);
    // A bare `firedAt` is a DIFFERENT read and must not satisfy it.
    expect(evaluatePredicate(traverse, scopeOf({ firedAt: 9999 }))).toBeUndefined();
  });

  it('reads a meta leaf back through its `@<key>` scope entry (engine pre-resolves it)', () => {
    // The engine's pure fast path pre-resolves `@current_date` through its meta
    // resolver and places it under `@current_date`; the comparison then reads it
    // back through the same key. A pure scalar WHERE round-trips end to end.
    const predicate: Expression = {
      type: 'compare',
      op: 'lte',
      left: { type: 'property', propertyTypeId: 'snoozed_until' },
      right: { type: 'meta', key: 'current_date' },
    };
    expect(evaluatePredicate(predicate, scopeOf({ snoozed_until: 100, '@current_date': 200 }))).toBe(true);
    expect(evaluatePredicate(predicate, scopeOf({ snoozed_until: 300, '@current_date': 200 }))).toBe(false);
    // A field literally named `current_date` does NOT satisfy the meta read.
    expect(
      evaluatePredicate({ type: 'meta', key: 'current_date' }, scopeOf({ current_date: 200 })),
    ).toBeUndefined();
  });

  it('compare: eq / neq with set-equality on arrays, in, contains, ordering', () => {
    const cmp = (op: FilterOperator, l: unknown, r: unknown) => compareValues(l, op, r);
    expect(cmp('eq', [1, 2], [2, 1])).toBe(true);
    expect(cmp('neq', [1, 2], [2, 3])).toBe(true);
    expect(cmp('in', 'b', ['a', 'b'])).toBe(true);
    expect(cmp('contains', 'hello', 'ell')).toBe(true);
    expect(cmp('gt', 5, 3)).toBe(true);
    expect(cmp('exists', null, undefined)).toBe(false);
    expect(cmp('exists', 0, undefined)).toBe(true);
  });

  it('relational ops compare date strings + lexical strings, not just Number()', () => {
    const cmp = (op: FilterOperator, l: unknown, r: unknown) => compareValues(l, op, r);
    // THE BUG: a date string Number()-coerces to NaN, so `Snoozed Until <= @current_date`
    // was false for every record. Date strings must compare chronologically.
    expect(cmp('lte', '2026-06-15', '2026-06-17')).toBe(true);
    expect(cmp('lte', '2026-06-18', '2026-06-17')).toBe(false);
    expect(cmp('lte', '2026-06-17', '2026-06-17')).toBe(true);
    expect(cmp('lte', '2026-06-15T09:00:00.000Z', '2026-06-17')).toBe(true);
    // plain numbers + numeric strings still compare numerically
    expect(cmp('lt', 5, 10)).toBe(true);
    expect(cmp('lt', '5', '10')).toBe(true);
    expect(cmp('gte', 10, 10)).toBe(true);
    // non-numeric, non-date strings compare lexically
    expect(cmp('lt', 'apple', 'banana')).toBe(true);
    // genuinely incomparable operands never match
    expect(cmp('lte', 'not-a-date', 5)).toBe(false);
  });

  it('logical short-circuits and/or', () => {
    const and: Expression = { type: 'logical', op: 'and', operands: [
      { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'a' }, right: { type: 'static', value: 1 } },
      { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'b' }, right: { type: 'static', value: 2 } },
    ] };
    expect(evaluatePredicate(and, scopeOf({ a: 1, b: 2 }))).toBe(true);
    expect(evaluatePredicate(and, scopeOf({ a: 0, b: 2 }))).toBe(false);
  });

  it('arithmetic: division by zero → null, otherwise numeric', () => {
    const div = (n: number, d: number): Expression => ({ type: 'arithmetic', op: '/', left: { type: 'static', value: n }, right: { type: 'static', value: d } });
    expect(evaluatePredicate(div(6, 2), scopeOf({}))).toBe(3);
    expect(evaluatePredicate(div(6, 0), scopeOf({}))).toBeNull();
  });

  it('negate: unary minus over a leaf read', () => {
    const negate: Expression = { type: 'negate', expression: { type: 'property', propertyTypeId: 'x' } };
    expect(evaluatePredicate(negate, scopeOf({ x: 5 }))).toBe(-5);
    expect(isPurePredicate(negate)).toBe(true);
  });

  it('arithmetic: % is TypeScript remainder (sign of the dividend), and by zero → null', () => {
    const mod = (n: number, d: number): Expression => ({ type: 'arithmetic', op: '%', left: { type: 'static', value: n }, right: { type: 'static', value: d } });
    expect(evaluatePredicate(mod(7, 3), scopeOf({}))).toBe(1);
    expect(evaluatePredicate(mod(-7, 20), scopeOf({}))).toBe(-7);
    expect(evaluatePredicate(mod(7, 0), scopeOf({}))).toBeNull();
    expect(isPurePredicate(mod(7, 3))).toBe(true);
  });

  it('concat folds nulls to empty strings', () => {
    const expr: Expression = { type: 'concat', parts: [{ type: 'static', value: 'a' }, { type: 'property', propertyTypeId: 'x' }, { type: 'static', value: 'b' }] };
    expect(evaluatePredicate(expr, scopeOf({ x: null }))).toBe('ab');
  });

  it('at: negative index from end, out of bounds → null, scalar as one-element list', () => {
    const at = (arr: Expression, i: number): Expression => ({ type: 'at', expression: arr, index: { type: 'static', value: i } });
    const list: Expression = { type: 'property', propertyTypeId: 'l' };
    expect(evaluatePredicate(at(list, -1), scopeOf({ l: [1, 2, 3] }))).toBe(3);
    expect(evaluatePredicate(at(list, 5), scopeOf({ l: [1, 2, 3] }))).toBeNull();
    expect(evaluatePredicate(at(list, 0), scopeOf({ l: 'solo' }))).toBe('solo');
  });

  it('WITHIN: parses, round-trips, and evaluates recency in the shared unit', () => {
    const identity = (name: string) => name;
    const expr = parse('updated WITHIN 30d', identity);
    expect(expr).toEqual({
      type: 'compare',
      op: 'within',
      left: { type: 'property', propertyTypeId: 'updated' },
      right: { type: 'static', value: '30d' },
    });
    // Bare-duration round-trip (not quoted).
    expect(serialize(expr, identity)).toBe('updated WITHIN 30d');
    // A WITHIN predicate is pure — pushable to an adapter / evaluable here.
    expect(isPurePredicate(expr)).toBe(true);

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    expect(evaluatePredicate(expr, scopeOf({ updated: daysAgo(2) }))).toBe(true);
    expect(evaluatePredicate(expr, scopeOf({ updated: daysAgo(45) }))).toBe(false);
    // A non-timestamp or absent value filters out rather than throwing.
    expect(evaluatePredicate(expr, scopeOf({ updated: null }))).toBe(false);
    expect(evaluatePredicate(expr, scopeOf({ updated: 'not-a-date' }))).toBe(false);
  });

  it('WITHIN: accepts hour / week units and a quoted duration', () => {
    const identity = (name: string) => name;
    expect(parse('seen WITHIN 12h', identity)).toMatchObject({ op: 'within', right: { value: '12h' } });
    expect(parse('seen WITHIN 1w', identity)).toMatchObject({ op: 'within', right: { value: '1w' } });
    expect(parse('seen WITHIN "30d"', identity)).toMatchObject({ op: 'within', right: { value: '30d' } });
  });

  it('conditional selects a branch on truthiness', () => {
    const expr: Expression = {
      type: 'conditional',
      condition: { type: 'compare', op: 'gt', left: { type: 'property', propertyTypeId: 'n' }, right: { type: 'static', value: 0 } },
      then: { type: 'static', value: 'pos' },
      else: { type: 'static', value: 'nonpos' },
    };
    expect(evaluatePredicate(expr, scopeOf({ n: 4 }))).toBe('pos');
    expect(evaluatePredicate(expr, scopeOf({ n: -4 }))).toBe('nonpos');
  });
});

// `== null` is the ONE loose comparison — TypeScript's carve-out, adopted so
// the language's guard idiom means the same thing everywhere. A read that isn't
// there arrives as `undefined` (an unknown name) or as `null` (an explicit
// empty); the author wrote one word, so both answer it. Everything else stays
// strict `===`. (plans/movement-absence-null-2026-07-31, piece 1.)
describe('comparison against the null literal', () => {
  const prop = (id: string): Expression => ({ type: 'property', propertyTypeId: id });
  const NULL: Expression = { type: 'static', value: null };
  const compare = (op: FilterOperator, left: Expression, right: Expression): Expression => ({
    type: 'compare',
    op,
    left,
    right,
  });
  const scope = scopeOf({ empty: null, filled: 'x', zero: 0, blank: '' });

  it('an undefined read (an unknown name) equals null', () => {
    expect(evaluatePredicate(compare('eq', prop('missing'), NULL), scope)).toBe(true);
    expect(evaluatePredicate(compare('neq', prop('missing'), NULL), scope)).toBe(false);
  });

  it('an explicit null equals null', () => {
    expect(evaluatePredicate(compare('eq', prop('empty'), NULL), scope)).toBe(true);
  });

  it('a present value does not — including the falsy ones', () => {
    for (const name of ['filled', 'zero', 'blank']) {
      expect(evaluatePredicate(compare('eq', prop(name), NULL), scope)).toBe(false);
      expect(evaluatePredicate(compare('neq', prop(name), NULL), scope)).toBe(true);
    }
  });

  it('reads the same in either operand order', () => {
    expect(evaluatePredicate(compare('eq', NULL, prop('missing')), scope)).toBe(true);
    expect(evaluatePredicate(compare('neq', NULL, prop('filled')), scope)).toBe(true);
  });

  it('ordering against null is false, never an accidental match', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte'] as FilterOperator[]) {
      expect(evaluatePredicate(compare(op, prop('zero'), NULL), scope)).toBe(false);
    }
  });

  it('value-to-value equality is untouched — undefined is NOT null there', () => {
    // The loosening is scoped to the LITERAL: two reads still compare strictly.
    expect(evaluatePredicate(compare('eq', prop('missing'), prop('empty')), scope)).toBe(false);
    expect(compareValues(undefined, 'eq', null)).toBe(false);
  });
});
