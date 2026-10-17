// A fake HubSpot-like provider for the Alice/Bob acceptance: deals behind a
// bearer access token, and the OAuth 2 token endpoint that issues them. Each
// user has an account; every token belongs to one, so a test sees WHO each
// read and write was made as. Refresh tokens rotate on every refresh, and a
// refresh token is honoured once, as a strict provider does.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ProviderCall {
  method: string;
  path: string;
  /** The account the call's access token belongs to; undefined when refused. */
  as?: string;
}

export interface FakeHubSpot {
  base: string;
  tokenUrl: string;
  authorizeUrl: string;
  /** Every deals call, in order. */
  calls: ProviderCall[];
  /** Every refresh, by the account it refreshed. */
  refreshes: string[];
  deals: Array<{ id: string; Name: string; owner: string }>;
  /** A user's account, signed in: an access token (already expired when
   *  `expired`) and a refresh token, as a sign-in leaves them. */
  signIn(user: string, options?: { expired?: boolean }): { access_token: string; refresh_token: string; expires_at: string };
  /** The refresh token the provider honours for `user` now. */
  refreshTokenOf(user: string): string | undefined;
  close(): Promise<void>;
}

export async function startFakeHubSpot(options: { clientId: string; clientSecret: string }): Promise<FakeHubSpot> {
  const access = new Map<string, { user: string; expiresAt: number }>();
  const refresh = new Map<string, string>();
  const calls: ProviderCall[] = [];
  const refreshes: string[] = [];
  const deals: FakeHubSpot['deals'] = [];
  let serial = 0;

  const issue = (user: string, lifetimeMs: number) => {
    serial += 1;
    const accessToken = `access-${user}-${serial}`;
    const refreshToken = `refresh-${user}-${serial}-${randomBytes(3).toString('hex')}`;
    access.set(accessToken, { user, expiresAt: Date.now() + lifetimeMs });
    for (const [token, owner] of refresh) if (owner === user) refresh.delete(token);
    refresh.set(refreshToken, user);
    return { accessToken, refreshToken, expiresIn: Math.round(lifetimeMs / 1000) };
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handle(req, res, body));
  });

  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(body);
      const basic = `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString('base64')}`;
      if (req.headers.authorization !== basic) return json(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') !== 'refresh_token') return json(res, 400, { error: 'unsupported_grant_type' });
      const user = refresh.get(form.get('refresh_token') ?? '');
      if (user === undefined) return json(res, 400, { error: 'invalid_grant' });
      refreshes.push(user);
      const issued = issue(user, 3_600_000);
      return json(res, 200, { access_token: issued.accessToken, refresh_token: issued.refreshToken, expires_in: issued.expiresIn, token_type: 'bearer' });
    }
    if (url.pathname === '/deals' || url.pathname.startsWith('/deals/')) {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      const held = token !== undefined ? access.get(token) : undefined;
      const valid = held !== undefined && held.expiresAt > Date.now();
      calls.push({ method: req.method ?? '', path: url.pathname, ...(valid ? { as: held.user } : {}) });
      if (!valid) return json(res, 401, { error: 'expired_or_unknown_token' });
      if (req.method === 'POST' && url.pathname === '/deals') {
        const parsed: unknown = JSON.parse(body || '{}');
        const name = parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'Name') : undefined;
        const deal = { id: `deal-${deals.length + 1}`, Name: String(name ?? ''), owner: held.user };
        deals.push(deal);
        return json(res, 200, deal);
      }
      if (req.method === 'GET') {
        const id = url.pathname.slice('/deals/'.length);
        const deal = deals.find((d) => d.id === id && d.owner === held.user);
        return deal !== undefined ? json(res, 200, deal) : json(res, 404, { error: 'not_found' });
      }
    }
    json(res, 404, { error: 'not_found' });
  };

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('the fake HubSpot has no address');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    tokenUrl: `${base}/oauth/token`,
    authorizeUrl: `${base}/oauth/authorize`,
    calls,
    refreshes,
    deals,
    signIn(user, signInOptions = {}) {
      const issued = issue(user, signInOptions.expired === true ? -60_000 : 3_600_000);
      return {
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        expires_at: new Date(Date.now() + (signInOptions.expired === true ? -60_000 : 3_600_000)).toISOString(),
      };
    },
    refreshTokenOf(user) {
      for (const [token, owner] of refresh) if (owner === user) return token;
      return undefined;
    },
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
