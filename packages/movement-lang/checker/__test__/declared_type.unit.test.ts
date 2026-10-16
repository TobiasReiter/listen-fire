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
  'graph = connect crm using probe',
  'type Thesis = <"Consumer" | "Infra" | "Health">',
].join('\n');

/** `shapes` are the node declarations the body extracts with. */
const diagnostics = (body: string, shapes = ''): Diagnostic[] =>
  checkProgram(
    parseProgram(`${PRELUDE}\n${shapes}\nfunction main(msg: <graph-[:message]->>) {\n${body}\n}`),
    catalog,
  ).filter((d) => (d.severity ?? 'error') === 'error');

const codes = (body: string, shapes = ''): string[] => diagnostics(body, shapes).map((d) => d.code);

/** A shape whose `thesis` field is annotated with the declared refinement. */
const COMPANY = [
  'node Company: "the company mentioned" {',
  '  name: <text> "the company\'s name"',
  '  thesis: <Thesis> "which thesis this company fits"',
  '}',
].join('\n');

/** The one company extracted, then whatever the test does with it. */
const withExtract = (uses: string[]): [string, string] => [
  ['  c = extractOne([msg.`Body`], Company)', '  if (c == null) { fail("no company") }', ...uses].join('\n'),
  COMPANY,
];

describe('a declared type constrains an extract field', () => {
  it('a valid value compares clean', () => {
    expect(codes(...withExtract(['  ok = c.`thesis` == "Infra"']))).toEqual([]);
  });

  it('a typo gets MOV_ENUM_UNKNOWN_VALUE with a did-you-mean — the borrowed path, unchanged', () => {
    const diag = diagnostics(...withExtract(['  ok = c.`thesis` == "Infrra"'])).find(
      (d) => d.code === C.ENUM_UNKNOWN_VALUE,
    );
    expect(diag).toBeDefined();
    expect(diag!.message).toContain('Consumer | Infra | Health');
    expect(diag!.message).toContain('Did you mean "Infra"?');
  });

  it('the value is TEXT at run time — it interpolates and concatenates', () => {
    expect(
      codes(...withExtract(['    line = "fits ${c.`thesis`}"', '    also = Text.concat(c.`name`, c.`thesis`)'])),
    ).toEqual([]);
  });

  it('the value writes into a text field', () => {
    expect(
      codes(
        ...withExtract([
          '    write graph-[:company]-> { Name ?: c.`name`, Thesis ?: c.`thesis` }',
        ]),
      ),
    ).toEqual([]);
  });
});

describe('an annotation that names no type says so', () => {
  it('a typo of a declared type is MOV_UNKNOWN_TYPE_NAME with a did-you-mean', () => {
    const diag = diagnostics(
      '  found = extractOne([msg.`Body`], Found)',
      'node Found: "the thesis" {\n  thesis: <Thessis> "which thesis"\n}',
    ).find((d) => d.code === C.UNKNOWN_TYPE_NAME);
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("did you mean 'Thesis'?");
  });

  it('a mistyped primitive is caught by the same check', () => {
    const diag = diagnostics(
      '  found = extractOne([msg.`Body`], Found)',
      'node Found: "the count" {\n  n: <nubmer> "how many"\n}',
    ).find((d) => d.code === C.UNKNOWN_TYPE_NAME);
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("did you mean 'number'?");
  });

  it('a primitive annotation stays clean', () => {
    expect(
      codes('  found = extractOne([msg.`Body`], Found)', 'node Found: "the count" {\n  n: <number> "how many"\n}'),
    ).toEqual([]);
  });
});

describe('a declared type is an ordinary name', () => {
  it('a second declaration of the same name is MOV_DUPLICATE_DECL', () => {
    const source = `${PRELUDE}\ntype Thesis = <"X">\nfunction main(msg: <graph-[:message]->>) {\n}`;
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
      'function main(msg: <graph-[:message]->>) {',
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
