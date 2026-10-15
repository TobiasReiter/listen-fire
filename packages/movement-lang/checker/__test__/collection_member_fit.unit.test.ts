// A collection op's function is called by the op, once per member — so each
// member is an argument, held to the parameter it binds as an author's
// argument is. TypeScript refuses `["a"].map((n: number) => n)`. MAP, FILTER,
// GROUPBY and KEYBY hold each member to the function's parameter; REDUCE holds
// its starting value to the accumulator and each member to the parameter
// after it. The fit is the one value parameters use, the may-hold-a-record
// test included (MOV_CALL_ARG_TYPE, MOV_CALL_ARG_MAYBE_RECORD). A parameter
// left untyped takes the member's type.
//
// From Dancing Wren (5). Under 3 and 4 nothing compared them and the op ran,
// handing the function each member as it was (a sum over text came out NaN),
// so those versions are warned, and the warning blocks the move up.

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
  'function inc(n: <number>) {',
  '  return n + 1',
  '}',
].join('\n');

const CO = '  co = write crm-[:companies]-> { name: "a" }';

const diagnosticsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${[CO, ...body].join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version });
};
const errors = (version: LanguageVersion, body: string[]): string[] =>
  diagnosticsUnder(version, body).filter(d => (d.severity ?? 'error') === 'error').map(d => d.code);
const warnings = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  diagnosticsUnder(version, body).filter(d => d.severity === 'warning');

const MISFITS: Array<[string, string[], string]> = [
  ['MAP over text, a closure taking a number', ['  x = MAP(["a"], (n: <number>) => n)'], 'MOV_CALL_ARG_TYPE'],
  ['MAP over text, a function by name taking a number', ['  x = MAP(["a"], inc)'], 'MOV_CALL_ARG_TYPE'],
  ['FILTER', ['  x = FILTER(["a"], (n: <number>) => n > 1)'], 'MOV_CALL_ARG_TYPE'],
  ['GROUPBY', ['  x = GROUPBY(["a"], (n: <number>) => "k")'], 'MOV_CALL_ARG_TYPE'],
  ['KEYBY', ['  x = KEYBY(["a"], (n: <number>) => "k")'], 'MOV_CALL_ARG_TYPE'],
  ['REDUCE\'s starting value against its accumulator', ['  x = REDUCE([1, 2], "s", (acc: <number>, n: <number>) => acc + n)'], 'MOV_CALL_ARG_TYPE'],
  ['REDUCE\'s members against the parameter after the accumulator', ['  x = REDUCE(["a"], 0, (acc: <number>, n: <number>) => acc + n)'], 'MOV_CALL_ARG_TYPE'],
  ['a record member, to a number', ['  x = MAP([co], (n: <number>) => n)'], 'MOV_CALL_ARG_TYPE'],
  ['a member that may be a record', ['  x = MAP([COALESCE(co, 1)], (n: <number>) => n)'], 'MOV_CALL_ARG_MAYBE_RECORD'],
];

describe('a collection op\'s members against its function\'s parameters', () => {
  it.each(MISFITS)('%s is refused under Dancing Wren (5)', (_label, body, code) => {
    expect(errors(5, body)).toEqual([code]);
  });

  it('the message names the parameter and what the op hands it', () => {
    const [error] = diagnosticsUnder(5, MISFITS[0]![1]);
    expect(error!.message).toBe("the function for 'MAP' expects number for 'n' (argument 1), but each member 'MAP' hands it is text");
    const [named] = diagnosticsUnder(5, MISFITS[1]![1]);
    expect(named!.message).toContain("'inc' expects number for 'n'");
  });

  it.each<LanguageVersion>([3, 4])('under version %i the op ran, so each is an upgrade warning', version => {
    for (const [, body, code] of MISFITS) {
      expect(errors(version, body)).toEqual([]);
      const [warning, ...rest] = warnings(version, body);
      expect(rest).toEqual([]);
      expect(warning!.code).toBe(code);
      expect(warning!.upgrade).toBe(true);
    }
  });

  it.each<[string, string[]]>([
    ['members of the parameter\'s type', ['  x = MAP([1, 2], (n: <number>) => n)']],
    ['an untyped parameter, typed by the member', ['  x = MAP(["a"], (n) => n)']],
    ['REDUCE whose starting value and members fit', ['  x = REDUCE([1, 2], 0, (acc: <number>, n: <number>) => acc + n)']],
    ['a field read off a record member', ['  x = MAP([co], (c) => c.name)']],
  ])('%s is clean', (_label, body) => {
    expect(diagnosticsUnder(5, body)).toEqual([]);
  });
});
