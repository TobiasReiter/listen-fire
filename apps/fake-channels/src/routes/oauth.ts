// Fake OAuth2 provider — the one real providers share: an authorize endpoint
// that redirects back with a code, a token endpoint serving the
// authorization_code and refresh_token grants, and a protected endpoint that
// checks a bearer token. Refresh tokens ROTATE (each refresh retires the one
// presented), which is the behaviour that makes a lost write-back fatal
// against a real provider, so a refresh that forgets to store its answer is
// caught here as an invalid_grant on the next refresh.
//
// Entities (service 'oauth'):
//   code    keyed by code            { clientId, redirectUri, scope }
//   access  keyed by access token    { refreshToken, expiresAt, expired }
//   refresh keyed by refresh token   { active, scope }
//   call    one per token request    { grant, outcome, presented, issued, at }
//   config  singleton 'default'      { expiresIn, rotate, failNext, failWith }
//
// Control surface (what `dev:inject oauth-*` / `dev:inspect oauth` drive):
//   POST /oauth/control/config   { expiresIn?, rotate?, failNext?, failWith? }
//   POST /oauth/control/mint     { scope? } -> a token pair, as a completed sign-in leaves one
//   POST /oauth/control/expire   { accessToken? } -> expire one token, or every live one
//   GET  /oauth/control/state    config + tokens + call log

import { Router } from 'express';
import type { Request } from 'express';
import type { EntityStore } from '../store';

export const OAUTH_SERVICE = 'oauth';
const SVC = OAUTH_SERVICE;

export type FailMode = 'invalid_grant' | 'server_error';

interface OAuthConfig {
  expiresIn: number;
  rotate: boolean;
  failNext: number;
  failWith: FailMode;
}

const DEFAULT_CONFIG: OAuthConfig = { expiresIn: 3600, rotate: true, failNext: 0, failWith: 'invalid_grant' };

function isFailMode(value: unknown): value is FailMode {
  return value === 'invalid_grant' || value === 'server_error';
}

function readConfig(store: EntityStore): OAuthConfig {
  const row = store.get(SVC, 'config', 'default');
  if (!row) return { ...DEFAULT_CONFIG };
  const { expiresIn, rotate, failNext, failWith } = row.data;
  return {
    expiresIn: typeof expiresIn === 'number' ? expiresIn : DEFAULT_CONFIG.expiresIn,
    rotate: typeof rotate === 'boolean' ? rotate : DEFAULT_CONFIG.rotate,
    failNext: typeof failNext === 'number' ? failNext : 0,
    failWith: isFailMode(failWith) ? failWith : DEFAULT_CONFIG.failWith,
  };
}

function writeConfig(store: EntityStore, patch: Partial<OAuthConfig>): OAuthConfig {
  const next = { ...readConfig(store), ...patch };
  store.create(SVC, 'config', { ...next }, 'default');
  return next;
}

function mintTokens(store: EntityStore, input: { scope: string; expiresIn: number; refreshToken?: string }) {
  const n = store.nextId(SVC, 'token');
  const accessToken = `fake-oauth-access-${n}`;
  const refreshToken = input.refreshToken ?? `fake-oauth-refresh-${n}`;
  const expiresAt = Date.now() + input.expiresIn * 1000;
  store.create(SVC, 'access', { refreshToken, expiresAt, expired: false, scope: input.scope }, accessToken);
  if (input.refreshToken === undefined) {
    store.create(SVC, 'refresh', { active: true, scope: input.scope }, refreshToken);
  }
  return { accessToken, refreshToken, expiresAt };
}

/** Whether the provider would refuse this bearer token. Only tokens this fake
 *  issued can be refused: anything else is taken to be a fixture credential
 *  from before the provider existed. */
export function isRefusedBearer(store: EntityStore, bearer: string): boolean {
  const row = store.get(SVC, 'access', bearer);
  if (!row) return false;
  return row.data.expired === true || Number(row.data.expiresAt) <= Date.now();
}

export function bearerOf(req: Request): string {
  const header = String(req.headers.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

export function oauthRoutes(store: EntityStore): Router {
  const r = Router();

  function logCall(entry: Record<string, unknown>): void {
    store.create(SVC, 'call', { ...entry, at: new Date().toISOString() });
  }

  r.get('/authorize', (req, res) => {
    const redirectUri = String(req.query.redirect_uri ?? '');
    if (redirectUri === '') return res.status(400).send('Missing redirect_uri');
    const code = `fake-oauth-code-${store.nextId(SVC, 'code')}`;
    store.create(
      SVC,
      'code',
      { clientId: String(req.query.client_id ?? ''), redirectUri, scope: String(req.query.scope ?? '') },
      code,
    );
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', String(req.query.state ?? ''));
    res.redirect(back.toString());
  });

  r.post('/token', (req, res) => {
    const grant = String(req.body?.grant_type ?? '');
    const config = readConfig(store);

    if (config.failNext > 0) {
      writeConfig(store, { failNext: config.failNext - 1 });
      logCall({ grant, outcome: `injected_${config.failWith}`, presented: presentedOf(req.body) });
      return config.failWith === 'server_error'
        ? res.status(500).json({ error: 'server_error', error_description: 'Injected failure' })
        : res.status(400).json({ error: 'invalid_grant', error_description: 'Injected failure' });
    }

    if (grant === 'authorization_code') {
      const code = String(req.body?.code ?? '');
      const row = store.get(SVC, 'code', code);
      if (!row) {
        logCall({ grant, outcome: 'invalid_grant', presented: code });
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or used code' });
      }
      store.delete(SVC, 'code', code);
      const scope = String(row.data.scope ?? '');
      const issued = mintTokens(store, { scope, expiresIn: config.expiresIn });
      logCall({ grant, outcome: 'ok', presented: code, issuedAccess: issued.accessToken, issuedRefresh: issued.refreshToken });
      return res.json(tokenResponse(issued, config, scope));
    }

    if (grant === 'refresh_token') {
      const presented = String(req.body?.refresh_token ?? '');
      const row = store.get(SVC, 'refresh', presented);
      if (!row || row.data.active !== true) {
        logCall({ grant, outcome: 'invalid_grant', presented });
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is unknown or already used' });
      }
      const scope = String(row.data.scope ?? '');
      const issued = config.rotate
        ? mintTokens(store, { scope, expiresIn: config.expiresIn })
        : mintTokens(store, { scope, expiresIn: config.expiresIn, refreshToken: presented });
      if (config.rotate) store.update(SVC, 'refresh', presented, { active: false });
      logCall({
        grant,
        outcome: 'ok',
        presented,
        issuedAccess: issued.accessToken,
        issuedRefresh: config.rotate ? issued.refreshToken : null,
      });
      // A non-rotating provider omits refresh_token from a refresh answer.
      return res.json(tokenResponse(issued, config, scope, { includeRefresh: config.rotate }));
    }

    logCall({ grant, outcome: 'unsupported_grant_type', presented: '' });
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  r.get('/protected', (req, res) => {
    const bearer = bearerOf(req);
    const row = store.get(SVC, 'access', bearer);
    if (!row || isRefusedBearer(store, bearer)) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'The access token is unknown or expired' });
    }
    res.json({ ok: true, scope: row.data.scope });
  });

  r.post('/control/config', (req, res) => {
    const patch: Partial<OAuthConfig> = {};
    const body = req.body ?? {};
    if (typeof body.expiresIn === 'number') patch.expiresIn = body.expiresIn;
    if (typeof body.rotate === 'boolean') patch.rotate = body.rotate;
    if (typeof body.failNext === 'number') patch.failNext = body.failNext;
    if (isFailMode(body.failWith)) patch.failWith = body.failWith;
    res.json(writeConfig(store, patch));
  });

  r.post('/control/mint', (req, res) => {
    const config = readConfig(store);
    res.json(mintTokens(store, { scope: String(req.body?.scope ?? ''), expiresIn: config.expiresIn }));
  });

  r.post('/control/expire', (req, res) => {
    const only = typeof req.body?.accessToken === 'string' ? req.body.accessToken : undefined;
    const targets = store
      .list(SVC, 'access')
      .filter((t) => (only === undefined ? t.data.expired !== true : t.id === only));
    for (const t of targets) store.update(SVC, 'access', t.id, { expired: true });
    res.json({ expired: targets.map((t) => t.id) });
  });

  r.get('/control/state', (_req, res) => {
    res.json({
      config: readConfig(store),
      access: store.list(SVC, 'access').map((t) => ({ id: t.id, ...t.data })),
      refresh: store.list(SVC, 'refresh').map((t) => ({ id: t.id, ...t.data })),
      calls: store.list(SVC, 'call').map((c) => ({ id: c.id, ...c.data })),
    });
  });

  return r;
}

function presentedOf(body: Record<string, unknown> | undefined): string {
  return String(body?.refresh_token ?? body?.code ?? '');
}

function tokenResponse(
  issued: { accessToken: string; refreshToken: string },
  config: OAuthConfig,
  scope: string,
  options: { includeRefresh: boolean } = { includeRefresh: true },
): Record<string, unknown> {
  return {
    access_token: issued.accessToken,
    ...(options.includeRefresh ? { refresh_token: issued.refreshToken } : {}),
    expires_in: config.expiresIn,
    token_type: 'bearer',
    scope,
  };
}
