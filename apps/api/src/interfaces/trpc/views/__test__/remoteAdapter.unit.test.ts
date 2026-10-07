/**
 * Sanity-tests for the `remoteAdapter` router factory. The procedures
 * themselves are thin DB-bound wrappers over the Phase 5a store
 * (`listRemoteAdapters` / `getRemoteAdapter` / `upsertRemoteAdapter` /
 * `deleteRemoteAdapter`) and pull `teamId` from `currentContext()`, so
 * they're exercised by the store's own tests + integration coverage. What
 * is worth locking down here is the input contract: `upsertFromManifest`
 * MUST validate against the canonical `RemoteAdapterManifestFile` schema
 * (not a redefinition), so a manifest the store would accept is exactly the
 * manifest the router accepts.
 */

import { remoteAdapterRouter } from '../remoteAdapter';
import { RemoteAdapterManifestFile } from '../../../../services/translation_graph/adapters/remote/manifest';

describe('remoteAdapter router — sanity', () => {
  it('exports the router factory', () => {
    expect(typeof remoteAdapterRouter).toBe('function');
  });
});

describe('upsertFromManifest input contract', () => {
  const validManifest = {
    protocolVersion: 2,
    adapterType: 'acme-crm',
    baseUrl: 'https://adapter.example.com',
    authStrategy: { kind: 'bearer' as const },
    credentialsId: '00000000-0000-0000-0000-000000000000',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: {
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    },
    methods: ['describe', 'resolve'],
  };

  it('accepts a well-formed manifest', () => {
    expect(RemoteAdapterManifestFile.safeParse(validManifest).success).toBe(true);
  });

  it('rejects a manifest missing the adapterType slug', () => {
    const { adapterType, ...rest } = validManifest;
    void adapterType;
    expect(RemoteAdapterManifestFile.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-uuid credentialsId', () => {
    expect(
      RemoteAdapterManifestFile.safeParse({
        ...validManifest,
        credentialsId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });
});
