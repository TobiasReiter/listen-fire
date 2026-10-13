// `type Thesis = <"A" | "B">` — an author-declared REFINEMENT, the written twin
// of an option set borrowed from a live field. The keyword is CONTEXTUAL, like
// `node`: only `type <name> =` declares, so a binding called `type` (which the
// `_resources WHERE type == "FILE"` idiom already leans on) keeps working.

import { MovementParseError, parseProgram } from '../parse';
import { Statement, TypeDeclaration } from '../ast';

function statements(source: string): Statement[] {
  return parseProgram(source).statements;
}

function declaration(source: string): TypeDeclaration {
  const first = statements(source)[0];
  if (first?.kind !== 'type') throw new Error(`expected a type declaration, got '${first?.kind}'`);
  return first;
}

function parseError(source: string): string {
  try {
    parseProgram(source);
  } catch (e) {
    if (e instanceof MovementParseError) return e.message;
    throw e;
  }
  throw new Error('expected a parse error');
}

describe('type declarations', () => {
  it('declares a closed set of text values, in the order written', () => {
    const decl = declaration('type Thesis = <"Consumer" | "Infra" | "Health">');
    expect(decl.name).toBe('Thesis');
    expect(decl.options).toEqual(['Consumer', 'Infra', 'Health']);
  });

  it('takes a single value', () => {
    expect(declaration('type Only = <"A">').options).toEqual(['A']);
  });

  it('reads across lines', () => {
    expect(declaration('type Thesis = <\n  "A"\n  | "B"\n>').options).toEqual(['A', 'B']);
  });

  it('takes a backticked name', () => {
    expect(declaration('type `Investment Thesis` = <"A">').name).toBe('Investment Thesis');
  });

  it('leaves a bare `type` an ordinary name — the keyword is contextual', () => {
    const first = statements('movement m(d: <s-[:m]->>) {\n  type = d.`kind`\n}');
    expect(first[0]?.kind).toBe('movement');
    const body = first[0]?.kind === 'movement' ? first[0].body : [];
    expect(body[0]).toMatchObject({ kind: 'assign', name: 'type' });
  });

  it('refuses a non-text value, naming the refinement-of-text rule', () => {
    const message = parseError('type Amount = <number>');
    expect(message).toContain('refinement of text');
    expect(message).toContain('<number>');
  });

  it('refuses an unclosed value list', () => {
    expect(parseError('type Thesis = <"A" | "B"')).toContain("to close 'Thesis's values");
  });
});
