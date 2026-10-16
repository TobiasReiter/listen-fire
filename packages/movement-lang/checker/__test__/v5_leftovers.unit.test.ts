// Checker leftovers of the v5 surface, held in both checkers (the Rust one
// through the wasm build, on the same catalog): a three-argument `map`'s
// settings go last; the `#transform` retirement suggests a positional call;
// `Text.lower` inside walk brackets is one finding, not two; and a field read
// off text is refused from 5 and warned before (both engines read null).

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
});
