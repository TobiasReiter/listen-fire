// B15 (checker half) and the declared NAMED function's leak (B14 review).
//
// A value that MAY be a record and may be something else (`COALESCE(org, "x")`,
// an IF of a record and text, a function or closure returning either) handed to
// a parameter that takes a record POSITION: TypeScript's `Org | string` is no
// `Org`. Refused from language version 5 (`MOV_CALL_ARG_MAYBE_RECORD`); versions
// 1-4 keep their meaning (the run-time refusal is the engine's). A union of
// records alone is one record and fits.
//
// A named function with a declared return (`function f(): <text> { … }`) hands
// back what its body may hand back wherever the call is used: a use that
// reaches data (a graph entry, a spread, a written field, a plugin argument) is refused on every version, as a closure's call is. The
// declaration itself is refused only from version 5. Declared recursion is no
// call cycle.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';
import { spelledFor } from './surface_spelling';

const catalog = mockCatalog({
  adapters: {
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: { company: { properties: { name: 'text', info: 'json' }, edges: {} } },
        collections: { companies: { target: 'company' } },
        writableRoots: { company: { fields: { name: 'text', info: 'json' }, resultShape: { externalId: 'text', name: 'text' } } },
      },
    },
  },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {
    summarise: {
      args: ['data'],
      argTypes: { data: 'json' },
      requiredArgs: ['data'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
  },
});

const check = (version: LanguageVersion, top: string[], body: string[]): Diagnostic[] => {
  const source = [
    'import { attio } from adapters',
    'import { crm_cred } from credentials',
    'import { summarise } from plugins',
    '',
    'crm = attio(credentials: crm_cred)',
    'movement hp(r: <crm-[:company]->>) {',
    '  n = r.name',
    '}',
    ...top,
    'movement m() {',
    '  org = write crm-[:companies]-> { name: "A" }',
    '  o2 = write crm-[:companies]-> { name: "B" }',
    ...body,
    '}',
  ].join('\n');
  return checkProgram(parseProgram(spelledFor(version, source, catalog), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error' && d.code !== 'MOV_LISTEN_MISSING',
  );
};

const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map(d => d.code);

describe.each([1, 3, 4, 5] as const)('B15: a maybe-record into a position parameter, version %i', version => {
  const refusedFrom5 = (top: string[], body: string[]): void => {
    const found = check(version, top, body);
    if (version >= 5) {
      expect(codes(found)).toEqual(['MOV_CALL_ARG_MAYBE_RECORD']);
      expect(found[0]!.message).toContain("'hp' expects crm.company");
      expect(found[0]!.message).toContain("'is'");
    } else {
      expect(found).toEqual([]);
    }
  };

  it('a name bound to a record or text, an operator written in place, an IF', () => {
    refusedFrom5([], ['  v = COALESCE(org, "x")', '  hp(r: v)']);
    refusedFrom5([], ['  hp(r: COALESCE(org, "x"))']);
    refusedFrom5([], ['  hp(r: IF 1 > 0 THEN org ELSE "x" END)']);
  });

  it('records alone are one record, and a record is a record', () => {
    expect(check(version, [], ['  hp(r: org)'])).toEqual([]);
    expect(check(version, [], ['  hp(r: COALESCE(org, o2))'])).toEqual([]);
    expect(check(version, [], ['  v = COALESCE(org, o2)', '  hp(r: v)'])).toEqual([]);
    expect(check(version, [], ['  hp(r: IF 1 > 0 THEN org ELSE o2 END)'])).toEqual([]);
  });

  it('IS narrows a value that may be a record to the record inside the arm (R1)', () => {
    expect(check(version, [], ['  v = COALESCE(org, "x")', '  if v IS <crm-[:company]->> {', '    hp(r: v)', '  }'])).toEqual([]);
    expect(check(version, [], ['  v = IF 1 > 0 THEN org ELSE "x" END', '  if v IS <crm-[:company]->> {', '    hp(r: v)', '  }'])).toEqual([]);
    // Outside the arm the value is still the union.
    const outside = check(version, [], ['  v = COALESCE(org, "x")', '  if v IS <crm-[:company]->> {', '    n = 1', '  }', '  hp(r: v)']);
    expect(codes(outside)).toEqual(version >= 5 ? ['MOV_CALL_ARG_MAYBE_RECORD'] : []);
  });

  it('a record with null or absence is a maybe-absent record, which a position parameter takes (L1)', () => {
    expect(check(version, [], ['  hp(r: COALESCE(org, NULL))'])).toEqual([]);
    expect(check(version, [], ['  v = COALESCE(org, NULL)', '  hp(r: v)'])).toEqual([]);
  });

  it('the message names the actual other member (L2)', () => {
    if (version < 5) return;
    const text = check(version, [], ['  hp(r: COALESCE(org, "x"))']);
    expect(text[0]!.message).toContain('a record or text');
    const num = check(version, [], ['  hp(r: COALESCE(org, 3))']);
    expect(num[0]!.message).toContain('a record or number');
    expect(num[0]!.message).not.toContain('or text');
  });

  if (version >= 3) {
    it('a closure or a function that returns either, called in place or bound', () => {
      refusedFrom5([], ['  c = () => COALESCE(org, "x")', '  hp(r: c())']);
      refusedFrom5([], ['  c = () => COALESCE(org, "x")', '  w = c()', '  hp(r: w)']);
      refusedFrom5(['function f() {', '  a = write crm-[:companies]-> { name: "A" }', '  return COALESCE(a, "x")', '}'], ['  hp(r: f())']);
      refusedFrom5(['function f() {', '  a = write crm-[:companies]-> { name: "A" }', '  return COALESCE(a, "x")', '}'], ['  w = f()', '  hp(r: w)']);
    });

    it('a closure or a function that returns records alone fits', () => {
      expect(check(version, [], ['  c = () => COALESCE(org, o2)', '  hp(r: c())'])).toEqual([]);
      expect(check(version, ['function f() {', '  a = write crm-[:companies]-> { name: "A" }', '  b = write crm-[:companies]-> { name: "B" }', '  return COALESCE(a, b)', '}'], ['  hp(r: f())'])).toEqual([]);
    });
  }
});

describe.each([3, 4, 5] as const)('B14 review gap: a declared named function whose body may hand back a record, version %i', version => {
  const DECLARED = [
    'function f(): <text> {',
    '  a = write crm-[:companies]-> { name: "A" }',
    '  return COALESCE(a, "x")',
    '}',
  ];
  const uses: Array<[string, string[], string]> = [
    ['a graph entry', ['  g = graph { name: f() }'], 'MOV_GRAPH_ENTRY_RECORD'],
    ['a graph entry through a name', ['  x = f()', '  g = graph { name: x }'], 'MOV_GRAPH_ENTRY_RECORD'],
    ['a spread', ['  held = { k: f() }', '  g = graph { ...held }'], 'MOV_GRAPH_SPREAD_RECORD'],
    ['a written field', ['  write crm-[:companies]-> { name: "n", info: f() }'], 'MOV_WRITE_FIELD_TYPE'],
    ['a plugin argument', ['  s = summarise(data: { a: f() })'], 'MOV_CALL_ARG_TYPE'],
  ];

  it.each(uses)('refused at the use: %s', (_name, body, code) => {
    const found = check(version, DECLARED, body);
    // From version 5 the declaration is refused and the call is what it declares.
    if (version >= 5) {
      expect(codes(found)).toEqual(['MOV_RETURN_TYPE']);
      return;
    }
    expect(found.length).toBeGreaterThan(0);
    expect(codes(found)).not.toContain('MOV_RETURN_TYPE');
    if (code !== '') expect(codes(found)).toContain(code);
  });

  it('unused or only compared, it is clean before version 5', () => {
    const quiet = check(version, DECLARED, ['  x = f()', '  y = IF f() = "x" THEN 1 ELSE 2 END']);
    expect(codes(quiet)).toEqual(version >= 5 ? ['MOV_RETURN_TYPE'] : []);
  });

  it('a body that hands back text stays clean at every use', () => {
    const text = ['function f(): <text> {', '  return COALESCE("y", "x")', '}'];
    expect(check(version, text, ['  g = graph { name: f() }', '  write crm-[:companies]-> { name: f(), info: { a: f() } }', '  s = summarise(data: { a: f() })'])).toEqual([]);
  });

  it('declared recursion is no call cycle, with the body clean or not', () => {
    const recursive = [
      'function down(n: <number>): <number> {',
      '  if n > 0 { return down(n - 1) }',
      '  return 0',
      '}',
      'function a(n: <number>): <text> {',
      '  if n > 0 { return b(n - 1) }',
      '  return "done"',
      '}',
      'function b(n: <number>): <text> {',
      '  if n > 0 { return a(n - 1) }',
      '  return "end"',
      '}',
    ];
    expect(check(version, recursive, ['  g = graph { c: down(3), t: a(2) }'])).toEqual([]);
    // A recursive body that may hand back a record: the call out of the cycle
    // still carries it, the edge inside it carries nothing.
    const leaky = [
      'function a(n: <number>): <text> {',
      '  if n > 0 { return a(n - 1) }',
      '  r = write crm-[:companies]-> { name: "A" }',
      '  return COALESCE(r, "x")',
      '}',
    ];
    const found = check(version, leaky, ['  g = graph { name: a(2) }']);
    expect(codes(found)).not.toContain('MOV_RECURSIVE_RETURN_TYPE');
    expect(codes(found)).toEqual(version >= 5 ? ['MOV_RETURN_TYPE'] : ['MOV_GRAPH_ENTRY_RECORD']);
  });
});
