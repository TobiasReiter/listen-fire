// Affinity, Airtable and Attio on their module lines, as the platform hosts
// them: each declares the signed inbound its door verified before (same
// provider key, scheme and header chain, so no webhook URL or valid signature
// changes); an OAuth module reads the platform's stored rows in its own field
// names and is refreshed with the platform's app, written back in the row's
// names; and a module's own files leave it naming the install that owns them.

const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
const postgresSecretsCalls: unknown[] = [];
jest.mock('../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../credentials/secrets_postgres'),
  postgresSecrets: (options: unknown) => {
    postgresSecretsCalls.push(options);
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
import { AIRTABLE_MANIFEST } from '@listen-fire/airtable/manifest';
import { LEGACY_SIGNATURE_HEADERS } from '../../../inbound/legacy_signature_headers';
import { ownedFilesAdapter } from 'movement-engine/public/modules';
import { BUILTIN_MODULES, builtinModuleInboundVerifier, loadBuiltinModule, type BuiltinModuleLine } from '../builtin_modules';
import { oauthAppFromEnv } from '../module_credentials';

function moduleLine(adapterType: string): Extract<BuiltinModuleLine, { kind: 'adapter'; line: 'module' }> {
  const line = BUILTIN_MODULES[adapterType];
  if (line?.kind !== 'adapter' || line.line !== 'module') throw new Error(`${adapterType} is not on a module line`);
  return line;
}

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
    const shape = moduleLine('airtable').storedAs;
    if (shape === undefined) throw new Error('airtable names no stored shape');
    const stored = { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', refreshTokenExpiresAt: 'x', baseUrl: 'b' };
    expect(shape.toFields(stored)).toEqual({ access_token: 'a', refresh_token: 'r', expires_at: '2030-01-01T00:00:00.000Z', refreshTokenExpiresAt: 'x', baseUrl: 'b' });
    expect(shape.withFields(stored, { access_token: 'a2', expires_at: 'e2' })).toEqual({ ...stored, accessToken: 'a2', accessTokenExpiresAt: 'e2' });
    expect(moduleLine('attio').storedAs?.toFields({ accessToken: 'k', baseUrl: 'b' })).toEqual({ access_token: 'k', baseUrl: 'b' });
    expect(moduleLine('dealroom').storedAs).toBeUndefined();
  });

  it("uses this deployment's app, and none without one", () => {
    const names = { clientId: 'AIRTABLE_CLIENT_ID', clientSecret: 'AIRTABLE_CLIENT_SECRET' };
    expect(oauthAppFromEnv(names, { AIRTABLE_CLIENT_ID: 'id', AIRTABLE_CLIENT_SECRET: 's' })).toEqual({ clientId: 'id', clientSecret: 's' });
    expect(oauthAppFromEnv(names, {})).toBeUndefined();
    expect(moduleLine('dealroom').hostApp).toBeUndefined();
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
      // The store reads the row through the line's shape (tested above), so
      // the vault holds it as the module reads it.
      vault.current = createMemoryVault({
        'cred-air': { access_token: 'stale', refresh_token: 'r1', expires_at: '2030-01-01T00:00:00.000Z', refreshTokenExpiresAt: '2031-01-01T00:00:00.000Z' },
      });
      postgresSecretsCalls.length = 0;
      const line = moduleLine('airtable');
      loadBuiltinModule({ ...line, load: () => probe }, { teamId: TEAM, credentialsId: 'cred-air' });
      expect(postgresSecretsCalls).toEqual([{ teamId: TEAM, shape: line.storedAs }]);
      expect(await seen?.fields()).toMatchObject({ access_token: 'stale', refresh_token: 'r1' });
      expect(await seen?.refresh?.()).toMatchObject({ access_token: 'fresh', refresh_token: 'rotated' });
      expect(calls).toEqual([`Basic ${Buffer.from('app-id:app-secret').toString('base64')} grant_type=refresh_token&refresh_token=r1`]);
      expect((await vault.current.resolve('cred-air'))?.fields).toMatchObject({
        access_token: 'fresh',
        refresh_token: 'rotated',
        refreshTokenExpiresAt: '2031-01-01T00:00:00.000Z',
      });
    } finally {
      delete process.env.AIRTABLE_CLIENT_ID;
      delete process.env.AIRTABLE_CLIENT_SECRET;
      tokenServer.close();
    }
  });
});

describe('a module line names its own files with the owning install', () => {
  it('names the credential and construction args on a file field', async () => {
    const own = { __brand: 'FileRef', name: 'a.pdf', source: { adapterType: 'attio', handle: 'f1' } };
    const adapter = {
      adapterType: 'attio',
      describe: async () => ({ fields: [{ fieldId: 'File', displayName: 'File', kind: 'file' }] }),
      getFieldValue: async () => own,
    } as unknown as Adapter;
    const named = ownedFilesAdapter(adapter, { adapterType: 'attio', credentialsId: 'cred-1', constructionArgs: { base: 'x' } });
    expect(await named.getFieldValue({ position: { recordType: 'Record' } as never, fieldId: 'File' })).toEqual({
      ...own,
      source: { adapterType: 'attio', credentialId: 'cred-1', constructionArgs: { base: 'x' }, handle: 'f1' },
    });
  });
});
