// The language kit's runner: replay a checks corpus against the checker and
// report every record whose diagnostics drifted. This is the checker
// regression (checker/__test__/checks_regression.unit.test.ts) as a command,
// over any corpus in its format — ours, or one an embedder harvested from
// their own programs (README.md beside this file).
//
//   pnpm language:conformance <checks.json> [--snapshots <checks.snapshots.json>]
//
// The snapshot table defaults to the corpus's sibling `<name>.snapshots.json`.
// Exits 0 when every replayed record matches, 1 when any drifted.
import { canonical } from '../parser/expression/__test__/lowering_fixture';
import { checkNow, loadChecks, loadSnapshots, type CheckRecord } from '../checker/__test__/checks_fixture';

declare const process: { argv: string[]; cwd(): string; env: Record<string, string | undefined>; exitCode?: number };
declare const console: { log(...args: unknown[]): void; error(...args: unknown[]): void };
declare function require(id: string): unknown;

const SHOWN = 20;

function usage(): never {
  throw new Error('usage: pnpm language:conformance <checks.json> [--snapshots <checks.snapshots.json>]');
}

function absolute(file: string): string {
  const path = require('path');
  if (typeof path !== 'object' || path === null || !('resolve' in path) || typeof path.resolve !== 'function') {
    throw new Error('no path module');
  }
  // pnpm runs a script from its package's directory; a path is the caller's.
  const resolved: unknown = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
  if (typeof resolved !== 'string') throw new Error(`cannot resolve ${file}`);
  return resolved;
}

function argsOf(argv: string[]): { checks: string; snapshots: string } {
  const [checks, ...rest] = argv;
  if (checks === undefined || checks.startsWith('--')) usage();
  let snapshots = checks.replace(/\.json$/, '') + '.snapshots.json';
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag !== '--snapshots' || value === undefined) usage();
    snapshots = value;
    i += 1;
  }
  return { checks: absolute(checks), snapshots: absolute(snapshots) };
}

const label = (record: CheckRecord): string => `v${record.version} ${JSON.stringify(record.source.slice(0, 120))}`;

function main(): void {
  const { checks, snapshots } = argsOf(process.argv.slice(2));
  const records = loadChecks(checks);
  const table = loadSnapshots(snapshots);
  const noted = records.filter(record => record.note !== undefined).length;
  const drifted: string[] = [];
  for (const record of records) {
    if (record.note !== undefined) continue;
    const now = canonical(checkNow(record, catalog => catalog, table));
    const pinned = canonical(record.diagnostics);
    if (now !== pinned) drifted.push(`${label(record)}: pinned ${pinned.slice(0, 400)} | now ${now.slice(0, 400)}`);
  }
  const replayed = records.length - noted;
  console.log(`${replayed} records replayed, ${noted} noted and not replayed, ${drifted.length} drifted (${checks})`);
  for (const line of drifted.slice(0, SHOWN)) console.error(line);
  if (drifted.length > SHOWN) console.error(`… and ${drifted.length - SHOWN} more`);
  process.exitCode = drifted.length === 0 ? 0 : 1;
}

main();
