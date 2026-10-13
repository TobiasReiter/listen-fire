// Author-declared refinements (`type Thesis = <"A" | "B">`) — the WRITTEN twin
// of an option set borrowed from a live field. The point of the feature is that
// nothing downstream can tell the two apart: a declared type resolves to the
// same closed enum a borrow does, so it constrains an extraction, hints its
// prompt, and checks a literal with the SAME did-you-mean, through the same
// code. These tests pin that sameness rather than a second mechanism.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const crmSchema: InstanceSchema = {
  positions: {
    message: { properties: { Body: 'text' }, edges: {} },
    company: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { message: { target: 'message' }, company: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: { Name: 'text', Thesis: 'text' },
      resultShape: { externalId: 'text', Name: 'text', Thesis: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: { probe: { adapter: 'crm' } },
});

const PRELUDE = [
  'import { crm } from adapters',
  'import { probe } from credentials',
  'graph = crm(credentials: probe)',
  'type Thesis = <"Consumer" | "Infra" | "Health">',
].join('\n');

const diagnostics = (body: string): Diagnostic[] =>
  checkProgram(
    parseProgram(`${PRELUDE}\nmovement main(msg: <graph-[:message]->>) {\n${body}\n}`),
    catalog,
  ).filter((d) => (d.severity ?? 'error') === 'error');

const codes = (body: string): string[] => diagnostics(body).map((d) => d.code);

/** An extract whose `thesis` field is annotated with the declared refinement,
 *  followed by whatever the test does with the extracted value. */
const withExtract = (uses: string[]): string =>
  [
    '  found = extract from [msg.`Body`] {',
    '    node company: "each company mentioned" {',
    '      name: "the company\'s name"',
    '      thesis: <Thesis> "which thesis this company fits"',
    '    }',
    '  }',
    '  found-[c:company]-> {',
    ...uses,
    '  }',
  ].join('\n');

describe('a declared type constrains an extract field', () => {
  it('a valid value compares clean', () => {
    expect(codes(withExtract(['    ok = c.`thesis` == "Infra"']))).toEqual([]);
  });

  it('a typo gets MOV_ENUM_UNKNOWN_VALUE with a did-you-mean — the borrowed path, unchanged', () => {
    const diag = diagnostics(withExtract(['    ok = c.`thesis` == "Infrra"'])).find(
      (d) => d.code === C.ENUM_UNKNOWN_VALUE,
    );
    expect(diag).toBeDefined();
    expect(diag!.message).toContain('Consumer | Infra | Health');
    expect(diag!.message).toContain('Did you mean "Infra"?');
  });

  it('the value is TEXT at run time — it interpolates and concatenates', () => {
    expect(
      codes(withExtract(['    line = "fits ${c.`thesis`}"', '    also = CONCAT(c.`name`, c.`thesis`)'])),
    ).toEqual([]);
  });

  it('the value writes into a text field', () => {
    expect(
      codes(
        withExtract([
          '    write graph-[:company]-> { Name ?: c.`name`, Thesis ?: c.`thesis` }',
        ]),
      ),
    ).toEqual([]);
  });
});

describe('an annotation that names no type says so', () => {
  it('a typo of a declared type is MOV_UNKNOWN_TYPE_NAME with a did-you-mean', () => {
    const diag = diagnostics(
      [
        '  found = extract from [msg.`Body`] {',
        '    thesis: <Thessis> "which thesis"',
        '  }',
      ].join('\n'),
    ).find((d) => d.code === C.UNKNOWN_TYPE_NAME);
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("did you mean 'Thesis'?");
  });

  it('a mistyped primitive is caught by the same check', () => {
    const diag = diagnostics(
      ['  found = extract from [msg.`Body`] {', '    n: <nubmer> "how many"', '  }'].join('\n'),
    ).find((d) => d.code === C.UNKNOWN_TYPE_NAME);
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("did you mean 'number'?");
  });

  it('a primitive annotation stays clean', () => {
    expect(
      codes(['  found = extract from [msg.`Body`] {', '    n: <number> "how many"', '  }'].join('\n')),
    ).toEqual([]);
  });
});

describe('a declared type is an ordinary name', () => {
  it('a second declaration of the same name is MOV_DUPLICATE_DECL', () => {
    const source = `${PRELUDE}\ntype Thesis = <"X">\nmovement main(msg: <graph-[:message]->>) {\n}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain(C.DUPLICATE_DECL);
  });

  it('a binding reusing the name shadows it — MOV_SHADOWED_NAME', () => {
    expect(codes('  Thesis = msg.`Body`')).toContain(C.SHADOWED_NAME);
  });
});

describe('a declared type annotates a declared node’s field', () => {
  // Structural conformance compares DECLARED types, and a node literal's field
  // is typed from its literal (text) — so an enum-typed declared field is not
  // satisfied by one. That is the behaviour a BORROWED option set already has
  // in this slot, and matching it exactly is the point of the feature.
  it('the declaration’s field carries the closed enum, and conformance sees it', () => {
    const source = [
      PRELUDE,
      'node Deal {',
      '  thesis: <Thesis>',
      '}',
      'movement main(msg: <graph-[:message]->>) {',
      '  d = node { thesis: "Infra" }',
      '  takes(deal: d)',
      '}',
      'movement takes(deal: <Deal>) {',
      '}',
    ].join('\n');
    const messages = checkProgram(parseProgram(source), catalog)
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.message);
    expect(messages.join('\n')).toContain('enum (Consumer | Infra | Health)');
  });
});
