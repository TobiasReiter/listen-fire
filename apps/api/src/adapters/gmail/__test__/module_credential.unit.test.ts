// The credential the platform hands `@lf/gmail`: one set of fields whichever
// way the mailbox was connected, the allowlist enforced before anything is
// handed over, a sign-in refreshed and written back in its stored shape, and
// a delegated mailbox's tokens minted per scope and never written down.

const mockRow: { app_id: string | null } = { app_id: 'gmail-oauth-mailbox' };
jest.mock('../../../lib/kysely', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['selectFrom', 'where', 'select']) chain[name] = () => chain;
  chain.executeTakeFirst = async () => ({ app_id: mockRow.app_id });
  return { getAutomationsQb: () => chain };
});
const mockPayloads: Map<string, Record<string, unknown>> = new Map();
jest.mock('../../../services/credentials/secrets_postgres', () => {
  const actual = jest.requireActual('../../../services/credentials/secrets_postgres');
  const { payloadSecrets } = jest.requireActual('../../../services/credentials/__test__/payload_secrets');
  return { ...actual, postgresSecrets: (options: { shape?: unknown }) => payloadSecrets(mockPayloads, options.shape ?? actual.flatPayloadShape) };
});
const mockHarness: { baseUrl?: string } = {};
jest.mock('../../../lib/recording', () => ({
  isTestHarnessTeam: () => mockHarness.baseUrl !== undefined,
  injectFakeBaseUrl: (creds: Record<string, unknown>) => (mockHarness.baseUrl !== undefined ? { ...creds, baseUrl: mockHarness.baseUrl } : creds),
}));

import type { TeamId } from '../../../generated/kysely/core/Team';

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, gmailClientFromFields } from '@listen-fire/gmail';
import { forgetMintedGmailTokens, gmailModuleCredential } from '../module_credential';

const TEAM = 'team-1' as TeamId;
const REF = 'cred-1';
const MAILBOX = 'deals@example.com';
const ALLOWED = { GMAIL_MAILBOX_ALLOWLIST: MAILBOX };
const NOW = Date.UTC(2026, 9, 17, 12, 0);

function signedIn(expiresAt: number) {
  mockRow.app_id = 'gmail-oauth-mailbox';
  mockPayloads.set(REF, {
    mailbox: MAILBOX,
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    expiresAt,
    grantedScopes: [GMAIL_READONLY_SCOPE],
  });
}

function delegatedRow() {
  mockRow.app_id = 'gmail-delegated';
  mockPayloads.set(REF, { mailbox: MAILBOX });
}

beforeEach(() => {
  mockPayloads.clear();
  delete mockHarness.baseUrl;
  forgetMintedGmailTokens();
  jest.restoreAllMocks();
});

describe('a signed-in mailbox', () => {
  it('reads as the token fields, the mailbox, its granted scopes and its method', async () => {
    signedIn(NOW + 3600_000 * 24 * 365 * 50);
    const fields = await gmailModuleCredential({ teamId: TEAM, credentialsId: REF }).fields();
    expect(fields).toMatchObject({
      mailbox: MAILBOX,
      method: 'oauth',
      access_token: 'stored-access',
      refresh_token: 'stored-refresh',
      granted_scopes: GMAIL_READONLY_SCOPE,
    });
    // What the module makes of it: a sign-in that never granted the send scope.
    expect(gmailClientFromFields(fields, { fetch }).canSend()).toBe(false);
  });

  it('is refreshed with the installation’s Gmail client when it nears expiry, and written back as stored', async () => {
    signedIn(Date.now() + 60_000);
    const calls: Array<{ url: string; body: string }> = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const env = { GMAIL_OAUTH_CLIENT_ID: 'gmail-client', GMAIL_OAUTH_CLIENT_SECRET: 'gmail-secret' };
    const fields = await gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env }).fields();

    expect(fields.access_token).toBe('fresh-access');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(new URLSearchParams(calls[0]?.body)).toEqual(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'stored-refresh', client_id: 'gmail-client', client_secret: 'gmail-secret' }),
    );
    expect(mockPayloads.get(REF)).toMatchObject({
      mailbox: MAILBOX,
      accessToken: 'fresh-access',
      refreshToken: 'stored-refresh',
      grantedScopes: [GMAIL_READONLY_SCOPE],
    });
    expect(mockPayloads.get(REF)).not.toHaveProperty('granted_scopes');
    expect(mockPayloads.get(REF)).not.toHaveProperty('method');
  });

  it('refreshes against the dev loop’s fake Google for the test-harness team', async () => {
    signedIn(Date.now() + 60_000);
    mockHarness.baseUrl = 'http://127.0.0.1:9999';
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ access_token: 'fake-access', expires_in: 3600 }), { status: 200 });
    });
    await gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: { GOOGLE_INTEGRATIONS_CLIENT_ID: 'g', GOOGLE_INTEGRATIONS_CLIENT_SECRET: 's' } }).fields();
    expect(urls).toEqual(['http://127.0.0.1:9999/fake-google-oauth/token']);
  });

  it('obeys an allowlist that is set and does not name it', async () => {
    signedIn(NOW + 3600_000 * 24 * 365 * 50);
    await expect(
      gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: { GMAIL_MAILBOX_ALLOWLIST: 'someone-else@example.com' } }).fields(),
    ).rejects.toThrow(/^GmailAdapter: deals@example\.com is not on this installation's GMAIL_MAILBOX_ALLOWLIST/);
  });
});

describe('a delegated mailbox', () => {
  const tokenFor = (scope: string) => (scope === GMAIL_READONLY_SCOPE ? 'read-token' : 'send-token');

  it('is refused while the allowlist is unset', async () => {
    delegatedRow();
    await expect(gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: {} }).fields()).rejects.toThrow(/GMAIL_MAILBOX_ALLOWLIST is not set/);
  });

  it('mints one token per scope, holds them until they near expiry, and stores nothing', async () => {
    delegatedRow();
    const minted: string[] = [];
    const mint = async (mailbox: string, scope: string) => {
      minted.push(`${mailbox} ${scope}`);
      return { token: tokenFor(scope), expiresAt: NOW + 3600_000 };
    };
    const credential = gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: ALLOWED, mint, now: () => NOW });
    const fields = await credential.fields();
    expect(fields).toEqual({
      mailbox: MAILBOX,
      method: 'delegated',
      access_token: 'read-token',
      send_access_token: 'send-token',
      expires_at: new Date(NOW + 3600_000).toISOString(),
    });
    expect(await credential.fields()).toBe(fields);
    expect(minted).toEqual([`${MAILBOX} ${GMAIL_READONLY_SCOPE}`, `${MAILBOX} ${GMAIL_SEND_SCOPE}`]);
    expect(mockPayloads.get(REF)).toEqual({ mailbox: MAILBOX });

    const later = gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: ALLOWED, mint, now: () => NOW + 3600_000 - 60_000 });
    await later.fields();
    expect(minted).toHaveLength(4);
  });

  it('keeps reads working when the grant lacks the send scope, and says why a send is refused', async () => {
    delegatedRow();
    const mint = async (_mailbox: string, scope: string) => {
      if (scope === GMAIL_SEND_SCOPE) throw Object.assign(new Error('unauthorized_client'), { status: 401 });
      return { token: 'read-token', expiresAt: NOW + 3600_000 };
    };
    const fields = await gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: ALLOWED, mint, now: () => NOW }).fields();
    expect(fields.access_token).toBe('read-token');
    expect(fields.send_access_token).toBeUndefined();
    expect(fields.send_refusal).toMatch(/missing_send_scope/);

    const client = gmailClientFromFields(fields, { fetch });
    await expect(client.sendMessage({ raw: 'cmF3' })).rejects.toThrow(/missing_send_scope/);
  });

  it('fails the call, holding nothing, when the send token fails for any other reason', async () => {
    delegatedRow();
    let attempts = 0;
    const mint = async (_mailbox: string, scope: string) => {
      if (scope === GMAIL_SEND_SCOPE && attempts++ === 0) throw Object.assign(new Error('socket hang up'), { status: 503 });
      return { token: tokenFor(scope), expiresAt: NOW + 3600_000 };
    };
    const credential = gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: ALLOWED, mint, now: () => NOW });
    await expect(credential.fields()).rejects.toThrow(/socket hang up/);
    expect((await credential.fields()).send_access_token).toBe('send-token');
  });

  it('mints nothing under the dev loop', async () => {
    delegatedRow();
    mockHarness.baseUrl = 'http://127.0.0.1:9999';
    const mint = jest.fn();
    const fields = await gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: ALLOWED, mint }).fields();
    expect(mint).not.toHaveBeenCalled();
    expect(fields).toMatchObject({ method: 'delegated', access_token: 'dev-loop-gmail-key', send_access_token: 'dev-loop-gmail-key' });
  });
});

describe('a row nothing should act on', () => {
  it('reads the retired per-user sign-in, and a missing credential, as no usable mailbox', async () => {
    mockRow.app_id = 'gmail-oauth';
    mockPayloads.set(REF, { mailbox: MAILBOX });
    await expect(gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: ALLOWED }).fields()).rejects.toThrow(
      'GmailAdapter: no usable Gmail mailbox for team team-1 (credentialsId=cred-1). Connect Gmail.',
    );
    await expect(gmailModuleCredential({ teamId: TEAM }, { env: ALLOWED }).fields()).rejects.toThrow(/credentialsId=unset/);
  });

  it('reads a payload that does not match the shape its column claims as no usable mailbox', async () => {
    mockRow.app_id = 'gmail-oauth-mailbox';
    mockPayloads.set(REF, { mailbox: MAILBOX });
    await expect(gmailModuleCredential({ teamId: TEAM, credentialsId: REF }, { env: ALLOWED }).fields()).rejects.toThrow(/no usable Gmail mailbox/);
  });
});
