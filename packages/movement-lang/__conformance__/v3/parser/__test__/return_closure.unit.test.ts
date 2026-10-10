// The two new surface forms: `return <value>` and `(<params>) => { … }`.
//
// `return` takes the ordinary right-hand-side grammar, so everything bindable
// is returnable and the statement adds nothing of its own. A closure is claimed
// by its ARROW — a parenthesised head could equally start an expression, so the
// `=>` is what decides, not a guess at the first token.

import { MovementParseError, parseProgram } from '../parse';
import { MovementDeclaration, Statement, typeNameOf } from '../ast';

function bodyOf(source: string): Statement[] {
  const first = parseProgram(source).statements[0];
  if (first.kind !== 'movement') throw new Error(`expected a movement, got '${first.kind}'`);
  return (first as MovementDeclaration).body;
}

const M = (body: string) => `movement m(d: <s-[:m]->>) {\n${body}\n}`;

function parseError(source: string): string {
  try {
    parseProgram(source);
  } catch (e) {
    if (e instanceof MovementParseError) return e.message;
    throw e;
  }
  throw new Error('expected a parse error');
}

describe('return', () => {
  it('takes a plain expression', () => {
    const [statement] = bodyOf(M('  return d.`Subject`'));
    expect(statement.kind).toBe('return');
    if (statement.kind !== 'return') throw new Error('unreachable');
    expect(statement.value.kind).toBe('expr');
  });

  it('takes everything a binding takes — a node literal', () => {
    const [statement] = bodyOf(M('  return node { t: d.`Subject` }'));
    if (statement.kind !== 'return') throw new Error('unreachable');
    expect(statement.value.kind).toBe('node');
  });

  it('takes a write', () => {
    const [statement] = bodyOf(M('  return write d-[:notes]-> { body: "x" }'));
    if (statement.kind !== 'return') throw new Error('unreachable');
    expect(statement.value.kind).toBe('write');
  });

  it('a bare `return` is refused — a body that hands nothing back has none', () => {
    expect(parseError(M('  return'))).toContain('return <value>');
  });
});

describe('closures', () => {
  it('parses a parameterless closure', () => {
    const [statement] = bodyOf(M('  f = () => {\n    return 1\n  }'));
    if (statement.kind !== 'assign' || statement.value.kind !== 'closure') {
      throw new Error('expected a closure binding');
    }
    expect(statement.value.closure.params).toEqual([]);
    expect(statement.value.closure.body).toHaveLength(1);
  });

  it('parses typed parameters, the same grammar a movement declares', () => {
    const [statement] = bodyOf(M('  f = (n: <number>, t: <text>) => {\n    return n\n  }'));
    if (statement.kind !== 'assign' || statement.value.kind !== 'closure') {
      throw new Error('expected a closure binding');
    }
    expect(statement.value.closure.params.map((p) => [p.name, typeNameOf(p.type)?.graph])).toEqual([
      ['n', 'number'],
      ['t', 'text'],
    ]);
  });

  it('a parenthesised EXPRESSION is not a closure — the arrow decides', () => {
    const [statement] = bodyOf(M('  x = (1 + 2) * 3'));
    if (statement.kind !== 'assign') throw new Error('unreachable');
    expect(statement.value.kind).toBe('expr');
  });

  it('a closure returns nothing when its body says nothing', () => {
    const [statement] = bodyOf(M('  f = () => {\n    write d-[:notes]-> { body: "x" }\n  }'));
    if (statement.kind !== 'assign' || statement.value.kind !== 'closure') {
      throw new Error('expected a closure binding');
    }
    expect(statement.value.closure.body.map((s) => s.kind)).toEqual(['write']);
  });
});
