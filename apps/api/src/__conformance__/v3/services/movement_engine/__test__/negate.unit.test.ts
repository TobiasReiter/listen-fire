// Unary minus end to end: parses (formula grammar), evaluates (the engine's
// `evalMovementExpr`), and is not flagged by the interpretability gate that
// blocks a save (`listUnsupportedConstructs`) — the three surfaces that must
// all agree a construct is live before an author can use it.

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

describe('unary minus evaluation', () => {
  it('negates a bound value', async () => {
    await expect(evaluate('-back_days', { back_days: 7 })).resolves.toBe(-7);
  });

  it('negates a parenthesised sub-expression', async () => {
    await expect(evaluate('-(a + b)', { a: 2, b: 3 })).resolves.toBe(-5);
  });

  it('a chain of signs', async () => {
    await expect(evaluate('- -x', { x: 4 })).resolves.toBe(4);
  });

  it('composes with multiplication at the expected precedence (-a * b == (-a) * b)', async () => {
    await expect(evaluate('-a * b', { a: 2, b: 3 })).resolves.toBe(-6);
  });

  it('a - b, a -b, a-b all stay binary subtraction', async () => {
    await expect(evaluate('a - b', { a: 5, b: 2 })).resolves.toBe(3);
    await expect(evaluate('a -b', { a: 5, b: 2 })).resolves.toBe(3);
    await expect(evaluate('a-b', { a: 5, b: 2 })).resolves.toBe(3);
  });
});

describe('unary minus is not flagged by the interpretability gate', () => {
  it('a movement using -back_days in a DATE.ADD_DAYS argument passes clean', () => {
    const source = `
import { email, crm } from adapters
import { acme_workspace } from credentials

inbox = email()
c = crm(credentials: acme_workspace)

movement remind(m: <inbox-[:message]->>) {
  back_days = 3
  write c-[:deals]-> {
    Name: "x"
    Amount: -back_days
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });
});
