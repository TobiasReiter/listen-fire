// The single-tenant UI's login and logout doors.
//
// The API key is the credential; what comes back is the SAME session cookie
// core's login sets (`listen_fire_token` httpOnly + the JS-readable `listen_fire_authed`
// marker), so the web app's existing "am I signed in?" check works unchanged.
// Logout drops the same pair, in the same shape core's logout produces.

import { AddressInfo } from 'node:net';

import express from 'express';

import type { Server } from 'node:http';

const ORIGINAL_ENV = {
  TOKEN_SECRET: process.env.TOKEN_SECRET,
  SESSION_JWT_AUDIENCE: process.env.SESSION_JWT_AUDIENCE,
  LISTEN_FIRE_PRINCIPAL: process.env.LISTEN_FIRE_PRINCIPAL,
  LISTEN_FIRE_PRODUCTS: process.env.LISTEN_FIRE_PRODUCTS,
  LISTEN_FIRE_TEAM_ID: process.env.LISTEN_FIRE_TEAM_ID,
  LISTEN_FIRE_API_KEY: process.env.LISTEN_FIRE_API_KEY,
  WEB_BASE_URL: process.env.WEB_BASE_URL,
  API_BASE_URL: process.env.API_BASE_URL,
};

process.env.TOKEN_SECRET = 'test-token-secret';
process.env.SESSION_JWT_AUDIENCE = 'http://localhost:3000';
process.env.LISTEN_FIRE_PRINCIPAL = 'static';
process.env.LISTEN_FIRE_PRODUCTS = 'knowledge';
process.env.LISTEN_FIRE_TEAM_ID = '11111111-1111-1111-1111-111111111111';
process.env.LISTEN_FIRE_API_KEY = 'sekrit-key';

import { staticLoginHandler, staticLogoutHandler } from '../capabilities';
import { verifyStaticSessionToken } from '../../../services/auth/static_session';

const TEAM = '11111111-1111-1111-1111-111111111111';
const TENANT = { teamId: TEAM, apiKey: 'sekrit-key' };

describe('the static-identity login and logout doors', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post('/api/public/auth/static/login', staticLoginHandler);
    app.post('/api/public/auth/static/logout', staticLogoutHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  // jest runs these suites in one process, so an unrestored env mutation here
  // would leak into whichever suite the worker loads next.
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function sessionToken(cookies: string[]): string {
    const session = cookies.find((c) => c.startsWith('listen_fire_token=')) ?? '';
    return decodeURIComponent(session.slice('listen_fire_token='.length).split(';')[0]);
  }

  async function login(body: unknown) {
    return fetch(`${base}/api/public/auth/static/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('sets the session cookie and its presence marker for the configured key', async () => {
    const res = await login({ apiKey: 'sekrit-key' });
    expect(res.status).toBe(200);

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('listen_fire_token='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    // The marker exists to be read by JS — httpOnly would defeat its purpose.
    const marker = cookies.find((c) => c.startsWith('listen_fire_authed=1'));
    expect(marker).toBeDefined();
    expect(marker).not.toContain('HttpOnly');

    expect(verifyStaticSessionToken(sessionToken(cookies), TENANT)).toBe(true);
  });

  // The API key is the only credential a static install has, so rotating it has
  // to end the sessions it bought — otherwise a leaked key keeps its browsers
  // signed in for 180 days after the operator believes they revoked it.
  it('refuses a session bought with a key that has since been rotated', async () => {
    const res = await login({ apiKey: 'sekrit-key' });
    const token = sessionToken(res.headers.getSetCookie());

    expect(verifyStaticSessionToken(token, { teamId: TEAM, apiKey: 'rotated-key' })).toBe(false);
    expect(verifyStaticSessionToken(token, TENANT)).toBe(true);
  });

  it('refuses a wrong key with no cookie and no detail', async () => {
    const res = await login({ apiKey: 'not-the-key' });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid API key' });
  });

  it('refuses a body with no key at all', async () => {
    const res = await login({});
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a session token minted for another tenant', async () => {
    const token = sessionToken((await login({ apiKey: 'sekrit-key' })).headers.getSetCookie());
    const otherTeam = { teamId: '22222222-2222-2222-2222-222222222222', apiKey: 'sekrit-key' };

    expect(verifyStaticSessionToken(token, otherTeam)).toBe(false);
  });

  it('refuses a malformed token rather than throwing', () => {
    expect(verifyStaticSessionToken('not-a-jwt', TENANT)).toBe(false);
  });

  // A self-host reached over plain http is a real deployment, not a mistake.
  // `Secure` there is set, dropped by the browser, and the user lands back on
  // the login they just completed — so the flag follows the scheme this
  // install is actually reached on.
  describe('the `Secure` flag', () => {
    // Self-contained on purpose: the rule reads exactly these two, so pin them
    // rather than inherit whatever the process happened to be started with,
    // and hand them back untouched afterwards.
    const OUTER_URLS = {
      WEB_BASE_URL: process.env.WEB_BASE_URL,
      API_BASE_URL: process.env.API_BASE_URL,
    };

    function clearUrls(): void {
      process.env.WEB_BASE_URL = '';
      process.env.API_BASE_URL = '';
    }

    beforeAll(clearUrls);
    afterEach(clearUrls);

    afterAll(() => {
      for (const [name, value] of Object.entries(OUTER_URLS)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    async function cookiesFor(env: Record<string, string>): Promise<string[]> {
      clearUrls();
      Object.assign(process.env, env);
      const res = await login({ apiKey: 'sekrit-key' });
      expect(res.status).toBe(200);
      return res.headers.getSetCookie();
    }

    it('is absent when the deployment is reached over http', async () => {
      const cookies = await cookiesFor({ WEB_BASE_URL: 'http://192.168.1.40:8080' });
      for (const cookie of cookies) expect(cookie).not.toContain('Secure');
    });

    it('is present when the deployment is reached over https', async () => {
      const cookies = await cookiesFor({ WEB_BASE_URL: 'https://listen-fire.example.com' });
      for (const cookie of cookies) expect(cookie).toContain('Secure');
    });

    // Headless (`static` with no web app): the API's own origin is the only
    // public URL there is.
    it('falls back to the API origin when there is no web app', async () => {
      const cookies = await cookiesFor({ API_BASE_URL: 'https://knowledge.example.com' });
      for (const cookie of cookies) expect(cookie).toContain('Secure');
    });

    // Only the two schemes a browser can actually be on are evidence. A base
    // URL written without one says nothing about how the person reaches this
    // install, so the build mode decides — and under test that is not
    // production, the same answer an unconfigured install gets.
    it('leaves the build mode to decide when no scheme says otherwise', async () => {
      for (const cookie of await cookiesFor({ WEB_BASE_URL: 'listen-fire.example.com' })) {
        expect(cookie).not.toContain('Secure');
      }
      for (const cookie of await cookiesFor({})) {
        expect(cookie).not.toContain('Secure');
      }
    });
  });

  it('logs out by clearing both cookies', async () => {
    const res = await fetch(`${base}/api/public/auth/static/logout`, { method: 'POST' });
    expect(res.status).toBe(204);

    const cookies = res.headers.getSetCookie();
    for (const name of ['listen_fire_token', 'listen_fire_authed']) {
      const cleared = cookies.find((c) => c.startsWith(`${name}=;`));
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    }
  });
});
