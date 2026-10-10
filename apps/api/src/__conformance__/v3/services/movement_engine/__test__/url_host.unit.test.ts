// URL.HOST end to end through the engine — the same generic namespaced-
// stdlib dispatch TEXT.SLUG uses (movement_engine/expression.ts's 'function'
// case → stdlibFunctionById → applyStdlib), so no per-function runtime code
// was needed; this pins that the registration in stdlib.ts alone is enough.

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

describe('URL.HOST evaluation', () => {
  it('lowercases the host, keeps www., drops port and path', async () => {
    await expect(
      evaluate('URL.HOST(link)', { link: 'https://WWW.Acme.com:8080/deals/1' }),
    ).resolves.toBe('www.acme.com');
  });

  it('is absent (null) for text that is not a URL with a host', async () => {
    await expect(evaluate('URL.HOST(link)', { link: 'not a url' })).resolves.toBeNull();
    await expect(evaluate('URL.HOST(link)', { link: 'mailto:a@b.com' })).resolves.toBeNull();
  });

  it('null in is absent out', async () => {
    await expect(evaluate('URL.HOST(link)', { link: null })).resolves.toBeNull();
  });
});

describe('URL.HOST is not flagged by the interpretability gate', () => {
  it('a movement using URL.HOST passes clean', () => {
    const source = `
import { email, crm } from adapters
import { acme_workspace } from credentials

inbox = email()
c = crm(credentials: acme_workspace)

movement enrich(m: <inbox-[:message]->>) {
  write c-[:deals]-> {
    Name: "x"
    Domain: URL.HOST(m.\`link\`)
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });
});
