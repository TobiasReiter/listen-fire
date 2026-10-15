// V8's date parser, as the TypeScript engine leans on it, for
// tests/dates_oracle.rs to hold the Rust engine to (crate::js_date):
//
//   - dates.json: seeded date-ish texts (seed 20261013) from a grammar of the
//     forms V8 accepts and nearly accepts — ISO with one defect, month and
//     weekday names, numeric orders and two-digit years, times with AM/PM,
//     zone words and offsets, parenthesised comments, junk, Unicode digits,
//     very large numbers, and wall times either side of the daylight-saving
//     changes of the zones below. For each, in each zone: `Date.parse(text)`
//     (epoch ms, or null for NaN), and the TypeScript's own readings through
//     the real functions — `DATE(text)` (builtins.ts), `DATE.FORMAT(text, …)`
//     (stdlib.ts) and a filter's `<` against the next text (filter.ts
//     `compareValues`).
//
// The one file of the generator not written in UTC: a text with no offset is
// read in the process's local zone, so this file sets `TZ` to each zone in
// turn (Node re-reads it on assignment, `Intl`'s default zone included) and
// sets it back to UTC before it returns. Each zone is recorded as `Intl`
// resolves it, which is what the shim sends (`Asia/Kolkata` resolves to ICU's
// canonical `Asia/Calcutta`).

import { applyMovementFunction } from '../../../../packages/movement-engine/services/movement_engine/builtins';
import { applyStdlib, stdlibFunctionById } from '../../../../packages/movement-lang/expression/stdlib';
import { compareValues } from '../../../../packages/shared/expression/filter';

type Rand = () => number;
type Write = (name: string, text: string) => void;

export const DATE_ZONES = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Pacific/Apia'] as const;

const FORMAT = 'YYYY-MM-DD HH:mm:ss ddd';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZONE_WORDS = ['UTC', 'UT', 'GMT', 'Z', 'z', 'EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT', 'utc', 'Gmt', 'BST', 'CET', 'IST', 'T'];
const JUNK = ['on', 'at', 'the', 'due', 'Item', 'Q3', '#', '~', '@', 'approx.', 'by', 'noon', 'x', 'ref:', '[', ']', '_', '`', 'é', '中', ' '];
const SEPARATORS = ['/', '-', '.', ' ', ', ', '  ', '/', '-', ''];
const UNICODE_DIGITS = ['٢٠٢٦', '２０２６', '۱۲', '१२', '𝟐𝟎𝟐𝟔'];
const SPACES = [' ', '\t', '\n', ' ', '　', '﻿', ' ', '\u0000', '\r'];

/** Wall times either side of the daylight-saving changes of DATE_ZONES
 *  (New York's and London's of 2026 and of years they ruled otherwise,
 *  Apia's day that never was and its years of daylight saving), and of the
 *  first standard times that replaced local mean time. */
const BOUNDARIES = [
  '2026-03-08T02:30', '2026-03-08T01:59:59', '2026-03-08T03:00', '2026-11-01T01:30', '2026-11-01T00:59', '2026-11-01T02:00',
  '2026-03-29T01:30', '2026-03-29T00:59', '2026-03-29T02:00', '2026-10-25T01:30', '2026-10-25T00:30', '2026-10-25T02:00',
  '2011-12-29T23:59', '2011-12-30T00:00', '2011-12-30T12:00', '2011-12-31T00:00', '2012-04-01T03:30', '2012-04-01T04:00',
  '2012-09-30T03:30', '2020-09-27T03:30', '2021-04-04T03:30', '2021-09-26T03:30', '1883-11-18T12:03:58', '1883-11-18T11:59',
  '1847-12-01T00:00', '1847-11-30T23:59', '1941-10-01T00:00', '1945-10-15T00:00', '1968-10-27T01:30', '1971-10-31T02:30',
  '1974-01-06T02:30', '1975-02-23T02:30', '2007-03-11T02:30', '2006-04-02T02:30', '1892-07-04T23:59', '1911-01-01T00:00',
];

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function int(rand: Rand, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function casing(rand: Rand, word: string): string {
  const roll = rand();
  if (roll < 0.15) return word.toUpperCase();
  if (roll < 0.3) return word.toLowerCase();
  if (roll < 0.35) return [...word].map((c) => (rand() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');
  return word;
}

function monthWord(rand: Rand): string {
  const month = pick(rand, MONTHS);
  const roll = rand();
  if (roll < 0.45) return casing(rand, month.slice(0, 3));
  if (roll < 0.85) return casing(rand, month);
  // A word sharing a month's first three letters, or nearly.
  return pick(rand, ['Septembre', 'Decimal', 'Marchand', 'Juni', 'Ja', 'Mayday', 'Oct.', 'Noc', 'Sept', 'Augustus']);
}

function year(rand: Rand): string {
  const roll = rand();
  if (roll < 0.45) return String(int(rand, 1990, 2035));
  if (roll < 0.65) return pad(int(rand, 0, 99), 2);
  if (roll < 0.72) return String(int(rand, 0, 99));
  if (roll < 0.8) return String(int(rand, 1800, 1969));
  if (roll < 0.86) return String(int(rand, 100, 999));
  if (roll < 0.92) return String(int(rand, 2036, 9999));
  return pick(rand, ['10000', '20000', '275760', '275761', '999999', '1000000', '1234567890123', '0000', '00049', '0050']);
}

function time(rand: Rand): string {
  const roll = rand();
  const twelve = rand() < 0.35;
  const hour = twelve ? int(rand, 0, 13) : int(rand, 0, 24);
  const minute = rand() < 0.95 ? int(rand, 0, 59) : int(rand, 60, 99);
  let text = `${rand() < 0.5 ? pad(hour, 2) : hour}:${pad(minute, 2)}`;
  if (roll < 0.6) text += `:${pad(rand() < 0.95 ? int(rand, 0, 59) : 60, 2)}`;
  if (roll < 0.25) text += `.${String(int(rand, 0, 999999)).slice(0, int(rand, 1, 6))}`;
  if (roll > 0.92) text = `${hour}::`;
  if (twelve) text += `${rand() < 0.6 ? ' ' : ''}${casing(rand, pick(rand, ['AM', 'PM', 'am', 'pm', 'a.m.', 'Pm']))}`;
  return text;
}

function offset(rand: Rand): string {
  const sign = rand() < 0.5 ? '+' : '-';
  const h = int(rand, 0, 14);
  const m = pick(rand, [0, 30, 45, 0, 0, 99]);
  return pick(rand, [
    `${sign}${pad(h, 2)}${pad(m, 2)}`, `${sign}${pad(h, 2)}:${pad(m, 2)}`, `${sign}${h}`, `GMT${sign}${h}`, `UTC${sign}${pad(h, 2)}${pad(m, 2)}`,
    `${sign}${pad(h, 2)}`, `GMT${sign}${pad(h, 2)}:${pad(m, 2)}`, `${sign}${h}${pad(m, 2)}`, `${sign}12345`, `${sign}`, `Z${sign}0100`,
  ]);
}

function comment(rand: Rand): string {
  return pick(rand, ['(Eastern Standard Time)', '(GMT)', '(a (nested) note)', '(unclosed', ')', '()', '(2026)', '((x)', '(India Standard Time)']);
}

/** The ES5 form, maybe with one defect. */
function isoish(rand: Rand): string {
  const y = int(rand, 1960, 2040);
  const mo = int(rand, 1, 12);
  const d = int(rand, 1, 31);
  const parts = [`${y}`, `-${pad(mo, 2)}`, `-${pad(d, 2)}`, `T${pad(int(rand, 0, 23), 2)}:${pad(int(rand, 0, 59), 2)}`, `:${pad(int(rand, 0, 59), 2)}`, `.${pad(int(rand, 0, 999), 3)}`];
  const keep = int(rand, 1, parts.length);
  let text = parts.slice(0, keep).join('');
  if (keep >= 4 && rand() < 0.55) text += pick(rand, ['Z', '+05:30', '-08:00', '+0100', 'z', '+24:00', '-00:00', '+5:30', ' Z', 'GMT']);
  if (rand() < 0.4) {
    const defects = [
      (t: string) => t.replace('T', ' '), (t: string) => t.replace('T', 't'), (t: string) => t.replace(/-(\d\d)-/, '-$1/'),
      (t: string) => t.replace(/^(\d{4})-\d\d/, '$1-13'), (t: string) => t.replace(/^(\d{4})-(\d)(\d)/, '$1-$3'), (t: string) => `${t}x`,
      (t: string) => ` ${t}`, (t: string) => `${t} `, (t: string) => t.replace('.', ','), (t: string) => t.replace(/T(\d\d)/, 'T24'),
      (t: string) => `+00${t}`, (t: string) => `-0${t}`, (t: string) => t.replace(/^(\d{4})/, '$1$1'), (t: string) => `${t} (UTC)`,
      (t: string) => t.replace(/T.*/, ''), (t: string) => t.toLowerCase(), (t: string) => t.replace(/:\d\d$/, ''),
    ];
    text = pick(rand, defects)(text);
  }
  return text;
}

function numericDate(rand: Rand): string {
  const sep = pick(rand, SEPARATORS);
  const a = String(rand() < 0.8 ? int(rand, 1, 12) : int(rand, 13, 40));
  const b = String(rand() < 0.8 ? int(rand, 1, 31) : int(rand, 32, 99));
  const order = rand();
  if (order < 0.5) return `${a}${sep}${b}${sep}${year(rand)}`;
  if (order < 0.7) return `${year(rand)}${sep}${a}${sep}${b}`;
  if (order < 0.85) return `${b}${sep}${a}${sep}${year(rand)}`;
  return `${a}${sep}${b}`;
}

function namedDate(rand: Rand): string {
  const m = monthWord(rand);
  const d = String(int(rand, 1, rand() < 0.9 ? 31 : 40));
  const y = year(rand);
  return pick(rand, [
    `${m} ${d}, ${y}`, `${d} ${m} ${y}`, `${m} ${d} ${y}`, `${y} ${m} ${d}`, `${d}-${m}-${y}`, `${m}-${d}-${y}`, `${m} ${d}`,
    `${d} ${m}`, `${m} ${y}`, `${d}${pick(rand, ['st', 'nd', 'rd', 'th'])} ${m} ${y}`, `${m}. ${d}, ${y}`, `${m}/${d}/${y}`,
  ]);
}

function legacy(rand: Rand): string {
  const pieces: string[] = [];
  if (rand() < 0.3) pieces.push(casing(rand, pick(rand, WEEKDAYS).slice(0, rand() < 0.5 ? 3 : 9)) + (rand() < 0.5 ? ',' : ''));
  if (rand() < 0.15) pieces.push(pick(rand, JUNK));
  pieces.push(rand() < 0.55 ? namedDate(rand) : numericDate(rand));
  if (rand() < 0.65) pieces.push(time(rand));
  const zone = rand();
  if (zone < 0.25) pieces.push(pick(rand, ZONE_WORDS));
  else if (zone < 0.45) pieces.push(offset(rand));
  if (rand() < 0.12) pieces.push(comment(rand));
  if (rand() < 0.08) pieces.push(pick(rand, JUNK));
  if (rand() < 0.1) {
    const i = int(rand, 0, pieces.length - 1);
    [pieces[i], pieces[pieces.length - 1]] = [pieces[pieces.length - 1]!, pieces[i]!];
  }
  return pieces.join(rand() < 0.9 ? ' ' : pick(rand, SPACES));
}

function oddity(rand: Rand): string {
  return pick(rand, [
    () => '', () => pick(rand, SPACES).repeat(int(rand, 1, 3)), () => pick(rand, UNICODE_DIGITS), () => `${pick(rand, UNICODE_DIGITS)}-01-01`,
    () => `Jan ${pick(rand, UNICODE_DIGITS)}`, () => String(int(rand, 0, 99999)), () => `${int(rand, 1, 9)}${'0'.repeat(int(rand, 5, 25))}`,
    () => `${'9'.repeat(int(rand, 8, 14))}-01-01`, () => `Jan 1 ${'1'.repeat(int(rand, 6, 12))}`, () => `${int(rand, 0, 30)}:${int(rand, 0, 70)}`,
    () => `+${pad(int(rand, 0, 300000), 6)}-0${int(rand, 1, 9)}-01T00:00Z`, () => `-${pad(int(rand, 0, 300000), 6)}-01-01`,
    () => pick(rand, ZONE_WORDS), () => `${pick(rand, JUNK)}${int(rand, 1, 30)}`, () => `${int(rand, 1, 12)}/${int(rand, 1, 28)}/${int(rand, 0, 99)}${pick(rand, JUNK)}`,
    () => `12:00 ${offset(rand)}`, () => `${pick(rand, BOUNDARIES)}`, () => `${int(rand, 1, 12)}.${int(rand, 1, 31)}.${int(rand, 0, 2040)}`,
    () => `0${int(rand, 0, 9)}/0${int(rand, 0, 9)}/000${int(rand, 0, 9)}`, () => `${pick(rand, MONTHS)}${int(rand, 1, 28)}`,
    () => `(${int(rand, 1, 12)}/${int(rand, 1, 28)}/2026)`, () => `1/1/2026 ${int(rand, 0, 30)}:${pad(int(rand, 0, 60), 2)}:${pad(int(rand, 0, 60), 2)}.${'0'.repeat(int(rand, 0, 12))}${int(rand, 0, 99)}`,
  ])();
}

/** A wall time near a daylight-saving change, in one of the forms that read
 *  it locally. */
function boundary(rand: Rand): string {
  const iso = pick(rand, BOUNDARIES);
  const [date, clock] = iso.split('T') as [string, string];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return pick(rand, [
    () => iso, () => `${date} ${clock}`, () => `${m}/${d}/${y} ${clock}`, () => `${MONTHS[m - 1]} ${d}, ${y} ${clock}`,
    () => `${d} ${MONTHS[m - 1]!.slice(0, 3)} ${y} ${clock} ${pick(rand, ['', 'GMT', 'EST', '+0000', 'PM'])}`.trim(), () => `${date}`,
    () => `${y}/${m}/${d}`,
  ])();
}

function dateText(rand: Rand): string {
  const roll = rand();
  if (roll < 0.25) return isoish(rand);
  if (roll < 0.7) return legacy(rand);
  if (roll < 0.85) return boundary(rand);
  return oddity(rand);
}

const msOrNull = (ms: number): number | null => (Number.isNaN(ms) ? null : ms);

export function writeDatesOracle(rand: Rand, write: Write): void {
  const texts: string[] = [];
  const seen = new Set<string>();
  while (texts.length < 6000) {
    const text = dateText(rand);
    if (seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  const format = stdlibFunctionById('date.format');
  if (format === undefined) throw new Error('no date.format');
  const saved = process.env.TZ;
  const resolved: string[] = [];
  const cases = texts.map((text) => ({ text, parse: [] as Array<number | null>, date: [] as unknown[], format: [] as unknown[], lt: [] as boolean[] }));
  try {
    for (const zone of DATE_ZONES) {
      process.env.TZ = zone;
      resolved.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
      for (const [i, c] of cases.entries()) {
        c.parse.push(msOrNull(Date.parse(c.text)));
        c.date.push(applyMovementFunction('date', [c.text]));
        c.format.push(applyStdlib(format, [c.text, FORMAT], new Date(0)));
        c.lt.push(compareValues(c.text, 'lt', texts[(i + 1) % texts.length]));
      }
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  const valid = cases.map((c) => c.parse.filter((ms) => ms !== null).length);
  const header = { tz: DATE_ZONES, zones: resolved, format: FORMAT, texts: cases.length, readInEveryZone: valid.filter((n) => n === DATE_ZONES.length).length };
  write('dates.json', `${JSON.stringify(header)}\n${cases.map((c) => JSON.stringify(c)).join('\n')}\n`);
  console.log(`dates.json: ${cases.length} texts × ${DATE_ZONES.length} zones`);
}
