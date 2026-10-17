// Connecting an OAuth 2 credential from its manifest declaration, against a
// fake provider: the authorize URL, the redirect's code exchanged once, the
// grant stored through the secrets family, and the host's refresh from the
// same declaration rotating it.

import {
  beginOAuth2Connect,
  createMemoryVault,
  createOAuth2Connector,
  createPendingStates,
  createSecretsFamily,
  declaredRefresher,
  OAuth2ExchangeFailed,
  pkceChallenge,
  storeGrant,
  UnknownConnectAttempt,
  type OAuth2Declaration,
} from 'movement-engine/public/secrets';
import { startFakeOAuthServer, type FakeOAuthServer } from 'movement-engine/public/secrets-testing';

const CLIENT = { clientId: 'lf-client', clientSecret: 's3cret-client' };
const REDIRECT = 'http://127.0.0.1:9/callback';

/** Open the authorize URL as a browser would, and read back where the
 *  provider sends it. */
async function consent(url: string): Promise<{ code: string; state: string }> {
  const answer = await fetch(url, { redirect: 'manual' });
  const location = answer.headers.get('location');
  if (location === null) throw new Error(`no redirect (${answer.status}): ${await answer.text()}`);
  const back = new URL(location);
  return { code: back.searchParams.get('code') ?? '', state: back.searchParams.get('state') ?? '' };
}

describe('connecting an OAuth 2 credential from its declaration', () => {
  let provider: FakeOAuthServer;
  let oauth2: OAuth2Declaration;

  beforeEach(async () => {
    provider = await startFakeOAuthServer({ ...CLIENT, requirePkce: true, expiresIn: 600 });
    oauth2 = {
      authorizeUrl: provider.authorizeUrl,
      tokenUrl: provider.tokenUrl,
      scopes: ['read', 'write'],
      pkce: true,
      authorizeParams: { access_type: 'offline' },
    };
  });
  afterEach(() => provider.close());

  it('builds the authorize URL from the declaration', () => {
    const { url, attempt } = beginOAuth2Connect({ oauth2, clientId: CLIENT.clientId, redirectUri: REDIRECT });
    const params = new URL(url).searchParams;
    expect(Object.fromEntries(params.entries())).toEqual({
      response_type: 'code',
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      scope: 'read write',
      state: attempt.state,
      code_challenge: pkceChallenge(attempt.codeVerifier ?? ''),
      code_challenge_method: 'S256',
      access_type: 'offline',
    });
    expect(url.startsWith(`${provider.authorizeUrl}?`)).toBe(true);
  });

  it('takes a state the shell signs itself, and sends no challenge without pkce', () => {
    const { url, attempt } = beginOAuth2Connect({ oauth2: { ...oauth2, pkce: false }, clientId: 'c', redirectUri: REDIRECT, state: 'signed-state' });
    expect(attempt).toEqual({ state: 'signed-state', redirectUri: REDIRECT });
    expect(new URL(url).searchParams.has('code_challenge')).toBe(false);
  });

  it('exchanges the code once, stores the grant over the credential, and refreshes it from the same declaration', async () => {
    const connector = createOAuth2Connector({ oauth2, client: CLIENT, redirectUri: REDIRECT });
    const back = await consent(connector.begin());
    const grant = await connector.complete(back);
    expect(grant.fields.access_token).toBe('access-1');
    expect(grant.fields.refresh_token).toBe(provider.currentRefreshToken());
    expect(Date.parse(grant.fields.expires_at ?? '')).toBeGreaterThan(Date.now() + 590_000);
    expect(grant.response.scope).toBe('granted');
    // The protocol's default client auth: HTTP Basic, nothing in the body.
    expect(provider.calls[0]?.authorization).toMatch(/^Basic /);
    expect(provider.calls[0]?.form.client_secret).toBeUndefined();

    await expect(connector.complete(back)).rejects.toBeInstanceOf(UnknownConnectAttempt);

    const vault = createMemoryVault({ acme: { client_id: CLIENT.clientId, webhook_secret: 'w-1', access_token: 'old', expires_at: '2000-01-01T00:00:00Z' } });
    const family = createSecretsFamily({ backend: vault });
    const stored = await storeGrant(family, 'acme', grant);
    expect(stored.fields).toMatchObject({ client_id: CLIENT.clientId, webhook_secret: 'w-1', access_token: 'access-1', refresh_token: grant.fields.refresh_token });

    const refresher = declaredRefresher({ name: 'acme', kind: 'oauth2', fields: [], oauth2 }, { client: CLIENT });
    if (refresher === undefined) throw new Error('an oauth2 declaration has a refresher');
    const refreshed = await family.refresh('acme', { seenVersion: stored.version, refresher });
    expect(refreshed.fields.access_token).toBe('access-2');
    expect(refreshed.fields.refresh_token).toBe(provider.currentRefreshToken());
    expect(refreshed.fields.refresh_token).not.toBe(grant.fields.refresh_token);
    expect(provider.calls.map((c) => c.grant)).toEqual(['authorization_code', 'refresh_token']);
  });

  it('puts the client in the form body when the declaration says so', async () => {
    await provider.close();
    provider = await startFakeOAuthServer({ ...CLIENT, clientAuth: 'body' });
    const connector = createOAuth2Connector({ oauth2: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, clientAuth: 'body' }, client: CLIENT, redirectUri: REDIRECT });
    const grant = await connector.complete(await consent(connector.begin()));
    expect(grant.fields.access_token).toBe('access-1');
    expect(provider.calls[0]?.form).toMatchObject({ client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret, grant_type: 'authorization_code', redirect_uri: REDIRECT });
    expect(provider.calls[0]?.form.code_verifier).toBeUndefined();
  });

  it('reports a refused exchange without the client secret or the code', async () => {
    const connector = createOAuth2Connector({ oauth2, client: { clientId: CLIENT.clientId, clientSecret: 'wrong-secret' }, redirectUri: REDIRECT });
    const back = await consent(connector.begin());
    const error = await connector.complete(back).catch((e: unknown) => e);
    if (!(error instanceof OAuth2ExchangeFailed)) throw error;
    expect(error.status).toBe(401);
    expect(String(error)).not.toContain('wrong-secret');
    expect(String(error)).not.toContain(back.code);
  });
});

describe('attempts waiting for their redirect', () => {
  it('expire, and a take is single use while a peek is not', () => {
    let now = 1_000;
    const pending = createPendingStates<string>({ ttlMs: 100, now: () => now });
    pending.put('a', 'first');
    pending.put('b', 'second');
    expect(pending.peek('a')).toBe('first');
    expect(pending.peek('a')).toBe('first');
    expect(pending.take('a')).toBe('first');
    expect(pending.take('a')).toBeUndefined();
    now += 101;
    expect(pending.peek('b')).toBeUndefined();
  });
});
