// A file-level value from version 5 (MOV_FILE_VALUE_RUNS): the file's values
// are worked out before every run of every function in it, with no event in
// scope, and again on every resume, so a value there holds a value only — a
// literal, a built-in's value, a closure, a construction. A call to a function
// or a plugin (written whole or nested in the value), a write, a walk, a wait
// or a node is refused at save, as the engines refuse it at run time. Before 5
// the save scan refused the same forms (interpretable.ts). The Rust checker's
// twin is crates/movement-checker/tests/file_value.rs.

import { parseProgram } from '../../parser/parse';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import { checkProgram } from '../check';

const SNAPSHOT = {
  adapters: {
    kg: {
      constructionArgs: [],
      schemas: {
        '': {
          positions: { note: { properties: { text: 'text' }, edges: {} } },
          collections: { notes: { target: 'note' } },
          writableRoots: { note: { fields: { text: 'text' }, resultShape: { externalId: 'text' } } },
        },
      },
    },
  },
  credentials: {},
  plugins: { echo: { args: ['q'], requiredArgs: ['q'], output: { kind: 'value', type: 'text' } } },
} as unknown as CatalogSnapshot;

function check(lines: string[], version = 5, library?: string) {
  const source = ['import { kg } from adapters', 'import { echo } from plugins', 'graph = connect kg', ...lines].join('\n');
  return checkProgram(parseProgram(source, { languageVersion: version }), fromCatalogSnapshot(SNAPSHOT), {
    languageVersion: version,
    ...(library !== undefined ? { resolveFile: (path: string) => (path === 'lib/vals' ? { source: library } : undefined) } : {}),
  });
}

const found = (lines: string[], version = 5) => check(lines, version).map(d => [d.code, d.span.start.line]);

describe('MOV_FILE_VALUE_RUNS', () => {
  it.each([
    ['a plugin call', ['p = echo("x")']],
    ['a plugin call nested in a value', ['said = { page: echo("x") }']],
    ['a function call', ['function f(n: <number>) {', '  return n', '}', 'x = f(1)']],
    ['a closure call', ['g = (n: <number>) => n + 1', 'x = g(1)']],
    ['a write', ['w = write graph-[:notes]-> { text: "x" }']],
    ['a node', ['n = node { a: 1 }']],
  ])('refuses %s', (_what, lines) => {
    expect(found(lines).filter(([code]) => code === 'MOV_FILE_VALUE_RUNS')).toEqual([['MOV_FILE_VALUE_RUNS', lines.length + 3]]);
  });

  it('says what the value holds', () => {
    const [d] = check(['said = { page: echo("x") }']).filter(x => x.code === 'MOV_FILE_VALUE_RUNS');
    expect(d?.message).toBe(
      "'said' is a file-level value, worked out before every run with no event in scope, so it holds a value only — not a call to 'echo'. Do it inside the function that uses it.",
    );
  });

  it.each([
    ['a literal', ['n = { a: 1, b: [2, 3] }']],
    ["a built-in's value", ['n = coalesce(null, "x")']],
    ['a closure that calls a plugin when it is called', ['f = (q: <text>) => echo(q)']],
  ])('accepts %s', (_what, lines) => {
    expect(found(lines)).toEqual([]);
  });

  it('refuses one in a library, at the import', () => {
    const library = ['import { echo } from plugins', 'said = echo("x")', 'export function f(n: <number>) {', '  return n', '}'].join('\n');
    const codes = check(['import { f } from "lib/vals"'], 5, library).map(d => [d.code, d.message.slice(0, 18)]);
    expect(codes).toEqual([['MOV_FILE_VALUE_RUNS', '"lib/vals" line 2:']]);
  });

  it('says nothing under version 4', () => {
    const before = ['import { kg } from adapters', 'import { echo } from plugins', 'graph = kg()', 'p = echo(q: "x")'].join('\n');
    const diagnostics = checkProgram(parseProgram(before, { languageVersion: 4 }), fromCatalogSnapshot(SNAPSHOT), { languageVersion: 4 });
    expect(diagnostics.map(d => d.code)).not.toContain('MOV_FILE_VALUE_RUNS');
  });
});
