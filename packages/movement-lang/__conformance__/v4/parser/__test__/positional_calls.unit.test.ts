// Parser coverage for POSITIONAL calls and VALUE parameter types.
//
// `f(a, b)` binds by declared order, as TypeScript does. A positional
// invocation is a call whatever it names: `x = email_to_doc(msg)` and
// `x = UPPER(msg)` are both calls, and resolution reads the second as the
// expression it carries once `UPPER` resolves to the standard library
// (`checker/calls.ts`). A parameter may spell a value type in full: `<text[]>`,
// `<{ mode: text, owner?: text }>`.

import { parseProgram, MovementParseError } from '../parse';
import type { CallStatement, MovementDeclaration, Statement } from '../ast';

function body(source: string): Statement[] {
  const program = parseProgram(`movement m(e: <inbox-[:message]->>) {\n${source}\n}`);
  const movement = program.statements.find((s) => s.kind === 'movement');
  if (movement?.kind !== 'movement') throw new Error('expected a movement');
  return movement.body;
}

function boundCall(source: string): CallStatement {
  const [statement] = body(source);
  if (statement?.kind !== 'assign' || statement.value.kind !== 'call') {
    throw new Error(`expected a bound call, got ${statement?.kind}`);
  }
  return statement.value.call;
}

function movement(source: string): MovementDeclaration {
  const found = parseProgram(source).statements.find((s) => s.kind === 'movement');
  if (found?.kind !== 'movement') throw new Error('expected a movement');
  return found;
}

describe('positional calls', () => {
  it('a bound positional invocation of a non-built-in is a call', () => {
    const call = boundCall('doc = email_to_doc(e)');
    expect(call.callee).toBe('email_to_doc');
    expect(call.args.map((a) => [a.kind, a.name])).toEqual([['expr', undefined]]);
  });

  it('a built-in function call is a call too, carrying its reading as one expression', () => {
    for (const source of ['x = UPPER(e.`Subject`)', 'x = upper(e.`Subject`)', 'x = COALESCE(e.`A`, "b")', 'x = AT(xs, 0)']) {
      const call = boundCall(source);
      expect(call.expression?.raw).toBe(source.slice('x = '.length));
    }
  });

  it('a word of the expression grammar is never a callee', () => {
    for (const source of ['x = NOT(e.`Done`)', 'x = EXISTS(e-[:files]->)']) {
      const [statement] = body(source);
      if (statement?.kind !== 'assign') throw new Error('expected an assignment');
      expect(statement.value.kind).toBe('expr');
    }
  });

  it('a function or a type is an argument a call can carry', () => {
    const map = boundCall('x = MAP(xs, (n) => { return n })');
    expect(map.args.map((a) => a.kind)).toEqual(['expr', 'closure']);
    const members = boundCall('x = MEMBERS(<Thesis>)');
    expect(members.args).toMatchObject([{ kind: 'type', type: 'Thesis' }]);
  });

  it('an invocation followed by more expression is left to the expression slot', () => {
    const [statement] = body('x = f(e) + 1');
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('expr');
  });

  it('a positional call passed as an argument is a call argument', () => {
    const [statement] = body('log_doc(email_to_doc(e), UPPER(e.`Subject`))');
    if (statement?.kind !== 'call') throw new Error('expected a call');
    expect(statement.args.map((a) => a.kind)).toEqual(['call', 'call']);
  });

  it('a record literal argument is an expression', () => {
    const [statement] = body('configure(e, { mode: "fast" })');
    if (statement?.kind !== 'call') throw new Error('expected a call');
    expect(statement.args.map((a) => a.kind)).toEqual(['expr', 'expr']);
  });

  it('the named-callback form takes positional fixed arguments', () => {
    const [statement] = body('cb = callback(remind(e))');
    if (statement?.kind !== 'assign' || statement.value.kind !== 'callback') throw new Error('expected a callback');
    const subject = statement.value.callback.subject;
    if (subject.kind !== 'named') throw new Error('expected the named form');
    expect(subject.args.map((a) => a.name)).toEqual([undefined]);
  });

  it('a zero-argument invocation is still a construction', () => {
    const [statement] = body('go = manual()');
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('construct');
  });

  it('mixing positional and named in a bound call is refused', () => {
    expect(() => body('doc = to_doc(e, x: 1)')).toThrow(MovementParseError);
  });
});

describe('value parameter types', () => {
  it('a list type', () => {
    const [param] = movement('movement m(tags: <text[]>) {\n}').params;
    expect(param.type).toMatchObject({ kind: 'list', of: { kind: 'name', name: 'text' } });
  });

  it('a record type, with an optional key and a nested list', () => {
    const [param] = movement('movement m(cfg: <{ mode: text, owner?: text, tags: text[] }>) {\n}').params;
    expect(param.type).toMatchObject({
      kind: 'record',
      keys: [
        { name: 'mode', type: { kind: 'name', name: 'text' } },
        { name: 'owner', optional: true, type: { kind: 'name', name: 'text' } },
        { name: 'tags', type: { kind: 'list', of: { kind: 'name', name: 'text' } } },
      ],
    });
  });

  it('a record type across lines', () => {
    const [param] = movement('movement m(cfg: <{\n  mode: text\n  owner?: text\n}>) {\n}').params;
    expect(param.type).toMatchObject({ kind: 'record', keys: [{ name: 'mode' }, { name: 'owner', optional: true }] });
  });

  it('a scalar and an address keep their TypeRef shape', () => {
    const [scalar, address] = movement('movement m(t: <text>, x: <inbox-[:message]->>) {\n}').params;
    expect(scalar.type).toMatchObject({ graph: 'text' });
    expect(address.type).toMatchObject({ graph: 'inbox', position: 'message' });
  });

  it('a bracketed member inside a record type is refused with the bare spelling', () => {
    expect(() => movement('movement m(cfg: <{ mode: <text> }>) {\n}')).toThrow(/bare type names/);
  });

  it('a key written twice is refused', () => {
    expect(() => movement('movement m(cfg: <{ mode: text, mode: text }>) {\n}')).toThrow(/written twice/);
  });
});

describe('both arrived with language version 3', () => {
  it('under version 2 a positional argument is the old naming error', () => {
    expect(() =>
      parseProgram('movement m(e: <inbox-[:message]->>) {\n  send(e)\n}', { languageVersion: 2 }),
    ).toThrow(/Arguments to 'send' are named/);
  });

  it('under version 2 a bound positional invocation is the expression it was', () => {
    const program = parseProgram('movement m(e: <inbox-[:message]->>) {\n  x = to_doc(e)\n}', {
      languageVersion: 2,
    });
    const found = program.statements.find((s) => s.kind === 'movement');
    if (found?.kind !== 'movement') throw new Error('expected a movement');
    const [statement] = found.body;
    if (statement?.kind !== 'assign') throw new Error('expected an assignment');
    expect(statement.value.kind).toBe('expr');
  });

  it('under version 2 a list type is not a type marker', () => {
    expect(() => parseProgram('movement m(tags: <text[]>) {\n}', { languageVersion: 2 })).toThrow(
      MovementParseError,
    );
  });
});
