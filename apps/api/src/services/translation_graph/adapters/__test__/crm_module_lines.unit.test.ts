// Affinity, Airtable and Attio on their module lines, as the platform hosts
// them: each declares the signed inbound its door verified before (same
// provider key, scheme and header chain, so no webhook URL or valid signature
// changes); an OAuth module reads the platform's stored rows in its own field
// names and is refreshed with the platform's app, written back in the row's
// names; and a module's own files leave it naming the install that owns them.

const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../credentials/secrets_postgres', () => ({
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';

import { defineModule, type ModuleCredential } from 'module-kit';
import { BaseAdapter } from 'module-kit/adapter/base';
import { createMemoryVault } from 'movement-engine/public/secrets';
import { verifyInbound } from 'movement-engine/public/inbound';
import { AIRTABLE_MANIFEST } from '@lf/airtable/manifest';
import { LEGACY_SIGNATURE_HEADERS } from '../../../inbound/legacy_signature_headers';
import { BUILTIN_MODULES, builtinModuleInboundVerifier, loadBuiltinModule } from '../builtin_modules';
import { platformOAuthApp, storedCredentialShape } from '../module_credentials';
import { stampingFileOwners } from '../module_file_owners';

const TEAM = 'team-crm-lines' as TeamId;

/** The least adapter a module can be: it reads nothing. */
class ProbeAdapter extends BaseAdapter {
  readonly adapterType = 'airtable';
  readonly supportedTriggers = [];
  async listEntryPoints() {
    return [];
  }
  async describe() {
    return null;
  }
}

describe.each(['affinity', 'airtable', 'attio'])('%s on its module line', (adapterType) => {
  const line = BUILTIN_MODULES[adapterType];
  if (line?.kind !== 'adapter' || line.line !== 'module') throw new Error(`${adapterType} is not on a module line`);
  const definition = line.load();

  it('lists by the manifest its module declares', () => {
    expect(line.manifest).toBe(definition.manifest);
  });

  it("declares today's provider key, scheme and header chain", () => {
    const key = adapterType.toUpperCase();
    const frozen = LEGACY_SIGNATURE_HEADERS[key];
    expect(definition.inbound?.providerKey).toBe(adapterType);
    expect(frozen !== undefined && 'scheme' in frozen ? { scheme: frozen.scheme, signatureHeaders: [...frozen.signatureHeaders] } : frozen).toEqual({
      scheme: definition.inbound?.scheme,
      signatureHeaders: definition.inbound?.signatureHeaders,
    });
    expect(builtinModuleInboundVerifier(key)).toBeDefined();
  });

  it('refuses a delivery whose subscription has no usable secret, however it is signed', () => {
    const verifier = builtinModuleInboundVerifier(adapterType.toUpperCase());
    if (verifier === undefined) throw new Error('no declared verifier');
    const rawBody = Buffer.from('{"events":[]}');
    const header = definition.inbound?.signatureHeaders[0] ?? '';
    for (const secret of ['', '   ', 'pending']) {
      const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
      expect(verifyInbound(verifier, { rawBody, headers: { [header]: signature }, secret })).toBe(false);
    }
  });
});

describe('an OAuth module over the platform row', () => {
  it("reads Airtable's stored names as the protocol's token fields, and writes back in the row's", () => {
    const shape = storedCredentialShape('@lf/airtable');
    const stored = { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', refreshTokenExpiresAt: 'x', baseUrl: 'b' };
    expect(shape.toModule(stored)).toEqual({ access_token: 'a', refresh_token: 'r', expires_at: '2030-01-01T00:00:00.000Z', refreshTokenExpiresAt: 'x', baseUrl: 'b' });
    expect(shape.toStored({ access_token: 'a2', expires_at: 'e2' })).toEqual({ accessToken: 'a2', accessTokenExpiresAt: 'e2' });
    expect(storedCredentialShape('@lf/dealroom').toModule({ apiKey: 'k' })).toEqual({ apiKey: 'k' });
  });

  it("uses this deployment's app, and none without one", () => {
    expect(platformOAuthApp('@lf/airtable', { AIRTABLE_CLIENT_ID: 'id', AIRTABLE_CLIENT_SECRET: 's' })).toEqual({ clientId: 'id', clientSecret: 's' });
    expect(platformOAuthApp('@lf/airtable', {})).toBeUndefined();
    expect(platformOAuthApp('@lf/dealroom', { AIRTABLE_CLIENT_ID: 'id', AIRTABLE_CLIENT_SECRET: 's' })).toBeUndefined();
  });

  it('refreshes a refused token with the platform app and writes the row back in its own names', async () => {
    const calls: string[] = [];
    const tokenServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        calls.push(`${req.headers.authorization ?? ''} ${body}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
    const { port } = tokenServer.address() as AddressInfo;
    process.env.AIRTABLE_CLIENT_ID = 'app-id';
    process.env.AIRTABLE_CLIENT_SECRET = 'app-secret';
    try {
      // A module named as Airtable's (its stored shape), declaring the token
      // URL of a local provider; it hands its credential back to the test.
      let seen: ModuleCredential | undefined;
      const probe = defineModule({
        kind: 'adapter',
        name: '@lf/airtable',
        manifest: { ...AIRTABLE_MANIFEST, methods: ['listEntryPoints'] },
        credentials: [
          { name: 'airtable', kind: 'oauth2', oauth2: { authorizeUrl: 'https://example.test/a', tokenUrl: `http://127.0.0.1:${port}/token` }, fields: [] },
        ],
        create: (ctx) => {
          seen = ctx.credential;
          return new ProbeAdapter();
        },
      });
      vault.current = createMemoryVault({
        'cred-air': { accessToken: 'stale', refreshToken: 'r1', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', refreshTokenExpiresAt: '2031-01-01T00:00:00.000Z' },
      });
      loadBuiltinModule(probe, { teamId: TEAM, credentialsId: 'cred-air' });
      expect(await seen?.fields()).toMatchObject({ access_token: 'stale', refresh_token: 'r1' });
      expect(await seen?.refresh?.()).toMatchObject({ access_token: 'fresh', refresh_token: 'rotated' });
      expect(calls).toEqual([`Basic ${Buffer.from('app-id:app-secret').toString('base64')} grant_type=refresh_token&refresh_token=r1`]);
      const row = (await vault.current.resolve('cred-air'))?.fields;
      expect(row).toMatchObject({ accessToken: 'fresh', refreshToken: 'rotated', refreshTokenExpiresAt: '2031-01-01T00:00:00.000Z' });
      expect(row).not.toHaveProperty('access_token');
    } finally {
      delete process.env.AIRTABLE_CLIENT_ID;
      delete process.env.AIRTABLE_CLIENT_SECRET;
      tokenServer.close();
    }
  });
});

describe('a module line stamps its own files with the owning install', () => {
  it('names the credential and construction args on its own unowned files only', async () => {
    const own = { __brand: 'FileRef', name: 'a.pdf', source: { adapterType: 'attio', handle: 'f1' } };
    const foreign = { __brand: 'FileRef', name: 'b.pdf', source: { adapterType: 'slack', handle: 'f2' } };
    const owned = { __brand: 'FileRef', name: 'c.pdf', source: { adapterType: 'attio', credentialId: 'other', handle: 'f3' } };
    const adapter = { adapterType: 'attio', getFieldValue: async () => ({ files: [own, foreign, owned] }) } as unknown as Adapter;
    const stamped = stampingFileOwners(adapter, { teamId: TEAM, credentialsId: 'cred-1', constructionArgs: { base: 'x' } });
    expect(await stamped.getFieldValue({ position: {} as never, fieldId: 'File' })).toEqual({
      files: [
        { ...own, source: { adapterType: 'attio', handle: 'f1', credentialId: 'cred-1', constructionArgs: { base: 'x' } } },
        foreign,
        owned,
      ],
    });
  });
});
