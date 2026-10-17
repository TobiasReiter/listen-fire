// The platform's OAuth connect flows, pinned: each one's authorize URL (the
// endpoint and every parameter, state and PKCE challenge masked to their
// length) and each one's code exchange (where it posts, the form it sends,
// how the client authenticates). Recorded from the flows as they stood before
// they moved onto the manifest-driven connect flow, so the move is proved to
// change none of them.

// google-auth-library's transport loads its fetch with a dynamic import jest
// cannot run; hand it the global fetch instead (read per call, so a test's
// fake fetch is the one it reaches).
jest.mock('google-auth-library', () => {
  const actual = jest.requireActual('google-auth-library');
  class OAuth2Client extends actual.OAuth2Client {
    constructor(options: Record<string, unknown> = {}) {
      super({ ...options, transporterOptions: { fetchImplementation: (...args: Parameters<typeof fetch>) => fetch(...args) } });
    }
  }
  return { ...actual, OAuth2Client };
});

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { AttioAuthClient } from '../../../adapters/attio/authClient';
import { AirtableAuthClient } from '../../../adapters/airtable/authClient';
import { DropboxAuthClient } from '../../../adapters/dropbox/authClient';
import { GoogleAuthClient } from '../../../adapters/google/authClient';
import { GmailAuthClient } from '../../../adapters/gmail/authClient';
import { SlackWebApiConnector } from '../../../adapters/slack/webApi/connector';

const APP = { clientId: 'client-id-1', clientSecret: 'client-secret-1', redirectBaseUrl: 'https://app.example.test' };
const GMAIL_ENV = { GMAIL_SEND_ENABLED: 'true' };

/** The URL as its endpoint and its parameters; state and challenge masked. */
function shapeOf(url: string): { endpoint: string; params: Record<string, string> } {
  const parsed = new URL(url);
  const params: Record<string, string> = {};
  for (const [key, value] of [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    params[key] = key === 'state' ? '<state>' : key === 'code_challenge' ? `<challenge ${value.length}>` : value;
  }
  return { endpoint: `${parsed.origin}${parsed.pathname}`, params };
}

function stateOf(url: string): string {
  const state = new URL(url).searchParams.get('state');
  if (state === null) throw new Error(`no state on ${url}`);
  return state;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** The media type alone: a charset parameter is the client library's, not
 *  the flow's. */
function mediaType(value: string | undefined): string | undefined {
  return value?.split(';')[0]?.trim();
}

interface SeenRequest {
  url: string;
  method: string;
  contentType: string | undefined;
  authorization: string | undefined;
  form: Record<string, string>;
}

function sortedForm(body: string): Record<string, string> {
  return Object.fromEntries([...new URLSearchParams(body).entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Global fetch answering every call with `answer`, recording each request. */
function fakeFetch(answer: Record<string, unknown>): { seen: SeenRequest[]; restore(): void } {
  const original = global.fetch;
  const seen: SeenRequest[] = [];
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      // fetch itself sets the type of a URLSearchParams body.
      contentType: mediaType(headers.get('content-type') ?? (init?.body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : undefined)),
      authorization: headers.get('authorization') ?? undefined,
      form: sortedForm(String(init?.body ?? '')),
    });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, restore: () => (global.fetch = original) };
}

/** An HTTP server answering every request with `answer` (for flows whose
 *  client library does not use global fetch). */
async function tokenServer(answer: Record<string, unknown>): Promise<{ base: string; seen: SeenRequest[]; close(): Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        method: req.method ?? '',
        contentType: mediaType(req.headers['content-type']),
        authorization: req.headers.authorization,
        form: sortedForm(body),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('no address');
  return { base: `http://127.0.0.1:${address.port}`, seen, close: () => new Promise((ok) => server.close(() => ok())) };
}

const STATE_LENGTH = 134; // 100 random bytes, base64url

describe('the authorize URL of each platform OAuth flow', () => {
  it('Attio', async () => {
    const url = await new AttioAuthClient(APP).generateInstallUrl();
    expect(stateOf(url)).toHaveLength(STATE_LENGTH);
    expect(shapeOf(url)).toMatchSnapshot();
  });

  it('Airtable', async () => {
    const url = await new AirtableAuthClient(APP).generateInstallUrl();
    expect(stateOf(url)).toHaveLength(STATE_LENGTH);
    expect(shapeOf(url)).toMatchSnapshot();
  });

  it('Dropbox', () => {
    const url = new DropboxAuthClient(APP).generateInstallUrl();
    expect(stateOf(url)).toHaveLength(STATE_LENGTH);
    expect(shapeOf(url)).toMatchSnapshot();
  });

  it('Google (Sheets and Drive)', async () => {
    const url = await new GoogleAuthClient(APP).generateInstallUrl();
    expect(stateOf(url)).toHaveLength(STATE_LENGTH);
    expect(shapeOf(url)).toMatchSnapshot();
  });

  it('Gmail, read only and with send', async () => {
    const readOnly = await new GmailAuthClient({ ...APP, env: {} }).generateInstallUrl();
    const withSend = await new GmailAuthClient({ ...APP, env: GMAIL_ENV }).generateInstallUrl();
    expect(stateOf(readOnly)).toHaveLength(STATE_LENGTH);
    expect(shapeOf(readOnly)).toMatchSnapshot();
    expect(shapeOf(withSend)).toMatchSnapshot();
  });

  it('Gmail against the dev loop fake Google', async () => {
    const url = await new GmailAuthClient({ ...APP, env: {}, fakeBaseUrl: 'http://localhost:5556/' }).generateInstallUrl();
    expect(shapeOf(url)).toMatchSnapshot();
  });

  it('Slack', async () => {
    const url = await new SlackWebApiConnector({
      clientId: APP.clientId,
      clientSecret: APP.clientSecret,
      stateSecret: 'state-secret-1',
      redirectUri: 'https://app.example.test/slack/callback',
    }).generateInstallUrl();
    expect(shapeOf(url)).toMatchSnapshot();
  });
});

describe('the code exchange of each platform OAuth flow', () => {
  afterEach(() => jest.restoreAllMocks());

  it('Attio', async () => {
    const client = new AttioAuthClient(APP);
    const state = stateOf(await client.generateInstallUrl());
    const fetched = fakeFetch({ access_token: 'attio-access' });
    try {
      await expect(client.codeToToken({ state, code: 'code-1' })).resolves.toEqual({ accessToken: 'attio-access' });
      expect(fetched.seen).toMatchSnapshot();
    } finally {
      fetched.restore();
    }
    await expect(client.codeToToken({ state, code: 'code-1' })).rejects.toThrow('Invalid state parameter value');
  });

  it('Airtable', async () => {
    const client = new AirtableAuthClient(APP);
    const url = await client.generateInstallUrl();
    const fetched = fakeFetch({ access_token: 'at-access', expires_in: 3600, refresh_token: 'at-refresh', refresh_expires_in: 7200 });
    try {
      await expect(client.codeToToken({ state: stateOf(url), code: 'code-1' })).resolves.toEqual({
        accessToken: 'at-access',
        refreshToken: 'at-refresh',
        expiresIn: 3600,
        refreshExpiresIn: 7200,
      });
      const [request] = fetched.seen;
      expect(s256(request?.form.code_verifier ?? '')).toBe(new URL(url).searchParams.get('code_challenge'));
      expect(fetched.seen.map((r) => ({ ...r, form: { ...r.form, code_verifier: `<verifier ${r.form.code_verifier?.length}>` } }))).toMatchSnapshot();
    } finally {
      fetched.restore();
    }
  });

  it('Dropbox', async () => {
    const client = new DropboxAuthClient(APP);
    const state = stateOf(client.generateInstallUrl());
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fetched = fakeFetch({ access_token: 'db-access', refresh_token: 'db-refresh', expires_in: 14400 });
    try {
      await expect(client.codeToToken({ state, code: 'code-1' })).resolves.toEqual({
        accessToken: 'db-access',
        refreshToken: 'db-refresh',
        expiresAt: 1_000_000 + 14_400_000,
      });
      expect(fetched.seen).toMatchSnapshot();
    } finally {
      fetched.restore();
    }
  });

  it('Google (Sheets and Drive)', async () => {
    const client = new GoogleAuthClient(APP);
    const url = await client.generateInstallUrl();
    const fetched = fakeFetch({ access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 });
    try {
      const before = Date.now();
      const tokens = await client.codeToToken({ state: stateOf(url), code: 'code-1' });
      expect(tokens).toMatchObject({ accessToken: 'g-access', refreshToken: 'g-refresh' });
      expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
      const [request] = fetched.seen;
      expect(s256(request?.form.code_verifier ?? '')).toBe(new URL(url).searchParams.get('code_challenge'));
      expect(fetched.seen.map((r) => ({ ...r, form: { ...r.form, code_verifier: `<verifier ${r.form.code_verifier?.length}>` } }))).toMatchSnapshot();
    } finally {
      fetched.restore();
    }
  });

  it('Gmail (through its token endpoint)', async () => {
    const server = await tokenServer({ access_token: 'gm-access', refresh_token: 'gm-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    try {
      const client = new GmailAuthClient({ ...APP, env: {}, fakeBaseUrl: server.base });
      const url = await client.generateInstallUrl();
      const before = Date.now();
      const tokens = await client.codeToToken({ state: stateOf(url), code: 'code-1' });
      expect(tokens).toMatchObject({ accessToken: 'gm-access', refreshToken: 'gm-refresh', grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
      expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
      const [request] = server.seen;
      expect(s256(request?.form.code_verifier ?? '')).toBe(new URL(url).searchParams.get('code_challenge'));
      expect(server.seen.map((r) => ({ ...r, form: { ...r.form, code_verifier: `<verifier ${r.form.code_verifier?.length}>` } }))).toMatchSnapshot();
    } finally {
      await server.close();
    }
  });
});
