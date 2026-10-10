// A node declaration written ONCE and reused: it describes itself, its fields
// and its nested nodes; an extraction takes it as its shape (`node entry:
// <Entry>`); and a write body spreads an extracted record's fields (`...e`,
// `?...e`). These tests pin the surface — what each spelling parses to.

import { MovementParseError, parseProgram } from '../parse';
import {
  ExtractExpression,
  ShapeDeclaration,
  Statement,
  WriteExpression,
  expandWriteSpreads,
} from '../ast';

function statements(source: string): Statement[] {
  return parseProgram(source).statements;
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

function declaration(source: string): ShapeDeclaration {
  const found = statements(source).find((s) => s.kind === 'shape');
  if (found?.kind !== 'shape') throw new Error('expected a node declaration');
  return found;
}

/** The first statement of `main`'s body. */
function bodyStatement(body: string): Statement {
  const movement = statements(`movement main() {\n${body}\n}`)[0];
  if (movement?.kind !== 'movement') throw new Error('expected a movement');
  return movement.body[0];
}

function extractOf(body: string): ExtractExpression {
  const statement = bodyStatement(body);
  if (statement.kind !== 'assign' || statement.value.kind !== 'extract') {
    throw new Error('expected a bound extract');
  }
  return statement.value.extract;
}

function writeOf(body: string): WriteExpression {
  const statement = bodyStatement(body);
  if (statement.kind !== 'write') throw new Error('expected a write');
  return statement.write;
}

const DESCRIBED = [
  'export node Entry: "each distinct dealflow item in this transcript" {',
  '  name: <text> "the company\'s name"',
  '  thesis: <Thesis> "the thesis this entry routes to. ${`Routing Rules`}"',
  '  stage: <text>',
  '  node founder: "each founder named" { first: <text> "given names" } order by arrival',
  '}',
].join('\n');

describe('a described node declaration', () => {
  it('carries the words for itself, each field, and each nested node', () => {
    const decl = declaration(DESCRIBED);
    expect(decl.exported).toBe(true);
    expect(decl.root.description?.raw).toBe('"each distinct dealflow item in this transcript"');
    expect(decl.root.fields.map((f) => [f.name, f.type, f.description?.raw])).toEqual([
      ['name', 'text', '"the company\'s name"'],
      ['thesis', 'Thesis', '"the thesis this entry routes to. ${`Routing Rules`}"'],
      ['stage', 'text', undefined],
    ]);
    const founder = decl.root.children[0];
    expect(founder.name).toBe('founder');
    expect(founder.description?.raw).toBe('"each founder named"');
    expect(founder.sequenced).toBe('arrival');
    expect(founder.fields[0].description?.raw).toBe('"given names"');
  });

  it('is unchanged without descriptions', () => {
    const decl = declaration('node Doc {\n  title: <text>\n  node file { name: <text> }\n}');
    expect(decl.root.description).toBeUndefined();
    expect(decl.root.fields[0].description).toBeUndefined();
    expect(decl.root.children[0].description).toBeUndefined();
  });

  it('takes several fields on one line, separated by `;` (the handbook spelling)', () => {
    const decl = declaration('node Company { name: <text>; website: <text> }');
    expect(decl.root.fields.map((f) => f.name)).toEqual(['name', 'website']);
  });

  it('keeps the type explicit — a description alone is not a field type', () => {
    expect(parseError('node Doc {\n  title: "the title"\n}')).toMatch(/type in angle brackets/);
  });
});

describe('an extraction node that takes a declaration as its shape', () => {
  it('names the declaration, with no description of its own', () => {
    const extract = extractOf('  found = extract "careful" from [x] {\n    node entry: <Entry>\n  }');
    const node = extract.stages[0].children[0];
    expect(node.declared).toEqual({ type: 'Entry', span: expect.anything() });
    expect(node.description).toBeUndefined();
    expect(node.stages).toEqual([]);
  });

  it('takes a use-site description, and chained `through` stages', () => {
    const extract = extractOf(
      [
        '  found = extract from [x] {',
        '    node entry: <Entry> "each deal pitched"',
        '      through [web_search(query: name)] { stage: "the round, from the search" }',
        '  }',
      ].join('\n'),
    );
    const node = extract.stages[0].children[0];
    if (node.declared === undefined) throw new Error('expected a declared node');
    expect(node.declared.type).toBe('Entry');
    expect(node.description?.raw).toBe('"each deal pitched"');
    expect(node.stages).toHaveLength(1);
    expect(node.stages[0].through?.[0].plugin).toBe('web_search');
    expect(node.stages[0].fields[0].name).toBe('stage');
  });

  it('sits beside inline fields and nodes', () => {
    const extract = extractOf(
      [
        '  found = extract from [x] {',
        '    summary: "one line"',
        '    node entry: <Entry>',
        '    node other: "each other thing" { name: "its name" }',
        '  }',
      ].join('\n'),
    );
    expect(extract.stages[0].fields.map((f) => f.name)).toEqual(['summary']);
    expect(extract.stages[0].children.map((c) => [c.name, c.declared?.type])).toEqual([
      ['entry', 'Entry'],
      ['other', undefined],
    ]);
  });

  it('refuses a brace after the declaration, naming both fixes', () => {
    const message = parseError(
      '  movement main() {\n  found = extract from [x] {\n    node entry: <Entry> { name: "n" }\n  }\n}',
    );
    expect(message).toContain("'entry' takes its fields from <Entry>");
    expect(message).toContain('through');
  });
});

describe('a spread in a write body', () => {
  it('parses `...e` and `?...e` beside `unique by` and explicit lines', () => {
    const write = writeOf(
      [
        '  write deduped-[:entries]-> {',
        '    unique by (FUZZY name)',
        '    name: e.name',
        '    ?...e',
        '    ...f',
        '  }',
      ].join('\n'),
    );
    expect(write.uniqueBy).toHaveLength(1);
    expect(write.fields.map((f) => f.name)).toEqual(['name']);
    expect(write.spreads?.map((s) => [s.source, s.semantics])).toEqual([
      ['e', 'fill'],
      ['f', undefined],
    ]);
  });

  it('leaves a write without a spread as it was', () => {
    expect(writeOf('  write crm-[:companies]-> { name: "x" }').spreads).toBeUndefined();
  });

  it('refuses a spread with nothing to spread', () => {
    expect(parseError('movement main() {\n  write crm-[:companies]-> { ... }\n}')).toContain(
      "name the record right after it: '...e'",
    );
  });

  it('refuses a spread in a match — a match never writes', () => {
    expect(parseError('movement main() {\n  m = match crm-[:companies]-> { ...e }\n}')).toContain(
      'a match never writes',
    );
  });
});

describe('expandWriteSpreads', () => {
  const write = writeOf(
    ['  write t-[:entries]-> {', '    name: e.name', '    ?...e', '    ...f', '  }'].join('\n'),
  );
  const fields: Record<string, string[]> = {
    e: ['name', 'stage', 'Deal Size'],
    f: ['stage', 'owner'],
  };

  it('writes each field once: an explicit line wins, then the LATER spread', () => {
    const expanded = expandWriteSpreads(write, (s) => fields[s.source]);
    expect(expanded.map((f) => [f.name, f.value.raw, f.semantics, f.spread])).toEqual([
      ['name', 'e.name', undefined, undefined],
      ['Deal Size', 'e.`Deal Size`', 'fill', 'e'],
      ['stage', 'f.stage', undefined, 'f'],
      ['owner', 'f.owner', undefined, 'f'],
    ]);
  });

  it('a spread whose fields are unknown contributes nothing', () => {
    expect(expandWriteSpreads(write, () => undefined).map((f) => f.name)).toEqual(['name']);
  });
});
