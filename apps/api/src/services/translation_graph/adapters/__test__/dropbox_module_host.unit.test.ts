// What the platform does as Dropbox's host: reads the stored payload the
// connect flow wrote, refreshes a token about to expire through the secrets
// family against the platform's own app (the dev loop's fake OAuth provider
// here), hands the module only a working token, and points the test-harness
// team at fake-channels through the module's base URL override.

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

let harness = false;
jest.mock('../../../../lib/recording', () => ({
  isTestHarnessTeam: () => harness,
  injectFakeBaseUrl: (_creds: unknown, _type: string) => ({ baseUrl: `${process.env.FAKE_DROPBOX_ORIGIN}/dropbox` }),
}));

const oauth: { fakeBaseUrl?: string } = {};
jest.mock('../../../../adapters/registry', () => ({
  services: {
    get dropbox() {
      if (oauth.fakeBaseUrl === undefined) return undefined;
      const { DropboxAuthClient } = jest.requireActual('../../../../adapters/dropbox/authClient');
      return { authClient: new DropboxAuthClient({ clientId: 'c', clientSecret: 's', redirectBaseUrl: 'http://localhost', fakeBaseUrl: oauth.fakeBaseUrl }) };
    },
  },
}));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { createMemoryVault } from 'movement-engine/public/secrets';
import { makeMetaPosition } from 'movement-engine/public/catalog';
import { camelTokenPayloadShape } from '../../../credentials/secrets_postgres';
import { getAdapter } from '../registry';

const TEAM = 'team-host' as TeamId;

// The first call loads the module and its host; a loaded machine is slow at it.
jest.setTimeout(60_000);

interface Provider {
  origin: string;
  tokenCalls: string[];
  dropboxCalls: Array<{ path: string; authorization: string }>;
  refuseRefresh: boolean;
  close(): Promise<void>;
}

async function provider(): Promise<Provider> {
  const state: Provider = {
    origin: '',
    tokenCalls: [],
    dropboxCalls: [],
    refuseRefresh: false,
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/oauth/token') {
        state.tokenCalls.push(body);
        res.writeHead(state.refuseRefresh ? 400 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state.refuseRefresh ? { error: 'invalid_grant' } : { access_token: 'refreshed-token', expires_in: 3600 }));
        return;
      }
      state.dropboxCalls.push({ path: req.url ?? '', authorization: String(req.headers.authorization) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ entries: [{ '.tag': 'folder', name: 'Deals', path_display: '/Deals' }], has_more: false }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((done) => server.close(() => done()));
  return state;
}

const rootFolders = { position: makeMetaPosition('dropbox'), fieldId: 'Folders', direction: 'outgoing' as const };

describe('the platform as Dropbox’s host', () => {
  let fake: Provider;
  beforeEach(async () => {
    fake = await provider();
    harness = false;
    oauth.fakeBaseUrl = fake.origin;
    process.env.FAKE_DROPBOX_ORIGIN = fake.origin;
    postgresSecretsCalls.length = 0;
  });
  afterEach(() => fake.close());

  const install = { adapterType: 'dropbox', teamId: TEAM, credentialsId: 'cred-1' };
  const seed = (fields: Record<string, string>) => {
    vault.current = createMemoryVault({ 'cred-1': fields });
  };
  const soon = () => new Date(Date.now() + 5_000).toISOString();
  const later = () => new Date(Date.now() + 3_600_000).toISOString();

  it('reads the stored payload as the connect flow shaped it, for the team only', async () => {
    seed({ access_token: 'stored-token', refresh_token: 'r', expires_at: later(), baseUrl: fake.origin });
    await getAdapter(install).getRelated(rootFolders);
    expect(postgresSecretsCalls).toEqual([{ teamId: TEAM, shape: camelTokenPayloadShape }]);
    expect(fake.tokenCalls).toEqual([]);
    expect(fake.dropboxCalls[0]?.authorization).toBe('Bearer stored-token');
  });

  it('refreshes a token about to expire through the platform’s app before the module uses it, and stores the result', async () => {
    seed({ access_token: 'stale-token', refresh_token: 'refresh-1', expires_at: soon(), baseUrl: fake.origin });
    await getAdapter(install).getRelated(rootFolders);
    expect(fake.tokenCalls).toHaveLength(1);
    expect(new URLSearchParams(fake.tokenCalls[0]).get('refresh_token')).toBe('refresh-1');
    expect(new URLSearchParams(fake.tokenCalls[0]).get('client_id')).toBe('c');
    expect(fake.dropboxCalls[0]?.authorization).toBe('Bearer refreshed-token');
    expect((await vault.current!.resolve('cred-1'))?.fields).toMatchObject({ access_token: 'refreshed-token', refresh_token: 'refresh-1' });
  });

  it('names Dropbox and no secret when the refresh is refused', async () => {
    seed({ access_token: 'stale-token', refresh_token: 'refresh-1', expires_at: soon(), baseUrl: fake.origin });
    fake.refuseRefresh = true;
    const failure = await getAdapter(install).getRelated(rootFolders).catch((error: Error) => error);
    expect(failure).toEqual(new Error('Dropbox token refresh failed'));
    expect(fake.dropboxCalls).toEqual([]);
  });

  it('points the test-harness team at fake-channels, whatever the credential says', async () => {
    harness = true;
    seed({ access_token: 't', refresh_token: 'r', expires_at: later(), baseUrl: 'https://not-the-fake.example' });
    await getAdapter(install).getRelated(rootFolders);
    expect(fake.dropboxCalls[0]?.path).toBe('/dropbox/2/files/list_folder');
  });
});
