// The checker conformance corpus (__fixtures__/checks.json and the snapshot
// table it names, checks.snapshots.json — see checks_regression) read back,
// and the replay of one record through the TypeScript checker: the language
// kit's (../../conformance/checks_corpus.ts), defaulted to our corpus. Shared
// by the regression pin and the catalog differential, which replays the same
// records with the catalog it hands the checker wrapped.
import {
  checkNow as checkAgainst,
  loadChecks as loadChecksAt,
  loadSnapshots as loadSnapshotsAt,
  snapshotOf as snapshotIn,
  textFiles,
  type CheckRecord,
} from '../../conformance/checks_corpus';
import type { CatalogSnapshot } from '../../service/snapshot';
import type { Catalog } from '../catalog';

declare const __dirname: string;

export { linesOf, type CheckRecord } from '../../conformance/checks_corpus';

const FIXTURE = `${__dirname}/__fixtures__/checks.json`;
const SNAPSHOTS = `${__dirname}/__fixtures__/checks.snapshots.json`;

/** A checks corpus's records: ours by default, or any file in its format. */
export function loadChecks(path: string = FIXTURE): CheckRecord[] {
  return loadChecksAt(path);
}

export function writeChecks(rows: CheckRecord[]): void {
  textFiles().write(FIXTURE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** A checks corpus's snapshot table, by key: ours by default. */
export function loadSnapshots(path: string = SNAPSHOTS): Map<string, CatalogSnapshot> {
  return loadSnapshotsAt(path);
}

export const SNAPSHOT_TABLE = loadSnapshots();

export function snapshotOf(record: CheckRecord, table: ReadonlyMap<string, CatalogSnapshot> = SNAPSHOT_TABLE): CatalogSnapshot {
  return snapshotIn(record, table);
}

/** The record's diagnostics from the checker as it is now, as plain data.
 *  `wrap` sees the catalog the checker is handed, and may stand in for it;
 *  `table` is the snapshot table the record names its snapshot in. */
export function checkNow(
  record: CheckRecord,
  wrap: (catalog: Catalog) => Catalog = c => c,
  table: ReadonlyMap<string, CatalogSnapshot> = SNAPSHOT_TABLE,
): unknown[] {
  return checkAgainst(record, table, wrap);
}
