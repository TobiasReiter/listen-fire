// The consent URL and the code exchange.
//
// What the install URL CARRIES is the whole decision this module makes: which
// scopes the user is asked to grant, and whether Google will hand back a
// refresh token at all. Both are read off the URL rather than through a real
// exchange — a test that signed in would be testing Google.

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from 'movement-engine/lib/google_cloud';
import { GmailAuthClient, parseGrantedScopes } from '../authClient';

function client(env: NodeJS.ProcessEnv): GmailAuthClient {
  return new GmailAuthClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectBaseUrl: 'https://app.example.com/',
    env,
  });
}

describe('the consent URL', () => {
  it('redirects to this deployment’s own Gmail callback', () => {
    expect(client({}).callbackUrl).toBe('https://app.example.com/gmail/callback');
  });

  it('asks only to READ when the installation has not enabled sending', async () => {
    const url = new URL(await client({}).generateInstallUrl());
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE);
  });

  it('asks to send as well once the installation enables it', async () => {
    const url = new URL(await client({ GMAIL_SEND_ENABLED: 'true' }).generateInstallUrl());
    expect(url.searchParams.get('scope')).toBe(`${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}`);
  });

  it('asks offline with a forced consent, which is what makes Google issue a refresh token', async () => {
    const url = new URL(await client({}).generateInstallUrl());
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('points every endpoint at the fake Google when the dev loop names one', async () => {
    const dev = new GmailAuthClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectBaseUrl: 'http://localhost:3503',
      fakeBaseUrl: 'http://localhost:5556',
      env: {},
    });
    const url = new URL(await dev.generateInstallUrl());
    expect(url.origin + url.pathname).toBe('http://localhost:5556/fake-google-oauth/auth');
  });
});

describe('a code exchange with no state behind it', () => {
  it('refuses rather than exchanging — the state is the flow’s only proof of origin', async () => {
    await expect(
      client({}).codeToToken({ state: 'never-issued', code: 'some-code' }),
    ).rejects.toThrow(/state/i);
  });
});

describe('parseGrantedScopes', () => {
  it('reads what Google says it granted, whatever was asked for', () => {
    expect(parseGrantedScopes(`${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}`, [])).toEqual([
      GMAIL_READONLY_SCOPE,
      GMAIL_SEND_SCOPE,
    ]);
  });

  it('falls back to what was REQUESTED when the response says nothing', () => {
    expect(parseGrantedScopes(undefined, [GMAIL_READONLY_SCOPE])).toEqual([GMAIL_READONLY_SCOPE]);
    expect(parseGrantedScopes('', [GMAIL_READONLY_SCOPE])).toEqual([GMAIL_READONLY_SCOPE]);
  });
});
