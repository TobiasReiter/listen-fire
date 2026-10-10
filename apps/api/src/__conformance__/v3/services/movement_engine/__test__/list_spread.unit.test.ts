// `...xs` inside a list literal, end to end: parses (formula grammar),
// evaluates (the engine's `evalMovementExpr`, and the shared pure-predicate
// evaluator), and is not flagged by the interpretability gate that blocks a
// save (`listUnsupportedConstructs`).

import { Environment, evalMovementExpr } from '../expression';
import { listUnsupportedConstructs } from '../interpretable';
import { parseMovementExpression } from 'movement-lang';
import { evaluatePredicate } from '#shared/expression/filter';

async function evaluate(text: string, bindings: Record<string, unknown> = {}): Promise<unknown> {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) {
    env.declare(name, { kind: 'value', value });
  }
  return (await evalMovementExpr(parseMovementExpression(text), { env })).value;
}

describe('a spread splices a list into a list literal', () => {
  it('in the middle', async () => {
    await expect(evaluate('[a, ...xs, b]', { a: 1, xs: [2, 3], b: 4 })).resolves.toEqual([1, 2, 3, 4]);
  });

  it('at the start and at the end', async () => {
    await expect(evaluate('[...xs, a]', { a: 'z', xs: ['x', 'y'] })).resolves.toEqual(['x', 'y', 'z']);
    await expect(evaluate('[a, ...xs]', { a: 'z', xs: ['x', 'y'] })).resolves.toEqual(['z', 'x', 'y']);
  });

  it('an empty list splices nothing', async () => {
    await expect(evaluate('[a, ...xs]', { a: 1, xs: [] })).resolves.toEqual([1]);
  });

  it('a list nested as a MEMBER stays one member — only a spread splices', async () => {
    await expect(evaluate('[xs, ...xs]', { xs: [1, 2] })).resolves.toEqual([[1, 2], 1, 2]);
  });

  it('a literal spread into a literal', async () => {
    await expect(evaluate('[...[1, 2], 3]')).resolves.toEqual([1, 2, 3]);
  });

  it('a spread of what is not a list fails the run rather than splicing nothing', async () => {
    await expect(evaluate('[1, ...x]', { x: 'text' })).rejects.toThrow("'...' splices a list's members");
    await expect(evaluate('[1, ...x]', { x: null })).rejects.toThrow('this value is null');
  });
});

describe('the pure-predicate evaluator splices the same way', () => {
  it('evaluates a spread of a literal', () => {
    expect(evaluatePredicate(parseMovementExpression('[1, ...[2, 3]]'), { read: () => undefined })).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('a spread is not flagged by the interpretability gate', () => {
  it('a movement writing a spread list passes clean', () => {
    const source = `
import { email, crm } from adapters
import { acme_workspace } from credentials

inbox = email()
c = crm(credentials: acme_workspace)

movement tag(m: <inbox-[:message]->>) {
  extra = ["a", "b"]
  write c-[:deals]-> {
    Name: "x"
    Tags: ["first", ...extra]
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });
});
