// The checker conformance corpus (__fixtures__/checks.json and the snapshot
// table it names, checks.snapshots.json — see checks_regression) read back,
// and the replay of one record through the TypeScript checker. Shared by the
// regression pin and the catalog differential, which replays the same records
// with the catalog it hands the checker wrapped.
import { canonical } from '../../parser/expression/__test__/lowering_fixture';
import { parseProgram } from '../../parser/parse';
import { fromCatalogSnapshot, resolveFileFromSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import type { Catalog } from '../catalog';
import { checkProgram } from '../check';

declare function require(id: string): unknown;
declare const __dirname: string;

export interface CheckRecord {
  source: string;
  /** The key of its snapshot in checks.snapshots.json. */
  snapshot: string;
  version: number;
  /** Present when the test parsed under another version than it checked. */
  parseVersion?: number;
  upgradingFrom?: number;
  diagnostics: unknown[];
  note?: string;
  file?: string;
}

const FIXTURE = `${__dirname}/__fixtures__/checks.json`;
const SNAPSHOTS = `${__dirname}/__fixtures__/checks.snapshots.json`;

function textFiles(): { read(path: string): string; write(path: string, data: string): void } {
  const fs = require('fs');
  if (
    typeof fs !== 'object' ||
    fs === null ||
    !('readFileSync' in fs) ||
    typeof fs.readFileSync !== 'function' ||
    !('writeFileSync' in fs) ||
    typeof fs.writeFileSync !== 'function'
  ) {
    throw new Error('no fs');
  }
  const { readFileSync, writeFileSync } = fs;
  return {
    read(path) {
      const text: unknown = readFileSync(path, 'utf8');
      if (typeof text !== 'string') throw new Error(`reading ${path} did not return text`);
      return text;
    },
    write(path, data) {
      writeFileSync(path, data);
    },
  };
}

const fs = textFiles();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
  return isRecord(value) && isRecord(value.adapters) && isRecord(value.credentials) && isRecord(value.plugins);
}

const optionalNumber = (value: unknown): boolean => value === undefined || typeof value === 'number';
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

function isCheckRecord(value: unknown): value is CheckRecord {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.version === 'number' &&
    optionalNumber(value.parseVersion) &&
    optionalNumber(value.upgradingFrom) &&
    typeof value.snapshot === 'string' &&
    Array.isArray(value.diagnostics) &&
    optionalString(value.note) &&
    optionalString(value.file)
  );
}

const linesOf = (path: string): unknown[] =>
  fs
    .read(path)
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));

export function loadChecks(): CheckRecord[] {
  return linesOf(FIXTURE).map((record, i) => {
    if (!isCheckRecord(record)) throw new Error(`checks.json line ${i + 1} is not a check record`);
    return record;
  });
}

export function writeChecks(rows: CheckRecord[]): void {
  fs.write(FIXTURE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function loadSnapshots(): Map<string, CatalogSnapshot> {
  return new Map(
    linesOf(SNAPSHOTS).map((row, i) => {
      if (!isRecord(row) || typeof row.key !== 'string' || !isSnapshot(row.snapshot)) {
        throw new Error(`checks.snapshots.json line ${i + 1} is not a keyed snapshot`);
      }
      return [row.key, row.snapshot];
    }),
  );
}

export const SNAPSHOT_TABLE = loadSnapshots();

export function snapshotOf(record: CheckRecord): CatalogSnapshot {
  const snapshot = SNAPSHOT_TABLE.get(record.snapshot);
  if (!snapshot) throw new Error(`no snapshot ${record.snapshot} in checks.snapshots.json`);
  return snapshot;
}

/** The record's diagnostics from the checker as it is now, as plain data.
 *  `wrap` sees the catalog the checker is handed, and may stand in for it. */
export function checkNow(record: CheckRecord, wrap: (catalog: Catalog) => Catalog = c => c): unknown[] {
  const { source, version, parseVersion, upgradingFrom } = record;
  const snapshot = snapshotOf(record);
  const resolveFile = resolveFileFromSnapshot(snapshot);
  const program = parseProgram(source, { languageVersion: parseVersion ?? version });
  const diagnostics = checkProgram(program, wrap(fromCatalogSnapshot(snapshot)), {
    languageVersion: version,
    ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    ...(resolveFile ? { resolveFile } : {}),
  });
  const plain: unknown = JSON.parse(canonical(diagnostics));
  if (!Array.isArray(plain)) throw new Error('diagnostics are not a list');
  return plain;
}
