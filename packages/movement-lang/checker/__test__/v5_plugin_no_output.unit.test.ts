// From version 5 a plugin whose manifest declares no output is called only as
// a statement, run for its effects: its result used as a value is refused
// (MOV_PLUGIN_OUTPUT_UNDECLARED), the message telling the plugin's author to
// declare an output. Both checkers, on the same catalog (the Rust one through
// the wasm build); the engines' half is apps/api's v5_plugin_call test.

import { mockCatalog } from '../catalog';
import { checkProgram, type Diagnostic } from '../check';
import { parseProgram } from '../../parser/parse';
import { mockCatalogSnapshot } from '../../service/snapshot';
import { checkSourceInRust } from '../rust_checker';
import type { LanguageVersion } from '../../language_version';

const spec: Parameters<typeof mockCatalog>[0] = {
  adapters: {},
  credentials: {},
  plugins: {
    lookup: { args: ['q'], argTypes: { q: 'text' }, requiredArgs: ['q'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
    enrich: { args: ['q'], argTypes: { q: 'text' }, requiredArgs: ['q'], effects: { ai: true } },
  },
};
const catalog = mockCatalog(spec);
const snapshot = mockCatalogSnapshot(spec);

const V5 = (body: string): string =>
  `import { lookup, enrich } from plugins\nfunction m(t: <text>) {\n${body}\n}\nfunction g(x: <text>) {\n  return x\n}\n`;

const errors = (found: Diagnostic[]): string[] =>
  found.filter((d) => (d.severity ?? 'error') === 'error' && d.code !== 'MOV_LISTEN_MISSING').map((d) => `${d.code}: ${d.message}`);

/** What both checkers refuse in `source` under `version` — the same, or the test fails. */
function check(source: string, version: LanguageVersion = 5): string[] {
  const ts = errors(checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }));
  const rust = errors(checkSourceInRust(source, snapshot, { languageVersion: version }));
  expect(rust).toEqual(ts);
  return ts;
}

const REFUSED =
  "MOV_PLUGIN_OUTPUT_UNDECLARED: 'enrich' is a plugin whose manifest declares no output, so its call hands nothing back to use — call it as a statement, on a line of its own, to run it for its effects. To use what it finds, the plugin's author declares an output in its manifest.";

describe('a plugin that declares no output, under version 5', () => {
  it.each(['  enrich(t)', '  f = (q: <text>) => {\n    enrich(q)\n  }', '  each = map([t], (q) => {\n    enrich(q)\n    return q\n  })'])(
    'runs as a statement: %s',
    (body) => {
      expect(check(V5(body))).toEqual([]);
    },
  );

  it.each([
    '  e = enrich(t)',
    '  return enrich(t)',
    '  n = Text.upper(enrich(t))',
    '  s = "a ${enrich(t)}"',
    '  y = coalesce(enrich(t), "z")',
    '  g(enrich(t))',
    '  b = g(enrich(t))',
    '  xs = map([t], (q) => enrich(q))',
    '  xs = map([t], (q) => { return enrich(q) })',
    '  r = lookup(enrich(t))',
  ])('is refused where its value is used: %s', (body) => {
    expect(check(V5(body))).toEqual([REFUSED]);
  });

  it('a plugin that declares an output is used as a value as before', () => {
    expect(check(V5('  e = lookup(t)\n  n = Text.upper(lookup(t))'))).toEqual([]);
  });
});
