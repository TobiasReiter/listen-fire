// The upgrade loop over every version 4 program the repository pins: the
// checks corpus's version 4 records (the v4 conformance suites, this package's
// tests and the engine's) and the engine oracle's handles (version 4). Each
// that checks clean under 4 either upgrades to clean under 5, or is reported
// with why, by cause:
//
//   - a version 5 rule: the original text, read under 4's grammar and checked
//     under 5's rules, is refused the same way — no rewrite of the spelling
//     could fix it; a person has to change the program;
//   - the rewrite: only the rewritten text is refused — the old spelling's fix
//     produced text that 5 does not read as the old text meant.
//
// The rate is pinned as a floor that only moves up.

import { checkSourceInRust } from '../rust_checker';
import { checkProgram, diagnosticSeverity, type Diagnostic } from '../check';
import { parseProgram } from '../../parser/parse';
import { fromCatalogSnapshot, resolveFileFromSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import { loadChecks, loadSnapshots, snapshotOf } from '../../conformance/checks_corpus';
import { rustCheck, upgradeSource } from '../upgrade';

declare function require(id: string): unknown;
const path = require('path') as { join(...parts: string[]): string };
const fs = require('fs') as { readFileSync(path: string, encoding: 'utf8'): string };

const FIXTURES = path.join(__dirname, '__fixtures__');
const ORACLE = path.join(__dirname, '../../../../crates/movement-engine/tests/oracle/handles.json');

/** 2026-10-16, at the v5 surface spine: 3,127 of 3,468 checks records.
 *  2026-10-16, v5b-upgrade: 4,082 of 4,449 programs (91.8%).
 *  Lowered the same day by Henry's ruling retiring the extraction keyword
 *  (MOV_EXTRACT_KEYWORD_RETIRED, whose fix is never safe, so the loop leaves
 *  it for a person): 3,862 of 4,449, with 241 programs left holding it.
 *  Lowered again by the upgrade warning on ORDER BY / LIMIT over records the
 *  run holds (MOV_IN_MEMORY_HOP_ORDER, which 4 ignored and 5 reads, so a
 *  person decides): 4,903 of 5,667, with 104 programs left holding it.
 *  Lowered again by MOV_EVENT_UNDESCRIBED (a read or write off an event the
 *  catalog does not describe is refused from 5, and only a person can describe
 *  it): 4,890 of 5,673, with 27 programs left holding it.
 *  Re-harvested at the v5 surface's last round: 4,981 of 5,881 (84.7%). The
 *  208 programs the harvest added are mostly the extraction keyword's suites,
 *  now pinned to 4 (295 programs left holding MOV_EXTRACT_KEYWORD_RETIRED,
 *  which only a person rewrites). Lowered by the walk off a record that may
 *  be absent (MOV_ABSENT_REQUIRED from 5: only a person decides where the
 *  guard goes): 4,972 of 5,881 (84.5%), 15 programs left holding it.
 *  Lowered at the wasm shrink: a file-level value is refused from 5
 *  (MOV_FILE_VALUE_RUNS, 3 programs) and more walks off records that may be
 *  absent are caught (MOV_ABSENT_REQUIRED, now 27): 4,958 of 5,881 (84.3%);
 *  re-harvested, 4,966 of 5,900 (84.2%). Lowered again when version 5
 *  refused the forms the engine does not run (MOV_WALK_ROOTLESS,
 *  MOV_JSON_HAS_NO_EDGES, MOV_KG_QUERY_RETIRED and others, a few programs
 *  each): 4,962 of 5,905 (84.0%). Lowered at the merge of those slices:
 *  the re-harvest took in every slice's new test programs at once, 62 more,
 *  of which 38 upgrade clean: 5,000 of 5,967 (83.8%). */
const FLOOR = 0.837;

interface Program {
  source: string;
  snapshot: CatalogSnapshot;
}

function programs(): Program[] {
  const table = loadSnapshots(path.join(FIXTURES, 'checks.snapshots.json'));
  const seen = new Set<string>();
  const out: Program[] = [];
  for (const record of loadChecks(path.join(FIXTURES, 'checks.json'))) {
    if (record.version !== 4 || record.note !== undefined || record.parseVersion !== undefined || record.upgradingFrom !== undefined) continue;
    const key = `${record.snapshot}\u0000${record.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: record.source, snapshot: snapshotOf(record, table) });
  }
  const oracle = JSON.parse(fs.readFileSync(ORACLE, 'utf8')) as { catalog: CatalogSnapshot; prelude: string; cases: Array<{ body: string }> };
  for (const c of oracle.cases) {
    const source = oracle.prelude.replace('BODY', c.body);
    if (seen.has(`oracle\u0000${source}`)) continue;
    seen.add(`oracle\u0000${source}`);
    out.push({ source, snapshot: oracle.catalog });
  }
  return out;
}

const isError = (d: Diagnostic): boolean => diagnosticSeverity(d) === 'error';

/** The codes 5's rules give the original text, read under 4's grammar. */
function ruleCodes(program: Program): Set<string> {
  const resolveFile = resolveFileFromSnapshot(program.snapshot);
  try {
    return new Set(
      checkProgram(parseProgram(program.source, { languageVersion: 4 }), fromCatalogSnapshot(program.snapshot), {
        languageVersion: 5,
        upgradingFrom: 4,
        ...(resolveFile ? { resolveFile } : {}),
      })
        .filter((d) => isError(d) || d.upgrade === true)
        .map((d) => d.code),
    );
  } catch {
    return new Set();
  }
}

/** A message with its names and places masked, so one cause counts once. */
const shapeOf = (message: string): string =>
  message
    .replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '_')
    .replace(/\(line \d+, col \d+\)/g, '')
    .slice(0, 90);

/** A whole-line `#` comment, as written. */
const commentLines = (source: string): string[] => source.split('\n').filter((line) => /^\s*#/.test(line));

describe('upgrading the version 4 corpus to version 5', () => {
  it('every program clean under 4 upgrades clean under 5, or says why', () => {
    let clean = 0;
    let upgraded = 0;
    const causes = new Map<string, number>();
    const broken: string[] = [];
    for (const program of programs()) {
      let underFour: Diagnostic[];
      try {
        underFour = checkSourceInRust(program.source, program.snapshot, { languageVersion: 4 });
      } catch {
        continue; // a source the v4 test pinned as refused
      }
      if (underFour.some(isError)) continue;
      clean += 1;

      const check = rustCheck({ snapshot: program.snapshot, upgradingFrom: 4 });
      const result = upgradeSource(program.source, check);
      // The loop's own promises, on every program.
      if (!result.settled) broken.push(`did not settle:\n${program.source}`);
      const again = upgradeSource(result.source, check);
      if (again.changed) broken.push(`a second upgrade changed it:\n${result.source}`);
      const kept = commentLines(result.source);
      for (const line of commentLines(program.source)) {
        if (!kept.includes(line)) broken.push(`lost the comment ${JSON.stringify(line)}:\n${program.source}`);
      }

      if (result.remaining.length === 0) {
        upgraded += 1;
        continue;
      }
      const rules = ruleCodes(program);
      const left = new Set(
        result.remaining.map((d) =>
          rules.has(d.code) ? `a version 5 rule: ${d.code}` : `the rewrite: ${d.code} ${shapeOf(d.message)}`,
        ),
      );
      for (const cause of left) causes.set(cause, (causes.get(cause) ?? 0) + 1);
    }

    const rate = upgraded / clean;
    const table = [...causes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cause, n]) => `  ${String(n).padStart(4)}  ${cause}`)
      .join('\n');
    console.log(
      `upgrade corpus: ${upgraded} of ${clean} programs clean under 4 upgrade clean under 5 (${(rate * 100).toFixed(1)}%)\n` +
        `programs left, by what is left (one program may count under several):\n${table}`,
    );
    expect(broken).toEqual([]);
    expect(rate).toBeGreaterThanOrEqual(FLOOR);
  });
});
