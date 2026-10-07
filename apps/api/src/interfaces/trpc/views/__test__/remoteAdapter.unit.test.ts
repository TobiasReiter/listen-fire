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

import { remoteAdapterRouter, toListEntry } from '../remoteAdapter';
import {
  RemoteAdapterManifestFile,
  RemoteAdapterManifestInput,
} from '../../../../services/translation_graph/adapters/remote/manifest';

describe('remoteAdapter router — sanity', () => {
  it('exports the router factory', () => {
    expect(typeof remoteAdapterRouter).toBe('function');
  });
});

describe('upsertFromManifest input contract', () => {
  const validManifest = {
    protocolVersion: 2,
    adapterType: 'acme_crm',
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

  it('accepts a manifest with no protocolVersion: install asks the server for it', () => {
    const { protocolVersion, ...unversioned } = validManifest;
    void protocolVersion;
    expect(RemoteAdapterManifestInput.safeParse(unversioned).success).toBe(true);
    expect(RemoteAdapterManifestFile.safeParse(unversioned).success).toBe(false);
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

describe('list entries tolerate a stored manifest that no longer parses', () => {
  const current = {
    protocolVersion: 2,
    adapterType: 'acme_crm',
    baseUrl: 'https://adapter.example.com',
    authStrategy: { kind: 'bearer' },
    supportedTriggers: [],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: [],
  };
  const rowOf = (adapterType: string, manifest: unknown) =>
    ({
      id: 'id-' + adapterType,
      adapter_type: adapterType,
      base_url: 'https://adapter.example.com',
      auth_strategy: { kind: 'bearer' },
      credentials_id: null,
      manifest,
      created_at: new Date(0),
      updated_at: new Date(0),
    }) as unknown as Parameters<typeof toListEntry>[0];

  it('maps a valid row and an old row (no protocolVersion) and a hyphenated slug side by side', () => {
    const { protocolVersion, ...old } = current;
    void protocolVersion;
    const entries = [
      rowOf('acme_crm', current),
      rowOf('old_one', { ...old, adapterType: 'old_one' }),
      rowOf('my-crm', { ...current, adapterType: 'my-crm' }),
    ].map(toListEntry);

    expect(entries.map((e) => e.kind)).toEqual(['valid', 'invalid', 'invalid']);
    const [, oldEntry, hyphenEntry] = entries;
    if (oldEntry?.kind === 'invalid') expect(oldEntry.reason).toContain('protocolVersion');
    if (hyphenEntry?.kind === 'invalid') {
      expect(hyphenEntry.adapterType).toBe('my-crm');
      expect(hyphenEntry.reason).toContain('adapterType');
    }
  });
});
