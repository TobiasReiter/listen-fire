import { Router, type RequestHandler } from 'express';
import crypto from 'crypto';
import { verify, type JwtPayload } from 'jsonwebtoken';

import { getCoreQb } from '../../lib/kysely';
import { ApiKeyService } from '../../services/api_key';
import { recordUserMilestone } from '../../lib/journey';
import { sessionJwtAudience } from '../../lib/middleware/authentication/session_jwt_audience';
import { logger } from '../../services/logger';
import { getRedisPool, redisConfigured } from '../../redisPool';
import { getOrigin } from './origin';

/**
 * OAuth flow state — auth codes and dynamically-registered clients — lives in
 * BOTH a process-local Map (fast path) and Redis (durable path). Memory alone
 * broke real connects: an API restart mid-flow (every deploy) wiped in-flight
 * codes, the token exchange then failed, and the MCP client silently restarted
 * the whole flow — which the user experienced as the consent button "needing a
 * double-click". Reads try memory first, then Redis; writes go to both,
 * best-effort on the Redis leg (a Redis hiccup degrades to today's
 * single-instance behavior instead of failing the flow). With no Redis configured
 * the Redis leg is skipped: the flow is exact within one process, but a restart
 * mid-flow, or another API instance answering the token exchange, loses it.
 */
interface AuthCodeData {
  apiKey: string;
  clientId: string;
  codeChallenge?: string;
  redirectUri: string;
  expiresAt: number;
}
interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

const authCodes = new Map<string, AuthCodeData>();
const registeredClients = new Map<string, RegisteredClient>();

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
// Registrations are re-minted freely by clients; 30 days outlives any session.
const CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);

async function redisOp<T>(op: (client: import('ioredis').Redis) => Promise<T>): Promise<T | null> {
  if (!redisConfigured()) return null;
  try {
    const pool = getRedisPool();
    const client = await pool.acquire();
    try {
      return await op(client);
    } finally {
      pool.release(client).catch(() => {});
    }
  } catch (e) {
    logger.warn('[mcp-oauth] redis op failed — falling back to in-memory state', { error: e });
    return null;
  }
}

async function persistAuthCode(code: string, data: AuthCodeData): Promise<void> {
  authCodes.set(code, data);
  await redisOp((c) => c.set(`mcp:oauth:code:${code}`, JSON.stringify(data), 'PX', AUTH_CODE_TTL_MS));
}

/** Single-use fetch: removes the code from both stores. */
async function consumeAuthCode(code: string): Promise<AuthCodeData | null> {
  const key = `mcp:oauth:code:${code}`;
  const local = authCodes.get(code);
  authCodes.delete(code);
  if (local) {
    void redisOp((c) => c.del(key));
    return local;
  }
  const raw = await redisOp(async (c) => {
    const value = await c.get(key);
    if (value) await c.del(key);
    return value;
  });
  return raw ? (JSON.parse(raw) as AuthCodeData) : null;
}

async function persistClient(client: RegisteredClient): Promise<void> {
  registeredClients.set(client.clientId, client);
  await redisOp((c) =>
    c.set(`mcp:oauth:client:${client.clientId}`, JSON.stringify(client), 'EX', CLIENT_TTL_SECONDS),
  );
}

async function lookupClient(clientId: string): Promise<RegisteredClient | null> {
  const local = registeredClients.get(clientId);
  if (local) return local;
  const raw = await redisOp((c) => c.get(`mcp:oauth:client:${clientId}`));
  return raw ? (JSON.parse(raw) as RegisteredClient) : null;
}

// ── Session helpers (no dependency on request context) ──

interface SessionUser {
  id: string;
  teamId: string;
}

async function getUserFromCookie(cookieToken: string): Promise<SessionUser | null> {
  try {
    const decoded = verify(cookieToken, process.env.TOKEN_SECRET!, {
      algorithms: ['HS256'],
      audience: sessionJwtAudience(),
    }) as JwtPayload;

    const email = decoded['listen-fire-token/email'];
    if (typeof email !== 'string') return null;

    const row = await getCoreQb(['user_email', 'user'])
      .selectFrom('user_email')
      .innerJoin('user', 'user.id', 'user_email.user_id')
      .where('user_email.email', '=', email)
      .where('user.granted_access_at', 'is not', null)
      .select(['user.id', 'user.default_team_id'])
      .executeTakeFirst();

    if (!row) return null;
    return { id: row.id, teamId: row.default_team_id };
  } catch {
    return null;
  }
}

async function createMcpApiKey(user: SessionUser, scopes: string[]): Promise<string> {
  // Through the service, never a second hand-rolled generator: the key's prefix
  // is what `validateKey` gates on, so a local copy of the minting code is a
  // rename away from issuing keys the door refuses.
  //
  // User-anchored (`teamId: null`) so the MCP connector spans every team the
  // user is a member of, defaulting to their home team at resolution time.
  // (api_key.team_id is authoritative-when-set; left null here.)
  const { key: plaintext } = await ApiKeyService.createForOwner({
    name: `Claude MCP (${scopes.join(', ')})`,
    scopes,
    teamId: null,
    createdBy: user.id,
  });

  // The connector grant is the "connected" moment. Automation only — the
  // knowledge/valuations connectors are deliberately not tracked.
  if (scopes.includes('automation')) {
    void recordUserMilestone(user.id, {
      milestone: 'mcp_connected',
      teamId: user.teamId,
    }).catch((e) => logger.warn('journey: mcp_connected record failed', { error: e }));
  }

  return plaintext;
}

// The Automation, Knowledge, and Valuations connectors are independently
// grantable. Each MCP resource (`/api/v1/mcp/<connector>`) advertises its OWN
// authorization server whose metadata lists only that connector's scope, so a
// spec-compliant client (RFC 9728 → RFC 8414 discovery) requests just that one
// scope rather than the union of all of them. We still defend at grant time: the
// scopes we mint are the ones the client actually requested, intersected with
// what the targeted connector is allowed to grant — never broader.
const SUPPORTED_SCOPES = ['automation', 'knowledge', 'valuations'] as const;

const CONNECTOR_SCOPES: Record<string, string[]> = {
  automation: ['automation'],
  knowledge: ['knowledge'],
  valuations: ['valuations'],
};

// The connector a `resource` URI names, from its last path segment
// (`…/api/v1/mcp/automation` → `automation`). null when absent/unrecognized.
function connectorForResource(resource: string | undefined): string | null {
  if (!resource) return null;
  const segment = resource.split('?')[0].split('/').filter(Boolean).pop() ?? '';
  return CONNECTOR_SCOPES[segment] ? segment : null;
}

// Scopes a client requested via the OAuth `scope` param (space-delimited; Express
// has already turned `+` into spaces), bounded to the ones we support.
function parseRequestedScopes(scope: string | undefined): string[] {
  if (!scope) return [];
  const supported: readonly string[] = SUPPORTED_SCOPES;
  return scope.split(/\s+/).filter((s) => supported.includes(s));
}

// The scopes a grant should actually carry. When the `resource` names a known
// connector, we grant that connector's FULL bundle: it is already bounded to
// that connector (an automation key never carries knowledge/valuations). When no
// connector is identifiable (older single-connector setups sending neither a
// recognizable resource nor a scope), we honor the request, or fall back to the
// legacy pair.
function resolveGrantedScopes(options: { resource?: string; scope?: string }): string[] {
  const connector = connectorForResource(options.resource);
  if (connector) {
    return [...CONNECTOR_SCOPES[connector]];
  }

  const requested = parseRequestedScopes(options.scope);
  if (requested.length) return requested;
  return ['valuations', 'knowledge'];
}

const SCOPE_LABELS: Record<string, string> = {
  automation: 'Automation — build &amp; run automations across your connected systems',
  knowledge: 'Knowledge API — read &amp; write',
  valuations: 'Valuations API — read &amp; write',
};

// ── Router ──

function createOAuthRouter(): ReturnType<typeof Router> {
  const router = Router();

  // ── OAuth Authorization Server Metadata (RFC 8414) ──

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(authServerMetadata(getOrigin(_req)));
  });

  // Per-connector authorization-server metadata (RFC 8414 path-aware form). Each
  // MCP resource points its `authorization_servers` at `${origin}/api/v1/mcp/<connector>`;
  // its metadata lives here and advertises ONLY that connector's scope, so the
  // client requests exactly that scope instead of the union of all connectors'.
  // The endpoints themselves stay shared at the origin root.
  router.get('/.well-known/oauth-authorization-server/api/v1/mcp/:domain', (req, res) => {
    const origin = getOrigin(req);
    const connectorScopes = CONNECTOR_SCOPES[req.params.domain];
    res.json(
      connectorScopes
        ? authServerMetadata(origin, {
            issuer: `${origin}/api/v1/mcp/${req.params.domain}`,
            scopes: connectorScopes,
          })
        : authServerMetadata(origin),
    );
  });

  // ── Dynamic Client Registration (RFC 7591) ──

  router.post('/oauth/register', (async (req, res) => {
    const { redirect_uris, client_name } = req.body ?? {};
    const clientId = `mcp_${crypto.randomUUID()}`;

    await persistClient({
      clientId,
      redirectUris: redirect_uris ?? [],
      clientName: typeof client_name === 'string' ? client_name : undefined,
    });

    res.status(201).json({
      client_id: clientId,
      client_name,
      redirect_uris,
    });
  }) as RequestHandler);

  // ── Authorization Endpoint ──

  router.get('/oauth/authorize', (async (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type, resource, scope } =
      req.query as Record<string, string>;

    if (response_type !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type' });
      return;
    }

    const escapedValues = {
      client_id: escapeHtml(client_id ?? ''),
      redirect_uri: escapeHtml(redirect_uri ?? ''),
      state: escapeHtml(state ?? ''),
      code_challenge: escapeHtml(code_challenge ?? ''),
      code_challenge_method: escapeHtml(code_challenge_method ?? ''),
      resource: escapeHtml(resource ?? ''),
      scope: escapeHtml(scope ?? ''),
    };

    const cookieToken = req.cookies?.listen_fire_token;
    const user = cookieToken ? await getUserFromCookie(cookieToken) : null;

    if (!user) {
      // Bounce through the web app's login page (same origin — the app
      // rewrites /oauth/* to the API, so the auth cookie is shared).
      // `returnUrl` is the login page's own guarded return mechanism,
      // honored by every method — password, Google, Microsoft, and the
      // already-signed-in fast path — so the user lands back on this
      // authorize URL with the cookie set. (The previous
      // `/sign-in?redirect_path=` target was a 404: no such route, and
      // nothing consumed the param — a logged-out browser could never
      // complete the connect.)
      res.redirect(`/login?returnUrl=${encodeURIComponent(req.originalUrl)}`);
      return;
    }

    // The grant is what the client requested, narrowed to what this connector
    // (named by `resource`) may carry — so the consent screen names exactly the
    // scopes this key will hold.
    const grantedScopes = resolveGrantedScopes({ resource, scope });
    const scopeRows = grantedScopes
      .map((s) => `    <div class="scope">${SCOPE_LABELS[s] ?? escapeHtml(s)}</div>`)
      .join('\n');

    // Name the ACTUAL client from its Dynamic Client Registration, not a
    // hardcoded "Claude" — the connector can be added from any MCP client.
    const registeredName = (await lookupClient(client_id ?? ''))?.clientName?.trim();
    const clientLabel = registeredName ? escapeHtml(registeredName) : null;
    const requester = clientLabel ?? 'An application';

    res.type('html').send(renderPage({
      title: clientLabel ? `Authorize ${clientLabel}` : 'Authorize access',
      body: `
  <p>${requester} is requesting access to your Listen-Fire account.</p>
  <div class="scopes">
${scopeRows}
  </div>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${escapedValues.client_id}" />
    <input type="hidden" name="redirect_uri" value="${escapedValues.redirect_uri}" />
    <input type="hidden" name="state" value="${escapedValues.state}" />
    <input type="hidden" name="code_challenge" value="${escapedValues.code_challenge}" />
    <input type="hidden" name="code_challenge_method" value="${escapedValues.code_challenge_method}" />
    <input type="hidden" name="resource" value="${escapedValues.resource}" />
    <input type="hidden" name="scope" value="${escapedValues.scope}" />
    <input type="hidden" name="session_auth" value="1" />
    <button type="submit">Allow access</button>
  </form>
  <script>
    // A submit with no feedback reads as a dead click; show a spinner so
    // latency is visibly the server working, not a missed click.
    // (Disabling happens after submission has started, so the POST still fires.)
    document.querySelector('form').addEventListener('submit', function () {
      var b = this.querySelector('button');
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span>Connecting…';
    });
  </script>`,
    }));
  }) as RequestHandler);

  router.post('/oauth/authorize', (async (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, resource, scope } = req.body ?? {};

    if (!redirect_uri) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Missing redirect_uri' });
      return;
    }

    const cookieToken = req.cookies?.listen_fire_token;
    if (!cookieToken) {
      res.status(401).send('Session expired — please try again');
      return;
    }
    const user = await getUserFromCookie(cookieToken);
    if (!user) {
      res.status(401).send('Invalid session — please try again');
      return;
    }
    const apiKey = await createMcpApiKey(user, resolveGrantedScopes({ resource, scope }));

    const code = crypto.randomBytes(32).toString('hex');
    await persistAuthCode(code, {
      apiKey,
      clientId: client_id ?? '',
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  }) as RequestHandler);

  // ── Token Endpoint ──

  router.post('/oauth/token', (async (req, res) => {
    const { grant_type, code, code_verifier } = req.body ?? {};

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    const authCode = await consumeAuthCode(code);
    if (!authCode || authCode.expiresAt < Date.now()) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    // PKCE verification
    if (authCode.codeChallenge) {
      if (!code_verifier) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Missing code_verifier' });
        return;
      }
      const expected = crypto.createHash('sha256').update(code_verifier).digest('base64url');
      if (expected !== authCode.codeChallenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    }

    // The API key IS the access token — Claude will send it as Bearer on MCP requests,
    // which the existing auth middleware validates.
    res.json({
      access_token: authCode.apiKey,
      token_type: 'Bearer',
    });
  }) as RequestHandler);

  return router;
}

// RFC 8414 Authorization Server Metadata. The global form (no options) lists all
// supported scopes; a per-connector form overrides `issuer` and narrows
// `scopes_supported` to that one connector. Endpoints are always the shared root.
/**
 * The authorize step is the one leg a BROWSER walks, and it needs the login
 * cookie — which lives on the web app's origin. The web app proxies /oauth/*
 * to the API, so advertising authorize there keeps the cookie in play on a
 * split deployment (api.x / web.x); token and registration are server-to-
 * server and stay at the API. Same-origin deployments set no WEB_BASE_URL
 * distinct from the origin, so nothing changes for them.
 */
function browserOrigin(origin: string): string {
  return (process.env.WEB_BASE_URL ?? origin).replace(/\/$/, '');
}

function authServerMetadata(origin: string, options?: { issuer?: string; scopes?: string[] }) {
  return {
    issuer: options?.issuer ?? origin,
    authorization_endpoint: `${browserOrigin(origin)}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: options?.scopes ?? [...SUPPORTED_SCOPES],
  };
}

function renderPage(options: { title: string; body: string }): string {
  return `<!DOCTYPE html>
<html><head>
<title>${escapeHtml(options.title)} — Listen-Fire</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .card { background: white; border-radius: 12px; padding: 32px; width: 100%; max-width: 400px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h2 { font-size: 20px; margin-bottom: 8px; }
  p { color: #666; font-size: 14px; margin-bottom: 24px; }
  label { font-size: 13px; font-weight: 500; color: #333; display: block; margin-bottom: 6px; }
  input[type="text"] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: monospace; }
  input[type="text"]:focus { outline: none; border-color: #333; }
  button { width: 100%; padding: 10px; margin-top: 16px; background: #1a1a2e; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
  button:hover { background: #2a2a4e; }
  button:disabled { cursor: default; opacity: 0.85; }
  .spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; border-radius: 50%; vertical-align: -2px; margin-right: 8px; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .scopes { margin-bottom: 16px; }
  .scope { padding: 8px 12px; background: #f8f8f8; border-radius: 6px; font-size: 13px; color: #333; margin-bottom: 6px; }
</style>
</head><body>
<div class="card">
  <h2>${escapeHtml(options.title)}</h2>
  ${options.body}
</div>
</body></html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { createOAuthRouter, resolveGrantedScopes, authServerMetadata, SCOPE_LABELS, CONNECTOR_SCOPES };
