// A walk inside an EXPRESSION (`count(found-[c:co]->)`, `exists(found-[:deals]->)`,
// a hop read in a write field, an interpolation) off a name that may hold no
// record fails the run at the hop when the record is absent, as a block's
// walk does (v5_walk_off_absent). From version 5 the checker refuses it
// (MOV_ABSENT_REQUIRED) until a `!= null` guard proves the record there;
// versions 1–4 keep it, and a move up across 5 is warned of. `exists(found)`
// has no hop and answers false for an absent record, so it is no walk. The
// Rust twin is crates/movement-checker/tests/v5_expression_walk_off_absent.rs,
// same programs, same messages.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { fromCatalogSnapshot } from '../../service/snapshot';
import type { LanguageVersion } from '../../language_version';

const CATALOG = fromCatalogSnapshot(JSON.parse('{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"edges":{"deals":{"target":"deal"}}},"deal":{"properties":{"title":"text","amount":"number"},"edges":{}},"note":{"properties":{"body":"text","title":"text","payload":"json"},"edges":{}}},"collections":{"companies":{"target":"company"},"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text","title":"text","payload":"json"},"resultShape":{"externalId":"text"}},"company":{"fields":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"resultShape":{"externalId":"text","name":"text"},"fuzzyResolution":true}},"supportsInPlaceUpdate":true}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}'));

const spelled = (version: LanguageVersion, text: string): string =>
  version < 5 ? text.replace(/\bcount\(/g, 'COUNT(').replace(/\bexists\(/g, 'EXISTS(') : text;

function found(body: string, version: LanguageVersion, upgradingFrom?: LanguageVersion): Array<[string, string, string]> {
  const source = [
    'import { attio } from adapters',
    'import { crm_cred } from credentials',
    version < 5 ? 'crm = attio(credentials: crm_cred)' : 'crm = connect attio using crm_cred',
    'node Found: "the companies named" {',
    '  node co: "each company" {',
    '    name: <text> "its name"',
    '  }',
    '}',
    `${version < 5 ? 'movement' : 'function'} go(t: <text>) {`,
    '  found = extractOne([t], Found)',
    spelled(version, body),
    '}',
    '',
  ].join('\n');
  return checkProgram(parseProgram(source, { languageVersion: version }), CATALOG, {
    languageVersion: version,
    ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
  })
    .filter((d) => d.code === 'MOV_ABSENT_REQUIRED')
    .map((d) => [d.code, d.severity === undefined ? 'error' : 'warning', d.message]);
}

const refused = (name: string): [string, string, string] => [
  'MOV_ABSENT_REQUIRED',
  'error',
  `'${name}' may be absent, and a walk inside an expression off a record that is not there fails the run. Guard the walk: 'if (${name} != null) { … }'. (see handbook: front#maybe-absent)`,
];

const POSITIONS: Record<string, string> = {
  'an aggregate': '  n = count(found-[c:co]->)',
  'an exists with a hop': '  has = exists(found-[c:co]->)',
  'a hop read in a write field': '  write crm-[:notes]-> { body: found-[c:co]->.name }',
  'an aggregate in a write field': '  write crm-[:notes]-> { body: count(found-[c:co]->) }',
  'an interpolation': '  write crm-[:notes]-> { body: "n: ${count(found-[c:co]->)}" }',
  'a condition': '  if (count(found-[c:co]->) > 0) {\n    write crm-[:notes]-> { body: "some" }\n  }',
};

describe('an expression walking off a record that may be absent', () => {
  for (const [position, body] of Object.entries(POSITIONS)) {
    it(`under 5, ${position} is refused unguarded and passes guarded`, () => {
      expect(found(body, 5)).toEqual([refused('found')]);
      expect(found(`  if (found != null) {\n${body}\n  }`, 5)).toEqual([]);
    });

    it(`under 3 and 4, ${position} is kept, and a move up across 5 is warned of`, () => {
      for (const version of [3, 4] as const) expect(found(body, version)).toEqual([]);
      const warned = found(body, 5, 4);
      expect(warned).toHaveLength(1);
      expect(warned[0][1]).toBe('warning');
      expect(warned[0][2].startsWith(`since "Dancing Wren" (5) a walk inside an expression off 'found', which may be absent, is refused`)).toBe(true);
    });
  }

  it('exists of the name alone has no hop and is no walk', () => {
    expect(found('  has = exists(found)', 5)).toEqual([]);
  });

  it('a name proven present by an and-guard is walked freely', () => {
    expect(found('  ok = found != null and count(found-[c:co]->) > 0', 5)).toEqual([]);
  });
});
