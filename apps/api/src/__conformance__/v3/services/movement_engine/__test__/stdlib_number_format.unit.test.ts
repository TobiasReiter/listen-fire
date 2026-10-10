// NUMBER.FORMAT and CURRENCY.FORMAT_FIGURE end to end through the engine —
// the same generic namespaced-stdlib dispatch URL.HOST uses (movement_engine/
// expression.ts's 'function' case -> stdlibFunctionById -> applyStdlib), so
// no per-function runtime code was needed; this pins that the registration in
// stdlib.ts alone is enough, and that ${NUMBER.FORMAT(x, "compact")} renders
// inside a string interpolation.

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

describe('NUMBER.FORMAT evaluation', () => {
  it('"compact" abbreviates with K/M/B/T', async () => {
    await expect(evaluate('NUMBER.FORMAT(n, "compact")', { n: 1_200_000 })).resolves.toBe('1.2M');
    await expect(evaluate('NUMBER.FORMAT(n, "compact")', { n: 350_000 })).resolves.toBe('350K');
    await expect(evaluate('NUMBER.FORMAT(n, "compact")', { n: 2_100_000_000 })).resolves.toBe('2.1B');
    await expect(evaluate('NUMBER.FORMAT(n, "compact")', { n: 999 })).resolves.toBe('999');
  });

  it('"grouped" adds thousands separators', async () => {
    await expect(evaluate('NUMBER.FORMAT(n, "grouped")', { n: 1_200_000 })).resolves.toBe(
      '1,200,000',
    );
    await expect(evaluate('NUMBER.FORMAT(n, "grouped")', { n: 1234.5 })).resolves.toBe('1,234.5');
  });

  it('null in is absent (null) out', async () => {
    await expect(evaluate('NUMBER.FORMAT(n, "compact")', { n: null })).resolves.toBeNull();
  });

  it('renders inside a string interpolation', async () => {
    await expect(
      evaluate('"total: ${NUMBER.FORMAT(n, "compact")}"', { n: 1_200_000 }),
    ).resolves.toBe('total: 1.2M');
  });
});

describe('CURRENCY.FORMAT_FIGURE evaluation', () => {
  it('is the inverse of GET_NUMBER_FROM_FIGURE', async () => {
    await expect(
      evaluate('CURRENCY.FORMAT_FIGURE(n, "EUR")', { n: 1_200_000 }),
    ).resolves.toBe('€1.2M');
    await expect(
      evaluate('CURRENCY.FORMAT_FIGURE(n, code)', { n: 350_000, code: 'USD' }),
    ).resolves.toBe('$350K');
  });

  it('a symbol-less known code prints after the amount', async () => {
    await expect(
      evaluate('CURRENCY.FORMAT_FIGURE(n, "CHF")', { n: 1_200_000 }),
    ).resolves.toBe('1.2M CHF');
  });

  it('null in is absent (null) out', async () => {
    await expect(evaluate('CURRENCY.FORMAT_FIGURE(n, "EUR")', { n: null })).resolves.toBeNull();
  });
});

describe('NUMBER.FORMAT and CURRENCY.FORMAT_FIGURE are not flagged by the interpretability gate', () => {
  it('a movement using both passes clean', () => {
    const source = `
import { email, crm } from adapters
import { acme_workspace } from credentials

inbox = email()
c = crm(credentials: acme_workspace)

movement enrich(m: <inbox-[:message]->>) {
  write c-[:deals]-> {
    Name: "x"
    Description: "\${NUMBER.FORMAT(m.\`Amount\`, "compact")} / \${CURRENCY.FORMAT_FIGURE(m.\`Amount\`, "EUR")}"
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });
});
