// `...m.k`, a record held under a map's key spread into a write: the fields
// it writes are the record's where the program spells them out (a
// `node { … }` literal), and an `extractOne` answer, which may be absent, is
// no such record (MOV_WRITE_SPREAD_SOURCE): `positionTypeOf` reads the held
// value's type as it is. Every version. The Rust twin is
// crates/movement-checker/tests/spread_held_record.rs, same programs.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { fromCatalogSnapshot } from '../../service/snapshot';

const CATALOG = fromCatalogSnapshot(JSON.parse('{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"note":{"properties":{"body":"text","title":"text","payload":"json"},"edges":{}}},"collections":{"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text","title":"text","payload":"json"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}'));

function codes(body: string, version: 3 | 4 | 5): string[] {
  const source = [
    'import { attio } from adapters',
    'import { crm_cred } from credentials',
    version < 5 ? 'crm = attio(credentials: crm_cred)' : 'crm = connect attio using crm_cred',
    'node Note: "the note" {',
    '  body: <text> "a body"',
    '}',
    `${version < 5 ? 'movement' : 'function'} go(t: <text>) {`,
    body,
    '}',
    '',
  ].join('\n');
  return checkProgram(parseProgram(source, { languageVersion: version }), CATALOG, { languageVersion: version })
    .filter((d) => d.severity === undefined)
    .map((d) => d.code);
}

describe('a record held under a key, spread into a write', () => {
  it.each([3, 4, 5] as const)('refuses a held extractOne answer as a spread source (version %i)', (version) => {
    expect(codes('  d = extractOne([t], Note)\n  held = { k: d }\n  write crm-[:notes]-> { ...held.k }', version)).toEqual(['MOV_WRITE_SPREAD_SOURCE']);
  });

  it.each([3, 4, 5] as const)("spreads a held node literal's fields (version %i)", (version) => {
    expect(codes('  n = node { body: t }\n  held = { k: n }\n  write crm-[:notes]-> { ...held.k }', version)).toEqual([]);
  });
});
