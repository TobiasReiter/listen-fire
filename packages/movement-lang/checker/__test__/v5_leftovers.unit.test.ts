// Checker leftovers of the v5 surface, held in both checkers (the Rust one
// through the wasm build, on the same catalog): a three-argument `map`'s
// settings go last; the `#transform` retirement suggests a positional call;
// `Text.lower` inside walk brackets is one finding, not two; and a field read
// off text, a number or a true/false value is refused from 5 and warned
// before (both engines read null).

import { mockCatalog } from '../catalog';
import { checkProgram, diagnosticSeverity, type Diagnostic } from '../check';
import { parseProgram } from '../../parser/parse';
import { mockCatalogSnapshot } from '../../service/snapshot';
import { checkSourceInRust } from '../rust_checker';
import type { LanguageVersion } from '../../language_version';

const spec: Parameters<typeof mockCatalog>[0] = {
  adapters: {
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: {
          company: { properties: { name: 'text' }, edges: { notes: { target: 'note', readable: true } } },
          note: { properties: { title: 'text' }, edges: {} },
        },
        collections: { companies: { target: 'company' } },
        writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
      },
    },
  },
  credentials: { crm_cred: { adapter: 'attio' } },
  plugins: {
    lookup: { args: ['q', 'limit'], argTypes: { q: 'text', limit: 'number' }, requiredArgs: ['q'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
    // A plugin that declares no output: before 5 it ran only as an extraction's stage.
    enrich: { args: ['q'], argTypes: { q: 'text' }, requiredArgs: ['q'] },
  },
};
const catalog = mockCatalog(spec);
const snapshot = mockCatalogSnapshot(spec);

const V5 = (body: string): string =>
  `import { attio } from adapters\nimport { crm_cred } from credentials\nimport { lookup } from plugins\ncrm = connect attio using crm_cred\nfunction m(t: <text>, c: <crm-[:company]->>) {\n${body}\n}\n`;
const V4 = (body: string): string =>
  `import { attio } from adapters\nimport { crm_cred } from credentials\nimport { lookup } from plugins\ncrm = attio(credentials: crm_cred)\nmovement m(t: <text>, c: <crm-[:company]->>) {\n${body}\n}\n`;

type Said = { code: string; severity: string; message: string };
const said = (found: Diagnostic[]): Said[] =>
  found.filter((d) => d.code !== 'MOV_LISTEN_MISSING').map((d) => ({ code: d.code, severity: diagnosticSeverity(d), message: d.message }));

/** What both checkers say of `source` under `version` — the same, or the test fails. */
function check(source: string, version: LanguageVersion): Said[] {
  const ts = said(checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }));
  const rust = said(checkSourceInRust(source, snapshot, { languageVersion: version }));
  expect(rust).toEqual(ts);
  return ts;
}

describe('version 5 checker leftovers, in both checkers', () => {
  it("a three-argument map's settings go after the function", () => {
    const [d] = check(V5('  a = map([1, 2], (x) => x, 5)'), 5);
    expect(d?.code).toBe('MOV_BUILTIN_ARGS');
    expect(d?.message).toContain('after the function — `map(xs, f, { onError: "warn", concurrency: 4 })`');
    expect(d?.message).not.toContain('between');
    // Versions 1–4 keep their order, and their words.
    expect(check(V4('  a = MAP([1, 2], (x) => x, 5)'), 4)[0]?.message).toContain('between the collection and the function');
  });

  it('the #transform retirement suggests a positional call', () => {
    const [d] = check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "lookup" }]->'), 5);
    expect(d?.code).toBe('MOV_TRANSFORM_HOP_RETIRED');
    expect(d?.message).toContain("'out = lookup(q)'");
    expect(d?.message).not.toContain('q:');
  });

  it('no #transform retirement suggests the retired extraction stage', () => {
    const messages = [
      ...check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "lookup" }]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "enrich" }]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "nothing" }]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#transform]->'), 5),
      ...check(V5('  e = crm-[k:companies]->-[:#other]->'), 5),
    ].filter((d) => d.code.endsWith('_RETIRED'));
    expect(messages.length).toBeGreaterThanOrEqual(5);
    for (const { message } of messages) {
      expect(message).not.toContain('through');
      expect(message).not.toContain('extract from');
      expect(message).not.toMatch(/\w+: …/);
    }
    // A stage-only plugin is called like any other.
    expect(check(V5('  e = crm-[k:companies]->-[:#transform { plugin: "enrich" }]->'), 5)[0]?.message).toContain("'out = enrich(q)'");
  });

  it('Text.lower inside walk brackets is one finding, its fix LOWER', () => {
    const found = check(V5('  b = c-[n:notes WHERE Text.lower(n.title) == "x"]->'), 5);
    expect(found.map((d) => d.code)).toEqual(['MOV_V5_SPELLING']);
    expect(found[0]?.message).toContain('is written `LOWER`');
  });

  it('a field read off text is refused from 5, and warned under 3 and 4', () => {
    const body = '  d = t.Name\n  write crm-[:companies]-> { name: t.Name }';
    const five = check(V5(body), 5);
    expect(five.map((d) => [d.code, d.severity])).toEqual([
      ['MOV_TEXT_HAS_NO_FIELDS', 'error'],
      ['MOV_TEXT_HAS_NO_FIELDS', 'error'],
    ]);
    expect(five[0]?.message).toContain("'t' is text, and a text has no fields");
    for (const version of [3, 4] as const) {
      const older = check(V4(body), version);
      expect(older.map((d) => [d.code, d.severity])).toEqual([
        ['MOV_TEXT_HAS_NO_FIELDS', 'warning'],
        ['MOV_TEXT_HAS_NO_FIELDS', 'warning'],
      ]);
      expect(older[0]?.message).toContain('it reads null; from it, this is refused');
    }
    // A field read off a record is untouched.
    expect(check(V5('  d = c.name'), 5)).toEqual([]);
  });

  it('a field read off a number or a true/false value is refused from 5, and warned under 3 and 4', () => {
    // Both engines read either as null under 3 and 4, as they read text's.
    for (const [value, noun] of [['3', 'a number'], ['true', 'a true/false value']] as const) {
      const [five, ...rest] = check(V5(`  n = ${value}\n  d = n.size`), 5);
      expect(rest).toEqual([]);
      expect([five?.code, five?.severity]).toEqual(['MOV_TEXT_HAS_NO_FIELDS', 'error']);
      expect(five?.message).toContain(`'n' is ${noun}, and ${noun} has no fields — 'size' is not something it holds`);
      for (const version of [3, 4] as const) {
        const older = check(V4(`  n = ${value}\n  d = n.\`size\``), version);
        expect(older.map((d) => [d.code, d.severity])).toEqual([['MOV_TEXT_HAS_NO_FIELDS', 'warning']]);
        expect(older[0]?.message).toContain(`'n' is ${noun}`);
      }
    }
  });
});

// A slot can arrive without the tree its program's parse cached (a program
// rebuilt from stored JSON, a slot the checker builds itself); the checker
// then reads its text again, and must read it under the program's version.
describe('a version 5 slot read again is read under 5', () => {
  const body = [
    '  u = Text.upper(t)',
    '  xs = [t, u]',
    '  y = xs[0]',
    '  if (y == "a" && u != "b") {',
    '    z = sort(xs, (x) => x, { order: "desc" })',
    '  }',
  ].join('\n');

  it('a program whose slots lost their cached parse checks as the parsed one does', () => {
    const parsed = parseProgram(V5(body), { languageVersion: 5 });
    const rebuilt = structuredClone(parsed);
    const found = said(checkProgram(rebuilt, catalog, { languageVersion: 5 }));
    expect(found).toEqual(said(checkProgram(parsed, catalog, { languageVersion: 5 })));
    expect(found.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

// ORDER BY and LIMIT on a hop over records the run already holds were ignored
// by both engines before 5 and are read from 5, so a move up says so.
describe('an in-memory hop with ORDER BY or LIMIT, on a move up across 5', () => {
  const upgrade = (body: string, options: { languageVersion: LanguageVersion; upgradingFrom?: LanguageVersion }): Said[] => {
    const ts = said(checkProgram(parseProgram(V4(body), { languageVersion: options.languageVersion }), catalog, options));
    const rust = said(checkSourceInRust(V4(body), snapshot, options));
    expect(rust).toEqual(ts);
    return ts.filter((d) => d.code === 'MOV_IN_MEMORY_HOP_ORDER');
  };
  const GRAPH = '  g = graph { title: "t", parts: [{ label: "two", n: 2 }, { label: "one", n: 1 }] }\n';
  const NODE = '  d = node { title: "t", people: [node { name: "Cy", rank: 3 }, node { name: "Ann", rank: 1 }] }\n';

  it('warns a graph literal, a node literal and an expression hop', () => {
    const [d] = upgrade(`${GRAPH}  g-[p:parts ORDER BY p.n]-> {\n    x = p.label\n  }`, { languageVersion: 5, upgradingFrom: 4 });
    expect(d).toEqual({
      code: 'MOV_IN_MEMORY_HOP_ORDER',
      severity: 'warning',
      message: expect.stringContaining("the ORDER BY on '-[:parts]->' is read: the hop walks records the run already holds"),
    });
    expect(d?.message).toContain('Its result may change');
    const [both] = upgrade(`${NODE}  d-[p:people ORDER BY p.rank LIMIT 1]-> {\n    x = p.name\n  }`, { languageVersion: 5, upgradingFrom: 4 });
    expect(both?.message).toContain("the ORDER BY and LIMIT on '-[:people]->' are read");
    expect(upgrade(`${GRAPH}  xs = g-[p:parts LIMIT 1]->.label`, { languageVersion: 5, upgradingFrom: 4 })).toHaveLength(1);
    const extracted = '  x = extract from [t] {\n    node deals: "each deal" {\n      name: "the company name"\n    }\n  }\n';
    expect(upgrade(`${extracted}  x-[k:deals LIMIT 2]-> {\n    y = k.name\n  }`, { languageVersion: 5, upgradingFrom: 4 })).toHaveLength(1);
  });

  it('says nothing of a source hop, a hop without either, or a check that is no move up', () => {
    expect(upgrade('  c-[n:notes ORDER BY n.title]-> {\n    x = n.title\n  }', { languageVersion: 5, upgradingFrom: 4 })).toEqual([]);
    expect(upgrade(`${GRAPH}  g-[p:parts]-> {\n    x = p.label\n  }`, { languageVersion: 5, upgradingFrom: 4 })).toEqual([]);
    expect(upgrade(`${GRAPH}  g-[p:parts ORDER BY p.n]-> {\n    x = p.label\n  }`, { languageVersion: 4 })).toEqual([]);
    expect(upgrade(`${GRAPH}  g-[p:parts ORDER BY p.n]-> {\n    x = p.label\n  }`, { languageVersion: 5 })).toEqual([]);
  });
});
