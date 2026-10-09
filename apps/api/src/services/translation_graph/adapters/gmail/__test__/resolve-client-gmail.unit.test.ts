// resolveGmailClient — the client built at USE time.
//
// Two things it decides. WHICH SHAPE the stored row is, read off `app_id` and
// never sniffed out of the payload, so a row from the retired per-user sign-in
// stays dead. And whether the mailbox is still allowed here: a credential
// connected under a wider list must stop working the moment the list narrows,
// with the run's error saying why — and that rule differs by method, because
// under a sign-in Google already confined the token to the one mailbox while
// under delegation nothing has.

const delegatedAuth = jest.fn((_input: unknown) => ({ __stub: 'delegated-auth' }));
jest.mock('../../../../../lib/google_cloud', () => {
  const actual = jest.requireActual('../../../../../lib/google_cloud');
  return { ...actual, delegatedGoogleAuth: (input: unknown) => delegatedAuth(input) };
});

const builtAuths: unknown[] = [];
jest.mock('googleapis', () => ({
  google: {
    gmail: (opts: { auth: unknown }) => {
      builtAuths.push(opts.auth);
      return {
        users: {
          getProfile: jest.fn(),
          messages: { send: jest.fn(), list: jest.fn(), get: jest.fn(), attachments: { get: jest.fn() } },
          history: { list: jest.fn() },
        },
      };
    },
  },
}));

let storedPayload: Record<string, unknown> = { mailbox: 'deals@example.com' };
let storedAppId: string | null = 'gmail-delegated';

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => JSON.stringify(storedPayload),
  encryptToken: async () => Buffer.from('enc'),
}));
jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (creds: unknown) => creds,
}));
jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => ({
      where: () => ({
        where: () => ({
          select: () => ({
            executeTakeFirst: async () => ({
              id: 'cred-1',
              credentials: Buffer.from('enc'),
              app_id: storedAppId,
            }),
          }),
        }),
      }),
    }),
  }),
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from '../../../../../lib/google_cloud';
import { resolveGmailClient } from '../client';

const TEAM = 'team-1' as TeamId;

const OAUTH_PAYLOAD = {
  mailbox: 'deals@example.com',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 4102444800000,
  grantedScopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
};

const prior = process.env.GMAIL_MAILBOX_ALLOWLIST;

beforeEach(() => {
  builtAuths.length = 0;
  delegatedAuth.mockClear();
  storedPayload = { mailbox: 'deals@example.com' };
  storedAppId = 'gmail-delegated';
});

afterEach(() => {
  if (prior === undefined) delete process.env.GMAIL_MAILBOX_ALLOWLIST;
  else process.env.GMAIL_MAILBOX_ALLOWLIST = prior;
});

describe('the delegated shape', () => {
  it('throws, naming the mailbox and the variable, when the allowlist is unset', async () => {
    delete process.env.GMAIL_MAILBOX_ALLOWLIST;
    await expect(resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).rejects.toThrow(
      /GMAIL_MAILBOX_ALLOWLIST/,
    );
    await expect(resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).rejects.toThrow(
      /deals@example\.com/,
    );
  });

  it('impersonates the mailbox once the allowlist names it', async () => {
    process.env.GMAIL_MAILBOX_ALLOWLIST = 'deals@example.com';
    const client = await resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' });
    expect(client).not.toBeNull();
    expect(delegatedAuth).toHaveBeenCalled();
  });
});

describe('the signed-in shape', () => {
  beforeEach(() => {
    storedAppId = 'gmail-oauth-mailbox';
    storedPayload = { ...OAUTH_PAYLOAD };
  });

  it('builds a token-bearing client with NO impersonation, even with the allowlist unset', async () => {
    delete process.env.GMAIL_MAILBOX_ALLOWLIST;
    const client = await resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' });
    expect(client).not.toBeNull();
    expect(delegatedAuth).not.toHaveBeenCalled();
    expect(builtAuths).toHaveLength(1);
  });

  it('still obeys an allowlist that IS set', async () => {
    process.env.GMAIL_MAILBOX_ALLOWLIST = 'someone-else@example.com';
    await expect(resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).rejects.toThrow(
      /GMAIL_MAILBOX_ALLOWLIST/,
    );
  });

  it('refuses a payload that does not match the shape its column claims', async () => {
    delete process.env.GMAIL_MAILBOX_ALLOWLIST;
    storedPayload = { mailbox: 'deals@example.com' };
    expect(await resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).toBeNull();
  });
});

describe('a row from the retired per-user sign-in', () => {
  it('reads as dead without anything being decrypted', async () => {
    process.env.GMAIL_MAILBOX_ALLOWLIST = 'deals@example.com';
    storedAppId = 'gmail-oauth';
    expect(await resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).toBeNull();
    storedAppId = null;
    expect(await resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).toBeNull();
  });
});
