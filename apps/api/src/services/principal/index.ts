// The composition root for identity: which PrincipalProvider and Directory this
// process runs on, chosen once at startup by `LISTEN_FIRE_PRINCIPAL`.
//
//   core   (default) — the tables in this database; composed Listen-Fire.
//   static           — one team, one secret, no infrastructure (core plan §3),
//                      for tests and for a product self-hosted without core.
//
// No product code branches on the answer; only this file knows there is one.

import {
  createStaticDirectory,
  createStaticPrincipalProvider,
  principalRequestFromExpress,
  staticConfigFromEnv,
  type Access,
  type Directory,
  type Principal,
  type PrincipalProvider,
  type PrincipalRequest,
} from 'principal';

import type { Request } from 'express';

import { AUTH_COOKIE } from '../../constants';
import { verifyStaticSessionToken } from '../auth/static_session';
import { currentContext } from '../context';
import { coreDirectory } from './core_directory';
import {
  authenticateCore,
  completeAuthentication,
  createCorePrincipalProvider,
  type CoreAuthOutcome,
  type ResolvedIdentity,
} from './core_provider';
import { principalMode, type PrincipalMode } from './mode';

/** The websocket subprotocol the realtime token rides in (D19). */
const REALTIME_SUBPROTOCOL = 'ListenFireToken';

interface Identity {
  mode: PrincipalMode;
  provider: PrincipalProvider;
  directory: Directory;
}

let identity: Identity | undefined;

function compose(): Identity {
  const mode = principalMode();
  if (mode === 'static') {
    const config = staticConfigFromEnv(process.env);
    return {
      mode,
      provider: createStaticPrincipalProvider(config, {
        // The cookie `POST /api/public/auth/static/login` sets. Core's own
        // session cookie name, because it IS the same cookie to everything
        // downstream — only what it claims differs. The session is bound to
        // the configured key, so rotating the key signs every browser out.
        session: {
          cookie: AUTH_COOKIE,
          verify: (value) => verifyStaticSessionToken(value, config),
        },
      }),
      directory: createStaticDirectory(config.directory),
    };
  }
  return { mode, provider: createCorePrincipalProvider(), directory: coreDirectory };
}

/** Lazily composed: reading the static config at import time would make every
 *  test that imports anything downstream pay for identity env vars. */
function currentIdentity(): Identity {
  identity ??= compose();
  return identity;
}

function principalProvider(): PrincipalProvider {
  return currentIdentity().provider;
}

function principalDirectory(): Directory {
  return currentIdentity().directory;
}

/**
 * Authenticate an express request.
 *
 * In `core` mode this is the whole funnel, and the outcome carries the exact
 * status + body each refusal has always answered with. With the static
 * provider there is no core to ask: the configured tenant either matches the
 * request's secret or it does not, and the refusal is the contract's.
 */
async function authenticateRequest(req: Request): Promise<CoreAuthOutcome> {
  const { mode, provider } = currentIdentity();
  if (mode === 'core') {
    return authenticateCore(principalRequestFromExpress(req));
  }

  const result = await provider.authenticate(principalRequestFromExpress(req));
  if (!result.ok) {
    return { ok: false, status: result.status, body: { error: { code: result.status, message: result.message } } };
  }
  // A static tenant has no home team distinct from the one it acts in.
  return { ok: true, principal: result.principal, defaultTeamId: result.principal.teamId };
}

/**
 * The websocket handshake, as a `PrincipalRequest` (D19). The realtime token
 * arrives as the `ListenFireToken` subprotocol instead of a cookie — same claim,
 * same secret, shorter life — so it answers the session-cookie lookup and the
 * whole chain applies unchanged. Everything else (the team override, the
 * impersonation cookie) is read off the handshake's cookies exactly as it is
 * off a request's.
 */
function principalRequestFromWs(req: {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}): PrincipalRequest {
  const headers = req.headers ?? {};
  const subprotocol = headers['sec-websocket-protocol'];
  // Comma-separated, and the whitespace after the comma is the CLIENT's choice:
  // browsers send `", "`, node's `ws` sends `","`. Splitting on the two-character
  // form (as this parsing did) reads a token from one kind of client and nothing
  // from the other.
  const parts = (typeof subprotocol === 'string' ? subprotocol : '')
    .split(',')
    .map((part) => part.trim());
  const realtimeToken = parts[0] === REALTIME_SUBPROTOCOL ? parts[1] : undefined;

  const base = principalRequestFromExpress({
    method: 'GET',
    url: req.url ?? '/',
    headers,
  });

  return {
    ...base,
    cookie: (name: string) =>
      name === AUTH_COOKIE ? (realtimeToken ?? base.cookie(name)) : base.cookie(name),
  };
}

/** Authenticate a websocket handshake through the same provider as a request. */
async function authenticateWebsocket(req: {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}): Promise<CoreAuthOutcome> {
  const { mode, provider } = currentIdentity();
  if (mode === 'core') {
    return authenticateCore(principalRequestFromWs(req));
  }
  const result = await provider.authenticate(principalRequestFromWs(req));
  if (!result.ok) {
    return { ok: false, status: result.status, body: result.message };
  }
  return { ok: true, principal: result.principal, defaultTeamId: result.principal.teamId };
}

/**
 * Park the resolved Principal on the ambient Context. Since C-10 the Context
 * holds no identity of its own — it reads the ambient store — so this exists
 * for the ONE caller that establishes an identity outside that store: the
 * websocket's lazy `authorise`, which tRPC calls between messages and whose
 * result the protected procedure then makes ambient.
 */
function installContextIdentity(outcome: CoreAuthOutcome & { ok: true }): void {
  const { principal } = outcome;
  if (principal.userId === undefined) return;

  currentContext().bindPrincipal(principal);
}

/**
 * A full-access principal for work that has already resolved WHO it acts as
 * without going through a credential: a dev script, a worker, an inbound door
 * that authenticated its own channel. `access`/`scopes` are the widest,
 * because there is no narrower credential to read them from — the caller has
 * already decided this code may act.
 */
function userPrincipal(identity: {
  userId: string;
  teamId: string;
  access?: Access;
  pinnedTeamId?: string | null;
}): Principal {
  return {
    userId: identity.userId,
    teamId: identity.teamId,
    access: identity.access ?? 'write',
    scopes: ['*'],
    pinnedTeamId: identity.pinnedTeamId ?? null,
  };
}

/**
 * A product door resolved its own credential; core still applies the tail (the
 * acting-team membership gate, impersonation, the access level) so a door can
 * never mint an identity core would have refused. Doors are a core-mode concept
 * — a self-hoster on the static provider has one tenant and no team to gate.
 */
async function completeDoorAuthentication(
  resolved: ResolvedIdentity,
  req: Request,
): Promise<CoreAuthOutcome> {
  return completeAuthentication(resolved, principalRequestFromExpress(req));
}

export {
  authenticateRequest,
  authenticateWebsocket,
  completeDoorAuthentication,
  installContextIdentity,
  principalDirectory,
  principalProvider,
  userPrincipal,
};
