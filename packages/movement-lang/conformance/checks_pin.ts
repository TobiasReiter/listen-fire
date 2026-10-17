// The pin of the TypeScript checker's answers (checker/__test__/__fixtures__/
// checks/), and our checks corpus assembled from it.
//
// The pin holds no program text: the text lives in the test that checks it,
// and the harvest (checker/harvest/) finds it there again. A pinned check names
// its program by content hash, its catalog by its key in the snapshot table
// (checks.snapshots.json, beside the pin) and its diagnostics by their key in
// its version's diagnostics table, because one list of diagnostics is the
// answer to many checks (a few thousand lists answer 22,000 version 5 checks).
// Each language version has its own two files (`v<n>.json`, the checks, and
// `v<n>.diagnostics.json`, the lists), so retiring a version deletes them.
//
// The harvest writes the programs it found (`programs.jsonl`: each hash with
// its text and the tests it came from) and the corpus assembled from the pin
// and those programs (`checks.json`, in the language kit's format, with
// `checks.snapshots.json` beside it) to target/checks/ at the repository root.
// Everything that needs a pinned program's text reads that corpus.
import type { CheckRecord } from './checks_corpus';

declare function require(id: string): any;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

export const PIN_DIR: string = path.resolve(__dirname, '../checker/__test__/__fixtures__/checks');
export const SNAPSHOT_TABLE_FILE: string = path.resolve(__dirname, '../checker/__test__/__fixtures__/checks.snapshots.json');
export const CORPUS_DIR: string = path.resolve(__dirname, '../../../target/checks');
export const CORPUS_FILE: string = path.join(CORPUS_DIR, 'checks.json');
export const PROGRAMS_FILE: string = path.join(CORPUS_DIR, 'programs.jsonl');

/** A pinned check: a corpus record with its text replaced by the text's hash. */
export interface PinnedCheck {
  program: string;
  snapshot: string;
  version: number;
  parseVersion?: number;
  upgradingFrom?: number;
  note?: string;
  file?: string;
  diagnostics: unknown[];
}

const sha256 = (data: string, encoding: 'utf8' | 'utf16le' = 'utf8'): string => crypto.createHash('sha256').update(data, encoding).digest('hex');

/** The hash a pinned check names its program by. Over the text's UTF-16 code
 *  units, as JavaScript holds it: some tests hand the parser a lone surrogate,
 *  which UTF-8 cannot carry, and two such programs would hash alike. */
export const programKey = (source: string): string => sha256(source, 'utf16le');

/** The key of a list of diagnostics: the sha256 of the list as stored. */
const diagnosticsKey = (stored: string): string => sha256(stored);

const pinFile = (dir: string, version: number): string => path.join(dir, `v${version}.json`);
const tableFile = (dir: string, version: number): string => path.join(dir, `v${version}.diagnostics.json`);
const PIN_NAME = /^v(\d+)\.json$/;

const jsonLines = (file: string): unknown[] =>
  String(fs.readFileSync(file, 'utf8'))
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The language versions the pin holds, ascending. */
export function pinnedVersions(dir: string = PIN_DIR): number[] {
  return (fs.readdirSync(dir) as string[])
    .flatMap(name => {
      const match = PIN_NAME.exec(name);
      return match ? [Number(match[1])] : [];
    })
    .sort((a, b) => a - b);
}

/** One version's checks, in file order, each with its diagnostics read back
 *  from the version's table; `unused` names the table's lists no check names. */
export function readPinnedVersion(version: number, dir: string = PIN_DIR): { checks: PinnedCheck[]; unused: string[]; misfiled: string[] } {
  const table = new Map<string, unknown[]>();
  for (const [i, row] of jsonLines(tableFile(dir, version)).entries()) {
    if (!isObject(row) || typeof row.key !== 'string' || !Array.isArray(row.diagnostics)) {
      throw new Error(`${tableFile(dir, version)} line ${i + 1} is not a keyed list of diagnostics`);
    }
    if (diagnosticsKey(JSON.stringify(row.diagnostics)) !== row.key) throw new Error(`${tableFile(dir, version)} line ${i + 1}: the key is not the hash of its list`);
    table.set(row.key, row.diagnostics);
  }
  const named = new Set<string>();
  const misfiled: string[] = [];
  const checks = jsonLines(pinFile(dir, version)).map((row, i): PinnedCheck => {
    const where = `${pinFile(dir, version)} line ${i + 1}`;
    if (
      !isObject(row) ||
      typeof row.program !== 'string' ||
      typeof row.snapshot !== 'string' ||
      typeof row.version !== 'number' ||
      typeof row.diagnostics !== 'string' ||
      !(row.parseVersion === undefined || typeof row.parseVersion === 'number') ||
      !(row.upgradingFrom === undefined || typeof row.upgradingFrom === 'number') ||
      !(row.note === undefined || typeof row.note === 'string') ||
      !(row.file === undefined || typeof row.file === 'string')
    ) {
      throw new Error(`${where} is not a pinned check`);
    }
    const diagnostics = table.get(row.diagnostics);
    if (diagnostics === undefined) throw new Error(`${where} names diagnostics ${row.diagnostics}, which its table does not hold`);
    named.add(row.diagnostics);
    if (row.version !== version) misfiled.push(where);
    return {
      program: row.program,
      snapshot: row.snapshot,
      version: row.version,
      ...(row.parseVersion !== undefined ? { parseVersion: row.parseVersion } : {}),
      ...(row.upgradingFrom !== undefined ? { upgradingFrom: row.upgradingFrom } : {}),
      ...(row.note !== undefined ? { note: row.note } : {}),
      ...(row.file !== undefined ? { file: row.file } : {}),
      diagnostics,
    };
  });
  return { checks, unused: [...table.keys()].filter(key => !named.has(key)), misfiled };
}

/** Every pinned check, version by version, in file order. */
export function readPin(dir: string = PIN_DIR): PinnedCheck[] {
  return pinnedVersions(dir).flatMap(version => readPinnedVersion(version, dir).checks);
}

/** Pins `records` (in their order), one pair of files per version, replacing
 *  the pin in `dir`: a version no record holds loses its files. */
export function writePin(records: readonly CheckRecord[], dir: string = PIN_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  const byVersion = new Map<number, CheckRecord[]>();
  for (const record of records) byVersion.set(record.version, [...(byVersion.get(record.version) ?? []), record]);
  for (const version of pinnedVersions(dir)) {
    if (byVersion.has(version)) continue;
    fs.rmSync(pinFile(dir, version));
    fs.rmSync(tableFile(dir, version), { force: true });
  }
  for (const [version, rows] of byVersion) {
    const table = new Map<string, string>();
    const lines = rows.map(({ source, snapshot, parseVersion, upgradingFrom, note, file, diagnostics }) => {
      const stored = JSON.stringify(diagnostics);
      const key = diagnosticsKey(stored);
      table.set(key, stored);
      return JSON.stringify({ program: programKey(source), snapshot, version, parseVersion, upgradingFrom, note, file, diagnostics: key });
    });
    const tableLines = [...table.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, stored]) => `{"key":${JSON.stringify(key)},"diagnostics":${stored}}`);
    fs.writeFileSync(pinFile(dir, version), lines.join('\n') + '\n');
    fs.writeFileSync(tableFile(dir, version), tableLines.join('\n') + '\n');
  }
}

/** The pin's checks with their texts from `programs` (hash → text), in the
 *  language kit's record format; `missing` are the checks whose program no
 *  harvested test produced. */
export function assemble(pin: readonly PinnedCheck[], programs: ReadonlyMap<string, string>): { records: CheckRecord[]; missing: PinnedCheck[] } {
  const records: CheckRecord[] = [];
  const missing: PinnedCheck[] = [];
  for (const { program, snapshot, version, parseVersion, upgradingFrom, note, file, diagnostics } of pin) {
    const source = programs.get(program);
    if (source === undefined) {
      missing.push({ program, snapshot, version, parseVersion, upgradingFrom, note, file, diagnostics });
      continue;
    }
    records.push({ source, snapshot, version, parseVersion, upgradingFrom, note, file, diagnostics });
  }
  return { records, missing };
}

/** Writes the assembled corpus (and the snapshot table beside it) where the
 *  readers look for it. */
export function writeCorpus(records: readonly CheckRecord[]): void {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.writeFileSync(CORPUS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.copyFileSync(SNAPSHOT_TABLE_FILE, path.join(CORPUS_DIR, 'checks.snapshots.json'));
}

/** The assembled corpus's path, or a loud refusal when no harvest wrote it. */
export function corpusFile(): string {
  if (!fs.existsSync(CORPUS_FILE)) {
    throw new Error(
      `no assembled checks corpus at ${CORPUS_FILE}: the pin holds no program text, so run \`pnpm checks:corpus\` in packages/movement-lang first (it harvests the programs from their tests and assembles the corpus)`,
    );
  }
  return CORPUS_FILE;
}

/** The tests that read the assembled corpus run only when asked
 *  (CHECKS_CORPUS=1, which `pnpm checks:corpus` sets for them). */
export const overCorpus = (): boolean => Boolean(process.env.CHECKS_CORPUS);
