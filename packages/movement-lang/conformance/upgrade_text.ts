// The upgrade loop (checker/upgrade.ts) over files or a string, from a shell:
//
//   pnpm --filter movement-lang language:upgrade [--check] [--snapshot <snapshot.json>] <file>...
//   echo '<program>' | pnpm --silent --filter movement-lang language:upgrade [--snapshot <snapshot.json>] -
//
// Files are rewritten in place (`--check`: the diff is printed and nothing is
// written); `-` reads the program from stdin and prints the rewritten text.
// What is left is printed by line on stderr, and the exit status is 1 when
// anything is left (or, with --check, when anything would change).
//
// Without --snapshot only the parse is consulted: every old spelling is
// rewritten, but nothing is checked against connected systems, so the text is
// not claimed clean. With a catalog snapshot (the JSON a run is handed) the
// Rust checker checks it, every other fix it marks for the move is applied
// too, and "left" means what still keeps it from checking clean under 5.

import { rustCheck, spellingCheck, unifiedDiff, upgradeSource, type UpgradeCheck } from '../checker/upgrade';
import { diagnosticSeverity } from '../checker/check';
import type { CatalogSnapshot } from '../service/snapshot';

declare function require(id: string): unknown;
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
};

const fs = require('fs') as {
  readFileSync(path: string | number, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
};
const path = require('path') as { resolve(...parts: string[]): string };

function main(argv: string[]): number {
  let checkOnly = false;
  let snapshotPath: string | undefined;
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--check') checkOnly = true;
    else if (arg === '--snapshot') snapshotPath = argv[++i];
    else targets.push(arg);
  }
  if (targets.length === 0) {
    process.stderr.write('usage: upgrade [--check] [--snapshot <snapshot.json>] <file>... | -\n');
    return 2;
  }
  // pnpm runs a package script in the package's folder; paths are the caller's.
  const here = (p: string): string => path.resolve(process.env.INIT_CWD ?? '.', p);
  const check: UpgradeCheck =
    snapshotPath !== undefined
      ? rustCheck({ snapshot: JSON.parse(fs.readFileSync(here(snapshotPath), 'utf8')) as CatalogSnapshot, upgradingFrom: 4 })
      : spellingCheck();

  let status = 0;
  for (const target of targets) {
    const name = target === '-' ? '<stdin>' : target;
    const before = fs.readFileSync(target === '-' ? 0 : here(target), 'utf8');
    const result = upgradeSource(before, check);
    if (target === '-') process.stdout.write(result.source);
    else if (checkOnly) process.stdout.write(unifiedDiff({ before, after: result.source, path: target }));
    else if (result.changed) fs.writeFileSync(here(target), result.source);
    for (const d of result.remaining) {
      process.stderr.write(`${name}:${d.span.start.line}:${d.span.start.col} ${diagnosticSeverity(d)} ${d.code} ${d.message}\n`);
    }
    if (!result.settled) process.stderr.write(`${name}: the fixes did not settle — a fix keeps rewriting its own output\n`);
    if (result.remaining.length > 0 || !result.settled || (checkOnly && result.changed)) status = 1;
  }
  return status;
}

process.exitCode = main(process.argv.slice(2));
