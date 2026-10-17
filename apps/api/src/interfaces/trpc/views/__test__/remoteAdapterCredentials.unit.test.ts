// A member creating their own provider credential for an installed remote
// module, through the `remoteAdapter` router and the sign-in callback route.
// The install row, its decrypted payload, the credentials table and the mint
// are mocked; what is locked down is what reaches the mint (and what never
// reaches the member: a secret value), and what is refused before it.

const ctxUser = { id: 'user-1', teamId: 'team-1' };
const ctxPrincipal = {
  userId: ctxUser.id,
  teamId: ctxUser.teamId,
  access: 'write' as const,
  scopes: ['*'],
  pinnedTeamId: null,
};
jest.mock('../../../../services/context', () => ({
  currentContext: () => ({ user: ctxUser, principal: ctxPrincipal }),
}));

const getRemoteAdapterMock = jest.fn();
jest.mock('../../../../services/translation_graph/adapters/remote/store', () => {
  const actual = jest.requireActual('../../../../services/translation_graph/adapters/remote/store');
  return { ...actual, getRemoteAdapter: (...args: unknown[]) => getRemoteAdapterMock(...args) };
});

const installPayloadMock = jest.fn();
jest.mock('../../../../services/translation_graph/adapters/resolve', () => ({
  loadRemoteInstallPayload: (...args: unknown[]) => installPayloadMock(...args),
}));

const mintMock = jest.fn().mockResolvedValue({ credentialsId: 'cred-new' });
jest.mock('../../../../services/credentials/remote_credential', () => ({
  mintRemoteModuleCredential: (...args: unknown[]) => mintMock(...args),
}));

// The credentials table: `execute` answers a listing, `executeTakeFirst` the
// taken-name check.
const credentialRows: { id: string; name: string; declared_credential: string }[] = [];
let takenName: { id: string } | undefined;
jest.mock('../../../../lib/kysely', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['selectFrom', 'where', 'select', 'orderBy']) chain[method] = () => chain;
  chain.execute = async () => credentialRows;
  chain.executeTakeFirst = async () => takenName;
  return { getAutomationsQb: () => chain };
});

import type { Request, Response } from 'express';

import { remoteAdapterRouter } from '../remoteAdapter';
import { trpc } from '../../trpc';
import { remoteAdapterSignInCallbackHandler } from '../../../rest/remote_adapter_callback';

const MANIFEST = {
  protocolVersion: 2,
  adapterType: 'hubspot',
  baseUrl: 'https://module.example.com',
  authStrategy: { kind: 'bearer' },
  supportedTriggers: [],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['describe'],
  credentials: [
    {
      name: 'api_key',
      kind: 'static',
      fields: [
        { name: 'token', label: 'API token' },
        { name: 'workspace', secret: false, optional: true },
      ],
    },
    {
      name: 'oauth',
      kind: 'oauth2',
      fields: [],
      oauth2: {
        authorizeUrl: 'https://provider.example.com/oauth/authorize',
        tokenUrl: 'https://provider.example.com/oauth/token',
        scopes: ['deals.read', 'deals.write'],
      },
    },
  ],
};

const INSTALL_ROW = {
  id: 'install-1',
  team_id: 'team-1',
  adapter_type: 'hubspot',
  base_url: MANIFEST.baseUrl,
  auth_strategy: MANIFEST.authStrategy,
  credentials_id: 'install-cred-1',
  manifest: MANIFEST,
  created_at: new Date(0),
  updated_at: new Date(0),
};

const SERVER_SECRET = 'server-secret-never-shown';
const CLIENT = { clientId: 'host-app', clientSecret: 'host-app-secret' };

function caller() {
  return remoteAdapterRouter(trpc.procedure).createCaller({ authorise: async () => {} });
}

/** Run the callback route with this query; what it answered. */
async function callback(query: Record<string, string>) {
  const answered: { status?: number; sent?: unknown; redirect?: string } = {};
  const res = {
    status(code: number) {
      answered.status = code;
      return res;
    },
    send(body: unknown) {
      answered.sent = body;
      return res;
    },
    redirect(url: string) {
      answered.redirect = url;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await remoteAdapterSignInCallbackHandler({ query } as unknown as Request, res as unknown as Response, (() => {}) as any);
  return answered;
}

beforeEach(() => {
  getRemoteAdapterMock.mockReset().mockResolvedValue(INSTALL_ROW);
  installPayloadMock.mockReset().mockResolvedValue({ secret: SERVER_SECRET, oauthClients: { oauth: CLIENT } });
  mintMock.mockClear();
  credentialRows.length = 0;
  takenName = undefined;
});

afterEach(() => jest.restoreAllMocks());

describe('credentials — what a module declares, and what was created for it', () => {
  it('lists each declaration with its fields flagged, its credentials, and never a secret value', async () => {
    credentialRows.push(
      { id: 'c-1', name: 'alice_hubspot', declared_credential: 'oauth' },
      { id: 'c-2', name: 'team_key', declared_credential: 'api_key' },
    );

    const listed = await caller().credentials({ adapterType: 'hubspot' });

    expect(getRemoteAdapterMock).toHaveBeenCalledWith({ teamId: 'team-1', adapterType: 'hubspot' });
    expect(listed.declarations).toEqual([
      {
        name: 'api_key',
        kind: 'static',
        fields: [
          { name: 'token', label: 'API token', secret: true, optional: false },
          { name: 'workspace', label: 'workspace', secret: false, optional: true },
        ],
        credentials: [{ id: 'c-2', name: 'team_key' }],
      },
      { name: 'oauth', kind: 'oauth2', signInAvailable: true, fields: [], credentials: [{ id: 'c-1', name: 'alice_hubspot' }] },
    ]);
    expect(listed.redirectUri).toMatch(/\/remote-adapters\/callback$/);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(SERVER_SECRET);
    expect(text).not.toContain(CLIENT.clientSecret);
  });

  it('says sign-in is unavailable when the install holds no OAuth app for the declaration', async () => {
    installPayloadMock.mockResolvedValue({ secret: SERVER_SECRET });
    const listed = await caller().credentials({ adapterType: 'hubspot' });
    expect(listed.declarations[1]).toMatchObject({ name: 'oauth', signInAvailable: false });
  });

  it('refuses a module the team has not installed', async () => {
    getRemoteAdapterMock.mockResolvedValue(null);
    await expect(caller().credentials({ adapterType: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('createStaticCredential — validated against the declaration, then minted', () => {
  it('mints with the module, the declaration, the name and the entered fields', async () => {
    const created = await caller().createStaticCredential({
      adapterType: 'hubspot',
      declaredCredential: 'api_key',
      name: 'team_key',
      fields: { token: 'tok-123', workspace: '' },
    });

    expect(created).toEqual({ credentialsId: 'cred-new' });
    expect(mintMock).toHaveBeenCalledWith({
      teamId: 'team-1',
      userId: 'user-1',
      adapterType: 'hubspot',
      declaredCredential: 'api_key',
      name: 'team_key',
      fields: { token: 'tok-123' },
    });
  });

  it('refuses a required field left out', async () => {
    await expect(
      caller().createStaticCredential({ adapterType: 'hubspot', declaredCredential: 'api_key', name: 'team_key', fields: { workspace: 'w1' } }),
    ).rejects.toThrow('"api_key" needs "API token"');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('refuses a field the declaration does not list', async () => {
    await expect(
      caller().createStaticCredential({
        adapterType: 'hubspot',
        declaredCredential: 'api_key',
        name: 'team_key',
        fields: { token: 'tok-123', password: 'hunter2' },
      }),
    ).rejects.toThrow('"api_key" does not declare "password"');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('refuses a name a movement could not import, and an oauth2 declaration', async () => {
    await expect(
      caller().createStaticCredential({ adapterType: 'hubspot', declaredCredential: 'api_key', name: "Alice's key", fields: { token: 't' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createStaticCredential({ adapterType: 'hubspot', declaredCredential: 'oauth', name: 'alice_hubspot', fields: {} }),
    ).rejects.toThrow('signing in at the provider');
    expect(mintMock).not.toHaveBeenCalled();
  });
});

describe('beginOAuthCredential and the callback — signing in at the provider', () => {
  it('returns an authorize URL built from the declaration and the install’s app', async () => {
    const { url } = await caller().beginOAuthCredential({ adapterType: 'hubspot', declaredCredential: 'oauth', name: 'alice_hubspot' });

    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://provider.example.com/oauth/authorize');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT.clientId);
    expect(authorize.searchParams.get('scope')).toBe('deals.read deals.write');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/\/remote-adapters\/callback$/);
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(url).not.toContain(CLIENT.clientSecret);
  });

  it('refuses when the install holds no OAuth app for the declaration', async () => {
    installPayloadMock.mockResolvedValue({ secret: SERVER_SECRET });
    await expect(
      caller().beginOAuthCredential({ adapterType: 'hubspot', declaredCredential: 'oauth', name: 'alice_hubspot' }),
    ).rejects.toThrow('has no OAuth app for "oauth"');
  });

  it('refuses a name already taken before sending the member to the provider', async () => {
    takenName = { id: 'c-9' };
    await expect(
      caller().beginOAuthCredential({ adapterType: 'hubspot', declaredCredential: 'oauth', name: 'alice_hubspot' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('the callback exchanges the code with the install’s app and stores the tokens through the mint', async () => {
    const { url } = await caller().beginOAuthCredential({ adapterType: 'hubspot', declaredCredential: 'oauth', name: 'alice_hubspot' });
    const state = new URL(url).searchParams.get('state') ?? '';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), { status: 200 }),
    );

    const answered = await callback({ state, code: 'code-1' });

    const [tokenUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(tokenUrl).toBe('https://provider.example.com/oauth/token');
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(mintMock).toHaveBeenCalledWith({
      teamId: 'team-1',
      userId: 'user-1',
      adapterType: 'hubspot',
      declaredCredential: 'oauth',
      name: 'alice_hubspot',
      fields: { access_token: 'at-1', refresh_token: 'rt-1', expires_at: expect.any(String) },
    });
    expect(answered.redirect).toMatch(/\/settings\/remote-adapters\?connected=alice_hubspot$/);

    // Single use: the same state again is an attempt this server no longer holds.
    mintMock.mockClear();
    const again = await callback({ state, code: 'code-1' });
    expect(mintMock).not.toHaveBeenCalled();
    expect(again.redirect).toContain('error=');
  });

  it('the callback refuses a state it never began', async () => {
    const answered = await callback({ state: 'never-began', code: 'code-1' });
    expect(answered).toMatchObject({ status: 401, sent: 'Unknown OAuth flow' });
    expect(mintMock).not.toHaveBeenCalled();
  });
});
