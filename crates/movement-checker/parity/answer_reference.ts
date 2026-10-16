// The TypeScript side of the check-answer parity (answers.sh): for every
// record the checker parity wrote (reference.ts → reference.jsonl), what the
// TypeScript's check answers the engine besides its diagnostics — the stamps
// it settles on nodes and the import link (program_check.ts `checkAnswer`) —
// written as JSON lines for the Rust side (examples/answer_parity.rs).
//
// Usage (answers.sh does this): node -r <ts-node>/register/transpile-only answer_reference.ts <work-dir>
import { parseProgram } from '../../../packages/movement-lang/parser/parse';
import { checkProgramWithLink } from '../../../packages/movement-lang/checker/check';
import { fromCatalogSnapshot, resolveFileFromSnapshot, type CatalogSnapshot } from '../../../packages/movement-lang/service/snapshot';
import { checkAnswer } from '../../../packages/movement-engine/services/movement_engine/program_check';

declare function require(id: string): any;
declare const process: { argv: string[] };
const fs = require('fs');
const path = require('path');

const work = process.argv[2];
const table = new Map<string, CatalogSnapshot>();
for (const line of fs.readFileSync(path.join(work, 'snapshots.jsonl'), 'utf8').split('\n')) {
  if (line === '') continue;
  const row = JSON.parse(line);
  table.set(row.key, row.snapshot);
}
const out: string[] = [];
let failed = 0;
for (const line of fs.readFileSync(path.join(work, 'reference.jsonl'), 'utf8').split('\n')) {
  if (line === '') continue;
  const { source, snapshot: key, version, parseVersion, upgradingFrom } = JSON.parse(line);
  const snapshot = table.get(key);
  if (snapshot === undefined) throw new Error(`no snapshot ${key}`);
  try {
    const program = parseProgram(source, { languageVersion: parseVersion ?? version });
    const catalog = fromCatalogSnapshot(snapshot);
    const resolveFile = resolveFileFromSnapshot(snapshot);
    const { diagnostics, link } = checkProgramWithLink(program, catalog, {
      languageVersion: version,
      ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
      ...(resolveFile !== undefined ? { resolveFile } : {}),
    });
    const blocked = diagnostics.some(d => (d.severity ?? 'error') === 'error');
    const answer = checkAnswer({ program, catalog, diagnostics, ...(link !== undefined ? { link } : {}), ...(resolveFile !== undefined ? { resolveFile } : {}) });
    out.push(JSON.stringify({ blocked, stamps: answer.stamps, ...(answer.link !== undefined ? { link: answer.link } : {}) }));
  } catch (error) {
    failed += 1;
    out.push(JSON.stringify({ error: String(error) }));
  }
}
fs.writeFileSync(path.join(work, 'answers.jsonl'), out.join('\n') + '\n');
console.log(`typescript: ${out.length} answers (${failed} failed)`);
