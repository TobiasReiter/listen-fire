// The patterns report: every pattern of the language patterns.json holds,
// where its programs end on the Rust engine (the version 5 reference), and
// the reason where one is refused — read from the committed patterns.json,
// which generate.ts writes by running each program (patterns_oracle.ts).
//
//   pnpm engine:patterns              the table
//   pnpm engine:patterns --unsupported only the patterns with a program the
//                                      engine refuses after a clean check
//   pnpm engine:patterns --json       the same, as JSON
//
// A program ends `whole` (run to its result or its own runtime failure),
// `at_check` (refused before a segment opens), `unsupported` (checked clean,
// then refused by the engine: an open gap reachability_gaps.ts lists),
// `unrecordable` (an event the eval wire cannot carry) or `state_refused`
// (a resume whose parked state does not read).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { CaseRecord } from './patterns_oracle';
import type { Ends } from './patterns_table';

interface PatternRow {
  name: string;
  ends: Ends;
  note: string;
  programs: number;
}

const oracle = JSON.parse(readFileSync(path.join(__dirname, 'patterns.json'), 'utf8')) as { seed: number; patterns: PatternRow[]; cases: CaseRecord[] };

const rows = oracle.patterns.map((pattern) => {
  const cases = oracle.cases.filter((c) => c.pattern === pattern.name);
  const count = (ends: Ends) => cases.filter((c) => c.ends === ends).length;
  return {
    name: pattern.name,
    ends: pattern.ends,
    programs: cases.length,
    whole: count('whole'),
    atCheck: count('at_check'),
    unsupported: count('unsupported'),
    reasons: [...new Set(cases.flatMap((c) => (c.reason !== undefined ? [c.reason] : [])))],
    note: pattern.note,
  };
});

const args = process.argv.slice(2);
const shown = args.includes('--unsupported') ? rows.filter((r) => r.unsupported > 0) : rows;

if (args.includes('--json')) {
  console.log(JSON.stringify({ seed: oracle.seed, patterns: shown }, null, 2));
} else {
  const count = (ends: Ends) => oracle.cases.filter((c) => c.ends === ends).length;
  console.log(
    `${rows.length} patterns, ${oracle.cases.length} programs (seed ${oracle.seed}): ${count('whole')} whole, ${count('at_check')} at the check, ${count('unsupported')} unsupported, ${count('unrecordable')} unrecordable, ${count('state_refused')} parked states refused\n`,
  );
  console.log('| pattern | ends | programs | whole | at the check | unsupported | reasons | note |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of shown) {
    console.log(`| \`${r.name}\` | ${r.ends} | ${r.programs} | ${r.whole} | ${r.atCheck} | ${r.unsupported} | ${r.reasons.map((x) => `\`${x}\``).join(', ') || '—'} | ${r.note} |`);
  }
}
