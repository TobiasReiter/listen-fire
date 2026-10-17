// What the platform hosts a module line with, beyond the defaults: the stored
// payload read as fields the way the line says (`storedAs`), an `oauth2`
// credential refreshed in process through the platform's app (`hostApp`)
// before it reaches the module, and the line's kv. The refresh runs once per
// credential however many calls find it stale, and the refreshed token is
// written back in the payload's own shape.

const mockPayloads: Map<string, Record<string, unknown>> = new Map();
jest.mock('../../../credentials/secrets_postgres', () => {
  const actual = jest.requireActual('../../../credentials/secrets_postgres');
  const { payloadSecrets } = jest.requireActual('../../../credentials/__test__/payload_secrets');
  return {
    ...actual,
    postgresSecrets: (options: { shape?: unknown }) => payloadSecrets(mockPayloads, options.shape ?? actual.flatPayloadShape),
  };
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { BASE_RUNTIME_CAPABILITIES } from 'movement-engine/public/adapter';
import { makeMetaPosition } from 'movement-engine/public/catalog';
import { defineModule, type AdapterModuleDefinition, type ModuleContext, type ModuleKv } from 'module-kit';

import { camelTokenPayloadShape } from '../../../credentials/secrets_postgres';
import { HOST_REFRESH_WINDOW_MS, loadBuiltinModule, type BuiltinModuleLine } from '../builtin_modules';

const TEAM = 'team-host' as TeamId;
const APP = { clientId: 'platform-client', clientSecret: 'platform-secret' };

/** A token endpoint that answers the refresh grant after a beat (so calls
 *  overlap), and keeps every form it was sent. */
async function tokenEndpoint(): Promise<{ url: string; forms: Array<Record<string, string>>; close(): Promise<void> }> {
  const forms: Array<Record<string, string>> = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      forms.push(Object.fromEntries(new URLSearchParams(body)));
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: `fresh-${forms.length}`, expires_in: 3600, token_type: 'Bearer' }));
      }, 50);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/token`, forms, close: () => new Promise((done) => server.close(() => done())) };
}

/** A module that answers its access token, and its kv's keys, as field values. */
function probeModule(tokenUrl: string): AdapterModuleDefinition {
  const manifest = {
    adapterType: 'token_probe',
    displayName: 'Token Probe',
    description: 'Answers its credential.',
    supportedTriggers: [],
    methods: ['listEntryPoints', 'describe', 'getFieldValue'],
  };
  return defineModule({
    kind: 'adapter',
    name: '@lf/token-probe',
    manifest,
    credentials: [{ name: 'probe', kind: 'oauth2', fields: [], oauth2: { authorizeUrl: 'https://auth.invalid/authorize', tokenUrl, scopes: ['read'], clientAuth: 'body' } }],
    create: (ctx: ModuleContext) => ({
      adapterType: 'token_probe',
      supportedTriggers: [],
      runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async ({ fieldId }) => (fieldId === 'kv' ? (await ctx.kv.list('')).map((entry) => entry.key) : ((await ctx.credential.fields()).access_token ?? null)),
      getRelated: async () => [],
      createRecord: async () => {
        throw new Error('read-only');
      },
      updateRecord: async () => {
        throw new Error('read-only');
      },
      deleteRecord: async () => {
        throw new Error('read-only');
      },
    }),
  });
}

function line(definition: AdapterModuleDefinition, extra: Partial<Extract<BuiltinModuleLine, { kind: 'adapter'; line: 'module' }>> = {}) {
  return { kind: 'adapter' as const, line: 'module' as const, manifest: definition.manifest, load: () => definition, storedAs: camelTokenPayloadShape, ...extra };
}

const at = { position: makeMetaPosition('token_probe'), fieldId: 'token' };

function storeGoogleShaped(ref: string, expiresAt: number): void {
  mockPayloads.set(ref, { accessToken: 'stale', refreshToken: 'refresh-1', expiresAt, scopes: ['kept'] });
}

describe('a module line’s oauth2 credential, refreshed in process', () => {
  let endpoint: Awaited<ReturnType<typeof tokenEndpoint>>;
  beforeEach(async () => {
    mockPayloads.clear();
    endpoint = await tokenEndpoint();
  });
  afterEach(() => endpoint.close());

  it('refreshes a token that expires within the window, once, through the platform’s app, and writes it back camel-shaped', async () => {
    storeGoogleShaped('cred-1', Date.now() + HOST_REFRESH_WINDOW_MS - 1_000);
    const loaded = loadBuiltinModule(line(probeModule(endpoint.url), { hostApp: () => APP }), { teamId: TEAM, credentialsId: 'cred-1' });
    const before = Date.now();
    expect(await loaded.adapter.getFieldValue(at)).toBe('fresh-1');
    expect(endpoint.forms).toEqual([{ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'platform-client', client_secret: 'platform-secret' }]);
    const stored = mockPayloads.get('cred-1');
    expect(stored).toEqual({ accessToken: 'fresh-1', refreshToken: 'refresh-1', expiresAt: expect.any(Number), scopes: ['kept'] });
    expect(Number(stored?.expiresAt)).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
    // Fresh now: the next call spends nothing.
    expect(await loaded.adapter.getFieldValue(at)).toBe('fresh-1');
    expect(endpoint.forms).toHaveLength(1);
  });

  it('makes one token call for two calls that find it stale at once', async () => {
    storeGoogleShaped('cred-1', Date.now() - 1_000);
    const loaded = loadBuiltinModule(line(probeModule(endpoint.url), { hostApp: () => APP }), { teamId: TEAM, credentialsId: 'cred-1' });
    expect(await Promise.all([loaded.adapter.getFieldValue(at), loaded.adapter.getFieldValue(at)])).toEqual(['fresh-1', 'fresh-1']);
    expect(endpoint.forms).toHaveLength(1);
  });

  it('hands over a token outside the window as stored, with no token call', async () => {
    storeGoogleShaped('cred-1', Date.now() + HOST_REFRESH_WINDOW_MS + 60_000);
    const loaded = loadBuiltinModule(line(probeModule(endpoint.url), { hostApp: () => APP }), { teamId: TEAM, credentialsId: 'cred-1' });
    expect(await loaded.adapter.getFieldValue(at)).toBe('stale');
    expect(endpoint.forms).toHaveLength(0);
  });

  it('never refreshes on a line with no host app', async () => {
    storeGoogleShaped('cred-1', Date.now() - 1_000);
    const loaded = loadBuiltinModule(line(probeModule(endpoint.url)), { teamId: TEAM, credentialsId: 'cred-1' });
    expect(await loaded.adapter.getFieldValue(at)).toBe('stale');
    expect(endpoint.forms).toHaveLength(0);
  });

  it('refuses by name an expired token when the platform has no app configured', async () => {
    storeGoogleShaped('cred-1', Date.now() - 1_000);
    const loaded = loadBuiltinModule(line(probeModule(endpoint.url), { hostApp: () => undefined }), { teamId: TEAM, credentialsId: 'cred-1' });
    await expect(loaded.adapter.getFieldValue(at)).rejects.toThrow('no Token Probe OAuth app configured');
    expect(endpoint.forms).toHaveLength(0);
  });
});

describe('a module line’s kv', () => {
  it('is the one the line supplies for the install', async () => {
    const entries = [{ key: 'granted/a', value: 1 }];
    const kv: ModuleKv = { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => entries };
    const seen: unknown[] = [];
    const loaded = loadBuiltinModule(
      line(probeModule('http://127.0.0.1:1/token'), {
        kv: (install) => {
          seen.push(install);
          return kv;
        },
      }),
      { teamId: TEAM, credentialsId: 'cred-1' },
    );
    expect(await loaded.adapter.getFieldValue({ ...at, fieldId: 'kv' })).toEqual(['granted/a']);
    expect(seen).toEqual([{ teamId: TEAM, credentialsId: 'cred-1' }]);
  });

  it('is refused by name when the line supplies none', async () => {
    const loaded = loadBuiltinModule(line(probeModule('http://127.0.0.1:1/token')), { teamId: TEAM, credentialsId: 'cred-1' });
    await expect(loaded.adapter.getFieldValue({ ...at, fieldId: 'kv' })).rejects.toThrow('@lf/token-probe: ctx.kv has no store');
  });
});
