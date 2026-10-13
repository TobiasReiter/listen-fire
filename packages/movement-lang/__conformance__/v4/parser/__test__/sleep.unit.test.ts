// The `sleep <duration>` STATEMENT was retired — `await sleep(<duration>)` is
// the one way to wait on the clock now, matching every other wake source
// (`await <edge>`, `await until(…)`). This file pins the parser GATE: the old
// bare statement is rejected with a pointer to the new form, and `sleep` is
// otherwise an ordinary name (like `ask` after chunk G) — the expression form
// still recognises it specially only inside `await sleep(…)`.

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

describe('the retired `sleep` statement is gated with a pointer to `await sleep(…)`', () => {
  it('a bare `sleep <duration>` statement is rejected', () => {
    expectParseError(M('  sleep 30s'), /sleep.*replaced.*await it as an expression.*await sleep\(4h\)/s);
  });

  it('a multi-unit duration is rejected the same way', () => {
    expectParseError(M('  sleep 1h30m'), /sleep.*replaced/s);
  });

  it('the did-you-mean names the race-arm idiom', () => {
    expectParseError(M('  sleep 5m'), /race arm.*await race\(\[q, \(\) => \{ await sleep\(4h\) \}\]\)/s);
  });
});

describe('`sleep` is otherwise an ordinary name now', () => {
  it('`sleep` binds as an instance', () => {
    const body = bodyOf(M('  sleep = builder()'));
    expect(as(body[0], 'assign').name).toBe('sleep');
  });

  it('`sleep` is a plain readable binding and a call target', () => {
    const body = bodyOf(M('  sleep = builder()\n  x = sleep\n  sleep()'));
    expect(as(body[0], 'assign').name).toBe('sleep');
    expect(as(body[2], 'call').callee).toBe('sleep');
  });

  it('`await sleep(<duration>)` still parses as the clock wake source', () => {
    const body = bodyOf(M('  await sleep(4h)'));
    const await_ = as(body[0], 'await').await;
    expect(await_.source.kind).toBe('sleep');
  });

  it('a handle named `sleep` reads as a traversal head, not the clock source, when no `(` follows', () => {
    const body = bodyOf(M('  sleep = builder()\n  answer = await sleep-[:Response]->'));
    const await_ = rv(as(body[1], 'assign').value, 'await').await;
    expect(await_.source.kind).toBe('traversal');
  });
});
