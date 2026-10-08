import { mockCatalog } from '../../checker/catalog';
import { CATALOG_SNAPSHOT_VERSION, EMPTY_CATALOG_SNAPSHOT, catalogSnapshotOf, fromCatalogSnapshot } from '../snapshot';

describe("a snapshot's contract version", () => {
  it('is written by the builder', () => {
    expect(catalogSnapshotOf(mockCatalog({}), { adapters: [] }).contractVersion).toBe(CATALOG_SNAPSHOT_VERSION);
  });

  it('reads when it is supported, and when it is absent (a snapshot written before it was carried)', () => {
    expect(() => fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, contractVersion: 1 })).not.toThrow();
    expect(EMPTY_CATALOG_SNAPSHOT).not.toHaveProperty('contractVersion');
    expect(() => fromCatalogSnapshot(EMPTY_CATALOG_SNAPSHOT)).not.toThrow();
  });

  it('is refused when this release does not read it, naming the contract, the version and the supported set', () => {
    expect(() => fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, contractVersion: 2 })).toThrow(
      'the catalog snapshot carries contract version 2, which this release does not read (supported: 1)',
    );
  });
});
