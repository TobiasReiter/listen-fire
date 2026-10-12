// Writes the TypeScript's own answers, which tests/stdlib_oracle.rs holds the
// Rust engine to:
//   - stdlib.json: every built-in (flat and namespaced) and the shared
//     comparator over a spread of hazardous inputs, values in the eval wire
//     format (crates/movement-engine/src/env.rs) so NaN, -0, undefined and key
//     order survive;
//   - numbers.json: `String(x)` for 30,000 seeded doubles (bit patterns as
//     hex), the 17-digit ties included;
//   - regex.json: `new RegExp(pattern).exec(text)` for seeded patterns over
//     backreferences, lazy quantifiers, lookaheads, \b, classes, anchors,
//     alternation and empty iterations; then the rest of the dialect from a
//     second seed (lookbehind, named groups and `\k`, Annex B's octal, `\c`
//     and identity escapes, class escapes at a range's end, quantified
//     lookaheads, deep nesting, long texts);
//   - order_limit.json: a hop's pushdown and ORDER BY / LIMIT plan
//     (./order_limit_oracle.ts; not ./order_limit, which Node resolves to
//     the .json beside it);
//   - extraction.json: the extraction keyword's specs, regions, prompts and
//     reply verdicts, and the priced-plugin cap (./extraction_oracle.ts);
//   - records.json: records held as values, whole programs run on the
//     TypeScript engine (./records_oracle.ts);
//   - parallel.json: `parallel` and `race` programs run on the TypeScript
//     engine, their requests in order and their writes in ledger order
//     (./parallel_oracle.ts);
//   - handles.json: language version 4's write handles (the record as
//     found, `-[:@old]->`, in-place writes, a match's miss) run on the
//     TypeScript engine against a scripted CRM, with what it received, the
//     writes, the trace and the parked state (./handles_oracle.ts);
//   - the TypeScript's runtime accidents, one file each (./tail_oracle.ts);
//   - dates.json: V8's date parser, and the members that read dates through
//     it, under five local zones (./dates_oracle.ts);
//   - patterns.json: the retirement proof — seeded programs for every
//     admission pattern the README's port list names, and every one chunk 7A
//     closed, each run on both engines through the real shim against one
//     scripted host and compared (./patterns_oracle.ts; the report is
//     ./patterns_report.ts, `pnpm engine:patterns`). A program that ends where
//     its pattern does not say fails the generator.
// Deterministic: a rerun writes the same bytes (CI diffs them). Some answers
// read local time (an offset-less date-time is local to `new Date`), so the
// process runs in UTC wherever it is started — all but dates_oracle.ts,
// which sets each of its zones in turn and then UTC again.
//
// Regenerate from apps/api (for its ts-node and compiler settings):
//   TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only \
//     ../../crates/movement-engine/tests/oracle/generate.ts

// Before anything reads the clock: Node re-reads TZ when it is assigned.
process.env.TZ = 'UTC';
// The engine's modules read these as they load (records_oracle.ts runs whole
// programs in process); nothing the oracle runs reaches a database.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL_TEST ??= 'postgresql://oracle:oracle@localhost:5432/oracle-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://oracle:oracle@localhost:5432/oracle-unused';
process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.SCRAPER_API_KEY ??= 'oracle-unused';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyStdlib,
  coerceToDate,
  coerceToDatetime,
  coerceToNumber,
  stdlibFunctionById,
} from '../../../../packages/movement-lang/expression/stdlib';
import { applyMovementFunction } from '../../../../apps/api/src/services/movement_engine/builtins';
import { fileValue } from '../../../../packages/engine-contracts/file_ref';
import { compareValues } from '../../../../packages/shared/expression/filter';
import { writeExtractionOracle } from './extraction_oracle';
import { writeOrderLimitOracle } from './order_limit_oracle';
import { writeHandlesOracle } from './handles_oracle';
import { writeParallelOracle } from './parallel_oracle';
import { writeRecordsOracle } from './records_oracle';
import { writeTailOracles } from './tail_oracle';
import { writeDatesOracle } from './dates_oracle';
import { writePatternsOracle } from './patterns_oracle';
import { outcome, wire } from './wire';
import type { FilterOperator } from '../../../../packages/shared/expression/types';

const SCALARS: unknown[] = [
  undefined, null, true, false, 0, -0, 1, -1, 1.5, -2.5, 0.1, 1e21, 1e-7, 123456789.125, 999950, 1_200_000, -1250,
  2_100_000_000, 1e15, NaN, Infinity, -Infinity, 8.64e15, -8.64e15 - 1, 1773273600000,
  '', ' ', '  12 ', '1e3', '0x10', '-0x10', '0b101', '.5', '5.', 'Infinity', 'NaN', '1_0', '  7 ﻿', '\u0085 7',
  '1,234.5', '£1.2m', '€3bn', '$2 trillion', '¥ 500k', '12 CHF', 'about 4.5 million usd', '5 constructor', 'abc',
  '12 March 2026', 'March 12, 2026', '1st Feb 2026', '22nd  feb, 2026', 'Feb 30 2026', 'constructor 5, 2026',
  '2026-02-29', '2024-02-29', '2026-3-9', '2026/03/12', '2026/3/9 ', '0099-01-01', '0100-01-01', '9999-12-31',
  '2026-03-12T09:30:00Z', '2026-03-12T09:30:00.123456+05:30', '2026-03-12T24:00:00Z', '2026-03-12T09:30',
  '2026-02-30T00:00Z', '2026-03-12 note', '12/03/2026', 'acme.com', 'https://WWW.Acme.com:8080/x', 'user@acme.com',
  'mailto:a@b.com', 'localhost:3000', 'http://a@b@c.com', 'not a url', 'ftp://Files.Example.org/x', 'ws://h:1',
  'Acme Corp Ltd.', 'ÄÖÜ straße', '😀 smile', 'line\nbreak', 'Tab\there', 'ΣΑΣ',
];

const COMPOSITES: unknown[] = [[], [1, '2', null], ['a', ['b', undefined]], {}, { b: 1, a: 'x', 10: true, 2: null }];

const VALUES = [...SCALARS, ...COMPOSITES];

const cases: Array<{ fn: string; args: unknown[]; outcome: unknown }> = [];

function stdlib(id: string, argSets: unknown[][]): void {
  const spec = stdlibFunctionById(id);
  if (spec === undefined) throw new Error(`no ${id}`);
  for (const args of argSets) {
    cases.push({ fn: id, args: args.map(wire), outcome: outcome(() => applyStdlib(spec, args, new Date(0))) });
  }
}

const one = VALUES.map((v) => [v]);
const cross = (a: unknown[], b: unknown[]) => a.flatMap((x) => b.map((y) => [x, y]));

for (const id of [
  'currency.get_number_from_figure', 'currency.get_code_from_figure', 'date.parse', 'date.format_iso', 'text.slug',
  'url.host',
]) stdlib(id, one);
// The members the environment answers (zones, WHATWG URLs, NFKD).
const ZONES = ['Europe/Berlin', 'America/New_York', 'UTC', 'utc', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago',
  'Australia/Lord_Howe', 'America/St_Johns', 'Africa/Casablanca', '+05:30', 'US/Eastern', 'Mars/Base', '', ' UTC', 7, null];
stdlib('date.today', ZONES.map((zone) => [zone]));
stdlib('datetime.at', [
  ...cross(['2026-06-15', '2026-03-29', '2026-10-25', '2026-03-08', '2026-11-01', '12 March 2026', '2024-02-29', 'someday', '0100-01-01'],
    ['07:00', '02:30', '00:00', '23:59', ' 01:30 ', '7:00', '24:00', 'noon'])
    .flatMap(([date, time]) => ['Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata', 'UTC', 'Nowhere/Land'].map((zone) => [date, time, zone])),
  [null, '07:00', 'UTC'], ['2026-06-15', null, 'UTC'], ['2026-06-15', '07:00', null], ['2026-06-15', '07:00', ''],
  [20260615, '07:00', 'UTC'], ['2026-06-15T23:30:00-05:00', '07:00', 'UTC'],
]);
const URL_HOSTS = ['bücher.de', 'BÜCHER.de', 'xn--bcher-kva.de', '例え.テスト', 'ﬁnance.io', '⒈.com', 'straße.de', 'пример.рф',
  '😀.ws', '127.0.0.1', '127.1', '0x7f.1', '1.2.3.4.', '256.0.0.1', '[::1]', '[2001:db8::FFFF]', 'a%41.com', '%zz.com', 'a b.com',
  'a_b.com', 'localhost', 'a..b', 'xn--a', 'A\u0301.com'];
stdlib('url.host', ['http://', 'https://', 'ftp://', 'git://', 'file://', 'sc://', '', 'joe@', 'http://joe@'].flatMap((prefix) =>
  URL_HOSTS.flatMap((host) => [[`${prefix}${host}`], [`${prefix}${host}:8080/x?q#f`]])));
stdlib('text.slug', ['Café Ünïcode', 'ﬁnance ½ ①', 'Straße', 'ΣΑΣ Ελλάδα', 'Ångström', 'naïve—résumé', '日本語', 'Ǆemal', 'İstanbul',
  'e\u0301\u0328', '㎞/h', 'Ⅻ', 'ｶﾞ', '😀 smile'].map((t) => [t]));
stdlib('currency.format_figure', cross(SCALARS, ['EUR', ' usd ', 'CHF', 'XYZ', '', null, 7]));
stdlib('number.format', cross(SCALARS, ['compact', 'grouped', 'other', null]));
stdlib('date.add_days', cross(SCALARS, [7, -12.9, 0, -0, 1e9, NaN, '3', null]));
stdlib('date.format', cross(SCALARS, ['MMMM D, YYYY', 'ddd DD/MM/YY HH:mm:ss H m s', 'Day', '', 'YYYYMMDD', null]));
stdlib('text.regex_extract', [
  ...cross(['ref ABC-123 and DEF-456', 'no digits', '', null], ['([A-Z]+)-(\\d+)', '\\d+', '(x)?y', '(', '[a-z]+$']),
  ['ref ABC-123', '([A-Z]+)-(\\d+)', 2], ['ref ABC-123', '([A-Z]+)-(\\d+)', 5], ['ref ABC-123', '([A-Z]+)-(\\d+)', 1.5],
  ['ref ABC-123', '([A-Z]+)-(\\d+)', null], ['aaa', '(a)|b', 1], ['Subject: hello\nBody', 'Subject: (.*)'],
  ['x😀y', '.(.)'], ['2026-03-12', '^(\\d{4})-(\\d{2})'],
]);
stdlib('text.pairs', cross([{ name: 'Acme', url: 'acme.com' }, { a: 1, b: null, c: undefined, d: [1], e: { x: 1 }, f: false }, {}, [1], 'x', null], [undefined, ', ', 5, null]).map((args) => (args[1] === undefined ? [args[0]] : args)));
stdlib('text.serialise', [
  ...VALUES.map((v) => [v, 'JSON']),
  [{ z: { b: 2, a: [1, -0, NaN] }, '10': 'ten', '9': 'nine', é: 1, e: 2 }, 'JSON'],
  // A dict that spells a descriptor is a dict: its keys print.
  [{ __brand: 'FileRef', name: 'a.pdf', size: 3, extra: 1 }, 'JSON'],
  // A file the engine holds prints as a file.
  [fileValue({ __brand: 'FileRef', name: 'a.pdf', size: 3, source: { store: 'document', objectUri: 's3://x/a.pdf' } }), 'JSON'],
  [1, 'json'], [1, undefined], [1, 7], [1, { a: 1 }],
]);

const FLAT_UNARY = [
  'isnull', 'trim', 'lower', 'upper', 'length', 'abs', 'round', 'floor', 'ceil', 'tostring', 'tonumber', 'date',
  'datetime', 'number',
];
const flat = (id: string, args: unknown[]) =>
  cases.push({ fn: `flat.${id}`, args: args.map(wire), outcome: outcome(() => applyMovementFunction(id, args)) });
for (const id of FLAT_UNARY) for (const value of VALUES) flat(id, [value]);
for (const id of FLAT_UNARY) flat(id, []);
for (const args of [[], [null], [1, null, [2, undefined, null], 'x'], [[]], [[1], [2]], [undefined, 0, false, ''], [{ a: 1 }, NaN]]) {
  flat('multi', args);
}
for (const args of cross([' a, ,b ,', 'a,b', '', 'x😀y', null, undefined, 12.5, ['p', 'q']], [undefined, null, ',', '', ' ', 'a,', 0])) {
  flat('split', args[1] === undefined ? [args[0]] : args);
}

for (const value of VALUES) {
  cases.push({ fn: 'coerce.date', args: [wire(value)], outcome: outcome(() => coerceToDate(value)) });
  cases.push({ fn: 'coerce.datetime', args: [wire(value)], outcome: outcome(() => coerceToDatetime(value)) });
  cases.push({ fn: 'coerce.number', args: [wire(value)], outcome: outcome(() => coerceToNumber(value)) });
}

const OPERATORS: FilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'in', 'contains'];
const COMPARED: unknown[] = [
  undefined, null, true, false, 0, -0, 1, 10, '10', '9', ' 10 ', '', 'apple', 'banana', 'b', NaN, '2026-03-12',
  '2026-03-12T10:00:00Z', 1773273600000, ['a', 'b'], ['b', 'a', 'a'], [NaN], 'seed round', 'seed', '｡', '😀',
];
for (const left of COMPARED) {
  for (const right of COMPARED) {
    for (const op of OPERATORS) {
      cases.push({ fn: `compare.${op}`, args: [wire(left), wire(right)], outcome: outcome(() => compareValues(left, op, right)) });
    }
  }
}

writeFileSync(path.join(__dirname, 'stdlib.json'), `${JSON.stringify(cases, null, 0).replace(/\},\{"fn"/g, '},\n{"fn"')}\n`);
console.log(`stdlib.json: ${cases.length} cases`);

// ── Seeded randomness ─────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── numbers.json ──────────────────────────────────────────────────────────────

const random = mulberry32(20261007);
const view = new DataView(new ArrayBuffer(8));
const numbers: Array<[string, string]> = [];
const bitsOf = (x: number) => {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
// Any bit pattern: every magnitude, subnormals included.
while (numbers.length < 20_000) {
  view.setUint32(0, Math.floor(random() * 2 ** 32));
  view.setUint32(4, Math.floor(random() * 2 ** 32));
  const x = view.getFloat64(0);
  if (Number.isFinite(x)) numbers.push([bitsOf(x), String(x)]);
}
// A 53-bit integer scaled by a small power of two: a short exact expansion,
// where two 17-digit candidates are most often equally near.
while (numbers.length < 30_000) {
  const m = 2 ** 52 + Math.floor(random() * 2 ** 52);
  const x = (random() < 0.5 ? -1 : 1) * m * 2 ** -(Math.floor(random() * 50) + 1);
  numbers.push([bitsOf(x), String(x)]);
}
writeFileSync(path.join(__dirname, 'numbers.json'), `[\n${numbers.map((n) => JSON.stringify(n)).join(',\n')}\n]\n`);
console.log(`numbers.json: ${numbers.length} doubles`);

// ── regex.json ────────────────────────────────────────────────────────────────

const rx = mulberry32(7);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rx() * items.length)]!;
const ATOMS = ['a', 'b', 'c', '.', '\\d', '\\w', '\\s', '\\W', '[a-c]', '[^ab]', '[\\d_]', 'x', ' ', '\\.', '-'];
const ASSERTIONS = ['^', '$', '\\b', '\\B'];
const QUANTIFIERS = ['*', '+', '?', '{2}', '{1,2}', '{0,}', '{0,1}', '*?', '+?', '??', '{1,3}?'];

function regexPattern(depth: number, groups: { count: number }): string {
  const terms: string[] = [];
  const length = 1 + Math.floor(rx() * 4);
  for (let i = 0; i < length; i++) {
    const roll = rx();
    let term: string;
    if (roll < 0.12) term = pick(ASSERTIONS);
    else if (roll < 0.22 && groups.count > 0) term = `\\${1 + Math.floor(rx() * groups.count)}`;
    else if (roll < 0.45 && depth < 3) {
      const kind = pick(['(', '(', '(?:', '(?=', '(?!']);
      if (kind === '(') groups.count += 1;
      const inner = [regexPattern(depth + 1, groups)];
      if (rx() < 0.4) inner.push(regexPattern(depth + 1, groups));
      term = `${kind}${inner.join('|')})`;
    } else term = pick(ATOMS);
    if (!ASSERTIONS.includes(term) && !term.startsWith('(?=') && !term.startsWith('(?!') && rx() < 0.4) term += pick(QUANTIFIERS);
    terms.push(term);
  }
  if (rx() < 0.1 && depth === 0) terms.push(pick(['(', ')', '[', '*', '{2,1}', '(?<n>a)', '(?<=a)']));
  return terms.join('');
}

function regexOutcome(pattern: string, text: string): unknown {
  try {
    const match = new RegExp(pattern).exec(text);
    return match === null ? { match: null } : { match: [...match].map((g) => (g === undefined ? null : g)) };
  } catch {
    return { syntaxError: true };
  }
}

const TEXT_UNITS = ['a', 'b', 'c', 'x', ' ', '1', '_', '-', '.', '\n', 'A', 'é'];
const regexCases: Array<{ pattern: string; text: string; outcome: unknown }> = [];
for (let p = 0; p < 400; p++) {
  const pattern = regexPattern(0, { count: 0 });
  for (let t = 0; t < 8; t++) {
    const length = Math.floor(rx() * 10);
    let text = '';
    for (let i = 0; i < length; i++) text += pick(TEXT_UNITS);
    regexCases.push({ pattern, text, outcome: regexOutcome(pattern, text) });
  }
}
// The rest of the dialect, from its own seed so the cases above stay as
// they were.
const ry = mulberry32(8);
const pickY = <T>(items: readonly T[]): T => items[Math.floor(ry() * items.length)]!;
const ATOMS_B = [
  ...ATOMS, '\\0', '\\07', '\\101', '\\377', '\\400', '\\8', '\\9', '\\cA', '\\cj', '\\c1', '\\c', '\\x4', '\\x41', '\\u0041',
  '\\u12', '\\k', '\\p', '\\P{L}', '[\\d-z]', '[a-\\w]', '[\\s-\\d]', '[\\c_]', '[\\c*]', '[\\c]', '[\\101-\\103]', '[\\b]', '[\\B]',
  '[\\18]', '\\-', '\\/', '{', '}', ']', 'k', '<', '>', '\\$', '[^\\W\\d]', '[]', '[^]',
];
const GROUPS_B = ['(', '(', '(?:', '(?=', '(?!', '(?<=', '(?<!', '(?<=', 'named'];

function regexPatternB(depth: number, groups: { count: number; names: string[] }): string {
  const terms: string[] = [];
  const length = 1 + Math.floor(ry() * 4);
  for (let i = 0; i < length; i++) {
    const roll = ry();
    let term: string;
    let quantifiable = true;
    if (roll < 0.1) {
      term = pickY(ASSERTIONS);
      quantifiable = false;
    } else if (roll < 0.17) {
      // A backreference, sometimes to a group past the last, which reads as
      // an octal escape or a digit.
      term = `\\${1 + Math.floor(ry() * (groups.count + 3))}`;
    } else if (roll < 0.22) {
      // A name declared before, the first name (which may come after), or
      // one never declared.
      const roll2 = ry();
      term = `\\k<${groups.names.length > 0 && roll2 < 0.8 ? pickY(groups.names) : roll2 < 0.93 ? 'n0' : 'n9'}>`;
    } else if (roll < 0.5 && depth < 5) {
      let kind = pickY(GROUPS_B);
      if (kind === 'named') {
        const name = ry() < 0.05 && groups.names.length > 0 ? pickY(groups.names) : `n${groups.names.length}`;
        groups.names.push(name);
        kind = `(?<${name}>`;
      }
      if (kind === '(' || kind.startsWith('(?<n')) groups.count += 1;
      const inner = [regexPatternB(depth + 1, groups)];
      if (ry() < 0.4) inner.push(regexPatternB(depth + 1, groups));
      term = `${kind}${inner.join('|')})`;
      // Annex B quantifies a lookahead; a lookbehind quantified is an error.
      if (kind.startsWith('(?<=') || kind.startsWith('(?<!')) quantifiable = ry() < 0.05;
    } else term = pickY(ATOMS_B);
    if (quantifiable && ry() < 0.4) term += pickY(QUANTIFIERS);
    terms.push(term);
  }
  if (ry() < 0.08 && depth === 0) terms.push(pickY(['(', ')', '[', '*', '{2,1}', '(?<1>a)', '(?<>a)', '(?<a', '\\', '(?x)']));
  return terms.join('');
}

const TEXT_UNITS_B = [...TEXT_UNITS, '\u0001', '\u0007', 'k', '<', '>', '8', '\\', 'A', 'B', '\u0000', '{', '0', '9', '$', 'p', 'u'];
for (let p = 0; p < 500; p++) {
  const pattern = regexPatternB(0, { count: 0, names: [] });
  for (let t = 0; t < 8; t++) {
    const length = Math.floor(ry() * 12);
    let text = '';
    for (let i = 0; i < length; i++) text += pickY(TEXT_UNITS_B);
    regexCases.push({ pattern, text, outcome: regexOutcome(pattern, text) });
  }
}
// Long texts and deep nesting, which a step or depth budget would have
// stopped short of.
for (const [pattern, text] of [
  ['(a|b)*c', 'ab'.repeat(2500)],
  ['(a|b)*$', 'ab'.repeat(2500)],
  ['^(?:a+)+$', `${'a'.repeat(20)}`],
  ['(?<=(a+))b', `${'a'.repeat(3000)}b`],
  ['(x+x+)+y', 'x'.repeat(16)],
  [`${'('.repeat(300)}a${')'.repeat(300)}`, 'xa'],
  [`${'(?:'.repeat(1000)}a${')'.repeat(1000)}`, 'xa'],
  [`${'(?=('.repeat(150)}a${'))'.repeat(150)}`, 'ba'],
  [`${'(?<=('.repeat(150)}a${'))'.repeat(150)}b`, 'ab'],
]) {
  regexCases.push({ pattern, text, outcome: regexOutcome(pattern, text) });
}

writeFileSync(
  path.join(__dirname, 'regex.json'),
  `[\n${regexCases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`,
);
console.log(`regex.json: ${regexCases.length} cases`);

// Awaited, and a failure fails the generator: CI's "oracle is current" step
// must not pass on a pin that was never written.
(async () => {
  await writeOrderLimitOracle(mulberry32(5));
  await writeExtractionOracle(mulberry32(20261009));
  await writeRecordsOracle(mulberry32(20261010), (name, text) => writeFileSync(path.join(__dirname, name), text));
  await writeParallelOracle(mulberry32(20261011), (name, text) => writeFileSync(path.join(__dirname, name), text));
  await writeHandlesOracle(mulberry32(20261012), (name, text) => writeFileSync(path.join(__dirname, name), text));
  await writeTailOracles(mulberry32, (name, text) => writeFileSync(path.join(__dirname, name), text));
  writeDatesOracle(mulberry32(20261013), (name, text) => writeFileSync(path.join(__dirname, name), text));
  // Both engines: the movement.wasm the shim loads is the one committed.
  await writePatternsOracle(mulberry32(20261015), (name, text) => writeFileSync(path.join(__dirname, name), text));
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
