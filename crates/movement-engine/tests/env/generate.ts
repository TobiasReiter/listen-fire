// Writes fixture.json: Node's own answers to the environment services
// (crates/movement-engine/src/env_services.rs), through the module the
// loader imports for the WASM artifact (packages/movement-lang/wasm/
// env_services.ts), so the fixture IS what the artifact is answered. The
// native implementation is held to it by tests/env_services.rs.
// Seeded: a rerun writes the same bytes on the same Node and ICU.
//
// Regenerate from apps/api (for its ts-node and compiler settings):
//   TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only \
//     ../../crates/movement-engine/tests/env/generate.ts

// Before anything reads the clock: Node re-reads TZ when it is assigned.
process.env.TZ = 'UTC';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { answerEnvRequest, type EnvRequest } from '../../../../packages/movement-lang/wasm/env_services';

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
const random = mulberry32(20261007);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const cases: Array<{ request: EnvRequest; answer: unknown }> = [];
const ask = (request: EnvRequest) => cases.push({ request, answer: answerEnvRequest(request).value });

// ── tz_convert ────────────────────────────────────────────────────────────────

const ZONES = [
  ...Intl.supportedValuesOf('timeZone'),
  'UTC', 'Etc/UTC', 'utc', 'GMT', 'Etc/GMT+5', 'Etc/GMT-14', 'US/Eastern', 'US/Pacific', 'Asia/Calcutta', 'Asia/Saigon',
  'Europe/Kiev', 'europe/berlin', 'AMERICA/NEW_YORK', 'EST5EDT', 'CET', 'EST', 'MST', 'HST', 'Japan', 'Singapore',
  '+05:30', '-08', '+0530', '-00:00', '+14:00', '+24:00', '+05:60', '+5', 'Z', '', ' UTC', 'UTC ', 'Europe/Berlin/',
  'Mars/Base', 'Europe/Nowhere', 'Factory', 'Europe/../UTC', 'Europe_Berlin',
];
const YEAR_MS = 31_556_952_000;
const between = (fromYear: number, toYear: number) =>
  Math.floor((fromYear - 1970) * YEAR_MS + random() * (toYear - fromYear) * YEAR_MS);
for (const zone of ZONES) {
  // Mostly today's rules, a few a century back, and a daylight-saving week.
  const instants = [between(1990, 2040), between(1990, 2040), between(1970, 1990), between(1900, 1970)];
  const spring = Date.UTC(2026, 2, 29, 1, 0) + Math.floor(random() * 6) * 1_800_000 - 3 * 3_600_000;
  const autumn = Date.UTC(2026, 9, 25, 1, 0) + Math.floor(random() * 6) * 1_800_000 - 3 * 3_600_000;
  // And one before the common era, whose year Intl writes without a sign.
  const ancient = Date.UTC(-1800 + Math.floor(random() * 1700), 0, 1) + Math.floor(random() * YEAR_MS);
  for (const instant of [...instants, spring, autumn, ancient]) ask({ op: 'tz_convert', instantIso: new Date(instant).toISOString(), zone });
}

// The days the clocks change elsewhere: the US (2026-03-08, 2026-11-01) and
// the southern hemisphere (Sydney, 2026-04-05 / 2026-10-04), every half hour
// across each, in the zones that keep them.
const TRANSITIONS: Array<{ zones: string[]; days: number[] }> = [
  { zones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'US/Eastern', 'America/St_Johns'], days: [Date.UTC(2026, 2, 8), Date.UTC(2026, 10, 1)] },
  { zones: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Lord_Howe', 'Australia/Adelaide', 'Pacific/Auckland'], days: [Date.UTC(2026, 3, 5), Date.UTC(2026, 9, 4)] },
];
for (const { zones, days } of TRANSITIONS) {
  for (const zone of zones) {
    for (const day of days) {
      // From 18h before the local midnight to 30h after, wherever the zone sits.
      for (let at = day - 18 * 3_600_000; at <= day + 30 * 3_600_000; at += 1_800_000) {
        ask({ op: 'tz_convert', instantIso: new Date(at).toISOString(), zone });
      }
    }
  }
}

// ── url_parse ─────────────────────────────────────────────────────────────────

const SCHEMES = ['http://', 'https://', 'HTTPS://', 'ws://', 'wss://', 'ftp://', 'file://', 'git://', 'mailto:', 'http:', 'http:\\\\', 'x-y+z://', ''];
const USERS = ['', 'joe@', 'joe:pw@', ':pw@', '@', 'a@b@'];
const HOSTS = [
  'acme.com', 'WWW.Acme.COM', 'bücher.de', 'BÜCHER.de', 'xn--bcher-kva.de', '例え.テスト', 'münchen.example', 'ﬁnance.io',
  '⒈.com', 'ß.de', 'straße.de', 'faß.de', 'ἀθῆναι.gr', 'пример.рф', 'مثال.إختبار', '😀.ws', 'a.b.c.d.', 'xn--', 'xn--a',
  '127.0.0.1', '127.1', '0x7f.0.0.1', '1.2.3.4.', '256.0.0.1', '0300.0250.0.1', '[::1]', '[2001:db8::FFFF]', '[::ffff:1.2.3.4]',
  '[1::2::3]', 'a%41.com', '%zz.com', 'a b.com', 'a_b.com', 'a*b.com', 'ex%E4mple.com', 'localhost', '', 'a..b', '.a',
  'a\u200db.com', 'A\u0301.com', 'x\u00adn.com',
];
const PORTS = ['', ':', ':80', ':443', ':8080', ':0080', ':65535', ':65536', ':8a'];
const PATHS = ['', '/', '/x', '/a/../b', '/%7e/ü', '\\x', '?q=1', '#f', '/p?q#h', '/a b', '/./.'];
for (const scheme of SCHEMES) for (const host of HOSTS) ask({ op: 'url_parse', text: `${scheme}${host}` });
while (cases.filter((c) => c.request.op === 'url_parse').length < 1500) {
  ask({ op: 'url_parse', text: `${pick(SCHEMES)}${pick(USERS)}${pick(HOSTS)}${pick(PORTS)}${pick(PATHS)}` });
}
for (const text of [
  ' http://acme.com ', '\thttp://ac\tme.com/\n', 'http://acme.com\u0000', 'HTTP://ACME.com:080', 'mailto:a@b.com',
  'data:text/plain,hi', 'javascript:alert(1)', 'urn:isbn:0451450523', 'blob:https://a.com/x', 'about:blank', 'http://',
  'http:///acme.com', 'https:acme.com', 'http://acme.com:99999999999999999999', 'file:///C:/x', 'file://host/share',
  'non-special://Host/x', 'sc://ñ/x', 'sc://%/', 'http://[::1]:8080/', 'not a url', '', '//acme.com',
]) ask({ op: 'url_parse', text });

// ── normalize ─────────────────────────────────────────────────────────────────

const UNITS = [
  'a', 'E', 'é', 'e\u0301', 'Å', 'A\u030a', '\u212b', 'ñ', 'n\u0303', 'ß', 'ẞ', 'ﬁ', 'ﬀ', '①', '½', '㎞', '™', 'ｶ', 'ｶﾞ',
  '가', '\u1100\u1161', '\u1100\u1161\u11a8', 'ǆ', 'Ǆ', 'ϒ', 'ϔ', '\u0344', 'ﷺ', 'ﻼ', '\u0958', '\u2126', 'ḱ', '\u1e9b\u0323',
  'q\u0307\u0323', '\u0301\u0300', '\u0300\u0301', '\u0f73', '𝐀', '😀', '\ufb2c', '\u00a0', '\u2002', ' ', '-', '1', 'Ⅻ',
  '\u3300', '\u33ff', 'ﾟ', '\ud55c', '\u0915\u093c', 'é\u0328', 'ǖ',
];
const FORMS = ['NFC', 'NFD', 'NFKC', 'NFKD'] as const;
for (const unit of UNITS) for (const form of FORMS) ask({ op: 'normalize', text: unit, form });
for (let i = 0; i < 800; i++) {
  let text = '';
  const length = 1 + Math.floor(random() * 8);
  for (let j = 0; j < length; j++) text += pick(UNITS);
  ask({ op: 'normalize', text, form: pick(FORMS) });
}

// ── number_format ─────────────────────────────────────────────────────────────

// Not de-CH: ICU4C 77 groups it with ’ and ICU4X 2.3's data with ' (an
// accepted divergence, crates/movement-engine/README.md).
const LOCALES = ['en-US', 'en-GB', 'en-IN', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'sv-SE', 'pl-PL', 'ru-RU', 'ja-JP', 'hi-IN'];
// No -0: JSON writes it as 0, so the fixture could not say which it asked.
const VALUES = [0, 1, -1, 0.5, 1.005, 2.5, -2.5, 1234, 12345.678, 1_000_000, -9876543.21, 0.000123, 1e21, 123456789.125];
const OPTIONS = [
  {}, { maximumFractionDigits: 0 }, { maximumFractionDigits: 2 }, { minimumFractionDigits: 2 },
  { minimumFractionDigits: 1, maximumFractionDigits: 1 }, { useGrouping: false }, { useGrouping: false, maximumFractionDigits: 1 },
];
for (const locale of LOCALES) for (const value of VALUES) ask({ op: 'number_format', value, locale, options: pick(OPTIONS) });
for (let i = 0; i < 400; i++) {
  const magnitude = 10 ** Math.floor(random() * 12 - 4);
  const value = Math.round((random() - 0.3) * magnitude * 1000) / 1000 + 0;
  ask({ op: 'number_format', value, locale: pick(LOCALES), options: pick(OPTIONS) });
}

const { tz, icu, unicode, cldr } = process.versions;
writeFileSync(path.join(__dirname, 'versions.json'), `${JSON.stringify({ node: process.version, tz, icu, unicode, cldr }, null, 2)}\n`);
writeFileSync(path.join(__dirname, 'fixture.json'), `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
const by = (op: string) => cases.filter((c) => c.request.op === op).length;
console.log(`fixture.json: ${cases.length} cases (tz_convert ${by('tz_convert')}, url_parse ${by('url_parse')}, normalize ${by('normalize')}, number_format ${by('number_format')})`);
