// A checks corpus (README.md beside this file) read back, one record replayed
// through the TypeScript checker, and a whole corpus replayed with what
// drifted. The language kit's command (language_conformance.ts) and the
// checker regression (checker/__test__/checks_regression.unit.test.ts) are
// both this replay: one over any corpus, one over ours.
import { parseProgram } from '../parser/parse';
import { fromCatalogSnapshot, resolveFileFromSnapshot, type CatalogSnapshot } from '../service/snapshot';
import type { Catalog } from '../checker/catalog';
import { checkProgram } from '../checker/check';

declare function require(id: string): unknown;

export interface CheckRecord {
  source: string;
  /** The key of its snapshot in the corpus's snapshot table. */
  snapshot: string;
  version: number;
  /** Present when the test parsed under another version than it checked. */
  parseVersion?: number;
  upgradingFrom?: number;
  diagnostics: unknown[];
  note?: string;
  file?: string;
}

/** Key order and `undefined` members are not part of a value. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

/** Text files, read and written. */
export function textFiles(): { read(path: string): string; write(path: string, data: string): void } {
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

/** A JSON-lines file's rows. */
export const linesOf = (path: string): unknown[] =>
  textFiles()
    .read(path)
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));

/** A checks corpus's records. */
export function loadChecks(path: string): CheckRecord[] {
  return linesOf(path).map((record, i) => {
    if (!isCheckRecord(record)) throw new Error(`${path} line ${i + 1} is not a check record`);
    return record;
  });
}

/** A checks corpus's snapshot table, by key. */
export function loadSnapshots(path: string): Map<string, CatalogSnapshot> {
  return new Map(
    linesOf(path).map((row, i) => {
      if (!isRecord(row) || typeof row.key !== 'string' || !isSnapshot(row.snapshot)) {
        throw new Error(`${path} line ${i + 1} is not a keyed snapshot`);
      }
      return [row.key, row.snapshot];
    }),
  );
}

export function snapshotOf(record: CheckRecord, table: ReadonlyMap<string, CatalogSnapshot>): CatalogSnapshot {
  const snapshot = table.get(record.snapshot);
  if (!snapshot) throw new Error(`no snapshot ${record.snapshot} in the snapshot table`);
  return snapshot;
}

/** The record's diagnostics from the checker as it is now, as plain data.
 *  `table` is the snapshot table the record names its snapshot in; `wrap`
 *  sees the catalog the checker is handed, and may stand in for it. */
export function checkNow(
  record: CheckRecord,
  table: ReadonlyMap<string, CatalogSnapshot>,
  wrap: (catalog: Catalog) => Catalog = c => c,
): unknown[] {
  const { source, version, parseVersion, upgradingFrom } = record;
  const snapshot = snapshotOf(record, table);
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

/** A language-version refusal or deprecation names the CURRENT version in its
 *  fix ("validate it under "Dancing Wren" (5)"), which changes every release,
 *  so a pin of it would go stale at each one. Both sides are compared with
 *  that name and number masked, in those two clauses of those two codes only;
 *  the message's shape is otherwise exact (the subject version included). */
function maskCurrentVersion(diagnostics: unknown): unknown {
  if (!Array.isArray(diagnostics)) return diagnostics;
  const clause = /\b(under|to) "[^"]+" \(\d+\)/gi;
  return diagnostics.map(d =>
    isRecord(d) &&
    (d.code === 'MOV_LANGUAGE_VERSION_UNSUPPORTED' || d.code === 'MOV_LANGUAGE_VERSION_DEPRECATED') &&
    typeof d.message === 'string'
      ? { ...d, message: d.message.replace(clause, '$1 "<current version name>" (<current version number>)') }
      : d,
  );
}

const label = (record: CheckRecord): string => `v${record.version} ${JSON.stringify(record.source.slice(0, 120))}`;

/** Every record without a note replayed against the checker as it is now:
 *  how many replayed, how many were noted and skipped, and each that
 *  drifted (its version, the start of its source, both diagnostics). */
export function replayChecks(
  records: readonly CheckRecord[],
  table: ReadonlyMap<string, CatalogSnapshot>,
): { replayed: number; noted: number; drifted: string[] } {
  const noted = records.filter(record => record.note !== undefined).length;
  const drifted = records
    .filter(record => record.note === undefined)
    .flatMap(record => {
      const now = canonical(maskCurrentVersion(checkNow(record, table)));
      const pinned = canonical(maskCurrentVersion(record.diagnostics));
      return now === pinned ? [] : [`${label(record)}: pinned ${pinned.slice(0, 400)} | now ${now.slice(0, 400)}`];
    });
  return { replayed: records.length - noted, noted, drifted };
}
