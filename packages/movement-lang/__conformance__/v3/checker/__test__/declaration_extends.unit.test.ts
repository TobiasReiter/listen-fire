// `node X extends Y { … }` — TypeScript's `interface X extends Y`. X is Y's
// fields and nested nodes (Y's types, words and order), then its own, and it is
// usable everywhere a declaration is. These tests pin that X checks EXACTLY as
// the declaration written out inline would, and the three refusals: a base that
// is not a node declaration, a chain that comes back round, a restated member.

import { parseProgram } from '../../parser/parse';
import {
  checkProgram,
  checkProgramWithLink,
  Diagnostic,
  DiagnosticCodes as C,
  type RecordedExtract,
} from '../check';
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
});

const PRELUDE = [
  'import { crm } from adapters',
  'import { probe } from credentials',
  'graph = crm(credentials: probe)',
  'type Thesis = <"Consumer" | "Infra" | "Health">',
  'rules = "route by sector"',
].join('\n');

const ENTRY = [
  'node Entry: "each company pitched" {',
  '  name: <text> "the company\'s name"',
  '  stage: <text>',
  '  node founder: "each founder named" { first: <text> "given names" } order by arrival',
  '}',
].join('\n');

const RECAP = [
  'node Recap extends Entry {',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '}',
].join('\n');

/** Recap, written out inline — what `extends` stands for. */
const RECAP_INLINE = [
  'node Recap: "each company pitched" {',
  '  name: <text> "the company\'s name"',
  '  stage: <text>',
  '  node founder: "each founder named" { first: <text> "given names" } order by arrival',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '}',
].join('\n');

const errors = (source: string, resolveFile?: ResolveFile): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog, resolveFile ? { resolveFile } : undefined).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );

const program = (body: string[], declarations = `${ENTRY}\n${RECAP}`): string =>
  [PRELUDE, declarations, 'movement main(msg: <graph-[:message]->>) {', ...body, '}'].join('\n');

const codes = (body: string[], declarations?: string): string[] =>
  errors(program(body, declarations)).map((d) => d.code);

const messages = (declarations: string): string[] =>
  errors(program([], declarations)).map((d) => `${d.code}: ${d.message}`);

const extractRecaps = ['  found = extract from [msg.`Body`] {', '    node entry: <Recap>', '  }'];

describe('the members X has', () => {
  it("is Y's fields and nested nodes, then its own", () => {
    expect(
      codes([
        ...extractRecaps,
        '  found-[e:entry]-> {',
        '    n = e.name',
        '    t = e.thesis',
        '    e-[f:founder]-> { g = f.first }',
        '  }',
      ]),
    ).toEqual([]);
  });

  it('and nothing else', () => {
    expect(codes([...extractRecaps, '  found-[e:entry]-> { r = e.round }'])).toEqual([
      C.EXTRACT_UNKNOWN_FIELD,
    ]);
  });

  it('checks exactly as the declaration written out inline', () => {
    const uses = [
      ...extractRecaps,
      '  found-[e:entry]-> {',
      '    write graph-[:company]-> { name: e.name, thesis: e.thesis }',
      '    ok = e.thesis == "Infrra"',
      '  }',
    ];
    const inherited = codes(uses);
    expect(inherited).toEqual(codes(uses, RECAP_INLINE));
    expect(inherited).toEqual([C.ABSENT_REQUIRED, C.ENUM_UNKNOWN_VALUE]);
  });

  it("keeps Y's types — an inherited refinement constrains a literal", () => {
    const withThesisInBase = [
      'node Entry { thesis: <Thesis> }',
      'node Recap extends Entry { name: <text> }',
    ].join('\n');
    const diagnostics = errors(
      program([...extractRecaps, '  found-[e:entry]-> { ok = e.thesis == "Infrra" }'], withThesisInBase),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.ENUM_UNKNOWN_VALUE]);
    expect(diagnostics[0].message).toContain('Did you mean "Infra"?');
  });

  it("keeps Y's order on an inherited nested node, and its whole tree reaches the symbol", () => {
    const { recording } = checkProgramWithLink(parseProgram(program([])), catalog, {
      recordAnalysis: true,
    });
    const recap = recording?.frames[0].scope.symbols.get('Recap');
    expect(recap?.schema?.positions.Recap.edges.founder).toEqual(
      expect.objectContaining({ target: 'Recap.founder', sequenced: expect.anything() }),
    );
    expect(Object.keys(recap?.schema?.positions.Recap.properties ?? {})).toEqual([
      'name',
      'stage',
      'thesis',
    ]);
    expect(recap?.declaration?.root.fields.map((f) => f.name)).toEqual(['name', 'stage', 'thesis']);
    expect(recap?.declaration?.root.children.map((c) => c.name)).toEqual(['founder']);
  });

  it('follows a chain, whatever order the declarations are written in', () => {
    const chain = [
      'node Final extends Recap { note: <text> }',
      RECAP,
      ENTRY,
    ].join('\n');
    expect(
      codes(
        [
          '  found = extract from [msg.`Body`] { node entry: <Final> }',
          '  found-[e:entry]-> {',
          '    n = e.name',
          '    t = e.thesis',
          '    o = e.note',
          '    e-[f:founder]-> { g = f.first }',
          '  }',
        ],
        chain,
      ),
    ).toEqual([]);
  });
});

describe('as an extraction shape', () => {
  function extractedEntry(declarations: string, tree = '    node entry: <Recap>') {
    const { recording } = checkProgramWithLink(
      parseProgram(program(['  found = extract from [msg.`Body`] {', tree, '  }'], declarations)),
      catalog,
      { recordAnalysis: true },
    );
    const extract = recording?.nodes.find((n): n is RecordedExtract => n.kind === 'extract');
    const entry = extract?.node.children.get('entry');
    if (entry === undefined) throw new Error('expected the extracted entry');
    return entry;
  }

  it("takes Y's words — the record's and each inherited member's — as its prompt", () => {
    const entry = extractedEntry(`${ENTRY}\n${RECAP}`);
    expect(entry.description).toBe('each company pitched');
    expect(entry.properties.get('name')?.description).toBe("the company's name");
    expect(entry.children.get('founder')?.description).toBe('each founder named');
    expect(entry.properties.get('thesis')?.description).toContain('the thesis it routes to.');
    expect([...entry.properties.keys()]).toEqual(['name', 'stage', 'thesis']);
  });

  it("X's own words for the record replace Y's", () => {
    const own = `${ENTRY}\nnode Recap extends Entry: "each company, for the recap" { thesis: <Thesis> }`;
    expect(extractedEntry(own).description).toBe('each company, for the recap');
  });
});

describe('everywhere else a declaration goes', () => {
  // Structural fit is judged for a record BUILT here (`node { … }`): one
  // carrying X's members fits a `<Y>` parameter, and one carrying only Y's does
  // not fit `<X>`. A record that arrived typed — extracted, or a parameter — is
  // still matched by the declaration it names (`positionsMatch`), for X and Y
  // exactly as for any two declarations; that rule is untouched here.
  const TEXT_ONLY = [
    'node Entry {',
    '  name: <text>',
    '  node founder { first: <text> }',
    '}',
    'node Recap extends Entry { note: <text> }',
  ].join('\n');
  const callees = [
    'function takes_entry(d: <Entry>) { n = d.name }',
    'function takes_recap(d: <Recap>) { o = d.note }',
  ];

  it('a record carrying X satisfies a parameter typed on Y — it carries every Y field', () => {
    const source = [
      PRELUDE,
      TEXT_ONLY,
      ...callees,
      'movement main(msg: <graph-[:message]->>) {',
      '  r = node { name: msg.`Body`, note: "seen", founder: node { first: "Ada" } }',
      '  takes_recap(d: r)',
      '  takes_entry(d: r)',
      '}',
    ].join('\n');
    expect(errors(source).map((d) => d.message)).toEqual([]);
  });

  it('while a record carrying only Y does not satisfy X — it lacks what X adds', () => {
    const source = [
      PRELUDE,
      TEXT_ONLY,
      ...callees,
      'movement main(msg: <graph-[:message]->>) {',
      '  e = node { name: msg.`Body` }',
      '  takes_recap(d: e)',
      '}',
    ].join('\n');
    const diagnostics = errors(source);
    expect(diagnostics.map((d) => d.code)).toEqual([C.NODE_ARG_SHAPE]);
    expect(diagnostics[0].message).toContain('note');
  });

  it('types a parameter, whose spread writes the whole field list', () => {
    const source = [
      PRELUDE,
      ENTRY,
      RECAP,
      'function record_recap(d: <Recap>) {',
      '  write graph-[:company]-> { ?...d }',
      '}',
    ].join('\n');
    const parsed = parseProgram(source);
    expect(checkProgram(parsed, catalog).filter((d) => (d.severity ?? 'error') === 'error')).toEqual(
      [],
    );
    const callee = parsed.statements.find((s) => s.kind === 'movement');
    if (callee?.kind !== 'movement' || callee.body[0].kind !== 'write') {
      throw new Error('expected the callee and its write');
    }
    expect(callee.body[0].write.spreads?.[0].fields).toEqual(['name', 'stage', 'thesis']);
  });

  it('spreads an extracted record of X', () => {
    expect(
      codes([...extractRecaps, '  found-[e:entry]-> { write graph-[:company]-> { unique by (name), ?...e } }']),
    ).toEqual([]);
  });

  it('types a collecting node', () => {
    expect(
      codes([
        '  kept = node { entries: <Recap> }',
        '  kept-[r:entries]-> {',
        '    t = r.thesis',
        '    r-[f:founder]-> { g = f.first }',
        '  }',
      ]),
    ).toEqual([]);
  });

  it('is an IS test', () => {
    const source = (body: string) =>
      [PRELUDE, ENTRY, RECAP, `function f(d: <Entry>, r: <Recap>) {`, body, '}'].join('\n');
    expect(errors(source('  if r IS <Entry> { n = r.name }')).map((d) => d.code)).toEqual([]);
    // A single-typed subject is decided at check time: an Entry is not a Recap,
    // so nothing narrows and `thesis` is still not one of its fields.
    expect(errors(source('  if d IS <Recap> { t = d.thesis }')).map((d) => d.code)).toEqual([
      C.UNKNOWN_PROPERTY,
    ]);
  });
});

// A parameter typed on a declaration is fitted STRUCTURALLY, whatever made the
// argument — the comparison `IS <Entry>` makes: every field the declaration
// names, with a compatible type; extras allowed; a nested node never gates it.
describe('a parameter typed on a declaration takes any record carrying it', () => {
  const withCallee = (body: string[], declarations = `${ENTRY}\n${RECAP}`): Diagnostic[] =>
    errors(
      [
        PRELUDE,
        declarations,
        'function takes_entry(d: <Entry>) { n = d.name }',
        'movement main(msg: <graph-[:message]->>) {',
        ...body,
        '}',
      ].join('\n'),
    );

  it('an extracted <Entry> record', () => {
    expect(
      withCallee([
        '  found = extract from [msg.`Body`] { node entry: <Entry> }',
        '  found-[e:entry]-> { takes_entry(d: e) }',
      ]).map((d) => d.message),
    ).toEqual([]);
  });

  it('an extracted record of a declaration that extends it', () => {
    expect(
      withCallee([...extractRecaps, '  found-[e:entry]-> { takes_entry(d: e) }']).map((d) => d.message),
    ).toEqual([]);
  });

  it('a record of an identical declaration', () => {
    const source = [
      PRELUDE,
      'node Entry {',
      '  name: <text>',
      '  stage: <text>',
      '}',
      'node Other {',
      '  name: <text>',
      '  stage: <text>',
      '}',
      'function takes_entry(d: <Entry>) { n = d.name }',
      'function takes_other(o: <Other>) { takes_entry(d: o) }',
      'function back(d: <Entry>) { takes_other(o: d) }',
    ].join('\n');
    expect(errors(source).map((d) => d.message)).toEqual([]);
  });

  it("a system's record that carries the fields", () => {
    const named = ['node Entry {', '  name: <text>', '  stage: <text>', '}'].join('\n');
    expect(
      withCallee(['  graph-[c:company]-> { takes_entry(d: c) }'], named).map((d) => d.message),
    ).toEqual([]);
  });

  it('a record missing a field is refused, naming it', () => {
    const named = ['node Entry {', '  name: <text>', '}'].join('\n');
    const diagnostics = withCallee(['  takes_entry(d: msg)'], named);
    expect(diagnostics.map((d) => d.code)).toEqual([C.CALL_ARG_TYPE]);
    expect(diagnostics[0].message).toBe("'takes_entry' expects a <Entry> record, and it has no `name`");
  });

  it('a record with a field of another type is refused, naming it', () => {
    const counted = ['node Entry {', '  name: <text>', '  stage: <number>', '}'].join('\n');
    const diagnostics = withCallee(['  graph-[c:company]-> { takes_entry(d: c) }'], counted);
    expect(diagnostics.map((d) => d.code)).toEqual([C.CALL_ARG_TYPE]);
    expect(diagnostics[0].message).toContain('its `stage` is text, not number');
  });

  it('an extracted record lacking a field is refused, naming it', () => {
    const diagnostics = withCallee(
      [
        '  found = extract from [msg.`Body`] { node entry: "each company" { name: "its name" } }',
        '  found-[e:entry]-> { takes_entry(d: e) }',
      ],
      ['node Entry {', '  name: <text>', '  stage: <text>', '}'].join('\n'),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.CALL_ARG_TYPE]);
    expect(diagnostics[0].message).toContain('it has no `stage`');
  });
});

describe('across files', () => {
  const libEntry = [
    'type Verdict = <"Keep" | "Drop">',
    'lens = "the library\'s lens"',
    'export node Entry: "each company, ${lens}" {',
    '  name: <text> "its name"',
    '  verdict: <Verdict> "whether to keep it"',
    '}',
  ].join('\n');

  it('extends an IMPORTED base, keeping the types its own file gave it', () => {
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      'node Recap extends Entry { thesis: <Thesis> }',
      'movement main(msg: <graph-[:message]->>) {',
      ...extractRecaps,
      '  found-[e:entry]-> {',
      '    ok = e.verdict == "Kep"',
      '    t = e.thesis',
      '  }',
      '}',
    ].join('\n');
    const resolve: ResolveFile = (path) => (path === 'lib/entries' ? { source: libEntry } : undefined);
    const diagnostics = errors(source, resolve);
    expect(diagnostics.map((d) => d.code)).toEqual([C.ENUM_UNKNOWN_VALUE]);
    expect(diagnostics[0].message).toContain('Did you mean "Keep"?');
  });

  it('imports an X whose base its library keeps private', () => {
    const lib = [
      'node Base { name: <text> }',
      'export node Recap extends Base { note: <text> }',
    ].join('\n');
    const source = [
      PRELUDE,
      'import { Recap } from "lib/recaps"',
      'movement main(msg: <graph-[:message]->>) {',
      ...extractRecaps,
      '  found-[e:entry]-> {',
      '    n = e.name',
      '    o = e.note',
      '  }',
      '}',
    ].join('\n');
    const resolve: ResolveFile = (path) => (path === 'lib/recaps' ? { source: lib } : undefined);
    expect(errors(source, resolve).map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });
});

describe('refused', () => {
  it('a base nothing declares', () => {
    expect(messages('node Recap extends Entyr { thesis: <Thesis> }').map((m) => m.split(':')[0])).toEqual([
      C.NAME_UNRESOLVED,
    ]);
  });

  it('a base that is not a node declaration, with the fix', () => {
    const found = messages('node Recap extends Thesis { note: <text> }');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(C.EXTENDS_NOT_A_NODE);
    expect(found[0]).toContain("'Thesis' is");
    expect(found[0]).toContain("not a node declaration — 'Recap' extends a node declared with 'node Thesis { … }'");
  });

  it('a cycle, on every declaration around it', () => {
    const found = messages(
      ['node A extends B { a: <text> }', 'node B extends A { b: <text> }'].join('\n'),
    );
    expect(found).toEqual([
      `${C.EXTENDS_CYCLE}: 'A' extends itself through 'B' (A extends B extends A) — one of them has to stand on its own`,
      `${C.EXTENDS_CYCLE}: 'B' extends itself through 'A' (B extends A extends B) — one of them has to stand on its own`,
    ]);
  });

  it('a declaration extending itself', () => {
    expect(messages('node A extends A { a: <text> }')).toEqual([
      `${C.EXTENDS_CYCLE}: 'A' extends itself — a node declaration extends a different one`,
    ]);
  });

  it('a field the base already has, naming it', () => {
    const found = messages(`${ENTRY}\nnode Recap extends Entry { stage: <number> }`);
    expect(found).toEqual([
      `${C.EXTENDS_REDEFINES}: 'stage' is already a field of 'Entry' — 'Recap' inherits it, with its type and its words, and cannot redefine it; a field of its own needs a name 'Entry' does not use`,
    ]);
  });

  it('a nested node the base already has — its order words included', () => {
    const found = messages(
      `${ENTRY}\nnode Recap extends Entry {\n  node founder { first: <text> } order by arrival\n}`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(C.EXTENDS_REDEFINES);
    expect(found[0]).toContain("'founder' is already a nested node of 'Entry'");
    expect(found[0]).toContain('its order');
  });
});
