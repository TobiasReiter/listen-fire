// A statement condition keeps the precedence an expression has: AND binds
// tighter than OR, so `a OR b AND c` is `a OR (b AND c)`, and an `IF … AND …
// END` inside a condition reads whole. The old expression bridge split a
// condition on every top-level AND before parsing, so the first ran as
// `(a OR b) AND c` and the second was refused. Fixed under every language
// version (plans/functional-extract-2026-10-02/2_one_grammar.md).

import { Environment, evalMovementExpr } from '../expression';
import { parseMovementCondition, parseMovementExpression, type MovementCondition } from 'movement-lang';

/** A condition's truth as the run reads it: every top-level conjunct holds. */
async function holds(condition: MovementCondition, env: Environment): Promise<boolean> {
  switch (condition.kind) {
    case 'and':
      for (const conjunct of condition.conjuncts) if (!(await holds(conjunct, env))) return false;
      return true;
    case 'expr':
      return Boolean((await evalMovementExpr(condition.expr, { env })).value);
    case 'isTest':
      throw new Error('no type tests here');
  }
}

function envOf(bindings: Record<string, unknown>): Environment {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) env.declare(name, { kind: 'value', value });
  return env;
}

describe('a condition reads as the same expression would', () => {
  const cases: ReadonlyArray<[string, Record<string, unknown>, boolean]> = [
    // a OR (b AND c): true; the bridge's (a OR b) AND c was false.
    ['a OR b AND c', { a: true, b: true, c: false }, true],
    ['a OR b AND c', { a: false, b: true, c: false }, false],
    ['a AND b OR c', { a: false, b: true, c: true }, true],
    ['IF a AND b THEN 1 ELSE 0 END == 1', { a: true, b: true }, true],
    ['IF a AND b THEN 1 ELSE 0 END == 1', { a: true, b: false }, false],
  ];

  it.each(cases)('%s with %j → %s', async (raw, bindings, expected) => {
    const env = envOf(bindings);
    await expect(holds(parseMovementCondition(raw), env)).resolves.toBe(expected);
    await expect(evalMovementExpr(parseMovementExpression(raw), { env }).then(r => Boolean(r.value))).resolves.toBe(
      expected,
    );
  });
});
