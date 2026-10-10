// The `ask` STATEMENT (and its `(link:)` delivery block + `fallback` rungs) was
// replaced by the ask adapter (asks-as-adapter, chunk G). An author now
// constructs `ask()` like any adapter, writes the question along a family edge,
// and `await`s the record's `Response`. This file pins the parser GATE: the old
// construction shape is rejected with a pointer to the new form, and the `ask`
// keyword is FREED — it is an ordinary instance / binding name now.

import { MovementParseError, parseProgram } from '../parse';
import { MovementDeclaration, RValue, Statement } from '../ast';

function as<K extends Statement['kind']>(
  s: Statement | undefined,
  kind: K,
): Extract<Statement, { kind: K }> {
  if (!s || s.kind !== kind) throw new Error(`expected statement '${kind}', got '${s?.kind}'`);
  return s as Extract<Statement, { kind: K }>;
}

function rv<K extends RValue['kind']>(v: RValue, kind: K): Extract<RValue, { kind: K }> {
  if (v.kind !== kind) throw new Error(`expected rvalue '${kind}', got '${v.kind}'`);
  return v as Extract<RValue, { kind: K }>;
}

/** The body statements of the program's first movement. */
function bodyOf(source: string): MovementDeclaration['body'] {
  return as(parseProgram(source).statements[0], 'movement').body;
}

function expectParseError(source: string, pattern: RegExp): void {
  expect(() => parseProgram(source)).toThrow(MovementParseError);
  try {
    parseProgram(source);
  } catch (e) {
    expect((e as MovementParseError).message).toMatch(pattern);
  }
}

const M = (body: string) => `movement m(d: <s-[:m]->>) {\n${body}\n}`;

describe('the retired `ask` statement is gated with a pointer to the new form', () => {
  it('a bound `ask <Kind><…>` is rejected — pointing at write + await', () => {
    expectParseError(
      M('  ok = ask Check<boolean> { title: "Pursue?" }'),
      /ask.*replaced by the ask adapter.*await.*Response/s,
    );
  });

  it('a bare `ask <Kind><…>` statement is rejected the same way', () => {
    expectParseError(
      M('  ask Provide<number> { title: "Amount?" }'),
      /ask.*replaced by the ask adapter.*await.*Response/s,
    );
  });

  it('a `(link:)` delivery block does not survive — the whole ask form is rejected', () => {
    expectParseError(
      M('  ok = ask Check<boolean> { title: "?" } (link: <text>) { write s-[:m]-> { x: "${link}" } }'),
      /ask.*replaced by the ask adapter/,
    );
  });

  it('a stray `fallback after …` rung is rejected — pointing at race + sleep', () => {
    expectParseError(
      M('  fallback after 4h { write s-[:m]-> { x: "y" } }'),
      /fallback.*ask.*replaced by the ask adapter.*race/s,
    );
  });
});

describe('the `ask` keyword is freed — it is an ordinary name now', () => {
  it('`ask` binds as an instance and is written along a family edge', () => {
    const body = bodyOf(M('  ask = questions()\n  q = write ask-[:Check]-> { Prompt: "Ship it?" }'));
    expect(as(body[0], 'assign').name).toBe('ask');
    // The write head names the freed `ask` instance.
    const write = rv(as(body[1], 'assign').value, 'write').write;
    expect(write.target.kind).toBe('linked');
  });

  it('`await ask-[:Response]->` reads the freed name as a traversal head', () => {
    const body = bodyOf(M('  answer = await ask-[:Response]->'));
    const await_ = rv(as(body[0], 'assign').value, 'await').await;
    expect(await_.source.kind).toBe('traversal');
  });

  it('`ask` is a plain readable binding (`= ask`) and a call target (`ask()`)', () => {
    const body = bodyOf(M('  ask = builder()\n  x = ask\n  ask()'));
    expect(as(body[0], 'assign').name).toBe('ask');
    expect(rv(as(body[1], 'assign').value, 'expr').expr.raw.trim()).toBe('ask');
    expect(as(body[2], 'call').callee).toBe('ask');
  });
});
