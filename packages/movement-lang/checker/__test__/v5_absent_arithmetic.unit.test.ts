// From version 5 a number computed from a value that may be absent is refused
// (MOV_ABSENT_REQUIRED): `+ - * / %`, unary minus, a built-in's number
// parameter (`Number.round(n)`), and a fold over a list that may hold an
// absent member (`List.sum`, `List.avg`, `List.min`, `List.max`). The engine
// reads an absent value as 0 there, so the run computed a number nobody meant;
// TypeScript refuses `n + 1` on `number | undefined` for the same reason. A
// `!= null` guard, a guard clause that leaves, `coalesce`, and `?:` each clear
// it; a fold's list is cleared by `List.compact` or a `coalesce` map. Versions
// 1–4 keep reading absent as 0, and a move up across 5 is warned of. The Rust
// twin is crates/movement-checker/tests/v5_absent_arithmetic.rs, same
// programs, same messages.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: { positions: { company: { properties: { name: 'text' }, edges: {} } }, collections: { companies: { target: 'company' } } },
    },
  },
  credentials: { crm_cred: { adapter: 'crm' } },
});

function absent(body: string, languageVersion: LanguageVersion, upgradingFrom?: LanguageVersion): Array<[string, string]> {
  const v5 = languageVersion >= 5;
  const source = [
    'import { crm } from adapters',
    'import { crm_cred } from credentials',
    v5 ? 'c = connect crm using crm_cred' : 'c = crm(credentials: crm_cred)',
    `${v5 ? 'function' : 'movement'} go(t: <text>, xs: <number[]>) {`,
    body,
    '}',
  ].join('\n');
  return checkProgram(parseProgram(source, { languageVersion }), catalog, {
    languageVersion,
    ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
  })
    .filter((d) => d.code === 'MOV_ABSENT_REQUIRED')
    .map((d) => [d.severity === undefined ? 'error' : 'warning', d.message]);
}

const SEE = ' (see handbook: front#maybe-absent)';
const guarded = (name: string) => `Guard it ('if (${name} != null) { … }'), or fall back to a value that is always there ('coalesce(${name}, 0)').${SEE}`;
const unnamed = `Guard it with a '!= null' test, or fall back to a value that is always there ('coalesce(…, 0)').${SEE}`;
const MAYBE = 'number (or absent)';

describe('under version 5', () => {
  it('an operator refuses an operand that may be absent, on either side', () => {
    expect(absent('  n = Number.parse(t)\n  m = n + 1', 5)).toEqual([
      ['error', `'n' may be absent (${MAYBE}), and '+' needs a number on both sides (it reads an absent value as 0). ${guarded('n')}`],
    ]);
    expect(absent('  n = Number.parse(t)\n  m = 2 * n', 5)).toEqual([
      ['error', `'n' may be absent (${MAYBE}), and '*' needs a number on both sides (it reads an absent value as 0). ${guarded('n')}`],
    ]);
    expect(absent('  m = first(xs) % 2', 5)).toEqual([
      ['error', `This value may be absent (${MAYBE}), and '%' needs a number on both sides (it reads an absent value as 0). ${unnamed}`],
    ]);
  });

  it('unary minus refuses one', () => {
    expect(absent('  m = -Number.parse(t)', 5)).toEqual([
      ['error', `This value may be absent (${MAYBE}), and unary '-' needs a number (it reads an absent value as 0). ${unnamed}`],
    ]);
  });

  it("a built-in's number parameter refuses one", () => {
    expect(absent('  n = Number.parse(t)\n  m = Number.round(n)', 5)).toEqual([
      ['error', `'n' may be absent (${MAYBE}), and Number.round's 'number' takes a number. ${guarded('n')}`],
    ]);
  });

  it('a fold refuses a list that may hold an absent member', () => {
    expect(absent('  ys = map(xs, (x) => Number.parse(t))\n  s = List.sum(ys)', 5)).toEqual([
      ['error', `'ys' may hold an absent member (${MAYBE}), and List.sum reads an absent member as 0. Drop the absent members first ('List.sum(List.compact(ys))' or 'List.sum(filter(ys, (x) => x != null))'), or fill them ('List.sum(map(ys, (x) => coalesce(x, 0)))').${SEE}`],
    ]);
    expect(absent('  ys = map(xs, (x) => Number.parse(t))\n  s = List.max(ys)', 5)).toHaveLength(1);
  });

  it('a guard, a guard clause that leaves, coalesce and ?: each clear it', () => {
    expect(absent('  n = Number.parse(t)\n  if (n != null) {\n    m = n + 1\n  }', 5)).toEqual([]);
    expect(absent('  n = Number.parse(t)\n  if (n == null) {\n    fail("no number")\n  }\n  m = -n', 5)).toEqual([]);
    expect(absent('  m = Number.round(coalesce(Number.parse(t), 0)) + 1', 5)).toEqual([]);
    expect(absent('  n = Number.parse(t)\n  m = n != null ? n * 2 : 0', 5)).toEqual([]);
  });

  it("a fold's list is cleared by dropping or filling its absent members", () => {
    expect(absent('  ys = map(xs, (x) => Number.parse(t))\n  s = List.sum(List.compact(ys))', 5)).toEqual([]);
    expect(absent('  ys = map(xs, (x) => Number.parse(t))\n  s = List.avg(map(ys, (y) => coalesce(y, 0)))', 5)).toEqual([]);
    expect(absent('  s = List.sum(xs) + count(xs)', 5)).toEqual([]);
  });
});

describe('under versions 1–4', () => {
  const OLD = '  m = FIRST(xs) + 1\n  k = -LAST(xs)\n  r = ROUND(FIRST(xs))';

  it('a number that may be absent is read as 0, as it always was', () => {
    for (const version of [3, 4] as const) expect(absent(OLD, version)).toEqual([]);
  });

  it('a move up across 5 is warned of', () => {
    const warned = absent('  m = first(xs) + 1', 5, 4);
    expect(warned).toEqual([
      ['warning', `since "Dancing Wren" (5) a number computed from a value that may be absent is refused; before, the absent value was read as 0. This value may be absent (${MAYBE}), and '+' needs a number on both sides (it reads an absent value as 0). Guard it with a '!= null' test, or fall back to a value that is always there ('coalesce(…, 0)'), then upgrade.${SEE}`],
    ]);
  });
});
