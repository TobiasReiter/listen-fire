// `node X extends Y { … }` — TypeScript's `interface X extends Y`. These tests
// pin the surface: what each spelling parses to, and which spellings are
// refused with the fix. What the base MEANS (its fields, its scope, a cycle, a
// redefinition) is the checker's — see checker/__test__/declaration_extends.

import { MovementParseError, parseProgram } from '../parse';
import { ShapeDeclaration } from '../ast';

function declarations(source: string): ShapeDeclaration[] {
  return parseProgram(source).statements.filter(
    (s): s is ShapeDeclaration => s.kind === 'shape',
  );
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

const ENTRY = 'node Entry { name: <text> }';

describe('node X extends Y', () => {
  it('names its base, and holds only its OWN members as parsed', () => {
    const [, recap] = declarations(
      [ENTRY, 'node `Recap Entry` extends Entry { diverse_founder: <text | null> }'].join('\n'),
    );
    expect(recap.name).toBe('Recap Entry');
    expect(recap.extends?.name).toBe('Entry');
    expect(recap.root.fields.map((f) => f.name)).toEqual(['diverse_founder']);
    expect(recap.root.fields[0].nullable).toBe(true);
  });

  it('takes its own words after the base, before the body', () => {
    const [, recap] = declarations(
      [ENTRY, 'node Recap extends Entry: "each entry, for the recap" { note: <text> }'].join('\n'),
    );
    expect(recap.extends?.name).toBe('Entry');
    expect(recap.root.description?.raw).toBe('"each entry, for the recap"');
  });

  it('takes a backticked base and nested nodes of its own', () => {
    const [, second] = declarations(
      [
        'node `Base Entry` { name: <text> }',
        'node Second extends `Base Entry` {',
        '  node note { body: <text> } order by arrival',
        '}',
      ].join('\n'),
    );
    expect(second.extends?.name).toBe('Base Entry');
    expect(second.root.children.map((c) => c.name)).toEqual(['note']);
    expect(second.root.children[0].sequenced).toBeDefined();
  });

  it('is exportable', () => {
    const [, recap] = declarations([ENTRY, 'export node Recap extends Entry { note: <text> }'].join('\n'));
    expect(recap.exported).toBe(true);
    expect(recap.extends?.name).toBe('Entry');
  });

  it('leaves a declaration without one exactly as it was', () => {
    const [entry] = declarations(ENTRY);
    expect(entry.extends).toBeUndefined();
    expect('extends' in entry).toBe(false);
  });

  it('keeps `extends` an ordinary name everywhere else', () => {
    const [node] = declarations('node extends { name: <text> }');
    expect(node.name).toBe('extends');
    expect(node.extends).toBeUndefined();
  });
});

describe('refused spellings', () => {
  it('words before the base — with the spelling that works', () => {
    const message = parseError(
      [ENTRY, 'node Recap: "each entry" extends Entry { note: <text> }'].join('\n'),
    );
    expect(message).toContain("'extends' comes straight after the name");
    expect(message).toContain('node Recap extends <base>: "each entry" { … }');
  });

  it('two bases', () => {
    expect(parseError([ENTRY, 'node Recap extends Entry, Other { note: <text> }'].join('\n'))).toContain(
      "'Recap' extends one node declaration",
    );
    expect(parseError([ENTRY, 'node Recap extends Entry extends Other { note: <text> }'].join('\n'))).toContain(
      "'Recap' extends one node declaration",
    );
  });

  it('no base named', () => {
    expect(parseError('node Recap extends { note: <text> }')).toContain(
      "the node declaration 'Recap' extends",
    );
  });

  it('on a nested node', () => {
    expect(
      parseError([ENTRY, 'node Outer { node inner extends Entry { note: <text> } }'].join('\n')),
    ).toContain("'extends' belongs to a node declared at the top level");
  });
});
