// A fake OAuth 2 provider for tests: an authorize page that consents at once
// (redirecting back with a code), and a token endpoint for the
// authorization-code and refresh-token grants that checks what a real one
// checks (the client, the redirect, the PKCE verifier, a code used once) and
// rotates refresh tokens. Every token call is recorded.
//
// Unit tests start it in process, with no fake-channels running; the dev
// loop's provider (apps/fake-channels routes/oauth.ts) serves the running
// stack instead, and engine code may not import an app.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeOAuthCall {
  grant: string;
  form: Record<string, string>;
  authorization: string | undefined;
}

export interface FakeOAuthServer {
  /** e.g. http://127.0.0.1:PORT */
  base: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Every token call, in order. */
  calls: FakeOAuthCall[];
  /** Every authorize request's query, in order. */
  authorizations: Record<string, string>[];
  /** The refresh token the provider currently honours. */
  currentRefreshToken(): string | undefined;
  close(): Promise<void>;
}

interface Issued {
  redirectUri: string;
  challenge: string | undefined;
}

export async function startFakeOAuthServer(options: {
  clientId: string;
  clientSecret: string;
  /** Where the client must authenticate on the token call. Default basic. */
  clientAuth?: 'basic' | 'body';
  /** Seconds each issued access token lives; a function of the issue's
   *  number (1 for the first) to vary it. Default 3600. */
  expiresIn?: number | ((issue: number) => number);
  /** Refuse PKCE-less attempts. */
  requirePkce?: boolean;
}): Promise<FakeOAuthServer> {
  const codes = new Map<string, Issued>();
  const calls: FakeOAuthCall[] = [];
  const authorizations: Record<string, string>[] = [];
  let refreshToken: string | undefined;
  let serial = 0;

  const issueTokens = (res: ServerResponse) => {
    serial += 1;
    refreshToken = `refresh-${serial}-${randomBytes(4).toString('hex')}`;
    json(res, 200, { access_token: `access-${serial}`, token_type: 'bearer', expires_in: typeof options.expiresIn === 'function' ? options.expiresIn(serial) : (options.expiresIn ?? 3600), refresh_token: refreshToken, scope: 'granted' });
  };

  const clientOk = (req: IncomingMessage, form: URLSearchParams): boolean => {
    if ((options.clientAuth ?? 'basic') === 'basic') {
      const expected = `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString('base64')}`;
      return req.headers.authorization === expected && !form.has('client_secret');
    }
    return form.get('client_id') === options.clientId && form.get('client_secret') === options.clientSecret;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const query = Object.fromEntries(url.searchParams.entries());
      authorizations.push(query);
      const redirectUri = query.redirect_uri;
      if (query.client_id !== options.clientId || query.response_type !== 'code' || redirectUri === undefined) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const challenge = query.code_challenge;
      if (options.requirePkce === true && (challenge === undefined || query.code_challenge_method !== 'S256')) {
        return json(res, 400, { error: 'invalid_request', error_description: 'PKCE required' });
      }
      const code = `code-${randomBytes(8).toString('hex')}`;
      codes.set(code, { redirectUri, challenge });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      if (query.state !== undefined) back.searchParams.set('state', query.state);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const grant = form.get('grant_type') ?? '';
        calls.push({ grant, form: Object.fromEntries(form.entries()), authorization: req.headers.authorization });
        if (!clientOk(req, form)) return json(res, 401, { error: 'invalid_client' });
        if (grant === 'authorization_code') {
          const code = form.get('code') ?? '';
          const issued = codes.get(code);
          codes.delete(code);
          if (issued === undefined || issued.redirectUri !== form.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
          if (issued.challenge !== undefined) {
            const verifier = form.get('code_verifier') ?? '';
            if (createHash('sha256').update(verifier).digest('base64url') !== issued.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
          }
          return issueTokens(res);
        }
        if (grant === 'refresh_token') {
          if (refreshToken === undefined || form.get('refresh_token') !== refreshToken) return json(res, 400, { error: 'invalid_grant' });
          return issueTokens(res);
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('the fake OAuth server has no address');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    calls,
    authorizations,
    currentRefreshToken: () => refreshToken,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
