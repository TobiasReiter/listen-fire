// `write v { … }` where `v` is bound to an IF or a COALESCE of records: as
// TypeScript's `A | A` IS `A`, records of one type are that type — two write
// handles of one system's Companies are a Company, so a write in place to it is
// held to a Company's fields and a read off it is typed. Records of different
// types stay a union: a record nobody can name, and nothing is refused. One
// that may be absent may be empty, and is no record to update in place; a value
// among them is no record at all.
//
// Versions. The write in place was the checker's own internal error
// (MOV_INTERNAL_UNTYPED_BINDING) until it read what the value may hold, so it
// never ran, and its checks hold on every version. A READ off it ran under 3
// and 4, untyped (`.nope` read null, `.name + 1` NaN — pinned in apps/api's
// records_of_one_type test), so the type is the value's from Dancing Wren (5),
// and what it refuses there is an upgrade warning before.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', size: 'number' }, edges: {} },
    person: { properties: { name: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, people: { target: 'person' } },
  writableRoots: {
    company: { fields: { name: 'text', size: 'number' }, resultShape: { externalId: 'text', name: 'text' } },
    person: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const catalog = mockCatalog({
  adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema } },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {},
});

const PRELUDE = ['import { attio } from adapters', 'import { crm_cred } from credentials', 'crm = attio(credentials: crm_cred)'].join('\n');

const diagnosticsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] => {
  const source = `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version });
};

const errorsUnder = (version: LanguageVersion, body: string[]): Array<[string, string]> =>
  diagnosticsUnder(version, body)
    .filter((d: Diagnostic) => (d.severity ?? 'error') === 'error')
    .map(d => [d.code, d.message]);

/** The codes a program is refused by under 5, and warned by (to upgrade) before. */
const refusedFrom5 = (version: LanguageVersion, body: string[]): Array<[string, string]> =>
  diagnosticsUnder(version, body)
    .filter(d => d.severity === undefined || d.upgrade === true)
    .map(d => [d.code, d.severity ?? 'error']);

const ORG = '  org = write crm-[:companies]-> { name: "Acme" }';
const PICK = '  pick = write crm-[:companies]-> { name: "Beta" }';
const PERSON = '  per = write crm-[:people]-> { name: "Ann" }';

describe.each<LanguageVersion>([3, 4, 5])('writing in place to a value that may be one of several records (version %i)', version => {
  it('one of two write handles of one type is that type: a field it has is written', () => {
    expect(errorsUnder(version, [ORG, PICK, '  v = COALESCE(pick, org)', '  write v { name: "B" }'])).toEqual([]);
    expect(errorsUnder(version, [ORG, PICK, '  c = 1 > 0', '  v = IF c THEN pick ELSE org END', '  write v { name: "B" }'])).toEqual([]);
  });

  it('one of two write handles of one type is that type: a field it has not is refused', () => {
    const unknown = [['MOV_WRITE_UNKNOWN_FIELD', "a crm.company handle has no field 'nope' — it has: name, size"]];
    expect(errorsUnder(version, [ORG, PICK, '  v = COALESCE(pick, org)', '  write v { nope: 1 }'])).toEqual(unknown);
    expect(errorsUnder(version, [ORG, PICK, '  c = 1 > 0', '  v = IF c THEN pick ELSE org END', '  write v { nope: 1 }'])).toEqual(unknown);
  });

  it('one of two records of different types is a record nobody can name, and nothing is refused', () => {
    expect(errorsUnder(version, [ORG, PERSON, '  v = COALESCE(per, org)', '  write v { name: "B" }'])).toEqual([]);
  });

  it('a walked record or a write handle is a record nobody can name, and nothing is refused', () => {
    expect(errorsUnder(version, ['  crm-[a:companies]-> {', `  ${ORG}`, '    v = COALESCE(a, org)', '    write v { nope: "B" }', '  }'])).toEqual([]);
  });

  it('a record or a value is no record to update in place', () => {
    expect(errorsUnder(version, [ORG, '  v = COALESCE(org, "x")', '  write v { name: "B" }'])).toEqual([
      [
        'MOV_WRITE_POSITION_NOT_RECORD',
        "'v' is a value that may hold something other than one record — 'write v { … }' updates an already-identified record in place, so it needs a record: a traversal alias, a prior write result, or a record picked from either",
      ],
    ]);
  });

  it('a record or nothing may be empty, and is no record to update in place', () => {
    const found = errorsUnder(version, [ORG, '  c = 1 > 0', '  v = IF c THEN org ELSE NULL END', '  write v { name: "B" }']);
    expect(found.map(([code]) => code)).toEqual(['MOV_WRITE_POSITION_NOT_RECORD']);
  });
});

/** What a refusal that is new under 5 is, under `version`. */
const typedRead = (version: LanguageVersion): string => (version >= 5 ? 'error' : 'warning');

describe.each<LanguageVersion>([3, 4, 5])('reading off one of several records (version %i)', version => {
  const notes = (value: string) => [ORG, PICK, '  c = 1 > 0', '  v = IF c THEN pick ELSE org END', `  write crm-[:companies]-> { ${value} }`];

  it('a field of records of one type is typed: COALESCE(pick, org).name is text', () => {
    expect(refusedFrom5(version, notes('name: COALESCE(pick, org).name'))).toEqual([]);
    expect(refusedFrom5(version, notes('size: COALESCE(pick, org).name'))).toEqual([['MOV_WRITE_FIELD_TYPE', typedRead(version)]]);
  });

  it('an IF of records of one type is that type, and a field it has not is refused', () => {
    expect(refusedFrom5(version, notes('name: v.name'))).toEqual([]);
    expect(refusedFrom5(version, notes('name: v.nope'))).toEqual([['MOV_UNKNOWN_PROPERTY', typedRead(version)]]);
  });

  it('records of different types stay a union: nothing is said of a field off it', () => {
    expect(refusedFrom5(version, [ORG, PERSON, '  write crm-[:companies]-> { size: COALESCE(per, org).nope }'])).toEqual([]);
  });
});
