// The committed patterns oracle (crates/movement-engine/tests/oracle/
// patterns.json) read without regenerating it: the generator holds each
// program to the reachability test's list of open gaps as it writes the
// file, but a gap closed later (its line removed from reachability_gaps.ts)
// would leave the committed file's programs still `unsupported` for it until
// someone reran generate.ts. This fails first.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PATTERNS_PRELUDE, type CaseRecord } from '../../../../../../crates/movement-engine/tests/oracle/patterns_oracle';
import { PATTERNS, type Ends } from '../../../../../../crates/movement-engine/tests/oracle/patterns_table';
import { KNOWN_GAPS } from 'movement-engine/services/movement_engine/__test__/reachability_gaps';

const ORACLE = path.resolve(__dirname, '../../../../../../crates/movement-engine/tests/oracle/patterns.json');

interface Committed {
  prelude: string;
  patterns: Array<{ name: string; ends: Ends; programs: number }>;
  cases: CaseRecord[];
}

const committed: Committed = JSON.parse(readFileSync(ORACLE, 'utf8'));

describe('the committed patterns oracle', () => {
  it('records a program unsupported only for a gap the reachability test still lists as open', () => {
    const wrong = committed.cases.filter((c) => c.ends === 'unsupported' && !KNOWN_GAPS.includes(c.reason ?? '')).map((c) => `${c.pattern}: ${c.reason ?? '(no reason)'}`);
    expect(wrong).toEqual([]);
  });

  it('is the table as it stands: every pattern, its programs counted, each run at version 5 after the prelude', () => {
    expect(committed.prelude).toBe(PATTERNS_PRELUDE);
    expect(committed.patterns.map((p) => p.name)).toEqual(PATTERNS.map((p) => p.name));
    expect(committed.patterns.map((p) => p.ends)).toEqual(PATTERNS.map((p) => p.ends));
    expect(committed.patterns.map((p) => p.programs)).toEqual(committed.patterns.map((p) => committed.cases.filter((c) => c.pattern === p.name).length));
    expect(committed.cases.filter((c) => (c.program.version ?? 5) < 5 || c.program.file === undefined).map((c) => c.pattern)).toEqual([]);
  });

  it('proves each pattern where it says it ends with a program that ends there', () => {
    const unproved = committed.patterns.filter((p) => !committed.cases.some((c) => c.pattern === p.name && c.ends === p.ends)).map((p) => p.name);
    expect(unproved).toEqual([]);
  });
});
