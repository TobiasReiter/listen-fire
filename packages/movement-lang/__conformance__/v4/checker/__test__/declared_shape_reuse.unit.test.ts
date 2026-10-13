// A node declaration written once and reused. An extraction that takes it as
// its shape (`node entry: <Entry>`) must type EXACTLY as the inline block that
// spells the declaration out — same fields, same refinements, same nested
// nodes — and a write body's spread (`...e`, `?...e`) must be checked exactly
// as the field lines it stands for. These tests pin that sameness.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { ResolveFile } from '../link';

const crmSchema: InstanceSchema = {
  positions: {
    message: { properties: { Body: 'text' }, edges: {} },
    company: { properties: { name: 'text', stage: 'text', thesis: 'text' }, edges: {} },
  },
  collections: { message: { target: 'message' }, company: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', thesis: 'text' },
      resultShape: { externalId: 'text', name: 'text', stage: 'text', thesis: 'text' },
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
  plugins: { lookup: { args: ['q'] } },
});

const PRELUDE = [
  'import { crm } from adapters',
  'import { lookup } from plugins',
  'import { probe } from credentials',
  'graph = crm(credentials: probe)',
  'type Thesis = <"Consumer" | "Infra" | "Health">',
  'rules = "route by sector"',
].join('\n');

const ENTRY = [
  'node Entry: "each company pitched" {',
  '  name: <text> "the company\'s name"',
  '  stage: <text>',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '  node founder: "each founder named" { first: <text> "given names" }',
  '}',
].join('\n');

const errors = (source: string, resolveFile?: ResolveFile): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog, resolveFile ? { resolveFile } : undefined).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );

const program = (body: string[], declarations = ENTRY): string =>
  [PRELUDE, declarations, 'movement main(msg: <graph-[:message]->>) {', ...body, '}'].join('\n');

const codes = (body: string[], declarations = ENTRY): string[] =>
  errors(program(body, declarations)).map((d) => d.code);

const extractEntries = ['  found = extract from [msg.`Body`] {', '    node entry: <Entry>', '  }'];

describe('an extraction node that takes a declaration as its shape', () => {
  it('walks records of the declared structure — fields and nested nodes', () => {
    expect(
      codes([
        ...extractEntries,
        '  found-[e:entry]-> {',
        '    s = e.stage',
        '    e-[f:founder]-> { n = f.first }',
        '  }',
      ]),
    ).toEqual([]);
  });

  it('refuses a field the declaration does not have', () => {
    expect(codes([...extractEntries, '  found-[e:entry]-> { s = e.round }'])).toEqual([
      C.EXTRACT_UNKNOWN_FIELD,
    ]);
  });

  it('constrains a refinement field exactly as inline — a typo gets the did-you-mean', () => {
    const diagnostics = errors(
      program([...extractEntries, '  found-[e:entry]-> { ok = e.thesis == "Infrra" }']),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.ENUM_UNKNOWN_VALUE]);
    expect(diagnostics[0].message).toContain('Did you mean "Infra"?');
  });

  it('types the same as the inline block the declaration spells out', () => {
    const inline = [
      '  found = extract from [msg.`Body`] {',
      '    node entry: "each company pitched" {',
      '      name: <text> "the company\'s name"',
      '      stage: <text> ""',
      '      thesis: <Thesis> "the thesis it routes to. ${rules}"',
      '      node founder: "each founder named" { first: <text> "given names" }',
      '    }',
      '  }',
    ];
    const uses = ['  found-[e:entry]-> {', '    write graph-[:company]-> { name: e.name }', '  }'];
    expect(codes([...extractEntries, ...uses])).toEqual(codes([...inline, ...uses]));
    // `<text>` is present text, declared or inline: a plain write takes it.
    expect(codes([...extractEntries, ...uses])).toEqual([]);
  });

  it('lets a following `through` stage read the declared fields, and nothing later', () => {
    const through = (arg: string): string[] =>
      codes([
        '  found = extract from [msg.`Body`] {',
        '    node entry: <Entry> "each deal"',
        `      through [lookup(q: ${arg})] { round: "the round, from the lookup" }`,
        '  }',
      ]).filter((code) => code !== C.PLUGIN_OUTPUT_UNDECLARED);
    expect(through('name')).toEqual([]);
    // The control: the stage's OWN field is a forward reference.
    expect(through('round')).toEqual([C.THROUGH_FORWARD_REF]);
  });

  it('refuses a name that is not a node declaration, naming the fix', () => {
    const diagnostics = errors(
      program(['  found = extract from [msg.`Body`] {', '    node entry: <Thesis>', '  }']),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.EXTRACT_SHAPE_NOT_DECLARED]);
    expect(diagnostics[0].message).toContain("node Thesis: \"…\" { … }");
  });

  it('refuses an unknown name', () => {
    expect(
      codes(['  found = extract from [msg.`Body`] {', '    node entry: <Entyr>', '  }']),
    ).not.toEqual([]);
  });

  it('reuses an IMPORTED declaration', () => {
    const lib = ['export node Entry: "each company" {', '  name: <text> "its name"', '}'].join('\n');
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      'movement main(msg: <graph-[:message]->>) {',
      ...extractEntries,
      '  found-[e:entry]-> { n = e.name }',
      '}',
    ].join('\n');
    const resolve: ResolveFile = (path) => (path === 'lib/entries' ? { source: lib } : undefined);
    expect(errors(source, resolve).map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it('refuses a field annotated with a name that is not a type', () => {
    const declaration = ['node Entry: "each company" {', '  thesis: <Thesiss> "its thesis"', '}'].join('\n');
    expect(codes(extractEntries, declaration)).toEqual([C.UNKNOWN_TYPE_NAME]);
  });

  it("refuses an imported declaration's refinement that only the IMPORTER declares", () => {
    // PRELUDE declares `Thesis`; the library does not — lexical scoping, so the
    // library's declaration cannot see it.
    const lib = ['export node Entry: "each company" {', '  thesis: <Thesis> "its thesis"', '}'].join('\n');
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      'movement main(msg: <graph-[:message]->>) {',
      ...extractEntries,
      '}',
    ].join('\n');
    const resolve: ResolveFile = (path) => (path === 'lib/entries' ? { source: lib } : undefined);
    expect(errors(source, resolve).map((d) => d.code)).toEqual([C.UNKNOWN_TYPE_NAME]);
  });
});

describe('presence on a declared shape — exactly as on the inline block', () => {
  const TYPED = [
    'node Entry: "each company pitched" {',
    '  name: <text> "its name"',
    '  thesis: <Thesis> "the thesis it routes to"',
    '  employees: <number> "headcount"',
    '  public: <boolean> "listed?"',
    '}',
  ].join('\n');
  const INLINE = [
    '  found = extract from [msg.`Body`] {',
    '    node entry: "each company pitched" {',
    '      name: <text> "its name"',
    '      thesis: <Thesis> "the thesis it routes to"',
    '      employees: <number> "headcount"',
    '      public: <boolean> "listed?"',
    '    }',
    '  }',
  ];
  /** The same body, checked against the declared shape and the inline block. */
  const both = (uses: string[]): [string[], string[]] => [
    codes([...extractEntries, '  found-[e:entry]-> {', ...uses, '  }'], TYPED),
    codes([...INLINE, '  found-[e:entry]-> {', ...uses, '  }'], TYPED),
  ];

  it('a `<text>` field is present: a plain write and an interpolation need nothing', () => {
    const [declared, inline] = both([
      '    write graph-[:company]-> { name: e.name, stage: "${e.name} (seed)" }',
    ]);
    expect(declared).toEqual([]);
    expect(declared).toEqual(inline);
  });

  it('a typed field — number, boolean, refinement — may be absent', () => {
    const [declared, inline] = both(['    write graph-[:company]-> { thesis: e.thesis }']);
    expect(declared).toEqual([C.ABSENT_REQUIRED]);
    expect(declared).toEqual(inline);
    for (const read of ['    big = e.employees > 3', '    both = e.public AND e.public']) {
      const [typed, typedInline] = both([read]);
      expect(typed).toEqual(typedInline);
    }
    const [ordered] = both(['    big = e.employees > 3']);
    expect(ordered).toEqual([C.ABSENT_REQUIRED]);
  });

  it('a null test on its text is refused, naming the emptiness test', () => {
    for (const test of ['e.name == null', 'e.name != null', 'EXISTS(e.name)', 'ISNULL(e.name)']) {
      const [declared, inline] = both([`    if ${test} { write graph-[:company]-> { name: "y" } }`]);
      expect(declared).toEqual([C.PRESENCE_TEST_ON_TEXT]);
      expect(declared).toEqual(inline);
    }
  });

  it('a guard on a typed field narrows it present inside the arm', () => {
    const [declared, inline] = both([
      '    if EXISTS(e.thesis) { write graph-[:company]-> { thesis: e.thesis } }',
    ]);
    expect(declared).toEqual([]);
    expect(declared).toEqual(inline);
  });
});

describe("a declaration's descriptions", () => {
  it('may interpolate a file-scope binding declared above it', () => {
    expect(codes([...extractEntries])).toEqual([]);
  });

  it('refuses one declared below it as read before it is bound', () => {
    const below = [
      'node Late: "each thing" {',
      '  name: <text> "named per ${later}"',
      '}',
      'later = "a rule"',
    ].join('\n');
    expect(codes([], below)).toContain(C.USE_BEFORE_BIND);
  });
});

describe('a spread in a write body', () => {
  const writeWith = (body: string): string[] => [
    ...extractEntries,
    '  found-[e:entry]-> {',
    `    write graph-[:company]-> { ${body} }`,
    '  }',
  ];

  it('`?...e` writes every field set-if-empty — clean', () => {
    // `founder` is a nested node, not a field: it is never spread.
    expect(codes(writeWith('unique by (name)  ?...e'))).toEqual([]);
  });

  it('`...e` refuses a maybe-absent field exactly as the plain line would, naming `?...`', () => {
    // Only `thesis` (a refinement) may be absent; `name` and `stage` are text.
    const diagnostics = errors(program(writeWith('...e')));
    expect(diagnostics.map((d) => d.code)).toEqual([C.ABSENT_REQUIRED]);
    expect(diagnostics[0].message).toContain('thesis');
    expect(diagnostics[0].message).toContain("'?...e'");
  });

  it('refuses a field of `e` the target does not have, naming the field', () => {
    const target = crmSchema.writableRoots.company.fields;
    const narrow = [
      'node Entry: "each company" {',
      '  name: <text> "its name"',
      '  founded: <number> "the year"',
      '}',
    ].join('\n');
    expect(target.founded).toBeUndefined();
    const diagnostics = errors(program(writeWith('?...e'), narrow));
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain("has no field 'founded'");
    expect(diagnostics[0].message).toContain("'...e'");
  });

  it('an explicit line wins over the spread for its field', () => {
    // `name` written plainly from a value that is always there; the rest filled.
    expect(codes(writeWith('name: "fixed", ?...e'))).toEqual([]);
  });

  it("refuses a system's record — its fields are the system's to say", () => {
    const diagnostics = errors(program(['  write graph-[:company]-> { ?...msg }']));
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_SPREAD_SOURCE]);
    expect(diagnostics[0].message).toContain("the system's to say");
    expect(diagnostics[0].message).toContain('one per line');
  });
});

describe('a spread of any record whose fields the program spells out', () => {
  const DEAL = [
    'node Deal {',
    '  name:  <text>',
    '  stage: <text>',
    '  node founder { first: <text> }',
    '}',
  ].join('\n');

  const withCallee = (body: string, declarations = DEAL): string =>
    [PRELUDE, declarations, 'function record_deal(d: <Deal>) {', `  ${body}`, '}'].join('\n');

  it('spreads a parameter typed on a declared structure — its fields, never its nested nodes', () => {
    expect(errors(withCallee('write graph-[:company]-> { ...d }')).map((d) => d.code)).toEqual([]);
  });

  it("records the declaration's field list on the spread, for the engine to write", () => {
    const parsed = parseProgram(withCallee('write graph-[:company]-> { ...d }'));
    checkProgram(parsed, catalog);
    const callee = parsed.statements.find((s) => s.kind === 'movement');
    if (callee?.kind !== 'movement') throw new Error('expected the callee');
    const write = callee.body[0];
    if (write.kind !== 'write') throw new Error('expected a write');
    expect(write.write.spreads?.[0].fields).toEqual(['name', 'stage']);
  });

  it('refuses a declared field the target lacks, naming it', () => {
    const wide = DEAL.replace('  stage: <text>', '  stage: <text>\n  round: <number>');
    const diagnostics = errors(withCallee('write graph-[:company]-> { ...d }', wide));
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain("has no field 'round'");
  });

  it('spreads a `node { … }` literal bound to a name', () => {
    expect(
      codes([
        '  n = node { name: msg.`Body`, stage: "Seed", company: node { name: "x" } }',
        '  write graph-[:company]-> { ...n }',
      ]),
    ).toEqual([]);
  });

  it('checks each field of a literal as the written line would be — an unknown one is named', () => {
    const diagnostics = errors(
      program([
        '  n = node { name: msg.`Body`, owner: "sam" }',
        '  write graph-[:company]-> { ...n }',
      ]),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain("has no field 'owner'");
  });
});
