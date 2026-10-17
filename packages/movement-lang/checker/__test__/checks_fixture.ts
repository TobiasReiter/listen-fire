// The checker conformance corpus read back, and the replay of one record
// through the TypeScript checker: the language kit's
// (../../conformance/checks_corpus.ts), defaulted to our corpus. Ours is
// pinned without its program texts (__fixtures__/checks/, see
// ../../conformance/checks_pin.ts) and assembled with them by the harvest
// (`pnpm checks:corpus`), so a reader of whole records needs that run first.
// Shared by the regression pin and the catalog differential, which replays the
// same records with the catalog it hands the checker wrapped.
import {
  checkNow as checkAgainst,
  loadChecks as loadChecksAt,
  loadSnapshots as loadSnapshotsAt,
  snapshotOf as snapshotIn,
  type CheckRecord,
} from '../../conformance/checks_corpus';
import { corpusFile, SNAPSHOT_TABLE_FILE, writePin } from '../../conformance/checks_pin';
import type { CatalogSnapshot } from '../../service/snapshot';
import type { Catalog } from '../catalog';

export { linesOf, type CheckRecord } from '../../conformance/checks_corpus';

/** A checks corpus's records: ours (assembled by the harvest) by default, or
 *  any file in its format. */
export function loadChecks(path: string = corpusFile()): CheckRecord[] {
  return loadChecksAt(path);
}

/** Re-pins our corpus's records, in their order. */
export function writeChecks(rows: CheckRecord[]): void {
  writePin(rows);
}

/** A checks corpus's snapshot table, by key: ours by default. */
export function loadSnapshots(path: string = SNAPSHOT_TABLE_FILE): Map<string, CatalogSnapshot> {
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
