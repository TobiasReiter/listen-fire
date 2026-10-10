// A template interpolating a value that may be absent prints nothing for it.
//
// The checker accepts `${x}` where `x` is `T | absent` because the answer is
// fixed: a template is present text, and an absent part contributes "". This
// pins the runtime half of that promise, so the two cannot drift apart.

import { Environment, evalMovementExpr } from '../expression';
import { parseMovementExpression } from 'movement-lang';

async function render(raw: string, bindings: Record<string, unknown>): Promise<unknown> {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) env.declare(name, { kind: 'value', value });
  return (await evalMovementExpr(parseMovementExpression(raw), { env })).value;
}

describe('interpolating an absent value', () => {
  it('renders nothing in the middle of a template', async () => {
    await expect(render('"said: ${x}!"', { x: null })).resolves.toBe('said: !');
  });

  it('renders the empty string as the whole template', async () => {
    await expect(render('"${x}"', { x: null })).resolves.toBe('');
  });

  it('renders a present value unchanged', async () => {
    await expect(render('"said: ${x}!"', { x: 'hi' })).resolves.toBe('said: hi!');
  });

  it('renders a missing dict key as nothing', async () => {
    await expect(render('"[${AT(d, k)}]"', { d: { a: 'x' }, k: 'b' })).resolves.toBe('[]');
  });
});
