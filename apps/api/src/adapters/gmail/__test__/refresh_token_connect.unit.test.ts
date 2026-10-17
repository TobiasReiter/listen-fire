// Connecting a mailbox from a refresh token its own admin obtained.
//
// The exchange IS the check, so the assertions are about what comes back from
// it: the mailbox Google names (never a typed one), the scopes it reports, and
// the two refusals a user can actually hit. The last thing asserted is that the
// token never appears in what anybody is told.

const refreshMock = jest.fn();
const tokenInfoMock = jest.fn();
jest.mock('google-auth-library', () => {
  const actual = jest.requireActual('google-auth-library');
  return {
    ...actual,
    OAuth2Client: class {
      credentials: Record<string, unknown> = {};
      setCredentials(credentials: Record<string, unknown>) {
        this.credentials = credentials;
      }
      on() {
        return this;
      }
      refreshAccessToken() {
        return refreshMock(this.credentials);
      }
      getTokenInfo(accessToken: string) {
        return tokenInfoMock(accessToken);
      }
      getAccessToken() {
        return Promise.resolve({ token: this.credentials.access_token });
      }
    },
  };
});

const profileMock = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { credentials: Record<string, unknown> = {}; setCredentials(credentials: Record<string, unknown>) { this.credentials = credentials; } } },
    gmail: () => ({ users: { getProfile: profileMock } }),
  },
}));

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from 'movement-engine/lib/google_cloud';
import { connectGmailByRefreshToken } from '../apiClient';

const PASTED = 'the-pasted-refresh-token';
const CLIENT_ENV = {
  GMAIL_OAUTH_CLIENT_ID: 'gmail-id',
  GMAIL_OAUTH_CLIENT_SECRET: 'gmail-secret',
} as NodeJS.ProcessEnv;

const priorAllowlist = process.env.GMAIL_MAILBOX_ALLOWLIST;

beforeEach(() => {
  refreshMock.mockReset();
  tokenInfoMock.mockReset();
  profileMock.mockReset();
  profileMock.mockResolvedValue({ data: { emailAddress: 'deals@example.com', historyId: '9' } });
  delete process.env.GMAIL_MAILBOX_ALLOWLIST;
});

afterEach(() => {
  if (priorAllowlist === undefined) delete process.env.GMAIL_MAILBOX_ALLOWLIST;
  else process.env.GMAIL_MAILBOX_ALLOWLIST = priorAllowlist;
});

describe('connectGmailByRefreshToken', () => {
  it('stores the pasted token with the mailbox and scopes Google reported', async () => {
    refreshMock.mockResolvedValue({
      credentials: {
        access_token: 'access-token',
        expiry_date: 4102444800000,
        scope: `${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}`,
      },
    });

    const result = await connectGmailByRefreshToken({ refreshToken: PASTED, env: CLIENT_ENV });

    expect(result).toEqual({
      ok: true,
      credentials: {
        mailbox: 'deals@example.com',
        accessToken: 'access-token',
        refreshToken: PASTED,
        expiresAt: 4102444800000,
        grantedScopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
      },
    });
  });

  it('asks tokeninfo when the exchange said nothing about scopes', async () => {
    refreshMock.mockResolvedValue({
      credentials: { access_token: 'access-token', expiry_date: 4102444800000 },
    });
    tokenInfoMock.mockResolvedValue({ scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] });

    const result = await connectGmailByRefreshToken({ refreshToken: PASTED, env: CLIENT_ENV });

    expect(tokenInfoMock).toHaveBeenCalledWith('access-token');
    expect(result.ok && result.credentials.grantedScopes).toEqual([
      GMAIL_READONLY_SCOPE,
      GMAIL_SEND_SCOPE,
    ]);
  });

  it('falls back to READ ONLY when nothing will say what was granted', async () => {
    refreshMock.mockResolvedValue({
      credentials: { access_token: 'access-token', expiry_date: 4102444800000 },
    });
    tokenInfoMock.mockRejectedValue(new Error('tokeninfo unavailable'));

    const result = await connectGmailByRefreshToken({ refreshToken: PASTED, env: CLIENT_ENV });

    expect(result.ok && result.credentials.grantedScopes).toEqual([GMAIL_READONLY_SCOPE]);
  });

  it('refuses a token Google will not exchange, without echoing it', async () => {
    refreshMock.mockRejectedValue(
      Object.assign(new Error(`invalid_grant for ${PASTED}`), { status: 400 }),
    );

    const result = await connectGmailByRefreshToken({ refreshToken: PASTED, env: CLIENT_ENV });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Gmail OAuth client/);
      expect(result.message).not.toContain(PASTED);
    }
    expect(profileMock).not.toHaveBeenCalled();
  });

  it('refuses a mailbox an allowlist that IS set does not name', async () => {
    refreshMock.mockResolvedValue({
      credentials: {
        access_token: 'access-token',
        expiry_date: 4102444800000,
        scope: GMAIL_READONLY_SCOPE,
      },
    });

    const result = await connectGmailByRefreshToken({
      refreshToken: PASTED,
      env: { ...CLIENT_ENV, GMAIL_MAILBOX_ALLOWLIST: 'someone-else@example.com' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('GMAIL_MAILBOX_ALLOWLIST');
      expect(result.message).toContain('deals@example.com');
    }
  });

  it('refuses outright when this server has no Gmail OAuth client to exchange with', async () => {
    const result = await connectGmailByRefreshToken({ refreshToken: PASTED, env: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/GMAIL_OAUTH_CLIENT_ID/);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
