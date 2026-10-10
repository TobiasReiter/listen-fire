// Narrowing WITHIN a boolean expression (version 3).
//
// `AND` and `OR` short-circuit at run time, so the right side of `a AND b` is
// only ever evaluated where `a` held, and of `a OR b` only where `a` failed.
// TypeScript types the right side accordingly — `x != null && x > 3`,
// `x == null || x > 3` — and from version 3 so does this checker, with the
// same proofs the statement-level guard clause uses. Version 2 keeps the old
// reading: each operand typed alone.
//
// Subjects on every plane the guard knows: a scalar binding (`n`), a field of
// an extracted record (`r.size`), a maybe-empty landing (`who`), a field of a
// record value (`f.size`), a dict key (`d.size`), and a hop WHERE's own field.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Members: { target: 'person', readable: true } },
    },
    person: {
      properties: { Name: 'text', Age: 'number', Score: { kind: 'maybeAbsent', of: 'number' } },
      edges: {},
    },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

const SETUP = [
  '  n = ONLY(c-[p:Members]->.`Age`)',
  '  who = ONLY(c-[p:Members]->)',
  '  r = extract from [c.`Name`] {',
  '    size: <number | null> "how many"',
  '  }',
  '',
].join('\n');

function codes(body: string, languageVersion?: LanguageVersion): string[] {
  const source = `import { slack } from adapters
chat = slack()
movement m(c: <chat-[:channel]->>) {
${SETUP}${body}
}`;
  const options = languageVersion !== undefined ? { languageVersion } : undefined;
  return checkProgram(parseProgram(source, options), catalog, options)
    .filter(d => (d.severity ?? 'error') === 'error')
    .map(d => d.code);
}

/** Each refused under version 2 with MOV_ABSENT_REQUIRED on the guarded side. */
const forms: Array<[string, string]> = [
  ['`AND` after `!= null`', '  big = n != null AND n > 3'],
  ['`OR` after `== null`', '  big = n == null OR n > 3'],
  ['a record field, `AND`', '  big = r.size != null AND r.size > 3'],
  ['a record field, `OR`', '  big = r.size == null OR r.size > 3'],
  ['a maybe-empty landing, `AND`', '  big = who != null AND who.`Age` > 3'],
  ['a maybe-empty landing, `OR`', '  big = who == null OR who.`Age` > 3'],
  ['`EXISTS(x) AND`', '  big = EXISTS(n) AND n > 3'],
  ['`ISNULL(x) OR`', '  big = ISNULL(n) OR n > 3'],
  ['`NOT EXISTS(x) OR`', '  big = NOT EXISTS(n) OR n > 3'],
  ['`NOT (x == null) AND`', '  big = NOT (n == null) AND n > 3'],
  ['inside `NOT (…)`, by De Morgan', '  big = NOT (n == null OR n <= 3)'],
  ['every operand before, in a chain', '  big = n != null AND r.size != null AND n > r.size'],
  ['nested: an `OR` inside an `AND`', '  big = n != null AND (r.size == null OR r.size < n)'],
  ['an `IF … THEN … ELSE … END` condition', '  big = IF n != null AND n > 3 THEN "big" ELSE "small" END'],
  ['a field guard narrows an `IF`\'s `THEN` too', '  big = IF r.size != null THEN r.size > 3 ELSE false END'],
  ['a maybe-empty landing narrows an `IF`\'s `THEN`', '  big = IF who != null THEN who.`Age` > 3 ELSE false END'],
  ['an `if` statement condition, `OR`', '  if n == null OR n > 3 { }'],
  ['an `if` statement condition, field `OR`', '  if r.size == null OR r.size > 3 { }'],
  ['a hop WHERE, bare field `AND`', '  c-[p:Members WHERE `Score` != null AND `Score` > 3]-> { }'],
  ['a hop WHERE, bare field `OR`', '  c-[p:Members WHERE `Score` == null OR `Score` > 3]-> { }'],
  ['a hop WHERE, through the alias', '  c-[p:Members WHERE p.`Score` == null OR p.`Score` > 3]-> { }'],
  ['a FILTER closure', '  xs = [n, 4]\n  kept = FILTER(xs, (x) => { return x != null AND x > 3 })'],
];

describe('narrowing within a boolean expression', () => {
  it.each(forms)('%s: clean under v3', (_label, body) => {
    expect(codes(body)).toEqual([]);
  });

  it.each(forms)('%s: refused under v2, each operand typed alone', (_label, body) => {
    expect(codes(body, 2)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a record value built in a closure narrows by its field (untyped, so silent, under v2)', () => {
    const body = [
      '  rows = MAP([1, 2], (i) => { return { ...r, i: i } })',
      '  MAP(rows, (f) => { return f.size != null AND f.size > 3 })',
    ].join('\n');
    expect(codes(body)).toEqual([]);
    expect(codes(body.replace('f.size != null AND ', ''))).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(codes(body, 2)).toEqual([]);
  });

  it('a dict key narrows by its key (a dict read is untyped, so silent, under v2)', () => {
    expect(codes('  d = { size: n }\n  big = d.size != null AND d.size > 3')).toEqual([]);
    expect(codes('  d = { size: n }\n  big = d.size > 3')).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(codes('  d = { size: n }\n  big = d.size != null AND d.size > 3', 2)).toEqual([]);
  });

  it('a statement `if a AND b` already narrowed conjunct by conjunct, in both versions', () => {
    expect(codes('  if r.size != null AND r.size > 3 { }')).toEqual([]);
    expect(codes('  if r.size != null AND r.size > 3 { }', 2)).toEqual([]);
  });

  describe('only the side the run reaches is narrowed', () => {
    const refused: Array<[string, string]> = [
      ['`!= null OR` — the right side runs where x IS absent', '  big = n != null OR n > 3'],
      ['`== null AND` — likewise', '  big = n == null AND n > 3'],
      ['the guard on the RIGHT proves nothing for the left', '  big = n > 3 AND n != null'],
      ['an `OR` guard proves nothing past the `OR`', '  big = (n != null OR 1 == 1) AND n > 3'],
      ['a narrowing ends with its operator', '  big = (n != null AND n > 1) OR n > 3'],
      ['a field proof narrows that field only', '  big = r.size != null AND n > 3'],
    ];
    it.each(refused)('%s', (_label, body) => {
      expect(codes(body)).toEqual(['MOV_ABSENT_REQUIRED']);
    });
  });
});
