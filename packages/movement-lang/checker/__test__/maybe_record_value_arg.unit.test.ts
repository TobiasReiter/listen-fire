// A value that MAY be a record and may be a value — `COALESCE(co, 1)`,
// `IF c THEN co ELSE 1 END`, a name bound to either — handed to a parameter
// typed as a value. No union mixes a record with a value, so the value's type
// is unknown and the fit check alone says nothing; what it may hold says it.
// TypeScript's `Org | number` is no `number`. Refused from Dancing Wren (5)
// (MOV_CALL_ARG_MAYBE_RECORD) on every call path: a function by name, a
// closure through a variable, a call as a statement, inside a list. Before 5
// the call ran — the record arrived where a number was typed — so versions 3
// and 4 are warned, and the warning blocks the move up. A plugin argument and
// a written field refuse it on every version, as they always have.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';
import { spelledFor } from './surface_spelling';

const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text', size: 'number' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { company: { fields: { name: 'text', size: 'number' }, resultShape: { externalId: 'text', name: 'text' } } },
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: { score: { args: ['n'], argTypes: { n: 'number' }, requiredArgs: ['n'], effects: { ai: true }, output: { kind: 'value', type: 'text' } } },
});

const PRELUDE = [
  'import { attio } from adapters',
  'import { crm_cred } from credentials',
  'import { score } from plugins',
  'crm = attio(credentials: crm_cred)',
  'function f(n: <number>) {',
  '  return n',
  '}',
  'function all3(ns: <number[]>) {',
  '  return 1',
  '}',
].join('\n');

const CO = '  co = write crm-[:companies]-> { name: "a" }';

const diagnosticsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = spelledFor(version, `${PRELUDE}\nmovement m() {\n${[CO, ...body].join('\n')}\n}`, catalog);
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version });
};
const errors = (version: LanguageVersion, body: string[]): string[] =>
  diagnosticsUnder(version, body).filter(d => (d.severity ?? 'error') === 'error').map(d => d.code);
const warnings = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  diagnosticsUnder(version, body).filter(d => d.severity === 'warning');

const CALLS: Array<[string, string[]]> = [
  ['COALESCE to a function by name', ['  x = f(COALESCE(co, 1))']],
  ['IF … THEN … ELSE … END to a function by name', ['  c = TRUE', '  x = f(IF c THEN co ELSE 1 END)']],
  ['a name bound to a COALESCE', ['  v = COALESCE(co, 1)', '  x = f(v)']],
  ['a call as a statement', ['  f(COALESCE(co, 1))']],
  ['a list member', ['  x = all3([COALESCE(co, 1)])']],
];

describe('a value that may be a record, handed to a value parameter', () => {
  it.each(CALLS)('%s is refused under Dancing Wren (5)', (_label, body) => {
    expect(errors(5, body)).toEqual(['MOV_CALL_ARG_MAYBE_RECORD']);
  });

  it('a closure called through a variable is held to the same rule', () => {
    expect(errors(5, ['  a = (n: <number>) => n', '  x = a(COALESCE(co, 1))'])).toEqual(['MOV_CALL_ARG_MAYBE_RECORD']);
  });

  it('the message names the record and the parameter', () => {
    const [error] = diagnosticsUnder(5, CALLS[0]![1]);
    expect(error!.message).toContain("'f' expects number for 'n'");
    expect(error!.message).toContain("'coalesce(co, 1)' may be a crm.company handle");
    expect(error!.message).toContain('as in TypeScript');
  });

  it.each<LanguageVersion>([3, 4])('under version %i the call ran, so it is an upgrade warning', version => {
    for (const [, body] of CALLS) {
      expect(errors(version, body)).toEqual([]);
      const [warning, ...rest] = warnings(version, body);
      expect(rest).toEqual([]);
      expect(warning!.code).toBe('MOV_CALL_ARG_MAYBE_RECORD');
      expect(warning!.upgrade).toBe(true);
    }
  });

  it.each<LanguageVersion>([3, 4, 5])('under version %i a plugin argument and a written field refuse it, as they always have', version => {
    expect(errors(version, ['  x = score(n: COALESCE(co, 1))'])).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors(version, ['  write crm-[:companies]-> { size: COALESCE(co, 1) }'])).toEqual(['MOV_WRITE_FIELD_TYPE']);
  });

  it.each<[string, string[]]>([
    ['a field read off the record', ['  x = f(COALESCE(co.size, 1))']],
    ['the record narrowed away', ['  c = TRUE', '  x = f(IF c THEN 2 ELSE 1 END)']],
  ])('%s is clean', (_label, body) => {
    expect(diagnosticsUnder(5, body)).toEqual([]);
  });

  it('a record whole, where the type shows it, is the fit check\'s to say — once', () => {
    expect(errors(5, ['  x = f(co)'])).toEqual(['MOV_CALL_ARG_TYPE']);
  });
});
