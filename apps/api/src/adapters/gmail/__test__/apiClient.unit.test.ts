// The Gmail wire client: the mailbox allowlist gate every enforcement site
// shares, the per-operation scope split (a delegation that covers reads but
// not sends must not fail the reads), and how a refused token is told apart
// by which scope set it was requesting.

const delegatedAuthCalls: { subject: string; scopes: readonly string[] }[] = [];
jest.mock('movement-engine/lib/google_cloud', () => {
  const actual = jest.requireActual('movement-engine/lib/google_cloud');
  return {
    ...actual,
    delegatedGoogleAuth: jest.fn((input: { subject: string; scopes: readonly string[] }) => {
      delegatedAuthCalls.push({ subject: input.subject, scopes: input.scopes });
      return { __marker: 'delegated-auth', subject: input.subject, scopes: input.scopes };
    }),
  };
});

interface BuiltApi {
  auth: unknown;
  users: {
    getProfile: jest.Mock;
    messages: { send: jest.Mock };
  };
}
const built: BuiltApi[] = [];
const gmailFactory = jest.fn((opts: { auth: unknown }) => {
  const api: BuiltApi = {
    auth: opts.auth,
    users: {
      getProfile: jest.fn().mockResolvedValue({
        data: { emailAddress: 'deals@example.com', historyId: '1' },
      }),
      messages: {
        send: jest.fn().mockResolvedValue({ data: { id: 'sent-1' } }),
      },
    },
  };
  built.push(api);
  return api;
});
jest.mock('googleapis', () => ({
  google: { gmail: (opts: { auth: unknown }) => gmailFactory(opts) },
}));

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from 'movement-engine/lib/google_cloud';
import {
  GMAIL_DELEGATION_MESSAGE,
  GmailApiClient,
  checkGmailMailboxAllowed,
  classifyGmailError,
  gmailMissingSendScopeMessage,
  validateGmailMailbox,
} from '../apiClient';

const ALLOWED_ENV = { GMAIL_MAILBOX_ALLOWLIST: 'deals@example.com,ops@example.com' };

/** A signed-in mailbox's stored payload. `grantedScopes` is the knob under
 *  test: it is what the send path consults before asking Google anything. */
function oauthCredentials(grantedScopes: string[] = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]) {
  return {
    mailbox: 'deals@example.com',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 4102444800000,
    grantedScopes,
  };
}

beforeEach(() => {
  delegatedAuthCalls.length = 0;
  built.length = 0;
  gmailFactory.mockClear();
});

describe('checkGmailMailboxAllowed — unset is a different answer per method', () => {
  it('refuses everything under DELEGATION when the list is unset, naming the variable', () => {
    const verdict = checkGmailMailboxAllowed('deals@example.com', {
      method: 'delegated',
      env: {},
    });
    expect(verdict).toEqual({
      ok: false,
      message: expect.stringContaining('GMAIL_MAILBOX_ALLOWLIST'),
    });
    if (!verdict.ok) {
      expect(verdict.message).toMatch(/is not set/);
    }
  });

  it('allows any signed-in mailbox under OAUTH when the list is unset — Google draws that line', () => {
    expect(
      checkGmailMailboxAllowed('anyone@example.com', { method: 'oauth', env: {} }),
    ).toEqual({ ok: true });
  });

  it('treats an empty string the same as unset, both ways round', () => {
    const env = { GMAIL_MAILBOX_ALLOWLIST: '' };
    expect(checkGmailMailboxAllowed('deals@example.com', { method: 'delegated', env })).toEqual({
      ok: false,
      message: expect.stringContaining('GMAIL_MAILBOX_ALLOWLIST'),
    });
    expect(checkGmailMailboxAllowed('deals@example.com', { method: 'oauth', env })).toEqual({
      ok: true,
    });
  });

  it('enforces a list that IS set for BOTH methods', () => {
    for (const method of ['oauth', 'delegated'] as const) {
      const verdict = checkGmailMailboxAllowed('someoneelse@example.com', {
        method,
        env: ALLOWED_ENV,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.message).toContain('someoneelse@example.com');
        expect(verdict.message).toContain('GMAIL_MAILBOX_ALLOWLIST');
      }
      expect(checkGmailMailboxAllowed('deals@example.com', { method, env: ALLOWED_ENV })).toEqual({
        ok: true,
      });
    }
  });

  it('allows a listed mailbox regardless of case or surrounding whitespace', () => {
    expect(
      checkGmailMailboxAllowed(' Deals@Example.com ', { method: 'delegated', env: ALLOWED_ENV }),
    ).toEqual({ ok: true });
  });
});

describe('validateGmailMailbox — the allowlist gate runs before Google is ever asked', () => {
  it('refuses an unlisted DELEGATED mailbox without needing a service account configured', async () => {
    await expect(
      validateGmailMailbox({ mailbox: 'someoneelse@example.com' }),
    ).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('GMAIL_MAILBOX_ALLOWLIST'),
    });
    expect(gmailFactory).not.toHaveBeenCalled();
  });

  it('reads an OAuth payload as the oauth method, so an unset list does not refuse it', async () => {
    const prior = process.env.GMAIL_MAILBOX_ALLOWLIST;
    delete process.env.GMAIL_MAILBOX_ALLOWLIST;
    try {
      await expect(validateGmailMailbox(oauthCredentials())).resolves.toEqual({
        ok: true,
        profile: { emailAddress: 'deals@example.com', historyId: '1' },
      });
    } finally {
      if (prior !== undefined) process.env.GMAIL_MAILBOX_ALLOWLIST = prior;
    }
  });
});

describe('classifyGmailError — which scope set was being requested', () => {
  it('reads a token refusal on the send call as a missing send scope', () => {
    const err = Object.assign(new Error('unauthorized_client'), { status: 403 });
    expect(classifyGmailError(err, 'users.messages.send').failure).toBe('missing_send_scope');
  });

  it('reads the identical refusal on a read call as general delegation', () => {
    const err = Object.assign(new Error('unauthorized_client'), { status: 403 });
    expect(classifyGmailError(err, 'users.getProfile').failure).toBe('delegation');
  });

  it('has a plain sentence for the missing-send-scope failure naming the mailbox, the scope, and that reads are unaffected', () => {
    const message = gmailMissingSendScopeMessage('deals@example.com');
    expect(message).toContain('deals@example.com');
    expect(message).toContain(GMAIL_SEND_SCOPE);
    expect(message).toMatch(/reads still work/i);
  });

  it('leaves the two connect-time messages distinct from the send one', () => {
    expect(GMAIL_DELEGATION_MESSAGE).not.toContain(GMAIL_SEND_SCOPE);
  });
});

describe('GmailApiClient — each call asks for only the scope it needs', () => {
  it('builds a readonly-scoped client and a send-scoped client up front', () => {
    // eslint-disable-next-line no-new
    new GmailApiClient({ mailbox: 'deals@example.com' });
    expect(delegatedAuthCalls).toEqual([
      { subject: 'deals@example.com', scopes: [GMAIL_READONLY_SCOPE] },
      { subject: 'deals@example.com', scopes: [GMAIL_SEND_SCOPE] },
    ]);
  });

  it('reads through the readonly-scoped client only, never the send-scoped one', async () => {
    const client = new GmailApiClient({ mailbox: 'deals@example.com' });
    const [readApi, sendApi] = built;

    await client.getProfile();

    expect(readApi.users.getProfile).toHaveBeenCalledTimes(1);
    expect(sendApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('sends through the send-scoped client only, never the readonly-scoped one', async () => {
    const client = new GmailApiClient({ mailbox: 'deals@example.com' });
    const [readApi, sendApi] = built;

    await client.sendMessage({ raw: 'cmF3' });

    expect(sendApi.users.messages.send).toHaveBeenCalledTimes(1);
    expect(readApi.users.getProfile).not.toHaveBeenCalled();
  });
});

describe('GmailApiClient — the signed-in shape', () => {
  it('builds ONE token-bearing client rather than impersonating anybody', () => {
    // eslint-disable-next-line no-new
    new GmailApiClient(oauthCredentials());
    expect(delegatedAuthCalls).toEqual([]);
    expect(gmailFactory).toHaveBeenCalledTimes(1);
  });

  it('refuses a send from the GRANTED SCOPES, before Google is called at all', async () => {
    const client = new GmailApiClient(oauthCredentials([GMAIL_READONLY_SCOPE]));
    const [api] = built;

    await expect(client.sendMessage({ raw: 'cmF3' })).rejects.toThrow(/missing_send_scope/);
    expect(api.users.messages.send).not.toHaveBeenCalled();
  });

  it('sends when the sign-in did grant the send scope', async () => {
    const client = new GmailApiClient(oauthCredentials());
    const [api] = built;

    await client.sendMessage({ raw: 'cmF3' });

    expect(api.users.messages.send).toHaveBeenCalledTimes(1);
  });

  it('reports the remedy that fits the method', () => {
    expect(gmailMissingSendScopeMessage('deals@example.com', 'oauth')).toMatch(
      /GMAIL_SEND_ENABLED/,
    );
    expect(gmailMissingSendScopeMessage('deals@example.com', 'delegated')).toMatch(
      /Workspace admin/,
    );
  });
});
