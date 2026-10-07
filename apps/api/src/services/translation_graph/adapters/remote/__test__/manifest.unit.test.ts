// The importable remote-adapter manifest file. The secret is never in the
// manifest, so a fresh install has no credential yet: `credentialsId` is
// optional and the server fills it when the secret is supplied. The projection
// must NOT advertise a requiredCredentialType — that would force a `credentials:`
// construction arg and break credential-free `acme_crm()` construction.

import { randomUUID } from 'node:crypto';

import { RemoteAdapterManifestFile, remoteAdapterManifest } from '../manifest';

const base = {
  protocolVersion: 2,
  adapterType: 'acme_crm',
  displayName: 'Acme CRM',
  baseUrl: 'https://crm.example/adapter',
  authStrategy: { kind: 'bearer' as const },
  supportedTriggers: ['webhook'],
  runtimeCapabilities: {
    traversal: { incoming: false, edgeProperties: false },
    resources: false,
  },
  methods: ['describe', 'createRecord'],
};

describe('RemoteAdapterManifestFile', () => {
  it('parses a manifest with NO credentialsId (install precedes connect)', () => {
    const parsed = RemoteAdapterManifestFile.parse(base);
    expect(parsed.credentialsId).toBeUndefined();
  });

  it('still parses a manifest that carries a credentialsId', () => {
    const id = randomUUID();
    const parsed = RemoteAdapterManifestFile.parse({ ...base, credentialsId: id });
    expect(parsed.credentialsId).toBe(id);
  });

  it('refuses a manifest without protocolVersion 2, naming the field', () => {
    const { protocolVersion: _omit, ...unversioned } = base;
    const missing = RemoteAdapterManifestFile.safeParse(unversioned);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['protocolVersion']);
    expect(missing.error?.issues[0]?.message).toMatch(/^protocolVersion: expected 2, got nothing/);

    const v1 = RemoteAdapterManifestFile.safeParse({ ...base, protocolVersion: 1 });
    expect(v1.error?.issues[0]?.message).toMatch(/^protocolVersion: expected 2, got 1/);
  });

  it('projection advertises no requiredCredentialType (construction stays credential-free)', () => {
    const projected = remoteAdapterManifest(RemoteAdapterManifestFile.parse(base));
    expect(projected.requiredCredentialType).toBeUndefined();
  });
});
