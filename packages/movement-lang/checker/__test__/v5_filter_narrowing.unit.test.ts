// From version 5 a `filter` whose function's own test keeps only members that
// are there answers a list of present members, as TypeScript's inferred type
// predicate makes `xs.filter(x => x != null)` a `T[]`. The narrowing is the
// body's: `x != null` returned, `!(x == null)`, a guard clause that returns
// `false` above a `return true`, a conjunction — every `return` that may keep
// a member proves it present. So the filtered list clears MOV_ABSENT_REQUIRED
// on `List.sum` and its siblings. Nothing is keyed on a name. Versions 1–4
// keep the members' type as it was. The Rust twin is
// crates/movement-checker/tests/v5_filter_narrowing.rs, same programs, same
// answers.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const catalog = mockCatalog({ adapters: {}, credentials: {} });

function diagnostics(body: string, languageVersion: LanguageVersion): Array<[string, string]> {
  const source = [`${languageVersion >= 5 ? 'function' : 'movement'} go(t: <text>, xs: <number[]>) {`, body, '}'].join('\n');
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion })
    .filter((d) => d.severity === undefined)
    .map((d) => [d.code, d.message]);
}

/** The absence refusals a sum over `filter(ns, <fn>)` draws, `ns` a list
 *  that may hold an absent member. */
function summed(fn: string): string[] {
  return diagnostics(`  ns = map(xs, (x) => Number.parse(t))\n  ys = filter(ns, ${fn})\n  s = List.sum(ys)`, 5)
    .filter(([code]) => code === 'MOV_ABSENT_REQUIRED')
    .map(([, message]) => message);
}

describe('under version 5', () => {
  it.each([
    ['a returned `!= null`', '(n) => n != null'],
    ['`null !=` the other way round', '(n) => null != n'],
    ['a negated `== null`', '(n) => !(n == null)'],
    ['a conjunction', '(n) => n != null && n > 3'],
    ['a guard clause above `return true`', '(n) => {\n    if (n == null) {\n      return false\n    }\n    return true\n  }'],
    ['an `if` arm that returns', '(n) => {\n    if (n != null) {\n      return true\n    }\n    return false\n  }'],
  ])('%s keeps only present members', (_, fn) => {
    expect(summed(fn)).toEqual([]);
  });

  it('the filter written inside the fold clears it too', () => {
    const found = diagnostics('  ns = map(xs, (x) => Number.parse(t))\n  s = List.sum(filter(ns, (n) => n != null)) + 1', 5);
    expect(found).toEqual([]);
  });

  it.each([
    ['a test that keeps every member', '(n) => true'],
    ['a test that keeps the absent ones', '(n) => n == null'],
    ['a return that keeps one without the test', '(n) => {\n    if (n == null) {\n      return true\n    }\n    return n > 3\n  }'],
    ['a disjunction', '(n) => n != null || t == ""'],
  ])('%s does not', (_, fn) => {
    expect(summed(fn)).toHaveLength(1);
  });

  it("the fold's remedy offers the filter form", () => {
    expect(summed('(n) => true')[0]).toContain("'List.sum(filter(ys, (x) => x != null))'");
  });
});

describe('under versions 1–4', () => {
  it("a filter keeps its members' type as it was", () => {
    // A text built-in names the list it is handed, members' absence and all.
    const named = (version: LanguageVersion) =>
      diagnostics('  ns = MAP(xs, (x) => FIRST(xs))\n  ys = FILTER(ns, (n) => NOT ISNULL(n))\n  u = UPPER(ys)', version)
        .filter(([code]) => code === 'MOV_BUILTIN_ARG_TYPE')
        .map(([, message]) => message);
    for (const version of [3, 4] as const) expect(named(version).join()).toContain('number (or absent)');
  });
});

describe('the list the filter answers, under version 5', () => {
  it('is a list of present members', () => {
    const found = diagnostics('  ns = map(xs, (x) => Number.parse(t))\n  ys = filter(ns, (n) => n != null)\n  u = Text.upper(ys)', 5)
      .filter(([code]) => code === 'MOV_BUILTIN_ARG_TYPE');
    expect(found).toHaveLength(1);
    expect(found[0]![1]).not.toContain('absent');
  });
});
