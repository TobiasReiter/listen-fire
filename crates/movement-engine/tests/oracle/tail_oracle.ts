// The TypeScript engine's runtime accidents (behaviours that come from V8,
// Node or zod rather than from the language's design), each written by the
// TypeScript's own code for tests/tail_oracle.rs to hold the Rust engine to.
// One file per accident, each from its own seed; written by generate.ts;
// deterministic.
//
//   - file_bound.json: a source file's text bounded for the prompt
//     (extraction.ts `boundFileText`) under a seeded `EXTRACTION_FILE_CHARS`,
//     fractional ones included: the content, the marker, and the `chars`
//     the trace reports.
//   - case_mapping.json: `LOWER` and `UPPER` of seeded texts (builtins.ts
//     `applyMovementFunction`, so `toLowerCase` / `toUpperCase` over Node's
//     ICU), the final sigma's contexts among them.
//   - mixed_sort.json: ORDER BY / `SORT` keys that mix numbers with texts
//     and other kinds, past V8's 64-item insertion sort (order_limit.ts
//     `sortByOrderKey`, so V8's TimSort over a comparator no total order
//     agrees with): the order the items land in.

import type { FileRef } from '../../../../apps/api/src/services/translation_graph/adapter';
import { applyMovementFunction } from '../../../../apps/api/src/services/movement_engine/builtins';
import { boundFileText, maxFileChars } from '../../../../apps/api/src/services/movement_engine/extraction';
import { sortByOrderKey } from '../../../../packages/shared/expression/order_limit';

type Rand = () => number;
type Write = (name: string, text: string) => void;

/** Every accident's oracle, each from its own seed. */
export async function writeTailOracles(seeded: (seed: number) => Rand, write: Write): Promise<void> {
  writeFileBoundOracle(seeded(20261012), write);
  writeCaseMappingOracle(seeded(20261013), write);
  await writeMixedSortOracle(seeded(20261014), write);
}

const lines = (cases: unknown[]): string => `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`;

// ── file_bound.json ───────────────────────────────────────────────────────────

/** A deployment's setting as written: whole, fractional, exponent and hex
 *  forms, and the ones `maxFileChars` replaces with its default. */
function fileCharsSetting(rand: Rand): string {
  const whole = Math.floor(rand() * 12);
  const forms = [
    () => String(whole),
    () => String(whole + [0.5, 0.25, 0.1, 0.999, 1e-9, 0.75][Math.floor(rand() * 6)]!),
    () => `${whole}.${Math.floor(rand() * 1000)}`,
    () => `${(whole + 0.5) / 10}e1`,
    () => ` ${whole}.5 `,
    () => '0x8',
    () => ['0', '-2.5', 'Infinity', 'abc', '', '1e400'][Math.floor(rand() * 6)]!,
  ];
  return forms[Math.floor(rand() * forms.length)]!();
}

const FILE_UNITS = ['a', 'b', ' ', '\n', 'é', 'ß', '中', '1', '.'];

function writeFileBoundOracle(rand: Rand, write: Write): void {
  const ref: FileRef = { __brand: 'FileRef', name: 'f.pdf' };
  const cases: unknown[] = [];
  const saved = process.env.EXTRACTION_FILE_CHARS;
  try {
    for (let i = 0; i < 600; i++) {
      const setting = fileCharsSetting(rand);
      process.env.EXTRACTION_FILE_CHARS = setting;
      const ceiling = maxFileChars();
      if (ceiling >= 50_000) continue;
      const length = Math.floor(rand() * 16);
      let text = '';
      for (let u = 0; u < length; u++) text += FILE_UNITS[Math.floor(rand() * FILE_UNITS.length)]!;
      const bounded = boundFileText({ text, ref });
      cases.push({ setting, ceiling, text, ...bounded });
    }
  } finally {
    if (saved === undefined) delete process.env.EXTRACTION_FILE_CHARS;
    else process.env.EXTRACTION_FILE_CHARS = saved;
  }
  write('file_bound.json', lines(cases));
  console.log(`file_bound.json: ${cases.length} cases`);
}

// ── case_mapping.json ─────────────────────────────────────────────────────────

/** Characters whose case mapping is where engines part: the sigma and what
 *  it reads around it (cased letters, case-ignorable marks and
 *  punctuation, a letter both cased and ignorable), expansions (`ß`, `ŉ`,
 *  `İ`, the iota subscripts, ligatures), titlecase digraphs, and scripts whose
 *  case Unicode added late (Cherokee, Georgian Mtavruli, Garay). */
const CASE_UNITS = [
  'Σ', 'σ', 'ς', 'A', 'a', '1', ' ', '.', "'", ':', 'ͅ', '́', '­', '‍', 'ʕ', 'ʰ', 'ª', 'İ', 'I', 'ı', 'ß', 'ẞ',
  'ŉ', 'ǅ', 'Ǆ', 'ᾳ', 'ᾼ', 'ΐ', 'Ω', 'ﬀ', 'ﬃ', 'ŀ', 'µ', 'ÿ', 'ſ', 'K', 'Ⅷ', 'ⓐ', 'Ꭰ', 'ꭰ', 'ა', 'Ა', '𐐀', '𐐨', '𞤀', '𐵐', '𐵰',
  'Ꞔ', 'ꟊ', 'Ɤ', '中', 'é', 'É',
  // Cased only from Unicode 17, which Rust's own tables follow and Node 22's
  // ICU does not: Latin additions and Beria Erfe.
  '\uA7CE', '\uA7D3', '\u{16EA0}', '\u{16EBB}',
];

function caseText(rand: Rand): string {
  const length = Math.floor(rand() * 9);
  let text = '';
  for (let i = 0; i < length; i++) {
    if (rand() < 0.15) {
      let code = Math.floor(rand() * 0x110000);
      if (code >= 0xd800 && code <= 0xdfff) code -= 0x800;
      text += String.fromCodePoint(code);
    } else {
      text += CASE_UNITS[Math.floor(rand() * CASE_UNITS.length)]!;
    }
  }
  return text;
}

function writeCaseMappingOracle(rand: Rand, write: Write): void {
  const cases: unknown[] = [];
  for (let i = 0; i < 4000; i++) {
    const text = caseText(rand);
    cases.push({ text, lower: applyMovementFunction('lower', [text]), upper: applyMovementFunction('upper', [text]) });
  }
  write('case_mapping.json', lines(cases));
  console.log(`case_mapping.json: ${cases.length} cases`);
}

// ── mixed_sort.json ───────────────────────────────────────────────────────────

/** The eval wire's form of a key (crates/movement-engine/src/env.rs). */
function wireKey(value: unknown): unknown {
  if (value === undefined) return ['u'];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['n', String(value)];
  if (Array.isArray(value)) return ['l', 0, value.map(wireKey)];
  return value;
}

/** One key: a number, a numeric text (whose text and numeric orders
 *  disagree), a text, a boolean, an empty, a list. */
function mixedKey(rand: Rand): unknown {
  const roll = rand();
  if (roll < 0.35) return Math.floor(rand() * 200) - 20;
  if (roll < 0.55) return String(Math.floor(rand() * 200));
  if (roll < 0.7) return ['Acme', 'acme', 'Z', '', 'Ümlaut', 'b', '1e3', ' 7'][Math.floor(rand() * 8)];
  if (roll < 0.78) return rand() < 0.5;
  if (roll < 0.86) return rand() < 0.5 ? null : undefined;
  if (roll < 0.92) return [rand() < 0.5 ? 'a' : 3];
  return [1.5, NaN, Infinity, -0.5][Math.floor(rand() * 4)];
}

/** Keys laid out in runs (ascending, descending, constant) so V8's run
 *  detection, merges and galloping all see work. */
function mixedKeys(rand: Rand, count: number): unknown[] {
  const keys: unknown[] = [];
  while (keys.length < count) {
    const run = 1 + Math.floor(rand() * (rand() < 0.3 ? 80 : 12));
    const shape = rand();
    let base = Math.floor(rand() * 100);
    for (let i = 0; i < run && keys.length < count; i++) {
      if (shape < 0.3) keys.push(mixedKey(rand));
      else if (shape < 0.55) keys.push(base++);
      else if (shape < 0.7) keys.push(String(base--));
      else if (shape < 0.85) keys.push(rand() < 0.5 ? base : String(base));
      else keys.push(base + (rand() < 0.5 ? 0 : 1));
    }
  }
  return keys;
}

async function writeMixedSortOracle(rand: Rand, write: Write): Promise<void> {
  const cases: unknown[] = [];
  for (let i = 0; i < 400; i++) {
    const roll = rand();
    const count = roll < 0.1 ? 1 + Math.floor(rand() * 64) : roll < 0.9 ? 65 + Math.floor(rand() * 300) : 400 + Math.floor(rand() * 1600);
    const keys = mixedKeys(rand, count);
    const direction = (['asc', 'desc', undefined] as const)[Math.floor(rand() * 3)];
    const order = await sortByOrderKey(keys.map((_, index) => index), direction, { value: async (index) => keys[index] });
    cases.push({ direction: direction ?? null, keys: keys.map(wireKey), order });
  }
  write('mixed_sort.json', lines(cases));
  console.log(`mixed_sort.json: ${cases.length} cases`);
}
