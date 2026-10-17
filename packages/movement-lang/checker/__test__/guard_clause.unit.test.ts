// A branch that always leaves — `if (x == null) { fail("…") }`, a `return`,
// or an `if` whose every arm and `else` leave — proves its condition false for
// the rest of the enclosing block, so a record that may be absent is present
// below it, and every presence check (a write off it, a block's walk, a walk
// inside an expression, a required write field) accepts it. TypeScript's
// guard clause, with `fail` in the role of `throw`. Version 5 keeps exactly
// the narrowing `if ISNULL(x) { ERROR(…) }` gave on 1–4. Only a branch that
// always leaves narrows below it: an `if` never prefers one of its arms.
// `x != null && …` and `x == null || …` narrow `x` on the right side too.
//
// Both checkers answer every case, the TypeScript one and the Rust one; the
// Rust twin is crates/movement-checker/tests/guard_clause.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { fromCatalogSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import { checkSourceInRust } from '../rust_checker';

const snapshot: CatalogSnapshot = JSON.parse(
  '{"adapters":{"chat":{"canFire":true,"constructionArgs":[],"schemas":{"":{"positions":{"Channel":{"properties":{"Name":"text","Topic":"text"},"edges":{"Messages":{"target":"Message","writable":true}}},"Message":{"properties":{"Message":"text"},"edges":{}}},"collections":{"Channels":{"target":"Channel"}},"writableRoots":{"Channel":{"fields":{"Name":"text"},"resultShape":{"externalId":"text"}},"Message":{"fields":{"Message":"text"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{},"plugins":{}}',
);

type Version = 4 | 5;

/** The text in `version`'s spelling: 1–4 wrote `ERROR`, `ONLY`, `COUNT`,
 *  `EXISTS`, `AND` and `OR`. */
function spelled(version: Version, text: string): string {
  if (version >= 5) return text;
  return text
    .replace(/only\(/g, 'ONLY(')
    .replace(/count\(/g, 'COUNT(')
    .replace(/exists\(/g, 'EXISTS(')
    .replace(/fail\(/g, 'ERROR(')
    .replace(/ && /g, ' AND ')
    .replace(/ \|\| /g, ' OR ')
    .replace(/h\.Name ==/g, '`Name` ==');
}

function sourceOf(body: string, version: Version): string {
  const [prelude, declaration] =
    version < 5
      ? ['import { chat } from adapters\nc = chat()', 'movement']
      : ['import { `@lf/chat` as chat } from adapters\nc = connect chat', 'function'];
  return spelled(version, `${prelude}\n\n${declaration} go() {\n  x = only(c-[h:Channels WHERE h.Name == "alerts"]->)\n${body}\n}\n`);
}

/** The presence refusals `body` draws under `version`, from each checker. `x`
 *  is the one channel named "alerts", which may not be there. */
function absent(body: string, version: Version): { ts: string[]; rust: string[] } {
  const source = sourceOf(body, version);
  const ts = checkProgram(parseProgram(source, { languageVersion: version }), fromCatalogSnapshot(snapshot), { languageVersion: version });
  const rust = checkSourceInRust(source, snapshot, { languageVersion: version });
  const refusals = (found: Diagnostic[]): string[] => {
    const errors = found.filter((d) => (d.severity ?? 'error') === 'error');
    expect(errors.filter((d) => d.code !== 'MOV_ABSENT_REQUIRED').map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    return errors.map((d) => d.message);
  };
  return { ts: refusals(ts), rust: refusals(rust) };
}

/** Both checkers agree, and draw `count` refusals. */
function expectRefusals(body: string, version: Version, count: number): void {
  const { ts, rust } = absent(body, version);
  expect(rust).toEqual(ts);
  expect(ts).toHaveLength(count);
}

/** Each place a record that may be absent is refused, and whether 1–4 refuse
 *  it too (a walk inside an expression or a block is refused from 5 only). */
const POSITIONS: Array<[string, string, boolean]> = [
  ['a write off it', '  write x-[:Messages]-> { Message: "hi" }', true],
  ['a required write field read off it', '  write c-[:Channels]-> { Name: x.`Name` }', true],
  ["a block's walk off it", '  x-[m:Messages]-> {\n    write c-[:Channels]-> { Name: m.`Message` }\n  }', false],
  ['an aggregate walk', '  n = count(x-[:Messages]->)\n  return n', false],
  ['an exists with a hop', '  return exists(x-[:Messages]->)', false],
];

/** Branches that always leave, each proving `x` present below them. */
const GUARDS: Array<[string, string]> = [
  ['fail', '  if (x == null) { fail("no channel") }'],
  ['return', '  if (x == null) { return "none" }'],
  ['a disjunction that fails', '  if (x == null || 1 == 2) { fail("no channel") }'],
  ['an arm that fails after another that returns', '  if (1 == 2) { return "early" } else if (x == null) { fail("no channel") }'],
  ['an else that fails', '  if (x != null) {\n    y = 1\n  } else {\n    fail("no channel")\n  }'],
  ['a nested if whose every arm leaves', '  if (x == null) {\n    if (1 == 1) { fail("a") } else { return "b" }\n  }'],
  ['a guard inside the block it narrows', '  if (1 == 1) {\n    if (x == null) { fail("no channel") }\n  BODY\n  }'],
];

/** Branches that can fall through, so nothing below them is proved. */
const NOT_GUARDS: Array<[string, string]> = [
  ['an empty arm', '  if (x == null) { }'],
  ['an arm that leaves only sometimes', '  if (x == null) {\n    if (1 == 1) { fail("a") }\n  }'],
  ['a conjunction that fails', '  if (x == null && 1 == 1) { fail("no channel") }'],
  ['an earlier arm that falls through', '  if (1 == 1) {\n    y = 1\n  } else if (x == null) { fail("no channel") }'],
  ['an if with no else', '  if (x != null) {\n    y = 1\n  }'],
  ['a guard inside an arm, used after the if', '  if (1 == 1) {\n    if (x == null) { fail("no channel") }\n  }'],
  ["a guard inside a walk's block, used after it", '  c-[k:Channels]-> {\n    if (x == null) { return "none" }\n  }'],
];

const guarded = (guard: string, body: string): string =>
  guard.includes('BODY') ? guard.replace('  BODY', body) : `${guard}\n${body}`;

describe('a guard clause narrows a record that may be absent, in both checkers', () => {
  it.each(POSITIONS)('unguarded, %s is refused under 5 (and under 4 when 4 refused it)', (_position, body, before5) => {
    expectRefusals(body, 5, 1);
    expectRefusals(body, 4, before5 ? 1 : 0);
  });

  describe.each(POSITIONS)('%s', (_position, body) => {
    it.each(GUARDS)('is accepted below a branch that always leaves: %s', (_guard, text) => {
      expectRefusals(guarded(text, body), 5, 0);
      expectRefusals(guarded(text, body), 4, 0);
    });
  });

  describe.each(POSITIONS)('%s', (_position, body, before5) => {
    it.each(NOT_GUARDS)('is still refused below a branch that can fall through: %s', (_guard, text) => {
      expectRefusals(guarded(text, body), 5, 1);
      expectRefusals(guarded(text, body), 4, before5 ? 1 : 0);
    });
  });

  it.each([4, 5] as const)('the right side of a presence test sees the record there, under %s', (version) => {
    expectRefusals('  return x != null && count(x-[:Messages]->) > 0', version, 0);
    expectRefusals('  return x == null || count(x-[:Messages]->) > 0', version, 0);
    expectRefusals('  return x != null && x.`Name` == "a"', version, 0);
  });

  it('the other right sides do not', () => {
    expectRefusals('  return x == null && count(x-[:Messages]->) > 0', 5, 1);
    expectRefusals('  return x != null || count(x-[:Messages]->) > 0', 5, 1);
  });
});
