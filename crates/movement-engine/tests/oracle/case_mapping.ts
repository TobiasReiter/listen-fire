// Writes src/case_mapping.rs: JavaScript's `toLowerCase` and `toUpperCase`
// as the Node this repository runs reads them (V8 over Node's ICU; the
// versions are in the file's head), so the engine's case mapping is pinned to
// that data and not to whichever Unicode the Rust toolchain's tables carry.
//
// What it reads off Node:
//   - every code point's mapping on its own (`String.fromCodePoint(c)
//     .toLowerCase()`), which is the whole mapping in the root locale but for
//     one context: a capital sigma that ends a word lowers to `ς`;
//   - for that rule, how each code point counts as a neighbour, probed
//     through `toLowerCase` itself: "cased" when `1xΣ` lowers to a final
//     sigma, "ignorable" (skipped over) when `AxΣ` does and `1xΣ` does not.
//     ICU checks a neighbour's ignorability before its case, so a code point
//     both cased and case-ignorable (U+0345) is skipped, and this reads that
//     off the behaviour rather than off two property tables.
// Deterministic: a rerun on the same Node writes the same bytes.
//
// Regenerate from apps/api:
//   TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only \
//     ../../crates/movement-engine/tests/oracle/case_mapping.ts

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const hex = (code: number) => `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;

function* codePoints(): Generator<number> {
  for (let code = 0; code < 0x110000; code++) if (code < 0xd800 || code > 0xdfff) yield code;
}

/** Runs of code points that map one to one by a common offset, every
 *  `stride`th code point from `start`: `(start, count, stride, delta)`. */
type Run = [number, number, number, number];

interface Mapping {
  runs: Run[];
  /** Code points that map to more than one, or to a lone code point the
   *  runs cannot hold. */
  expansions: Array<[number, string]>;
}

function mappingOf(map: (text: string) => string): Mapping {
  const singles: Array<[number, number]> = [];
  const expansions: Array<[number, string]> = [];
  for (const code of codePoints()) {
    const from = String.fromCodePoint(code);
    const to = map(from);
    if (to === from) continue;
    const points = [...to];
    if (points.length === 1) singles.push([code, points[0]!.codePointAt(0)!]);
    else expansions.push([code, to]);
  }
  const runs: Run[] = [];
  for (const [code, mapped] of singles) {
    const delta = mapped - code;
    const last = runs[runs.length - 1];
    if (last !== undefined && last[3] === delta) {
      const end = last[0] + (last[1] - 1) * last[2];
      const gap = code - end;
      if (last[1] === 1 && (gap === 1 || gap === 2)) {
        last[2] = gap;
        last[1] = 2;
        continue;
      }
      if (last[1] > 1 && gap === last[2]) {
        last[1] += 1;
        continue;
      }
    }
    runs.push([code, 1, 1, delta]);
  }
  return { runs, expansions };
}

/** Sorted inclusive ranges of the code points `test` holds for. */
function rangesOf(test: (code: number) => boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = -1;
  let previous = -2;
  for (const code of codePoints()) {
    const holds = test(code);
    if (holds && (start < 0 || code !== previous + 1)) {
      if (start >= 0) ranges.push([start, previous]);
      start = code;
    }
    if (!holds && start >= 0) {
      ranges.push([start, previous]);
      start = -1;
    }
    if (holds) previous = code;
  }
  if (start >= 0) ranges.push([start, previous]);
  return ranges;
}

const finalSigma = (text: string) => text.toLowerCase().endsWith('ς');
const cased = rangesOf((code) => finalSigma(`1${String.fromCodePoint(code)}Σ`));
const ignorable = rangesOf((code) => {
  const x = String.fromCodePoint(code);
  return finalSigma(`A${x}Σ`) && !finalSigma(`1${x}Σ`);
});

const lower = mappingOf((text) => text.toLowerCase());
const upper = mappingOf((text) => text.toUpperCase());

const runRows = (runs: Run[]) => runs.map(([s, n, k, d]) => `    (${hex(s)}, ${n}, ${k}, ${d}),`).join('\n');
const expansionRows = (rows: Array<[number, string]>) =>
  rows.map(([code, to]) => `    (${hex(code)}, "${[...to].map((c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`).join('')}"),`).join('\n');
const rangeRows = (ranges: Array<[number, number]>) => ranges.map(([from, to]) => `    (${hex(from)}, ${hex(to)}),`).join('\n');

const source = `//! JavaScript's \`toLowerCase\` and \`toUpperCase\` as Node ${process.versions.node} reads them
//! (V8 over ICU ${process.versions.icu}, Unicode ${process.versions.unicode}). Written by
//! tests/oracle/case_mapping.ts; do not edit by hand.

/// Each code point's mapping on its own: \`(start, count, stride, delta)\`
/// runs, every \`stride\`th code point from \`start\` mapping to itself plus
/// \`delta\`, and the code points that map to more than one.
pub(crate) struct Mapping {
    pub(crate) runs: &'static [(u32, u32, u32, i32)],
    pub(crate) expansions: &'static [(u32, &'static str)],
}

pub(crate) const LOWER: Mapping = Mapping { runs: &LOWER_RUNS, expansions: &LOWER_EXPANSIONS };
pub(crate) const UPPER: Mapping = Mapping { runs: &UPPER_RUNS, expansions: &UPPER_EXPANSIONS };

/// The code points a final sigma's neighbour counts as cased.
pub(crate) const CASED: &[(u32, u32)] = &CASED_RANGES;
/// The code points the final-sigma rule skips over.
pub(crate) const IGNORABLE: &[(u32, u32)] = &IGNORABLE_RANGES;

const LOWER_RUNS: [(u32, u32, u32, i32); ${lower.runs.length}] = [
${runRows(lower.runs)}
];

const LOWER_EXPANSIONS: [(u32, &str); ${lower.expansions.length}] = [
${expansionRows(lower.expansions)}
];

const UPPER_RUNS: [(u32, u32, u32, i32); ${upper.runs.length}] = [
${runRows(upper.runs)}
];

const UPPER_EXPANSIONS: [(u32, &str); ${upper.expansions.length}] = [
${expansionRows(upper.expansions)}
];

const CASED_RANGES: [(u32, u32); ${cased.length}] = [
${rangeRows(cased)}
];

const IGNORABLE_RANGES: [(u32, u32); ${ignorable.length}] = [
${rangeRows(ignorable)}
];
`;
writeFileSync(path.join(__dirname, '../../src/case_mapping.rs'), source);
console.log(`case_mapping.rs: lower ${lower.runs.length} runs + ${lower.expansions.length}, upper ${upper.runs.length} runs + ${upper.expansions.length}, cased ${cased.length}, ignorable ${ignorable.length}`);
