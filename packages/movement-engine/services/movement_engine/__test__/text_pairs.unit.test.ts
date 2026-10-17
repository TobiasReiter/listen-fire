// TEXT.PAIRS rendered through the engine, including inside `${…}`
// interpolation — the Project A composer-row case from the handbook.

import { binding, Environment, evalMovementExpr } from '../expression';
import { CURRENT_LANGUAGE_VERSION, parseMovementExpression } from 'movement-lang';

async function evaluate(text: string, bindings: Record<string, unknown> = {}): Promise<unknown> {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) {
    env.declare(name, binding({ kind: 'value', value }));
  }
  return (await evalMovementExpr(parseMovementExpression(text), { env, languageVersion: CURRENT_LANGUAGE_VERSION })).value;
}

describe('TEXT.PAIRS evaluation', () => {
  it('a dict literal built from bound values', async () => {
    await expect(
      evaluate('TEXT.PAIRS({ name: name, url: url })', { name: 'Acme', url: 'acme.com' }),
    ).resolves.toBe('name=Acme | url=acme.com');
  });

  it('a custom separator', async () => {
    await expect(evaluate('TEXT.PAIRS({ a: 1, b: 2 }, ", ")')).resolves.toBe('a=1, b=2');
  });

  it('renders inside string interpolation', async () => {
    await expect(
      evaluate('"row: ${TEXT.PAIRS({ name: name, url: url })}"', { name: 'Acme', url: 'acme.com' }),
    ).resolves.toBe('row: name=Acme | url=acme.com');
  });
});
