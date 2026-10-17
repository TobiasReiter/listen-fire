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

  it.each(['ſlack', 'attıo', 'aﬃnity', 'Acme', '1acme', 'acme-crm', ''])('refuses the adapterType %j', (adapterType) => {
    const parsed = RemoteAdapterManifestFile.safeParse({ ...base, adapterType });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['adapterType']);
  });

  it('projection advertises no requiredCredentialType (construction stays credential-free)', () => {
    const projected = remoteAdapterManifest(RemoteAdapterManifestFile.parse(base));
    expect(projected.requiredCredentialType).toBeUndefined();
  });

  it('carries a module\'s declarations, and still parses a manifest stored before they existed', () => {
    const declared = {
      ...base,
      methods: [...base.methods, 'poll'],
      credentials: [{ name: 'acme', kind: 'static' as const, fields: [{ name: 'api_key' }] }],
      inbound: { providerKey: 'acme_crm', scheme: 'remote' as const, signatureHeaders: ['x-listen-fire-signature'] },
      poll: { intervalSeconds: 300 },
      periodic: [{ name: 'renew', intervalSeconds: 3600 }],
    };
    const parsed = RemoteAdapterManifestFile.parse(declared);
    expect(parsed.credentials).toEqual(declared.credentials);
    expect(parsed.inbound).toEqual(declared.inbound);
    expect(parsed.poll).toEqual({ intervalSeconds: 300 });
    expect(parsed.periodic).toEqual(declared.periodic);
    // A row stored with `poll` in methods and the declaration dropped.
    expect(RemoteAdapterManifestFile.safeParse({ ...base, methods: [...base.methods, 'poll'] }).success).toBe(true);
  });

  it('refuses a malformed declaration, as the protocol does', () => {
    expect(RemoteAdapterManifestFile.safeParse({ ...base, inbound: { providerKey: 'acme', scheme: 'unknown', signatureHeaders: ['x'] } }).success).toBe(false);
    expect(RemoteAdapterManifestFile.safeParse({ ...base, poll: { intervalSeconds: 0 } }).success).toBe(false);
  });
});
