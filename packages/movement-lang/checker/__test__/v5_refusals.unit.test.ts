// From version 5 the checker refuses at save the forms the engine does not
// run, each with the spelling it does run: a linked write or match whose
// target walks more than one hop (MOV_WRITE_MULTI_HOP), a walk with no root
// outside a hop's WHERE (MOV_WALK_ROOTLESS), and a `unique by` on a write to a
// declared node (MOV_WRITE_SHAPE_UNIQUE). `_resources` reads off an
// extraction call's result as off the keyword's. Versions 1–4 are unchanged.
// The Rust twin is crates/movement-checker/tests/v5_refusals.rs, same
// programs, same messages.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { fromCatalogSnapshot } from '../../service/snapshot';
import type { LanguageVersion } from '../../language_version';

const CATALOG = fromCatalogSnapshot(JSON.parse('{"contractVersion":1,"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{"deals":{"target":"deal"},"notes":{"target":"note","writable":true}}},"deal":{"properties":{"title":"text"},"edges":{}},"note":{"properties":{"body":"text"},"edges":{}}},"collections":{"companies":{"target":"company"},"notes":{"target":"note"}},"writableRoots":{"note":{"fields":{"body":"text"},"resultShape":{"externalId":"text"}},"company":{"fields":{"name":"text"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}'));

const CODES = [
  'MOV_WRITE_MULTI_HOP',
  'MOV_WALK_ROOTLESS',
  'MOV_WRITE_SHAPE_UNIQUE',
  'MOV_RESOURCES_NOT_EXTRACTED',
  'MOV_KG_QUERY_RETIRED',
  'MOV_AWAIT_ON_LIST',
  'MOV_WRITE_LINK_FIELD',
  'MOV_WRITE_LINK_FIELD_NUDGE',
  'MOV_JSON_HAS_NO_EDGES',
];

function found(body: string, version: LanguageVersion): Array<[string, number, string]> {
  const source = [
    'import { attio } from adapters',
    'import { crm_cred } from credentials',
    version < 5 ? 'crm = attio(credentials: crm_cred)' : 'crm = connect attio using crm_cred',
    'node Note {',
    '  title: <text>',
    '}',
    `${version < 5 ? 'movement' : 'function'} go(t: <text>, j: <json>) {`,
    body,
    '}',
    '',
  ].join('\n');
  return checkProgram(parseProgram(source, { languageVersion: version }), CATALOG, { languageVersion: version })
    .filter((d) => CODES.includes(d.code))
    .map((d) => [d.code, d.span.start.line, d.message]);
}

const codes = (body: string, version: LanguageVersion) => found(body, version).map(([code]) => code);

describe('version 5 refuses the forms the engine does not run', () => {
  it('a linked write or match walks one hop', () => {
    expect(found('  write crm-[:companies]->-[:notes]-> { body: t }', 5)).toEqual([
      [
        'MOV_WRITE_MULTI_HOP',
        8,
        "a write target walks exactly one edge, from the record it starts at — 'crm-[:companies]->-[:notes]->' walks 2 hops. Walk to the parent in a block, then write off its alias: 'parent-[p:…]-> { write p-[:notes]-> { … } }'",
      ],
    ]);
    expect(codes('  found = match crm-[:companies]->-[:notes]-> { unique by (`body`), body: t }', 5)).toEqual(['MOV_WRITE_MULTI_HOP']);
    // The spelling it names runs, and so does one hop.
    expect(codes('  crm-[c:companies]-> {\n    write c-[:notes]-> { body: t }\n  }', 5)).toEqual([]);
    expect(codes('  write crm-[:notes]-> { body: t }', 5)).toEqual([]);
    expect(codes('  write crm-[:companies]->-[:notes]-> { body: t }', 4)).toEqual([]);
  });

  it('a walk starts at a record it names', () => {
    expect(found('  -[c:companies]-> {\n    x = 1\n  }', 5)).toEqual([
      ['MOV_WALK_ROOTLESS', 8, "'-[c:companies]->' has no root, so nothing says which record it walks from — name the record it starts at: 'x-[c:companies]->'"],
    ]);
    expect(found('  x = exists(-[:notes]->)', 5)).toEqual([
      [
        'MOV_WALK_ROOTLESS',
        8,
        "'-[:notes]->' has no root, so nothing says which record it walks from — name the record it starts at ('x-[:notes]->'). Only inside a hop's WHERE does 'exists(-[:notes]->)' walk from a record: the one that hop lands on",
      ],
    ]);
    expect(codes('  if (exists(-[n:notes WHERE n.body == t]->)) {\n    x = 1\n  }', 5)).toEqual(['MOV_WALK_ROOTLESS']);
    expect(codes('  x = count(-[:notes]->)', 5)).toEqual(['MOV_WALK_ROOTLESS']);
    expect(codes('  f = () => exists(-[:notes]->)', 5)).toEqual(['MOV_WALK_ROOTLESS']);
    // Inside a hop's WHERE a rootless EXISTS walks off the record the hop lands on.
    expect(codes('  crm-[c:companies WHERE exists(-[:deals]->)]-> {\n    write crm-[:notes]-> { body: c.name }\n  }', 5)).toEqual([]);
    expect(codes('  x = exists(crm-[c:companies WHERE exists(-[:deals]->)]->)', 5)).toEqual([]);
    // Versions 1–4 keep their own reading.
    expect(codes('  -[c:companies]-> {\n    x = 1\n  }', 4)).toEqual([]);
    expect(codes('  x = EXISTS(-[:notes]->)', 4)).toEqual([]);
  });

  it('a write to a declared node finds nothing by unique by', () => {
    expect(found('  n = write Note-[:item]-> { unique by (`title`), title: t }', 5)).toEqual([
      [
        'MOV_WRITE_SHAPE_UNIQUE',
        8,
        "'unique by' has no meaning on a write to the declared node 'Note' — the record it makes lands in memory, so there is no store to find an existing one in. Drop the 'unique by' clause (or synthesise the record, 'node { title: … }')",
      ],
    ]);
    expect(codes('  n = write Note-[:item]-> { unique by (`title`), title: t }', 4)).toEqual([]);
  });

  it("resources read off an extraction call's result", () => {
    const extractOne =
      '  d = extractOne([t], node D: "the company" { name: <text> "a name" })\n  if (d != null) {\n    d-[f:_resources]-> {\n      write crm-[:notes]-> { body: f.content }\n    }\n  }';
    expect(found(extractOne, 5)).toEqual([]);
    const extract =
      '  found = extract([t], node D: "each company" { name: <text> "a name" })\n  found-[f:_resources]-> {\n    write crm-[:notes]-> { body: f.content }\n  }';
    expect(found(extract, 5)).toEqual([]);
    // A system's record still reaches its files over an edge it declares.
    expect(codes('  crm-[c:companies]-> {\n    c-[f:_resources]-> {\n      x = 1\n    }\n  }', 5)).toEqual(['MOV_RESOURCES_NOT_EXTRACTED']);
  });

  it('a knowledge graph query text is retired', () => {
    expect(found('  x = KG_VALUE("MATCH (n) RETURN n")', 5)).toEqual([
      [
        'MOV_KG_QUERY_RETIRED',
        8,
        "'KG_VALUE(…)' is retired — it ran a query text against the knowledge graph, and no engine runs one from version 5. Walk the graph instead: connect it ('kg = connect graph'), then read along its edges ('kg-[c:Company WHERE …]->')",
      ],
    ]);
    expect(codes('  if (KG_EXISTS("MATCH (n) RETURN n")) {\n    x = 1\n  }', 5)).toEqual(['MOV_KG_QUERY_RETIRED']);
    expect(codes('  x = KG_VALUE("MATCH (n) RETURN n")', 4)).toEqual([]);
  });

  it('an await parks on one record', () => {
    expect(found('  xs = crm-[c:companies]-> {\n    return c\n  }\n  w = await first(xs-[d:deals]->)', 5)).toEqual([
      [
        'MOV_AWAIT_ON_LIST',
        11,
        "'await' parks on one record, under one key, and 'xs' holds a list of records — there is no one record to wait at. Await on one record a name holds: 'await first(rec-[d:deals]->)'",
      ],
    ]);
  });

  it("a record is not a relationship's value", () => {
    const body = '  d = write crm-[:notes]-> { body: t }\n  write crm-[:companies]-> { name: t, deals: d }';
    expect(found(body, 5)).toEqual([
      [
        'MOV_WRITE_LINK_FIELD',
        9,
        "'deals' is a relationship of crm.company, and a record is not written into it as a value — connect 'd' structurally: write off it ('write d-[:…]-> { … }'), or link the two after the write ('link … -[:deals]-> d')",
      ],
    ]);
    expect(codes(body, 4)).toEqual(['MOV_WRITE_LINK_FIELD_NUDGE']);
  });

  it('a json value has no relationships', () => {
    expect(found('  n = count(j-[:subs]->)', 5)).toEqual([
      [
        'MOV_JSON_HAS_NO_EDGES',
        8,
        "'j' holds a json value, and a json value has no relationships — '-[:subs]->' walks nothing. Read a key with a dot ('j.key'), or walk the record the value came from",
      ],
    ]);
    expect(codes('  j-[s:subs]-> {\n    x = 1\n  }', 5)).toEqual(['MOV_JSON_HAS_NO_EDGES']);
    expect(codes('  n = count(j-[:subs]->)', 4)).toEqual([]);
  });

  it('a built-in call on a line by itself parses, and is reported as a value nothing reads', () => {
    const diagnostics = checkProgram(
      parseProgram('function go(t: <text>) {\n  Text.upper(t)\n}\n', { languageVersion: 5 }),
      CATALOG,
      { languageVersion: 5 },
    );
    expect(diagnostics.map((d) => [d.code, d.span.start.line])).toEqual([['MOV_BUILTIN_UNUSED', 2]]);
  });
});
