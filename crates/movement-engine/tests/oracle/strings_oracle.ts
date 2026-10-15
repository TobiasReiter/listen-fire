// Strings as JavaScript holds them — any run of UTF-16 code units, a lone
// surrogate included — for tests/stdlib_oracle.rs to hold the Rust engine's
// string type to (crate::js_string). Seeded texts (seed 20261016) are built
// from pieces chosen for the hazards: lone high and low halves, pairs (which
// two lone halves written side by side become), astral and BMP letters, a
// combining mark, the final sigma, and the two characters the Rust engine's
// in-band escape is made of (U+FDD0 and U+100000), which a text may hold as
// itself. Over each, through the TypeScript's own code:
//
//   - the built-ins (builtins.ts `applyMovementFunction`, stdlib.ts
//     `applyStdlib`): TRIM, LOWER, UPPER, LENGTH, TOSTRING, TONUMBER, SPLIT
//     (`""` and lone-half separators among them), TEXT.REGEX_EXTRACT (a
//     pattern's `.` is one code unit), TEXT.SLUG, TEXT.PAIRS,
//     TEXT.SERIALISE (keys too), URL.HOST (WHATWG's `new URL`), and a date
//     read through V8's parser;
//   - the comparator (filter.ts `compareValues`): `==`, `<`, `CONTAINS`;
//   - cuts: `slice(0, n)` at every unit, and a file bounded for the prompt
//     (extraction.ts `boundFileText`), which keep the half on their side;
//   - JSON: `JSON.stringify(text)` (a lone half escaped `\udXXX`), and a JSON
//     text holding texts as keys and values, which the Rust engine's JSON
//     reader must read as `JSON.parse` does and its writer write back as
//     `JSON.stringify` does.
//
// Cases are `{fn, args, outcome}` in the eval wire format (./wire.ts), as
// stdlib.json's are.

import { applyMovementFunction } from '../../../../packages/movement-engine/services/movement_engine/builtins';
import { boundFileText, maxFileChars } from '../../../../packages/movement-engine/services/movement_engine/extraction';
import type { FileRef } from '../../../../packages/movement-engine/services/translation_graph/adapter';
import { applyStdlib, coerceToDatetime, stdlibFunctionById } from '../../../../packages/movement-lang/expression/stdlib';
import { compareValues } from '../../../../packages/shared/expression/filter';
import { outcome, wire } from './wire';

type Rand = () => number;
type Write = (name: string, text: string) => void;

const PIECES = [
  'a', 'b', 'x', ' ', '-', ',', '.', '1', 'A', 'Σ', 'é', '́', '\n',
  '\uD83D', '\uDE00', '\uDBFF', '\uDC00', '\uD800', '\uDFFF',
  '😀', '𝒜', '￿', '﷐', '􀀀',
];

const SEPARATORS = ['', ',', ' ', 'a', '\uD83D', '\uDE00', '😀', '﷐', '􀀀', '﷐\uDBC0'];

const PATTERNS = ['.', '(.)(.)', '[^a]+', '\\uD83D', '[\\uD800-\\uDBFF]', '[\\uDC00-\\uDFFF]+', '\\s(.)', '(.)$', '^.', 'a|\\uDE00', '\\uFDD0.'];

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function text(rand: Rand): string {
  const length = Math.floor(rand() * 7);
  let out = '';
  for (let i = 0; i < length; i++) out += pick(rand, PIECES);
  return out;
}

export function writeStringsOracle(rand: Rand, write: Write): void {
  const cases: Array<{ fn: string; args: unknown[]; outcome: unknown }> = [];
  const flat = (id: string, args: unknown[]) => cases.push({ fn: `flat.${id}`, args: args.map(wire), outcome: outcome(() => applyMovementFunction(id, args)) });
  const stdlib = (id: string, args: unknown[]) => {
    const spec = stdlibFunctionById(id);
    if (spec === undefined) throw new Error(`no ${id}`);
    cases.push({ fn: id, args: args.map(wire), outcome: outcome(() => applyStdlib(spec, args, new Date(0))) });
  };
  const texts = Array.from({ length: 400 }, () => text(rand));
  for (const t of texts) {
    for (const id of ['trim', 'lower', 'upper', 'length', 'tostring', 'tonumber']) flat(id, [t]);
    flat('split', [t, pick(rand, SEPARATORS)]);
    flat('split', [t, '']);
    stdlib('text.regex_extract', [t, pick(rand, PATTERNS)]);
    stdlib('text.regex_extract', [t, '(.)(.)', 2]);
    stdlib('text.slug', [t]);
    stdlib('text.serialise', [{ [t]: t, k: [t] }, 'JSON']);
    stdlib('text.pairs', [{ [t]: t }]);
    // `new URL` reads a USVString: a lone half is U+FFFD to it.
    stdlib('url.host', [`https://a${t}.example/x`]);
    stdlib('url.host', [`${t}.example`]);
    cases.push({ fn: 'coerce.datetime', args: [wire(`Mar${t} 12 2026`)], outcome: outcome(() => coerceToDatetime(`Mar${t} 12 2026`)) });
    const other = pick(rand, texts);
    for (const op of ['eq', 'lt', 'contains'] as const) {
      cases.push({ fn: `compare.${op}`, args: [wire(t), wire(other)], outcome: outcome(() => compareValues(t, op, other)) });
    }
    for (let n = 0; n <= t.length; n++) cases.push({ fn: 'slice', args: [wire(t), n], outcome: outcome(() => t.slice(0, n)) });
    cases.push({ fn: 'json.quote', args: [wire(t)], outcome: { value: JSON.stringify(t) } });
    const json = JSON.stringify({ [t]: [t, `${t}${other}`] });
    cases.push({ fn: 'json.text', args: [json], outcome: { value: wire(JSON.parse(json)) } });
  }
  // A file bounded for the prompt: the cut at the ceiling keeps the half on
  // its side.
  const ref: FileRef = { __brand: 'FileRef', name: 'f.pdf' };
  const saved = process.env.EXTRACTION_FILE_CHARS;
  try {
    for (const t of texts) {
      const setting = String(Math.floor(rand() * 6));
      process.env.EXTRACTION_FILE_CHARS = setting;
      const ceiling = maxFileChars();
      const bounded = boundFileText({ text: t, ref });
      cases.push({ fn: 'bound', args: [wire(t), ceiling], outcome: { value: wire([bounded.content, bounded.chars, bounded.truncatedFrom ?? null]) } });
    }
  } finally {
    if (saved === undefined) delete process.env.EXTRACTION_FILE_CHARS;
    else process.env.EXTRACTION_FILE_CHARS = saved;
  }
  write('strings.json', `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
  console.log(`strings.json: ${cases.length} cases`);
}
