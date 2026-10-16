// Language version 5's semantics the spelling rewrite alone cannot carry
// (plans/naming-rethink-2026-10-14/5_design.md): old spellings in imported
// libraries and in block closures nested in expressions; a name that hides a
// built-in; plugins by their exact-case names and package tags. Each under 4
// as before. The Rust checker's twin is crates/movement-checker/tests/v5_scope.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog } from '../catalog';
import type { ResolveFile } from '../link';

const catalog = mockCatalog({});

function check(source: string, languageVersion: number, resolveFile?: ResolveFile): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, {
    languageVersion,
    ...(resolveFile ? { resolveFile } : {}),
  });
}

const spellings = (found: Diagnostic[]): Diagnostic[] => found.filter((d) => d.code === 'MOV_V5_SPELLING');

describe("a library's old spellings", () => {
  const root = 'import { helper } from "lib/a"\nfunction go(t: <text>) {\n  x = helper(t)\n}';

  it('are reported at the import, prefixed by its path and line, without its fix', () => {
    const files: Record<string, string> = { 'lib/a': 'export function helper(t: <text>) {\n  return UPPER(t)\n}' };
    const found = spellings(check(root, 5, (path) => (files[path] !== undefined ? { source: files[path] } : undefined)));
    expect(found).toEqual([
      {
        code: 'MOV_V5_SPELLING',
        message: '"lib/a" line 2: `UPPER` is written `Text.upper` from language version 5',
        span: { start: { line: 1, col: 1 }, end: { line: 1, col: 31 } },
      },
    ]);
  });

  it("of a library's library are reported at the root import, both paths named", () => {
    const files: Record<string, string> = {
      'lib/a': 'import { inner } from "lib/b"\nexport function helper(t: <text>) {\n  return inner(t)\n}',
      'lib/b': 'export function inner(t: <text>) {\n  return LOWER(t)\n}',
    };
    const found = spellings(check(root, 5, (path) => (files[path] !== undefined ? { source: files[path] } : undefined)));
    expect(found.map((d) => d.message)).toEqual([
      '"lib/a" line 1: "lib/b" line 2: `LOWER` is written `Text.lower` from language version 5',
    ]);
  });

  it('are not findings under 4', () => {
    const lib = 'export movement helper(t: <text>) {\n  return UPPER(t)\n}';
    const v4root = 'import { helper } from "lib/a"\nmovement go(t: <text>) {\n  x = helper(t)\n}';
    expect(spellings(check(v4root, 4, (path) => (path === 'lib/a' ? { source: lib } : undefined)))).toEqual([]);
  });
});

describe('a block closure nested in an expression', () => {
  it("has its statements' old spellings reported under 5", () => {
    const source =
      'function go(xs) {\n  if (count(filter(xs, (r) => {\n    return LENGTH(r) > 0\n  })) > 0) {\n    y = 1\n  }\n}';
    const found = spellings(check(source, 5));
    expect(found.map((d) => [d.message, d.span.start])).toEqual([
      ['`LENGTH` is written `Text.length` from language version 5', { line: 3, col: 12 }],
    ]);
  });

  it('has none under 4', () => {
    const source =
      'movement go(xs) {\n  if COUNT(FILTER(xs, (r) => {\n    return LENGTH(r) > 0\n  })) > 0 {\n    y = 1\n  }\n}';
    expect(spellings(check(source, 4))).toEqual([]);
  });
});
