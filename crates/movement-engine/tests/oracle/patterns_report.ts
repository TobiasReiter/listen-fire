// The retirement report: every admission pattern the Rust engine's port list
// names (and every one chunk 7A closed), whether its programs run whole on
// the Rust engine, and the reason where one does not — read from the
// committed patterns.json, which generate.ts writes by running each program
// on both engines (patterns_oracle.ts).
//
//   pnpm engine:patterns            the table
//   pnpm engine:patterns --refused  only the patterns still refused or declined
//   pnpm engine:patterns --json     the same, as JSON
//
// A pattern is `whole` when every program the generator holds for it runs
// whole on Rust and agrees with the TypeScript engine; `refused` or
// `declined` when one still does not (by the reason named); `unreached` when
// no program reaches it through the real shim (the checker or the parser
// refuses every one, or it is an input fault the shim never sends).

import { readFileSync } from 'node:fs';
import path from 'node:path';

interface PatternRow {
  reason: string;
  routes: 'whole' | 'refused' | 'declined' | 'unreached';
  note: string;
  programs: number;
}

interface CaseRow {
  pattern: string;
  routes: 'whole' | 'refused' | 'declined' | 'unreached';
  reasons: string[];
  agreement?: 'exact' | 'kit' | 'check';
}

const oracle = JSON.parse(readFileSync(path.join(__dirname, 'patterns.json'), 'utf8')) as { seed: number; patterns: PatternRow[]; cases: CaseRow[] };

const rows = oracle.patterns.map((pattern) => {
  const cases = oracle.cases.filter((c) => c.pattern === pattern.reason);
  const count = (routes: CaseRow['routes']) => cases.filter((c) => c.routes === routes).length;
  const reasons = [...new Set(cases.filter((c) => c.routes !== 'whole').flatMap((c) => c.reasons))];
  return {
    reason: pattern.reason,
    status: pattern.routes,
    programs: cases.length,
    whole: count('whole'),
    exact: cases.filter((c) => c.agreement === 'exact').length,
    refused: count('refused'),
    declined: count('declined'),
    reasons,
    note: pattern.note,
  };
});

const args = process.argv.slice(2);
const shown = args.includes('--refused') ? rows.filter((r) => r.status === 'refused' || r.status === 'declined') : rows;

if (args.includes('--json')) {
  console.log(JSON.stringify({ seed: oracle.seed, patterns: shown }, null, 2));
} else {
  const by = (status: string) => rows.filter((r) => r.status === status).length;
  console.log(
    `${rows.length} patterns, ${oracle.cases.length} programs (seed ${oracle.seed}): ${by('whole')} whole, ${by('refused')} refused, ${by('declined')} declined, ${by('unreached')} unreached through the real shim\n`,
  );
  console.log('| pattern | status | programs | whole on Rust (exactly) | refused / declined for | note |');
  console.log('|---|---|---|---|---|---|');
  for (const r of shown) {
    console.log(`| \`${r.reason}\` | ${r.status} | ${r.programs} | ${r.whole} (${r.exact}) | ${r.reasons.map((x) => `\`${x}\``).join(', ') || '—'} | ${r.note} |`);
  }
}
