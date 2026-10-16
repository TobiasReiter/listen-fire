// A block whose head walks off a name that may hold no record — an
// `extractOne` answer, a `match` that found nothing — fails the run at the
// head when the record is absent (it does not run zero times), on every
// version, and runs when it is there. From version 5 the checker refuses it
// (MOV_ABSENT_REQUIRED) until a `!= null` guard proves the record there;
// versions 1–4 keep it, and a move up across 5 is warned of. The Rust twin is
// crates/movement-checker/tests/v5_walk_off_absent.rs, same programs, same
// messages.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { fromCatalogSnapshot } from '../../service/snapshot';
import type { LanguageVersion } from '../../language_version';

const CATALOG = fromCatalogSnapshot(JSON.parse('{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"edges":{"deals":{"target":"deal"}}},"deal":{"properties":{"title":"text","amount":"number"},"edges":{}},"note":{"properties":{"body":"text","title":"text","payload":"json"},"edges":{}}},"collections":{"companies":{"target":"company"},"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text","title":"text","payload":"json"},"resultShape":{"externalId":"text"}},"company":{"fields":{"name":"text","stage":"text","domain":"text","summary":"text","employees":"number"},"resultShape":{"externalId":"text","name":"text"},"fuzzyResolution":true}},"supportsInPlaceUpdate":true}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}'));

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
    body,
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
  `'${name}' may be absent, and a block's walk off a record that is not there fails the run rather than running zero times. Guard the walk: 'if (${name} != null) { … }'. (see handbook: front#maybe-absent)`,
];

const EXTRACTED = '  found = extractOne([t], Found)\n  found-[c:co]-> {\n    write crm-[:notes]-> { body: c.name }\n  }';
const MATCHED = '  co = match crm-[:companies]-> { unique by (`name`), name: t }\n  co-[d:deals]-> {\n    write crm-[:notes]-> { body: d.title }\n  }';

describe('a block walking off a record that may be absent', () => {
  it('under 5, an extractOne answer or a match walked unguarded is refused', () => {
    expect(found(EXTRACTED, 5)).toEqual([refused('found')]);
    expect(found(MATCHED, 5)).toEqual([refused('co')]);
  });

  it('under 5, an expression root that may be absent is refused, asking for a name', () => {
    expect(found('  rows = [extractOne([t], Found)]\n  rows[0]-[c:co]-> {\n    write crm-[:notes]-> { body: c.name }\n  }', 5)).toEqual([
      [
        'MOV_ABSENT_REQUIRED',
        'error',
        "'rows[0]' may be absent, and a block's walk off a record that is not there fails the run rather than running zero times. Guard the walk: 'x = rows[0]', then 'if (x != null) { … }'. (see handbook: front#maybe-absent)",
      ],
    ]);
  });

  it('under 5, a guard proves the record there', () => {
    expect(found('  found = extractOne([t], Found)\n  if (found != null) {\n    found-[c:co]-> {\n      write crm-[:notes]-> { body: c.name }\n    }\n  }', 5)).toEqual([]);
    expect(found('  co = match crm-[:companies]-> { unique by (`name`), name: t }\n  if (co != null) {\n    co-[d:deals]-> {\n      write crm-[:notes]-> { body: d.title }\n    }\n  }', 5)).toEqual([]);
  });

  it('versions 1–4 keep the form, and a move up across 5 is warned of', () => {
    for (const version of [3, 4] as const) {
      expect(found(EXTRACTED, version)).toEqual([]);
      expect(found(MATCHED, version)).toEqual([]);
    }
    const warned = found(EXTRACTED, 5, 4);
    expect(warned).toHaveLength(1);
    expect(warned[0][1]).toBe('warning');
    expect(warned[0][2].startsWith(`since "Dancing Wren" (5) a block's walk off 'found', which may be absent, is refused`)).toBe(true);
  });
});
