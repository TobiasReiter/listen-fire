// The delegated Google auth builder — the credential shape a connected Gmail
// mailbox is reached through.
//
// The assertion is what the builder hands `google-auth-library`, because that
// IS the whole decision: the library keeps its options private, and a test that
// went through a real token exchange would be testing Google.

const constructed: unknown[] = [];

jest.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: unknown) {
      constructed.push(options);
    }
  },
}));

import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  delegatedGoogleAuth,
  gmailMailboxAllowlist,
  googleAuth,
} from 'movement-engine/lib/google_cloud';

const ACCOUNT_ENV = {
  GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nline\\n-----END PRIVATE KEY-----',
  GOOGLE_CLIENT_EMAIL: 'runtime@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'example-project',
} as NodeJS.ProcessEnv;

function lastOptions(): Record<string, unknown> {
  const options = constructed[constructed.length - 1];
  if (typeof options !== 'object' || options === null) throw new Error('nothing was constructed');
  return { ...options };
}

beforeEach(() => {
  constructed.length = 0;
});

describe('delegatedGoogleAuth', () => {
  it('impersonates the named mailbox with only the scopes it was given', () => {
    delegatedGoogleAuth({
      subject: 'deals@example.com',
      scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
      env: ACCOUNT_ENV,
    });

    expect(lastOptions()).toMatchObject({
      clientOptions: { subject: 'deals@example.com' },
      scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
    });
  });

  it('unescapes the PEM newlines the environment carries', () => {
    delegatedGoogleAuth({
      subject: 'deals@example.com',
      scopes: [GMAIL_READONLY_SCOPE],
      env: ACCOUNT_ENV,
    });
    const credentials = lastOptions()['credentials'];
    expect(credentials).toMatchObject({
      type: 'service_account',
      client_email: 'runtime@example.iam.gserviceaccount.com',
    });
    expect(JSON.stringify(credentials)).toContain('\\n');
    expect(JSON.stringify(credentials)).not.toContain('\\\\n');
  });

  it('is distinct from the account acting as ITSELF — no subject, cloud scope', () => {
    googleAuth(ACCOUNT_ENV);
    const options = lastOptions();
    expect(options['clientOptions']).toBeUndefined();
    expect(options['scopes']).toEqual(['https://www.googleapis.com/auth/cloud-platform']);
  });

  it('refuses to build one when the deployment has no service account', () => {
    expect(() =>
      delegatedGoogleAuth({ subject: 'deals@example.com', scopes: [GMAIL_READONLY_SCOPE], env: {} }),
    ).toThrow(/not configured/);
    expect(constructed).toHaveLength(0);
  });
});

describe('gmailMailboxAllowlist', () => {
  it('parses to an empty set when unset', () => {
    expect(gmailMailboxAllowlist({})).toEqual(new Set());
  });

  it('parses to an empty set when set to the empty string', () => {
    expect(gmailMailboxAllowlist({ GMAIL_MAILBOX_ALLOWLIST: '' })).toEqual(new Set());
  });

  it('splits on commas, trims whitespace, and lower-cases each address', () => {
    expect(
      gmailMailboxAllowlist({
        GMAIL_MAILBOX_ALLOWLIST: ' Ops@Example.com ,deals@example.com,, ',
      }),
    ).toEqual(new Set(['ops@example.com', 'deals@example.com']));
  });

  it('reads process.env by default', () => {
    const prior = process.env.GMAIL_MAILBOX_ALLOWLIST;
    process.env.GMAIL_MAILBOX_ALLOWLIST = 'deals@example.com';
    try {
      expect(gmailMailboxAllowlist()).toEqual(new Set(['deals@example.com']));
    } finally {
      if (prior === undefined) delete process.env.GMAIL_MAILBOX_ALLOWLIST;
      else process.env.GMAIL_MAILBOX_ALLOWLIST = prior;
    }
  });
});
