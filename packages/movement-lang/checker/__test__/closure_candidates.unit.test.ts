// A value that may be any of several closures — a body whose returns hand back
// different closures (`mk` returns `made` on one path and `label` on another).
// TypeScript calls a union of function types only with arguments that fit
// EVERY member's parameters, and the call is the union of their returns. From
// Dancing Wren (5) so is this: every candidate's arity, an argument fitting
// every candidate's parameter (two that share no argument are named), and a
// record any candidate hands back is seen wherever the call's value goes. A
// declared return type on the function narrows the candidates to it.
//
// Before 5 the call was typed and bound by the first return's closure alone,
// and it RAN on whichever closure it reached: a record written where text was
// typed, a number handed to a text parameter, a missing argument failing at
// run time only when the other path was taken. So versions 3 and 4 are
// warned, and the warning blocks the move up.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {},
});

const PRELUDE = [
  'import { attio } from adapters',
  'import { crm_cred } from credentials',
  'crm = attio(credentials: crm_cred)',
  'function made() {',
  '  o = write crm-[:companies]-> { name: "Acme Inc." }',
  '  return o',
  '}',
  'function label() {',
  '  return "x"',
  '}',
  'function pair(a: <number>, b: <number>) {',
  '  return a',
  '}',
].join('\n');

const diagnosticsUnder = (version: LanguageVersion, functions: string[], body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\n${functions.join('\n')}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version });
};
const errors = (version: LanguageVersion, functions: string[], body: string[]): string[] =>
  diagnosticsUnder(version, functions, body).filter(d => (d.severity ?? 'error') === 'error').map(d => d.code);
const warnings = (version: LanguageVersion, functions: string[], body: string[]): Diagnostic[] =>
  diagnosticsUnder(version, functions, body).filter(d => d.severity === 'warning');

/** A closure in the body returning `first` on one path and `second` on the other. */
const choosing = (first: string, second: string, call: string, after: string[] = []): string[] => [
  '  c = TRUE',
  '  mk = () => {',
  '    if c {',
  `      return ${first}`,
  '    }',
  `    return ${second}`,
  '  }',
  '  g = mk()',
  `  x = ${call}`,
  ...after,
];
const NOTE = ['  write crm-[:notes]-> { title: x }'];

/** A function by name returning one declared function on each path (version 5: a named function is a value). */
const mkOf = (first: string, second: string, declared = ''): string[] =>
  [`function mk(c: <boolean>)${declared} {`, '  if c {', `    return ${first}`, '  }', `    return ${second}`, '}'];

describe('a call of one of several closures, under Dancing Wren (5)', () => {
  it.each<[string, string[], string[]]>([
    ['a record the first returns', mkOf('made', 'label'), ['  g = mk(TRUE)', '  x = g()', ...NOTE]],
    ['a record a later one returns', mkOf('label', 'made'), ['  g = mk(TRUE)', '  x = g()', ...NOTE]],
    ['a record a later closure literal returns', [], choosing('() => "x"', '() => made()', 'g()', NOTE)],
  ])('%s is seen where the call\'s value is written', (_label, functions, body) => {
    expect(errors(5, functions, body)).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it('is held to every candidate\'s arity', () => {
    const found = diagnosticsUnder(5, mkOf('label', 'pair'), ['  g = mk(TRUE)', '  x = g()']);
    expect(found.map(d => d.code)).toEqual(['MOV_CALL_ARITY']);
    expect(found[0]!.message).toContain('taking 0 or 2 arguments');
  });

  it('refuses parameters no one argument fits, naming the two candidates', () => {
    const found = diagnosticsUnder(5, [], choosing('(n: <number>) => n + 1', '(n: <text>) => n', 'g(1)'));
    expect(found.map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(found[0]!.message).toContain("a closure returning number takes number for 'n', and a closure returning text takes text for 'n'");
    expect(found[0]!.message).toContain('as in TypeScript');
  });

  it('holds an argument to the narrowest candidate parameter', () => {
    expect(errors(5, [], choosing('(n: <number>) => n + 1', '(n: <number>) => n', 'g("a")'))).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors(5, [], choosing('(n: <number>) => n + 1', '(n: <number>) => n', 'g(2)'))).toEqual([]);
  });

  it('candidates that agree check clean', () => {
    expect(diagnosticsUnder(5, mkOf('label', 'label'), ['  g = mk(TRUE)', '  x = g()', ...NOTE])).toEqual([]);
    expect(diagnosticsUnder(5, [], choosing('() => "x"', '() => "y"', 'g()', NOTE))).toEqual([]);
  });

  it('a declared return type narrows the candidates to it', () => {
    const found = diagnosticsUnder(5, mkOf('made', 'label', ': <() => <text>>'), ['  g = mk(TRUE)', '  x = g()', ...NOTE]);
    expect(found.map(d => d.code)).toEqual(['MOV_RETURN_TYPE']);
    expect(diagnosticsUnder(5, mkOf('label', 'label', ': <() => <text>>'), ['  g = mk(TRUE)', '  x = g()', ...NOTE])).toEqual([]);
  });
});

describe('before Dancing Wren (5) the call is typed by the first candidate, and ran', () => {
  const CASES: Array<[string, string[], string]> = [
    ['a later one returns a record', choosing('() => "x"', '() => made()', 'g()', NOTE), 'MOV_CALL_CLOSURE_RETURNS'],
    ['a later one takes another arity', choosing('() => "x"', '(a: <number>) => a', 'g()'), 'MOV_CALL_ARITY'],
    ['a later one takes another parameter type', choosing('(n: <number>) => n + 1', '(n: <text>) => n', 'g(1)'), 'MOV_CALL_ARG_TYPE'],
  ];

  it.each<LanguageVersion>([3, 4])('under version %i each is an upgrade warning, not a refusal', version => {
    for (const [, body, code] of CASES) {
      expect(errors(version, [], body)).toEqual([]);
      const [warning, ...rest] = warnings(version, [], body);
      expect(rest).toEqual([]);
      expect(warning!.code).toBe(code);
      expect(warning!.upgrade).toBe(true);
    }
  });

  it.each<LanguageVersion>([3, 4])('under version %i a record the first candidate returns is refused, as it always was', version => {
    expect(errors(version, [], choosing('() => made()', '() => "x"', 'g()', NOTE))).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it.each<LanguageVersion>([3, 4])('under version %i the first candidate\'s arity is refused, as it always was', version => {
    expect(errors(version, [], choosing('(a: <number>) => a', '() => "x"', 'g()'))).toEqual(['MOV_CALL_ARITY', 'MOV_CALL_ARG_MISSING']);
  });
});
