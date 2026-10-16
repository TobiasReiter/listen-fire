// `write v { … }` where `v` is bound to an IF or a COALESCE whose arms have no
// one type: `v` is read by what it may hold, as a graph entry and `delete`
// read it. Records alone are one record (`A | B` of two `Org`s is an `Org`) —
// that record when the arms agree on where it starts, unnamed (so nothing is
// refused) when they do not, as two write handles never do; one that may be
// absent may be empty,
// and is no record to update in place; a value among them is no record at all.
// It was once the checker's own internal error (MOV_INTERNAL_UNTYPED_BINDING).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    person: { properties: { name: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, people: { target: 'person' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
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

const errorsUnder = (version: LanguageVersion, body: string[]): Array<[string, string]> => {
  const source = `${PRELUDE}\nmovement m() {\n${body.join('\n')}\n}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version })
    .filter((d: Diagnostic) => (d.severity ?? 'error') === 'error')
    .map(d => [d.code, d.message]);
};

const ORG = '  org = write crm-[:companies]-> { name: "Acme" }';
const PICK = '  pick = write crm-[:companies]-> { name: "Beta" }';
const PERSON = '  per = write crm-[:people]-> { name: "Ann" }';

describe.each<LanguageVersion>([3, 4, 5])('writing in place to a value that may be one of several records (version %i)', version => {
  it('one of two write handles is a record nobody can name, and nothing is refused', () => {
    expect(errorsUnder(version, [ORG, PICK, '  v = COALESCE(pick, org)', '  write v { name: "B" }'])).toEqual([]);
    expect(errorsUnder(version, [ORG, PICK, '  c = 1 > 0', '  v = IF c THEN pick ELSE org END', '  write v { name: "B" }'])).toEqual([]);
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
