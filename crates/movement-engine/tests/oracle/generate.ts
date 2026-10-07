// Writes stdlib.json: the TypeScript standard library's answers (and the
// shared comparator's) for a spread of hazardous inputs, which
// tests/stdlib_oracle.rs holds the Rust engine to. Values travel in the
// eval wire format (crates/movement-engine/src/env.rs), so NaN, -0,
// undefined and key order survive.
//
// Regenerate from apps/api (for its ts-node and compiler settings):
//   TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only \
//     ../../crates/movement-engine/tests/oracle/generate.ts

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyStdlib,
  coerceToDate,
  coerceToDatetime,
  coerceToNumber,
  stdlibFunctionById,
} from '../../../../packages/movement-lang/expression/stdlib';
import { compareValues } from '../../../../packages/shared/expression/filter';
import type { FilterOperator } from '../../../../packages/shared/expression/types';

function wire(value: unknown): unknown {
  if (value === undefined) return ['u'];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['n', 'NaN'];
    if (value === Infinity) return ['n', 'Infinity'];
    if (value === -Infinity) return ['n', '-Infinity'];
    if (Object.is(value, -0)) return ['n', '-0'];
    return value;
  }
  if (Array.isArray(value)) return ['l', 0, value.map(wire)];
  if (value !== null && typeof value === 'object') {
    return ['o', 0, Object.entries(value).map(([k, v]) => [k, wire(v)])];
  }
  return value;
}

/** A lone surrogate, which no Rust string holds: the engine must hand such
 *  a case back to TypeScript. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function outcome(run: () => unknown): unknown {
  try {
    const value = run();
    if (typeof value === 'string' && LONE_SURROGATE.test(value)) return { loneSurrogate: true };
    return { value: wire(value) };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    return { throws: { name: e.name, message: e.message } };
  }
}

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
  [{ __brand: 'FileRef', name: 'a.pdf', size: 3, extra: 1 }, 'JSON'],
  [1, 'json'], [1, undefined], [1, 7], [1, { a: 1 }],
]);

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
console.log(`${cases.length} cases`);
