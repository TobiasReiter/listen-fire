// The TypeScript side of the parity harness: every program the repository
// pins a check or a run for, checked by the TypeScript checker as it is now,
// written as JSON lines for the Rust side (examples/parity.rs) to replay.
//
//   - the checks corpus (packages/movement-lang/checker/__test__/__fixtures__/checks.json):
//     every program the v1 to v4 conformance suites, this package's own tests
//     and the engine's tests (its v4 corpus and its own) check, each under
//     its own version; and again under the current version, for the programs
//     pinned at version 3 or later, where they still parse;
//   - the engine oracles' programs (crates/movement-engine/tests/oracle):
//     records (each case's own version), handles (version 4), parallel
//     (version 3) and patterns (each its own version, and the current one),
//     each against its oracle's catalog.
//
// Usage (run.sh does this): node -r <ts-node>/register/transpile-only reference.ts <out-dir>
import { checkNow, loadChecks, loadSnapshots, type CheckRecord } from '../../../packages/movement-lang/conformance/checks_corpus';
import { CURRENT_LANGUAGE_VERSION } from '../../../packages/movement-lang/language_version';
import type { CatalogSnapshot } from '../../../packages/movement-lang/service/snapshot';

declare function require(id: string): any;
declare const process: { argv: string[]; hrtime: { bigint(): bigint } };
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
const ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = path.join(ROOT, 'packages/movement-lang/checker/__test__/__fixtures__');
const ORACLES = path.join(ROOT, 'crates/movement-engine/tests/oracle');

const table = loadSnapshots(path.join(FIXTURES, 'checks.snapshots.json'));
const records = loadChecks(path.join(FIXTURES, 'checks.json')).filter(r => r.note === undefined);

const lines: string[] = [];
let failed = 0;
const started = process.hrtime.bigint();
function emit(corpus: string, record: CheckRecord): void {
  let ts: unknown[];
  try {
    ts = checkNow(record, table);
  } catch {
    failed += 1; // a program that no longer parses under this version
    return;
  }
  const { source, snapshot, version, parseVersion, upgradingFrom } = record;
  lines.push(JSON.stringify({ corpus, source, snapshot, version, parseVersion, upgradingFrom, ts }));
}

for (const record of records) emit(`checks v${record.version}`, record);
const current = new Set<string>();
for (const record of records) {
  if (record.version < 3 || record.version === CURRENT_LANGUAGE_VERSION || record.upgradingFrom !== undefined) continue;
  const key = `${record.snapshot}\u0000${record.source}`;
  if (current.has(key)) continue;
  current.add(key);
  emit(`checks under v${CURRENT_LANGUAGE_VERSION}`, { ...record, version: CURRENT_LANGUAGE_VERSION, parseVersion: undefined, diagnostics: [] });
}

const oracles: Array<{ file: string; version: (c: any) => number }> = [
  { file: 'records.json', version: c => c.version },
  { file: 'handles.json', version: () => 4 },
  { file: 'parallel.json', version: () => 3 },
];
for (const { file, version } of oracles) {
  const oracle = JSON.parse(fs.readFileSync(path.join(ORACLES, file), 'utf8'));
  const key = `oracle:${file}`;
  (table as Map<string, CatalogSnapshot>).set(key, oracle.catalog);
  const seen = new Set<string>();
  for (const c of oracle.cases) {
    const source = String(oracle.prelude).replace('BODY', c.body);
    const v = version(c);
    if (seen.has(`${v}\u0000${source}`)) continue;
    seen.add(`${v}\u0000${source}`);
    emit(`oracle ${file.replace('.json', '')}`, { source, snapshot: key, version: v, diagnostics: [] });
  }
}

// The engine's pattern programs (patterns.json): every admission pattern
// both engines run, under its own version and, from version 3, under the
// current one — the programs a Rust run is checked on before its segment
// opens, which the corpus above never held (gate 19 found four the Rust
// checker passed and the TypeScript refuses).
{
  const { PATTERNS_CATALOG, sourceOf } = require(path.join(ORACLES, 'patterns_oracle.ts'));
  const patterns = JSON.parse(fs.readFileSync(path.join(ORACLES, 'patterns.json'), 'utf8'));
  const seen = new Set<string>();
  for (const c of patterns.cases) {
    const program = c.program;
    const catalog = program.files !== undefined ? { ...PATTERNS_CATALOG, files: program.files } : PATTERNS_CATALOG;
    const key = `oracle:patterns:${program.files !== undefined ? JSON.stringify(program.files) : ''}`;
    (table as Map<string, CatalogSnapshot>).set(key, catalog);
    const source = sourceOf(program);
    const own: number = program.version ?? 3;
    for (const v of own >= 3 && own !== CURRENT_LANGUAGE_VERSION ? [own, CURRENT_LANGUAGE_VERSION] : [own]) {
      if (seen.has(`${key}\u0000${v}\u0000${source}`)) continue;
      seen.add(`${key}\u0000${v}\u0000${source}`);
      emit(v === own ? 'oracle patterns' : `oracle patterns under v${v}`, { source, snapshot: key, version: v, diagnostics: [] });
    }
  }
}

fs.writeFileSync(path.join(out, 'reference.jsonl'), lines.join('\n') + '\n');
fs.writeFileSync(
  path.join(out, 'snapshots.jsonl'),
  [...table.entries()].map(([key, snapshot]) => JSON.stringify({ key, snapshot })).join('\n') + '\n',
);
const seconds = Number(process.hrtime.bigint() - started) / 1e9;
console.log(`typescript: ${lines.length} checks in ${seconds.toFixed(1)}s (${failed} skipped: no longer parse)`);
