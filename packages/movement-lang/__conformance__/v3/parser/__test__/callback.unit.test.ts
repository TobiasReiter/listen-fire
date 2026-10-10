// The `callback(…)` grammar and the `function` alias (callback-primitive
// chunk 1). A callback mints a DEFERRED invocation: an inline anonymous
// movement (optionally with the fire-time parameters a platform supplies), or
// a movement BY NAME — the one position in the language where a movement is a
// value. Config is always the second argument, so nothing has to guess whether
// a brace object is arguments or settings.

import { MovementParseError, parseProgram } from '../parse';
import { CallbackExpression, MovementDeclaration, RValue, Statement, typeNameOf } from '../ast';

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

function bodyOf(source: string): MovementDeclaration['body'] {
  return as(parseProgram(source).statements[0], 'movement').body;
}

/** The callback bound by the first statement of a one-statement movement body. */
function callbackIn(line: string): CallbackExpression {
  const body = bodyOf(`movement m(d: <s-[:m]->>) {\n${line}\n}`);
  return rv(as(body[0], 'assign').value, 'callback').callback;
}

function expectParseError(source: string, pattern: RegExp): void {
  expect(() => parseProgram(source)).toThrow(MovementParseError);
  try {
    parseProgram(source);
  } catch (e) {
    expect((e as MovementParseError).message).toMatch(pattern);
  }
}

describe('callback — the inline (anonymous movement) subject', () => {
  it('a bare block is an inline subject with no parameters', () => {
    const cb = callbackIn('  cb = callback({ write d-[:reply]-> { text: "ok" } })');
    expect(cb.subject.kind).toBe('inline');
    if (cb.subject.kind !== 'inline') throw new Error('expected inline');
    expect(cb.subject.closure.params).toEqual([]);
    expect(cb.subject.closure.body).toHaveLength(1);
    expect(cb.config).toEqual([]);
  });

  it('the arrow form carries the movement parameter grammar verbatim', () => {
    const cb = callbackIn('  cb = callback((when: <date>, note: <text>) => { write d-[:reply]-> { text: note } })');
    if (cb.subject.kind !== 'inline') throw new Error('expected inline');
    expect(cb.subject.closure.params.map((p) => [p.name, typeNameOf(p.type)?.graph])).toEqual([
      ['when', 'date'],
      ['note', 'text'],
    ]);
    expect(cb.subject.closure.body).toHaveLength(1);
  });

  it('a multi-statement body parses as ordinary movement statements', () => {
    const cb = callbackIn(
      '  cb = callback({ a = write d-[:reply]-> { text: "1" }\n    write a-[:notes]-> { text: "2" } })',
    );
    if (cb.subject.kind !== 'inline') throw new Error('expected inline');
    expect(cb.subject.closure.body.map((s) => s.kind)).toEqual(['assign', 'write']);
  });
});

describe('callback — the body-less forms are an EMPTY body, not a variant', () => {
  it('`callback()` is an inline subject with no parameters and no statements', () => {
    const cb = callbackIn('  cb = callback()');
    if (cb.subject.kind !== 'inline') throw new Error('expected inline');
    expect(cb.subject.closure.params).toEqual([]);
    expect(cb.subject.closure.body).toEqual([]);
  });

  it('`callback((d: <date>))` keeps its signature with no body', () => {
    const cb = callbackIn('  cb = callback((picked: <date>))');
    if (cb.subject.kind !== 'inline') throw new Error('expected inline');
    expect(cb.subject.closure.params.map((p) => p.name)).toEqual(['picked']);
    expect(cb.subject.closure.body).toEqual([]);
  });

  it('a body-less callback WITH parameters still takes config', () => {
    const cb = callbackIn('  cb = callback((picked: <date>), { ttl: 2d })');
    if (cb.subject.kind !== 'inline') throw new Error('expected inline');
    expect(cb.subject.closure.body).toEqual([]);
    expect(cb.config.map((c) => [c.name, c.value.raw])).toEqual([['ttl', '2d']]);
  });

  it('with no subject at all there is nothing to put config after — write the empty body', () => {
    expectParseError(
      'movement m(d: <s-[:m]->>) {\n  cb = callback(, { ttl: 2d })\n}',
      /a callback body.*or the name of a movement/s,
    );
    const cb = callbackIn('  cb = callback({}, { ttl: 2d })');
    if (cb.subject.kind !== 'inline') throw new Error('expected inline');
    expect(cb.subject.closure.body).toEqual([]);
    expect(cb.config.map((c) => c.name)).toEqual(['ttl']);
  });
});

describe('callback — the named subject (the one place a movement is a value)', () => {
  it('a bare movement name defers it with no fixed arguments', () => {
    const cb = callbackIn('  cb = callback(send_reminder)');
    expect(cb.subject).toMatchObject({ kind: 'named', movement: 'send_reminder', args: [] });
  });

  it('a call-shaped subject supplies the FIXED arguments by name', () => {
    const cb = callbackIn('  cb = callback(send_reminder(who: "sam", topic: d.`subject`))');
    if (cb.subject.kind !== 'named') throw new Error('expected named');
    expect(cb.subject.args.map((a) => [a.name, a.kind === 'expr' ? a.expr.raw : 'write'])).toEqual([
      ['who', '"sam"'],
      ['topic', 'd.`subject`'],
    ]);
  });

  it('a backtick-quoted movement name is a name like any other', () => {
    const cb = callbackIn('  cb = callback(`send reminder`)');
    expect(cb.subject).toMatchObject({ kind: 'named', movement: 'send reminder' });
  });
});

describe('callback — config is always the SECOND argument', () => {
  it('reads `once` and `ttl` as raw named entries (the checker owns the vocabulary)', () => {
    const cb = callbackIn('  cb = callback({ write d-[:reply]-> { text: "x" } }, { once: FALSE, ttl: 2d })');
    expect(cb.config.map((c) => [c.name, c.value.raw])).toEqual([
      ['once', 'FALSE'],
      ['ttl', '2d'],
    ]);
  });

  it('a multi-line config parses', () => {
    const cb = callbackIn('  cb = callback(send_reminder, {\n    once: FALSE\n    ttl: 1h30m\n  })');
    expect(cb.config.map((c) => c.name)).toEqual(['once', 'ttl']);
  });

  it('an unknown key still PARSES (loudness is the checker\'s, with a did-you-mean)', () => {
    const cb = callbackIn('  cb = callback(send_reminder, { onces: TRUE })');
    expect(cb.config.map((c) => c.name)).toEqual(['onces']);
  });

  it('a missing close is a parse error naming the config', () => {
    expectParseError(
      'movement m(d: <s-[:m]->>) {\n  cb = callback(send_reminder, { once: FALSE\n}\n',
      /callback/,
    );
  });
});

describe('callback — the surface refuses what it cannot mean', () => {
  it('an unbound `callback(…)` statement points at the binding form', () => {
    expectParseError(
      'movement m(d: <s-[:m]->>) {\n  callback({ write d-[:reply]-> { text: "x" } })\n}',
      /must be bound to a name.*cb\.id/s,
    );
  });

  it('a parameter list with no arrow and no `)` is a parse error', () => {
    expectParseError(
      'movement m(d: <s-[:m]->>) {\n  cb = callback((when: <date>) { write d-[:reply]-> { text: "x" } })\n}',
      /=>/,
    );
  });

  it('an unbracketed parameter type gets the angle-bracket fix-it (the movement param grammar)', () => {
    expectParseError(
      'movement m(d: <s-[:m]->>) {\n  cb = callback((when: date) => { write d-[:reply]-> { text: "x" } })\n}',
      /angle brackets.*<date>/s,
    );
  });
});

describe('`function` is a pure parser alias for `movement`', () => {
  it('declares a top-level movement, indistinguishable in the AST', () => {
    const program = parseProgram('function intake(d: <s-[:m]->>) {\n  write d-[:reply]-> { text: "x" }\n}');
    const declaration = as(program.statements[0], 'movement');
    expect(declaration.name).toBe('intake');
    expect(declaration.params.map((p) => p.name)).toEqual(['d']);
    expect(declaration.body).toHaveLength(1);
  });

  it('parses to the SAME AST as the `movement` spelling', () => {
    const source = (keyword: string) =>
      `${keyword} intake(d: <s-[:m]->>) {\n  write d-[:reply]-> { text: "x" }\n}`;
    const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'span' ? undefined : x)));
    expect(strip(parseProgram(source('function')))).toEqual(strip(parseProgram(source('movement'))));
  });

  it('`export function` is `export movement`', () => {
    const program = parseProgram('export function helper(d: <s-[:m]->>) {\n  write d-[:reply]-> { text: "x" }\n}');
    expect(as(program.statements[0], 'movement')).toMatchObject({ name: 'helper', exported: true });
  });

  it('both spellings coexist in one file, and a listen fires either', () => {
    const program = parseProgram(
      [
        'function a(d: <s-[:m]->>) { write d-[:reply]-> { text: "1" } }',
        'movement b(d: <s-[:m]->>) { write d-[:reply]-> { text: "2" } }',
        'listen to s {} fire a',
      ].join('\n'),
    );
    expect(program.statements.map((s) => s.kind)).toEqual(['movement', 'movement', 'listen']);
  });

  it('a name after `function` is still required', () => {
    expectParseError('function (d: <s-[:m]->>) { }', /a name after 'function'/);
  });
});
