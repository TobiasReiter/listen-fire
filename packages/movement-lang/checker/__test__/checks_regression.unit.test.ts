// Every program the corpora (v1, v2 and the current tests — see ../harvest)
// hand the checker, with the catalog that check consulted (as a snapshot), the
// language version and the full diagnostics, in __fixtures__/checks.json; each
// record names its snapshot by key in __fixtures__/checks.snapshots.json. This
// is the Rust checker's conformance oracle: it checks the same sources against
// the same snapshots and must emit the same diagnostics, messages and order
// included. A pin changes only with a ruling.
//
// The replay goes through `fromCatalogSnapshot`, so a record that drifts here
// while the checker is unchanged is a harvest that recorded the wrong catalog.
// Schema field order is observable in diagnostic messages ("it has: Title,
// Colour"), so the stored snapshots keep the order the catalog answered in and
// neither side may sort schema keys (the Rust catalog types included).
//
// `parseVersion` is present when the test parsed under a different version
// than it checked (a test passing `languageVersion` to one call and not the
// other); the replay parses under it, so the Program is the one the test had.
//
// A record carrying a `note` is one whose catalog no snapshot can express (the
// note says why); it is kept, as evidence, but not replayed.
//
// Set UPDATE_CHECKS_FIXTURE=1 to rewrite the pins from the current checker
// (after a re-harvest, or a ruling) — then read the diff.
import { canonical } from '../../parser/expression/__test__/lowering_fixture';
import { parseProgram } from '../../parser/parse';
import { fromCatalogSnapshot, resolveFileFromSnapshot, type CatalogSnapshot } from '../../service/snapshot';
import { checkProgram } from '../check';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;
declare const console: { warn(...args: unknown[]): void };

interface CheckRecord {
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
const KNOWN_VERSIONS = [1, 2, 3];

const fs = require('fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
};

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
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));

function load(): CheckRecord[] {
  return linesOf(FIXTURE).map((record, i) => {
    if (!isCheckRecord(record)) throw new Error(`checks.json line ${i + 1} is not a check record`);
    return record;
  });
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

const SNAPSHOT_TABLE = loadSnapshots();

function snapshotOf(record: CheckRecord): CatalogSnapshot {
  const snapshot = SNAPSHOT_TABLE.get(record.snapshot);
  if (!snapshot) throw new Error(`no snapshot ${record.snapshot} in checks.snapshots.json`);
  return snapshot;
}

function checkNow(record: CheckRecord): unknown[] {
  const { source, version, parseVersion, upgradingFrom } = record;
  const snapshot = snapshotOf(record);
  const resolveFile = resolveFileFromSnapshot(snapshot);
  const diagnostics = checkProgram(parseProgram(source, { languageVersion: parseVersion ?? version }), fromCatalogSnapshot(snapshot), {
    languageVersion: version,
    ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    ...(resolveFile ? { resolveFile } : {}),
  });
  const plain: unknown = JSON.parse(canonical(diagnostics));
  if (!Array.isArray(plain)) throw new Error('diagnostics are not a list');
  return plain;
}

const label = (record: CheckRecord): string => `v${record.version} ${JSON.stringify(record.source.slice(0, 120))}`;

describe('checks regression', () => {
  if (process.env.UPDATE_CHECKS_FIXTURE) {
    const rows = load().map(r => (r.note ? r : { ...r, diagnostics: checkNow(r) }));
    fs.writeFileSync(FIXTURE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  it('checks every pinned program against its snapshot exactly as pinned', () => {
    const pins = load();
    expect(pins.length).toBeGreaterThan(2000);
    const drifted = pins
      .filter(pin => !pin.note)
      .flatMap(pin => {
        const now = canonical(checkNow(pin));
        const pinned = canonical(pin.diagnostics);
        return now === pinned ? [] : [`${label(pin)}: pinned ${pinned.slice(0, 400)} | now ${now.slice(0, 400)}`];
      });
    expect(drifted).toEqual([]);
  });

  it('names only snapshots the table holds, and the table holds no others', () => {
    const named = new Set(load().map(r => r.snapshot));
    expect([...named].filter(key => !SNAPSHOT_TABLE.has(key))).toEqual([]);
    expect([...SNAPSHOT_TABLE.keys()].filter(key => !named.has(key))).toEqual([]);
  });

  it('reports any pinned version outside the known ones', () => {
    const odd = [...new Set(load().map(r => r.version).filter(v => !KNOWN_VERSIONS.includes(v)))];
    if (odd.length > 0) console.warn(`checks.json pins unexpected language versions: ${odd.join(', ')}`);
  });
});
