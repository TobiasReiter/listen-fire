import { EMPTY_CATALOG_SNAPSHOT, fromCatalogSnapshot } from '../snapshot';

// The deployment's reachable models reach the editor's checker the way the
// credentials do: on the snapshot, read back through the catalog.
describe("a snapshot's models", () => {
  it('reads back through the catalog', () => {
    const catalog = fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, models: ['claude-sonnet-5'] });
    expect(catalog.models?.()).toEqual(['claude-sonnet-5']);
  });

  // Absent is "this snapshot does not say", not "no model is reachable".
  it('stays absent when the snapshot carries none, and empty when it carries an empty list', () => {
    expect(fromCatalogSnapshot(EMPTY_CATALOG_SNAPSHOT).models).toBeUndefined();
    expect(fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, models: [] }).models?.()).toEqual([]);
  });
});
