import { mockCatalog, type InstanceSchema } from '../../checker/catalog';
import { catalogSnapshotOf, fromCatalogSnapshot } from '../snapshot';

const crmSchema: InstanceSchema = { positions: { company: { properties: { name: 'text' }, edges: {} } }, collections: {}, writableRoots: {} };
const graphSchema: InstanceSchema = { positions: { note: { properties: { body: 'text' }, edges: {} } }, collections: {}, writableRoots: {} };

const catalog = mockCatalog({
  adapters: {
    crm: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }] },
    graph: { constructionArgs: [], schema: graphSchema },
  },
  credentials: { acme: { adapter: 'crm' }, other: { adapter: 'mail' } },
  plugins: { summarise: { args: ['text'] } },
  instantiate: (adapter, args) =>
    adapter === 'crm' && args.credentials === 'acme' ? crmSchema : adapter === 'graph' ? graphSchema : undefined,
  models: ['claude-sonnet-5'],
});

// The engine takes data, not a catalog object: what a catalog answers must
// survive the round trip through a snapshot.
describe('catalogSnapshotOf', () => {
  const snapshot = catalogSnapshotOf(catalog, { adapters: ['crm', 'graph', 'absent'], plugins: ['summarise'] });
  const roundTripped = fromCatalogSnapshot(snapshot);

  it('answers instantiate as the catalog did, per credential', () => {
    expect(roundTripped.instantiate('crm', { credentials: 'acme' })).toEqual(crmSchema);
    expect(roundTripped.instantiate('graph', {})).toEqual(graphSchema);
  });

  // A credential that cannot authenticate the adapter names no instance of it.
  it('reads no schema for a credential of another adapter', () => {
    expect(roundTripped.instantiate('crm', { credentials: 'other' })).toBeUndefined();
  });

  it('carries the adapters, credentials, plugins and models it was asked for', () => {
    expect(Object.keys(snapshot.adapters).sort()).toEqual(['crm', 'graph']);
    expect(roundTripped.adapter('crm')?.constructionArgs).toEqual(catalog.adapter('crm')?.constructionArgs);
    expect(roundTripped.credential('acme')).toEqual({ adapters: ['crm'] });
    expect(roundTripped.plugin('summarise')).toEqual(catalog.plugin('summarise'));
    expect(roundTripped.models?.()).toEqual(['claude-sonnet-5']);
  });

  it('is plain data', () => {
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
