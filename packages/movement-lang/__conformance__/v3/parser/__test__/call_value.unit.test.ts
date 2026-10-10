// Parser coverage for a CALL as an argument — the utility idiom's spelling
// (layer 10 §A).
//
// `log_doc(d: email_to_doc(m: msg))` is recognised structurally rather than
// left in the expression slot, because a call's value is a NODE and no
// expression can hold one. The signal is the NAMED-argument form, which is the
// whole grammar of a call and no part of any expression: every stdlib function
// is positional. These pin that signal from both sides. From language version 3
// a positional invocation is a call as well, whatever it names; resolution says
// whether that is a built-in (`checker/calls.ts`).

import { parseProgram, MovementParseError } from '../parse';
import type { CallStatement, Statement } from '../ast';

function body(source: string): Statement[] {
  const program = parseProgram(`movement m(e: <inbox-[:message]->>) {\n${source}\n}`);
  const movement = program.statements.find((s) => s.kind === 'movement');
  if (movement?.kind !== 'movement') throw new Error('expected a movement');
  return movement.body;
}

function call(source: string): CallStatement {
  const [statement] = body(source);
  if (statement?.kind !== 'call') throw new Error(`expected a call, got ${statement?.kind}`);
  return statement;
}

describe('a call as an argument', () => {
  it('is its own argument kind, carrying the nested call', () => {
    const outer = call('log_doc(d: email_to_doc(m: e))');
    expect(outer.callee).toBe('log_doc');
    const [arg] = outer.args;
    expect(arg.kind).toBe('call');
    if (arg.kind !== 'call') throw new Error('unreachable');
    expect(arg.name).toBe('d');
    expect(arg.call.callee).toBe('email_to_doc');
    expect(arg.call.args.map((a) => a.name)).toEqual(['m']);
  });

  it('sits beside ordinary arguments, in either order', () => {
    expect(call('log(a: e, d: to_doc(m: e))').args.map((a) => a.kind)).toEqual(['expr', 'call']);
    expect(call('log(d: to_doc(m: e), a: e)').args.map((a) => a.kind)).toEqual(['call', 'expr']);
  });

  it('nests as deep as it is written', () => {
    const outer = call('a(x: b(y: c(z: e)))');
    const [first] = outer.args;
    if (first.kind !== 'call') throw new Error('expected a call argument');
    const [second] = first.call.args;
    if (second.kind !== 'call') throw new Error('expected a nested call argument');
    expect(second.call.callee).toBe('c');
  });

  it('takes the richer argument grammar too — a node literal inside a nested call', () => {
    const outer = call('log(d: to_doc(n: node { title: "x" }))');
    const [arg] = outer.args;
    if (arg.kind !== 'call') throw new Error('expected a call argument');
    expect(arg.call.args.map((a) => a.kind)).toEqual(['node']);
  });
});

describe('what is NOT a call argument', () => {
  it('a POSITIONAL invocation is a call too — resolution, not the parser, reads a built-in as its value', () => {
    // Language version 3: the parser no longer keeps a list of built-in names,
    // so `UPPER(…)` is recorded as the call it is, carrying its reading as one
    // expression (`checker/calls.ts` reads it so once `UPPER` resolves).
    const [upper] = call('log(d: UPPER(e.`Subject`))').args;
    if (upper?.kind !== 'call') throw new Error('expected a call argument');
    expect(upper.call.callee).toBe('UPPER');
    expect(upper.call.expression?.raw).toBe('UPPER(e.`Subject`)');
    expect(call('log(d: COALESCE(e.`A`, e.`B`))').args.map((a) => a.kind)).toEqual(['call']);
  });

  it('under version 2 a positional invocation is still an expression argument', () => {
    const program = parseProgram('movement m(e: <inbox-[:message]->>) {\n  log(d: UPPER(e.`Subject`))\n}', {
      languageVersion: 2,
    });
    const found = program.statements.find((s) => s.kind === 'movement');
    if (found?.kind !== 'movement') throw new Error('expected a movement');
    const [statement] = found.body;
    if (statement?.kind !== 'call') throw new Error('expected a call');
    expect(statement.args.map((a) => a.kind)).toEqual(['expr']);
  });

  it('a zero-argument invocation stays an expression', () => {
    expect(call('log(d: NOW())').args.map((a) => a.kind)).toEqual(['expr']);
  });

  it('a bare name is still a plain expression argument', () => {
    expect(call('log(d: e)').args.map((a) => a.kind)).toEqual(['expr']);
  });

  it("a nested call's own arguments are still named — the rule does not lapse inside", () => {
    let thrown: unknown;
    try {
      body('log(d: to_doc(m: e, e))');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MovementParseError);
    expect((thrown as Error).message).toMatch(/are named/);
  });
});

describe('a bound call and a construction are one form', () => {
  // `name(args)` is ONE form; only resolution says whether it constructs an
  // adapter or runs a movement. The parser records the shape and does not
  // guess — EXCEPT where an argument proves the answer.
  it('with plain-value arguments it records as the construction shape', () => {
    const [statement] = body('doc = email_to_doc(m: e)');
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('construct');
    if (statement.value.kind !== 'construct') throw new Error('unreachable');
    expect(statement.value.construct.callee).toBe('email_to_doc');
    expect(statement.value.construct.args.map((a) => a.name)).toEqual(['m']);
  });

  it('an argument a construction cannot hold settles it — a node literal', () => {
    const [statement] = body('doc = email_to_doc(m: node { title: e.`Subject` })');
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('call');
    if (statement.value.kind !== 'call') throw new Error('unreachable');
    expect(statement.value.call.callee).toBe('email_to_doc');
    expect(statement.value.call.args.map((a) => a.kind)).toEqual(['node']);
  });

  it('so does a nested CALL argument', () => {
    const [statement] = body('doc = wrap(m: inner(x: e))');
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('call');
  });

  it('an ordinary construction is untouched', () => {
    const [statement] = body('crm = attio(credentials: acme_main)');
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('construct');
  });

  it('a zero-argument construction is untouched', () => {
    const [statement] = body('go = manual()');
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('construct');
  });

  it('a positional call of a built-in is a call, read as its expression once resolved', () => {
    const [statement] = body('x = UPPER(e.`Subject`)');
    if (statement?.kind !== 'assign' || statement.value.kind !== 'call') throw new Error('expected a bound call');
    expect(statement.value.call.expression?.raw).toBe('UPPER(e.`Subject`)');
  });

  it('an unterminated invocation fails AS a call, naming the argument it was reading', () => {
    // It used to backtrack into the expression slot and fail there, where the
    // message could only ever be about an expression.
    let thrown: unknown;
    try {
      body('doc = email_to_doc(m: e');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MovementParseError);
    expect((thrown as Error).message).toMatch(/argument 'm' of 'email_to_doc'/);
  });
});
