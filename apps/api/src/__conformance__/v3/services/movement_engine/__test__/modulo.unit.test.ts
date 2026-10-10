// `%` end to end: parses (formula grammar), evaluates (the engine's
// `evalMovementExpr`), and is not flagged by the interpretability gate that
// blocks a save (`listUnsupportedConstructs`) — the three surfaces that must
// all agree a construct is live before an author can use it. Same shape as
// negate.unit.test.ts (unary minus, 2026-09-28).

import { Environment, evalMovementExpr } from '../expression';
import { listUnsupportedConstructs } from '../interpretable';
import { parseMovementExpression } from 'movement-lang';

async function evaluate(text: string, bindings: Record<string, unknown> = {}): Promise<unknown> {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) {
    env.declare(name, { kind: 'value', value });
  }
  return (await evalMovementExpr(parseMovementExpression(text), { env })).value;
}

describe('% (remainder) evaluation', () => {
  it('the ordinary case', async () => {
    await expect(evaluate('a % b', { a: 7, b: 3 })).resolves.toBe(1);
  });

  it('TypeScript remainder semantics — the sign of the DIVIDEND, not truncated-toward-zero mod', async () => {
    await expect(evaluate('a % b', { a: -7, b: 20 })).resolves.toBe(-7);
  });

  it('a negative divisor', async () => {
    await expect(evaluate('a % b', { a: 7, b: -3 })).resolves.toBe(1);
  });

  it('division by zero is null, like /', async () => {
    await expect(evaluate('a % b', { a: 7, b: 0 })).resolves.toBeNull();
  });

  it('composes with * and / at the same precedence, left-associative', async () => {
    // 10 % 4 * 2 == (10 % 4) * 2 == 4
    await expect(evaluate('a % b * c', { a: 10, b: 4, c: 2 })).resolves.toBe(4);
  });

  it('binds tighter than + / -', async () => {
    // 1 + 10 % 3 == 1 + (10 % 3) == 2
    await expect(evaluate('a + b % c', { a: 1, b: 10, c: 3 })).resolves.toBe(2);
  });
});

describe('% is not flagged by the interpretability gate', () => {
  it('a movement using a % b in a write field passes clean', () => {
    const source = `
import { email, crm } from adapters
import { acme_workspace } from credentials

inbox = email()
c = crm(credentials: acme_workspace)

movement remind(m: <inbox-[:message]->>) {
  write c-[:deals]-> {
    Name: "x"
    Amount: 17 % 5
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });
});
