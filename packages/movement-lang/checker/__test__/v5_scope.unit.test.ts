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

describe('a plugin', () => {
  const plugins = mockCatalog({ plugins: { fetch_url: { args: ['url'] } } });
  const checkWith = (source: string, languageVersion: number): Diagnostic[] =>
    checkProgram(parseProgram(source, { languageVersion }), plugins, { languageVersion });
  const codes = (found: Diagnostic[]): string[] => found.map((d) => d.code);
  const old = 'import { fetch_url } from plugins\nmovement go(u: <text>) {\n  p = fetch_url(url: u)\n}';

  it('is imported by its exact camelCase name under 5, as by the catalog key under 4', () => {
    const v5 = 'import { fetchUrl } from plugins\nfunction go(u: <text>) {\n  p = fetchUrl(url: u)\n}';
    const aliased = 'import { fetchUrl as get } from plugins\nfunction go(u: <text>) {\n  p = get(url: u)\n}';
    expect(codes(checkWith(v5, 5))).toEqual(codes(checkWith(old, 4)));
    expect(codes(checkWith(aliased, 5))).toEqual(codes(checkWith(old, 4)));
  });

  it("is refused under 5 by the catalog's key, the local name kept by the fix", () => {
    const found = spellings(checkWith('import { fetch_url } from plugins\n', 5));
    expect(found.map((d) => [d.message, d.fix?.edits[0]?.text])).toEqual([
      ['from language version 5 the plugin `fetch_url` is imported as `fetchUrl`', 'fetchUrl as fetch_url'],
    ]);
    expect(spellings(checkWith('import { fetch_url as get } from plugins\n', 5))[0]?.fix?.edits[0]?.text).toBe('fetchUrl');
  });

  it('in another letter case is unknown under 5, named as written', () => {
    const unknown = checkWith('import { fetchURL } from plugins\n', 5).filter((d) => d.code === 'MOV_IMPORT_UNKNOWN');
    expect(unknown.map((d) => d.message)).toEqual(["Unknown plugin 'fetchURL' in 'plugins'"]);
  });

  it("is imported by the catalog's key under 4, the camelCase name unknown", () => {
    expect(codes(checkWith('import { fetch_url } from plugins\n', 4))).not.toContain('MOV_IMPORT_UNKNOWN');
    expect(checkWith('import { fetchUrl } from plugins\n', 4).map((d) => d.message)).toContain(
      "Unknown plugin 'fetchUrl' in 'plugins'",
    );
  });
});

describe('a name the program binds', () => {
  const ofCode = (found: Diagnostic[], code: string): string[] => found.filter((d) => d.code === code).map((d) => d.message);

  it('takes the call under 5: `upper` hides nothing (`Text.upper` is the function)', () => {
    const closure = 'function go(t: <text>) {\n  upper = (s: <text>) => s\n  a = upper(t)\n  n = Text.length(upper(t))\n}';
    const found = check(closure, 5);
    expect(ofCode(found, 'MOV_V5_SPELLING')).toEqual([]);
    expect(ofCode(found, 'MOV_FUNCTION_NAME_COLLISION')).toEqual([]);
    const fn = 'function upper(s: <text>) {\n  return s\n}\nfunction go(t: <text>) {\n  a = upper(t)\n  upper(t)\n}';
    expect(ofCode(check(fn, 5), 'MOV_V5_SPELLING')).toEqual([]);
    expect(ofCode(check(fn, 5), 'MOV_FUNCTION_NAME_COLLISION')).toEqual([]);
  });

  it('only where it is bound: an unbound old name is still refused under 5', () => {
    expect(ofCode(check('function go(t: <text>) {\n  a = upper(t)\n}', 5), 'MOV_V5_SPELLING')).toEqual([
      '`upper` is written `Text.upper` from language version 5',
    ]);
    const inner = 'function go(t: <text>) {\n  if (t == "a") {\n    upper = (s: <text>) => s\n  }\n  n = upper(t)\n}';
    expect(ofCode(check(inner, 5), 'MOV_V5_SPELLING')).toHaveLength(1);
  });

  it('is refused under 5, for now, when it hides a core word or a namespace (exact case)', () => {
    const found = check('function go(count: <number>) {\n  Text = 3\n  Map = 3\n  upper = 3\n}', 5);
    expect(ofCode(found, 'MOV_V5_HIDES_BUILTIN')).toEqual([
      "'count' would hide the core word `count` — not yet allowed: inside an expression a call written with 'count' is read as the core word `count` before any name is bound, so it would not reach this binding. Name it something else",
      "'Text' would hide the namespace `Text` — not yet allowed: inside an expression a call written with 'Text' is read as the namespace `Text` before any name is bound, so it would not reach this binding. Name it something else",
    ]);
    const fn = check('function first(s: <text>) {\n  return 1\n}', 5).filter(
      (d) => d.code === 'MOV_V5_HIDES_BUILTIN' || d.code === 'MOV_FUNCTION_NAME_COLLISION',
    );
    expect(fn.map((d) => d.code)).toEqual(['MOV_V5_HIDES_BUILTIN']);
  });

  it("under 4 may not share a built-in's name in any letter case, as before", () => {
    const found = check('movement go(t: <text>) {\n  upper = (s: <text>) => s\n  map = 3\n}', 4);
    expect(ofCode(found, 'MOV_FUNCTION_NAME_COLLISION')).toHaveLength(1);
    expect(ofCode(found, 'MOV_V5_HIDES_BUILTIN')).toEqual([]);
  });
});
