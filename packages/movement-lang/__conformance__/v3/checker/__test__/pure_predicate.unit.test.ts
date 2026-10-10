// Pins the purity carve-out for alias-rooted ZERO-STEP traverse leaf reads
// (the AST a parameter field-read like `t.firedAt` parses to). Such a read is
// a pure synchronous leaf — semantically identical to `property`/`alias_ref`,
// which are already pure — so a pure scalar WHERE that references a bound
// position value must be classified pure and pushable, NOT gated as
// "must run in app (AI/EXISTS) over an unbounded source".
//
// The negative guard pins the carve-out's narrowness: a MULTI-step traverse
// (a real graph walk, steps.length > 0) stays impure.

import {
  evaluatePredicate,
  isPurePredicate,
  leafReadKey,
  pureLeafReads,
} from '@listen-fire/shared/expression/filter';
import type { Expression } from '@listen-fire/shared/expression/types';

// `t.firedAt` — the exact AST the formula parser emits for a bare alias
// followed by `.field`: an alias-rooted traverse with EMPTY steps wrapping the
// field read. (formula.ts parseAtom: `{ type:'traverse', aliasRoot, steps:[],
//  expression }`.)
const aliasParamRead = (alias: string, propertyTypeId: string): Expression => ({
  type: 'traverse',
  aliasRoot: alias,
  steps: [],
  expression: { type: 'property', propertyTypeId },
});

describe('isPurePredicate — alias-rooted zero-step traverse carve-out', () => {
  it('treats `snoozed_until <= t.firedAt AND status == "Snoozed"` as PURE', () => {
    // Mirrors the UnsnoozeActions hop WHERE that was wrongly gated:
    //   kg-[a:Action WHERE snoozed_until <= t.firedAt AND status == "Snoozed"]->
    const predicate: Expression = {
      type: 'logical',
      op: 'and',
      operands: [
        {
          type: 'compare',
          op: 'lte',
          left: { type: 'property', propertyTypeId: 'snoozed_until' },
          right: aliasParamRead('t', 'firedAt'),
        },
        {
          type: 'compare',
          op: 'eq',
          left: { type: 'property', propertyTypeId: 'status' },
          right: { type: 'static', value: 'Snoozed' },
        },
      ],
    };

    expect(isPurePredicate(predicate)).toBe(true);
  });

  it('treats a bare zero-step traverse leaf read as PURE', () => {
    expect(isPurePredicate(aliasParamRead('t', 'firedAt'))).toBe(true);
  });

  it('keeps a MULTI-step traverse (real graph walk) IMPURE', () => {
    // `c-[:company]->.name` — a traverse with a non-empty steps[] is a genuine
    // graph walk, not a synchronous leaf read; it must stay impure so it is
    // never pushed to a native adapter as a server-side filter.
    const graphWalk: Expression = {
      type: 'traverse',
      aliasRoot: 'c',
      steps: [{ type: 'edge', edgeTypeId: 'company', direction: 'outgoing' }],
      expression: { type: 'property', propertyTypeId: 'name' },
    };

    expect(isPurePredicate(graphWalk)).toBe(false);

    // And a predicate that merely CONTAINS such a walk is tainted impure.
    const predicate: Expression = {
      type: 'compare',
      op: 'eq',
      left: graphWalk,
      right: { type: 'static', value: 'Acme' },
    };
    expect(isPurePredicate(predicate)).toBe(false);
  });
});

// A `meta` node (`@current_date`, `@user_email`, `@current_timestamp`) is a
// pure, engine-resolvable ambient scalar — a childless leaf, just like the
// alias-rooted zero-step traverse. A pure scalar WHERE that compares a field to
// one (the UnsnoozeActions `Snoozed Until` <= @current_date case) must classify
// PURE, NOT trip the "must run in app (AI/EXISTS) over an unbounded source" gate.
const meta = (key: string): Extract<Expression, { type: 'meta' }> => ({ type: 'meta', key });

describe('isPurePredicate — meta (@current_date etc.) carve-out', () => {
  it('treats `\`Snoozed Until\` <= @current_date AND Status == "Snoozed"` as PURE', () => {
    const predicate: Expression = {
      type: 'logical',
      op: 'and',
      operands: [
        {
          type: 'compare',
          op: 'lte',
          left: { type: 'property', propertyTypeId: 'Snoozed Until' },
          right: meta('current_date'),
        },
        {
          type: 'compare',
          op: 'eq',
          left: { type: 'property', propertyTypeId: 'Status' },
          right: { type: 'static', value: 'Snoozed' },
        },
      ],
    };
    expect(isPurePredicate(predicate)).toBe(true);
  });

  it('treats a bare meta leaf as PURE', () => {
    expect(isPurePredicate(meta('current_date'))).toBe(true);
    expect(isPurePredicate(meta('user_email'))).toBe(true);
  });

  it('surfaces a meta leaf and keys it distinctly from any field', () => {
    const predicate: Expression = {
      type: 'compare',
      op: 'lte',
      left: { type: 'property', propertyTypeId: 'Snoozed Until' },
      right: meta('current_date'),
    };
    const leaves = pureLeafReads(predicate);
    expect(leaves).toContainEqual(meta('current_date'));
    expect(leafReadKey(meta('current_date'))).toBe('@current_date');
    // A field literally named `current_date` keys without the `@` — never collides.
    expect(leafReadKey({ type: 'property', propertyTypeId: 'current_date' })).toBe('current_date');
  });

  it('evaluatePredicate reads a meta leaf back through its @-keyed scope entry', () => {
    const predicate: Expression = {
      type: 'compare',
      op: 'lte',
      left: { type: 'property', propertyTypeId: 'Snoozed Until' },
      right: meta('current_date'),
    };
    const scope = { 'Snoozed Until': 100, '@current_date': 200 };
    expect(
      evaluatePredicate(predicate, { read: (n) => (scope as Record<string, unknown>)[n] }),
    ).toBe(true);
    const future = { 'Snoozed Until': 300, '@current_date': 200 };
    expect(
      evaluatePredicate(predicate, { read: (n) => (future as Record<string, unknown>)[n] }),
    ).toBe(false);
  });
});

describe('zero-step traverse — runtime leaf-read contract', () => {
  // pureLeafReads must SURFACE the zero-step traverse (so the caller resolves
  // it before evaluation) without descending into its alias-rooted wrapped
  // read, and evaluatePredicate must read it back under the SAME key. If the
  // two disagreed, the engine's pure fast path would throw or misresolve.
  it('surfaces the traverse leaf under a stable alias-rooted key', () => {
    const leaf = aliasParamRead('t', 'firedAt');
    const leaves = pureLeafReads(leaf);
    expect(leaves).toEqual([leaf]); // the traverse node itself, not its inner read
    expect(leafReadKey(leaves[0])).toBe('t.firedAt');
    // Distinct from a bare `firedAt` field read — never collides.
    expect(leafReadKey({ type: 'property', propertyTypeId: 'firedAt' })).toBe('firedAt');
  });

  it('evaluatePredicate reads the traverse leaf back through the scope key', () => {
    const predicate: Expression = {
      type: 'logical',
      op: 'and',
      operands: [
        {
          type: 'compare',
          op: 'lte',
          left: { type: 'property', propertyTypeId: 'snoozed_until' },
          right: aliasParamRead('t', 'firedAt'),
        },
        {
          type: 'compare',
          op: 'eq',
          left: { type: 'property', propertyTypeId: 'status' },
          right: { type: 'static', value: 'Snoozed' },
        },
      ],
    };
    const scope = { snoozed_until: 100, 't.firedAt': 200, status: 'Snoozed' };
    expect(evaluatePredicate(predicate, { read: (n) => (scope as Record<string, unknown>)[n] })).toBe(
      true,
    );
    const tooEarly = { snoozed_until: 300, 't.firedAt': 200, status: 'Snoozed' };
    expect(
      evaluatePredicate(predicate, { read: (n) => (tooEarly as Record<string, unknown>)[n] }),
    ).toBe(false);
  });
});
