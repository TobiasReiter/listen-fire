import { DropboxAuthClient } from '../authClient';

const base = { clientId: 'cid', clientSecret: 'secret', redirectBaseUrl: 'http://localhost:3003' };

describe('DropboxAuthClient endpoints', () => {
  it('sends the consent to Dropbox by default', () => {
    const url = new URL(new DropboxAuthClient(base).generateInstallUrl());
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
  });

  it('sends the consent to the fake OAuth provider when one is configured', () => {
    const url = new URL(new DropboxAuthClient({ ...base, fakeBaseUrl: 'http://localhost:5556/' }).generateInstallUrl());
    expect(url.origin + url.pathname).toBe('http://localhost:5556/oauth/authorize');
  });

  it('exchanges the code at the fake provider token endpoint', async () => {
    const client = new DropboxAuthClient({ ...base, fakeBaseUrl: 'http://localhost:5556' });
    const state = new URL(client.generateInstallUrl()).searchParams.get('state') ?? '';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), { status: 200 }),
    );
    try {
      const tokens = await client.codeToToken({ state, code: 'c' });
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5556/oauth/token');
      expect(tokens).toMatchObject({ accessToken: 'a', refreshToken: 'r' });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
