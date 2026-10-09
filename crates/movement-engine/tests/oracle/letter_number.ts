// Writes src/letter_number.rs: the code points JavaScript's `/[\p{L}\p{N}]/u`
// matches, as ranges, read off the Node this repository runs (its Unicode
// version is in the file's head). local_edge_adapter.ts splits a name into
// its words on `/[^\p{L}\p{N}]+/u`, which no Rust standard predicate
// reproduces (`char::is_alphabetic` also takes the combining marks that
// spell Indic vowels). Deterministic: a rerun on the same Node writes the
// same bytes.
//
// Regenerate from apps/api:
//   TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only \
//     ../../crates/movement-engine/tests/oracle/letter_number.ts

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const ranges: Array<[number, number]> = [];
let start = -1;
for (let code = 0; code <= 0x110000; code++) {
  const surrogate = code >= 0xd800 && code <= 0xdfff;
  const matches = code < 0x110000 && !surrogate && LETTER_OR_NUMBER.test(String.fromCodePoint(code));
  if (matches && start < 0) start = code;
  if (!matches && start >= 0) {
    ranges.push([start, code - 1]);
    start = -1;
  }
}
const hex = (code: number) => `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;
const rows = ranges.map(([from, to]) => `    (${hex(from)}, ${hex(to)}),`).join('\n');
const source = `//! The code points \`/[\\p{L}\\p{N}]/u\` matches in Node ${process.versions.node}
//! (Unicode ${process.versions.unicode}), as sorted inclusive ranges. Written by
//! tests/oracle/letter_number.ts; do not edit by hand.

/// Whether \`c\` is a letter or a number, as JavaScript's \`\\p{L}\` / \`\\p{N}\` read it.
pub fn is_letter_or_number(c: char) -> bool {
    let code = c as u32;
    RANGES.binary_search_by(|&(from, to)| if to < code { std::cmp::Ordering::Less } else if from > code { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal }).is_ok()
}

const RANGES: [(u32, u32); ${ranges.length}] = [
${rows}
];
`;
writeFileSync(path.join(__dirname, '../../src/letter_number.rs'), source);
