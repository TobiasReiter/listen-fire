// A value that MAY be a record and may be a value — `COALESCE(co, 1)`,
// `IF c THEN co ELSE 1 END`, a name bound to either — handed to a built-in
// whose argument takes a value: `ROUND(COALESCE(co, 1))`. No union mixes a
// record with a value, so the value's type is unknown and the kind check alone
// says nothing; what it may hold says it, as it does for a function's value
// parameter (MOV_CALL_ARG_MAYBE_RECORD). Refused from Dancing Wren (5). Before
// 5 the built-in ran on the record as it was (ROUND gave NaN, UPPER
// "[OBJECT OBJECT]"), so versions 3 and 4 are warned, and the warning blocks
// the move up.

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
  plugins: {},
});

const PRELUDE = ['import { attio } from adapters', 'import { crm_cred } from credentials', 'crm = attio(credentials: crm_cred)'].join('\n');
const CO = '  co = write crm-[:companies]-> { name: "a" }';

const diagnosticsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${[CO, ...body].join('\n')}\n}`;
  return checkProgram(parseProgram(spelledFor(version, source, catalog), { languageVersion: version }), catalog, { languageVersion: version });
};
const errors = (version: LanguageVersion, body: string[]): string[] =>
  diagnosticsUnder(version, body).filter(d => (d.severity ?? 'error') === 'error').map(d => d.code);
const warnings = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  diagnosticsUnder(version, body).filter(d => d.severity === 'warning');

const CALLS: Array<[string, string[]]> = [
  ['COALESCE to ROUND', ['  x = ROUND(COALESCE(co, 1))']],
  ['IF … THEN … ELSE … END to ROUND', ['  c = TRUE', '  x = ROUND(IF c THEN co ELSE 1 END)']],
  ['a name bound to a COALESCE', ['  v = COALESCE(co, 1)', '  x = ROUND(v)']],
  ['COALESCE to UPPER', ['  x = UPPER(COALESCE(co, "b"))']],
];

describe('a value that may be a record, handed to a built-in that takes a value', () => {
  it.each(CALLS)('%s is refused under Dancing Wren (5)', (_label, body) => {
    expect(errors(5, body)).toEqual(['MOV_CALL_ARG_MAYBE_RECORD']);
  });

  it('the message names the built-in, its argument and the record', () => {
    const [error] = diagnosticsUnder(5, CALLS[0]![1]);
    expect(error!.message).toContain("Number.round's 'number' takes a number, but this may be a crm.company handle");
    expect(error!.message).toContain('as in TypeScript');
  });

  it.each<LanguageVersion>([3, 4])('under version %i the built-in ran, so it is an upgrade warning', version => {
    for (const [, body] of CALLS) {
      expect(errors(version, body)).toEqual([]);
      const [warning, ...rest] = warnings(version, body);
      expect(rest).toEqual([]);
      expect(warning!.code).toBe('MOV_CALL_ARG_MAYBE_RECORD');
      expect(warning!.upgrade).toBe(true);
    }
  });

  it.each<[string, string[]]>([
    ['a field read off the record', ['  x = ROUND(COALESCE(co.size, 1))']],
    ['a value on every arm', ['  c = TRUE', '  x = ROUND(IF c THEN 2 ELSE 1 END)']],
    ['a built-in that takes anything', ['  x = COALESCE(COALESCE(co, 1), 2)']],
  ])('%s is clean', (_label, body) => {
    expect(errors(5, body)).toEqual([]);
  });

  it('a record whole, where the type shows it, is the record-as-value rule\'s to say — once', () => {
    expect(errors(5, ['  x = ROUND(co)'])).toEqual(['MOV_RECORD_NOT_A_VALUE']);
  });
});
