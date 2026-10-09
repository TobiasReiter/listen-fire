// The door in front of the system routes: which verifiers the settings install,
// the boot check on them, and the gate's answer with one mode, both, or none.

import { createServer, type Server } from 'node:http';

import express from 'express';

import type { AddressInfo } from 'node:net';

import {
  assertSystemAuthConfigured,
  defersToSystemCaller,
  installSystemCallerVerifiers,
  registerSystemCallerVerifier,
  requireSystemAction,
  requireSystemCaller,
  requireTenantCaller,
  systemCallerOf,
} from '../index';
import { registeredSystemCallerVerifiers, resetSystemCallerVerifiersForTests } from '../verifier';
import { logger } from '../../logger';
import { startFakeIssuer, type FakeIssuer } from './fake_issuer';


const AUDIENCE = 'http://api.test/api/v1/system/automations/drain';
const SUBJECT = 'scheduler@dev-loop';

let issuer: FakeIssuer;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  issuer = await startFakeIssuer();
  const app = express();
  // Stands in for the host's authentication: an `lf_` bearer is a verified key,
  // and so is an `x-api-key` when the bearer is not one (as the core provider reads them).
  app.use((req, res, next) => {
    const authorization = req.headers.authorization?.replace(/^Bearer /, '');
    const xApiKey = req.headers['x-api-key'];
    const bearer = authorization?.startsWith('lf_') ? authorization : typeof xApiKey === 'string' ? xApiKey : undefined;
    if (bearer?.startsWith('lf_')) {
      res.locals.apiKeyId = 'key-1';
      res.locals.apiKeyScopes = bearer === 'lf_system' ? ['system'] : ['automation'];
    }
    next();
  });
  app.post('/drain', requireSystemCaller(), requireSystemAction('drain'), (req, res) => {
    res.status(200).json({ caller: systemCallerOf(req) });
  });
  app.get('/tenant', requireSystemCaller(), requireTenantCaller(), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await issuer.close();
});

beforeEach(() => {
  resetSystemCallerVerifiersForTests();
});

function oidcEnv(modes: string) {
  return {
    SYSTEM_AUTH_MODES: modes,
    SYSTEM_AUTH_OIDC_ISSUER: issuer.url,
    SYSTEM_AUTH_OIDC_AUDIENCE: AUDIENCE,
    SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS: `other@dev-loop, ${SUBJECT}`,
  };
}

async function tick(bearer: string) {
  const res = await fetch(`${baseUrl}/drain`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const token = () => issuer.mint({ sub: SUBJECT, aud: AUDIENCE });

describe('the system caller gate', () => {
  it('with nothing configured, asks the API key alone, exactly as the scope gate did', async () => {
    installSystemCallerVerifiers({});
    expect(registeredSystemCallerVerifiers().map((v) => v.name)).toEqual(['api_key']);

    expect(await tick('lf_system')).toEqual({
      status: 200,
      body: { caller: { verifier: 'api_key', principal: { id: 'api_key:key-1' }, actions: ['drain'] } },
    });
    expect(await tick('lf_automation')).toEqual({ status: 403, body: { error: 'API key missing required scope: system' } });
    expect((await tick(token())).status).toBe(403);
  });

  it('with no verifier registered at all (a process composed without the boot step), still asks the API key', async () => {
    expect((await tick('lf_system')).status).toBe(200);
    expect((await tick(token())).status).toBe(403);
  });

  it('with oidc alone, accepts the token and refuses the API key', async () => {
    installSystemCallerVerifiers(oidcEnv('oidc'));
    expect(await tick(token())).toEqual({
      status: 200,
      body: { caller: { verifier: 'oidc', principal: { id: SUBJECT }, actions: ['drain'] } },
    });
    expect(await tick('lf_system')).toEqual({ status: 403, body: { error: 'the bearer is not a JWT' } });
  });

  it('with both, accepts either credential, and a refusal names each verifier', async () => {
    installSystemCallerVerifiers(oidcEnv('api_key,oidc'));
    expect(registeredSystemCallerVerifiers().map((v) => v.name)).toEqual(['api_key', 'oidc']);
    expect((await tick('lf_system')).body).toMatchObject({ caller: { verifier: 'api_key' } });
    expect((await tick(token())).body).toMatchObject({ caller: { verifier: 'oidc' } });
    expect(await tick(issuer.mint({ sub: 'stranger', aud: AUDIENCE }))).toEqual({
      status: 403,
      body: {
        error: "api_key: API key missing required scope: system; oidc: the token's subject is not on the allow-list",
      },
    });
  });

  it('under the default mode, a request with no key (a session) gets the scope gate\'s own answer', async () => {
    installSystemCallerVerifiers({});
    const res = await fetch(`${baseUrl}/drain`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'API key missing required scope: system' });
  });

  it('a tenant route refuses an oidc caller whose request also carries a low-scope key the host verified', async () => {
    installSystemCallerVerifiers(oidcEnv('api_key,oidc'));
    const attack = await fetch(`${baseUrl}/tenant`, {
      headers: { authorization: `Bearer ${token()}`, 'x-api-key': 'lf_automation' },
    });
    expect(attack.status).toBe(403);
    expect(await attack.json()).toEqual({
      error: 'this route acts in a tenant: call it with an API key holding the system scope',
    });
    const operator = await fetch(`${baseUrl}/tenant`, { headers: { authorization: 'Bearer lf_system' } });
    expect(operator.status).toBe(200);
  });

  it('logs a refusal once a minute per caller and verifier, however its reason varies', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    installSystemCallerVerifiers(oidcEnv('oidc'));
    await tick(issuer.mint({ sub: 'stranger', aud: AUDIENCE }));
    await tick(issuer.mint({ sub: SUBJECT, aud: 'elsewhere' }));
    await tick('not-a-jwt');
    expect(warn.mock.calls.filter(([message]) => String(message).includes('refused the request'))).toHaveLength(1);
    warn.mockRestore();
  });

  it("an embedder's own verifier is asked in registration order, and may decline an action", async () => {
    registerSystemCallerVerifier({
      name: 'mtls',
      verify: async ({ headers }) =>
        headers['x-client-cert'] === 'trusted'
          ? { ok: true, principal: { id: 'cert:scheduler' }, actions: [] }
          : { ok: false, reason: 'no trusted client certificate' },
    });
    const res = await fetch(`${baseUrl}/drain`, { method: 'POST', headers: { 'x-client-cert': 'trusted' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'this system caller may not drain' });
  });

  it('defers the host refusal of a system request only when a verifier other than the API key is registered', () => {
    const at = (path: string) => ({ path });
    installSystemCallerVerifiers({});
    expect(defersToSystemCaller(at('/api/v1/system/automations/drain'))).toBe(false);

    resetSystemCallerVerifiersForTests();
    installSystemCallerVerifiers(oidcEnv('oidc'));
    expect(defersToSystemCaller(at('/api/v1/system/automations/drain'))).toBe(true);
    expect(defersToSystemCaller(at('/api/v1/system'))).toBe(true);
    expect(defersToSystemCaller(at('/api/v1/systemic'))).toBe(false);
    expect(defersToSystemCaller(at('/api/v1/automation/movements'))).toBe(false);
  });
});

describe('the boot check', () => {
  it('passes the default and a complete oidc mode', () => {
    expect(() => assertSystemAuthConfigured({})).not.toThrow();
    expect(() => assertSystemAuthConfigured(oidcEnv('api_key, oidc'))).not.toThrow();
  });

  it('refuses a mode it does not know', () => {
    expect(() => assertSystemAuthConfigured({ SYSTEM_AUTH_MODES: 'api_key,saml' })).toThrow(
      'SYSTEM_AUTH_MODES names "saml"; the modes are api_key and oidc.',
    );
  });

  it('refuses oidc named without its settings, naming each missing one', () => {
    expect(() => assertSystemAuthConfigured({ SYSTEM_AUTH_MODES: 'oidc', SYSTEM_AUTH_OIDC_ISSUER: issuer.url })).toThrow(
      'SYSTEM_AUTH_MODES names oidc, which needs SYSTEM_AUTH_OIDC_AUDIENCE, SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS.',
    );
  });

  it('refuses a plain http issuer in production', () => {
    expect(() => assertSystemAuthConfigured({ ...oidcEnv('oidc'), NODE_ENV: 'production' })).toThrow(
      `SYSTEM_AUTH_OIDC_ISSUER must be an https URL (got "${issuer.url}").`,
    );
    expect(() =>
      assertSystemAuthConfigured({ ...oidcEnv('oidc'), SYSTEM_AUTH_OIDC_ISSUER: 'https://accounts.google.com', NODE_ENV: 'production' }),
    ).not.toThrow();
  });
});
