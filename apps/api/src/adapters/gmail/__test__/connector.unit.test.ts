// The OAuth callback — what a finished sign-in leaves behind.
//
// Three facts have to survive it: the tokens, the mailbox Google says signed in
// (never a typed address), and the scopes Google says it granted. The last is
// what the send path later reads, so a callback that dropped it would leave
// every send finding out the hard way.

const profileMock = jest.fn().mockResolvedValue({
  data: { emailAddress: 'deals@example.com', historyId: '42' },
});
jest.mock('googleapis', () => ({
  google: { gmail: () => ({ users: { getProfile: profileMock } }) },
}));

const storedPending: unknown[] = [];
jest.mock('../../../lib/pendingCredentials', () => ({
  storePendingCredentials: async (credentials: unknown) => {
    storedPending.push(credentials);
    return 'claim-token-1';
  },
}));
jest.mock('../../../lib/oauthFlows', () => ({ getFlowUserId: () => 'user-1' }));
jest.mock('../../../lib/oauthCallbackRedirect', () => ({
  resolveOAuthCallbackRedirect: () => 'https://app.example.com/gmail/callback?claimToken=claim-token-1',
}));

import type { Request, Response } from 'express';

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from 'movement-engine/lib/google_cloud';
import { GmailAppAdapter } from '../connector';

const GRANTED = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 4102444800000,
  grantedScopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
};

/** The connect half, stubbed at the one place a real Google would answer. */
function adapter() {
  const authClient = {
    callbackUrl: 'https://app.example.com/gmail/callback',
    fakeBaseUrl: undefined,
    scopes: () => [GMAIL_READONLY_SCOPE],
    codeToToken: jest.fn().mockResolvedValue(GRANTED),
    generateInstallUrl: jest.fn(),
  };
  return {
    connector: new GmailAppAdapter({
      authClient: authClient as unknown as ConstructorParameters<
        typeof GmailAppAdapter
      >[0]['authClient'],
    }),
    authClient,
  };
}

function response() {
  const sent: { status?: number; body?: unknown; redirect?: string } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    send(body: unknown) {
      sent.body = body;
      return res;
    },
    redirect(url: string) {
      sent.redirect = url;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res: res as unknown as Response, sent };
}

function request(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

const priorAllowlist = process.env.GMAIL_MAILBOX_ALLOWLIST;

beforeEach(() => {
  storedPending.length = 0;
  profileMock.mockClear();
});

afterEach(() => {
  if (priorAllowlist === undefined) delete process.env.GMAIL_MAILBOX_ALLOWLIST;
  else process.env.GMAIL_MAILBOX_ALLOWLIST = priorAllowlist;
});

describe('handleCallback', () => {
  it('stores the tokens, the mailbox Google named, and the scopes it granted', async () => {
    delete process.env.GMAIL_MAILBOX_ALLOWLIST;
    const { connector } = adapter();
    const { res, sent } = response();

    await connector.handleCallback(request({ state: 'state-1', code: 'code-1' }), res);

    expect(storedPending).toEqual([
      {
        mailbox: 'deals@example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: 4102444800000,
        grantedScopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
      },
    ]);
    expect(profileMock).toHaveBeenCalledTimes(1);
    expect(sent.redirect).toContain('claimToken=claim-token-1');
  });

  it('stores NOTHING when the signed-in mailbox is not on a list that is set', async () => {
    process.env.GMAIL_MAILBOX_ALLOWLIST = 'someone-else@example.com';
    const { connector } = adapter();
    const { res, sent } = response();

    await connector.handleCallback(request({ state: 'state-1', code: 'code-1' }), res);

    expect(storedPending).toEqual([]);
    expect(sent.status).toBe(403);
    expect(String(sent.body)).toContain('GMAIL_MAILBOX_ALLOWLIST');
  });

  it('refuses a callback carrying Google’s own error rather than exchanging anything', async () => {
    const { connector, authClient } = adapter();
    const { res, sent } = response();

    await connector.handleCallback(request({ state: 'state-1', error: 'access_denied' }), res);

    expect(authClient.codeToToken).not.toHaveBeenCalled();
    expect(sent.status).toBe(401);
  });
});
