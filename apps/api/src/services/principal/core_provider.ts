// `CorePrincipalProvider` — core's implementation of the identity contract
// (core plan §3/§4). This IS the credential funnel: cookie session JWT → api
// key → the public identity, then the shared tail (impersonation overlay,
// acting-team resolution, access level). The express middleware that used to
// hold this if/else now only turns the answer into a request context.
//
// Two things follow from the provider being the source rather than a shim
// derived after the fact. First, there is one chain instead of two that can
// disagree. Second, the express-specific bits — `res.locals`, `req.*`, the
// journey milestone — are the CALLER's business: everything here reads a
// `PrincipalRequest` (a header lookup and a cookie lookup), which is also what
// a websocket handshake and a remote `POST /internal/principal/resolve` can
// answer.
//
// Product-owned inbound doors (an email callback, a webhook signature) do NOT
// live here. They resolve their own credential and hand the identity back
// through `completeAuthentication`, so they share this file's tail — the
// membership gate on the acting team is applied to them identically.

import type {
  Principal,
  PrincipalProvider,
  PrincipalRequest,
  PrincipalResult,
} from 'principal';

import { AUTH_COOKIE, IMPERSONATE_COOKIE } from '../../constants';
import { getEnvVar } from '../../lib/utils/environment';
import { unauthorisedGetUserById } from '../../lib/middleware/authentication/identify_user';
import { getCookieAuthUser } from '../../lib/middleware/authentication/token';
import { resolveActingTeam } from '../../lib/middleware/authentication/resolve_acting_team';
import { API_KEY_PREFIX, ApiKeyService } from '../api_key';
import { logger } from 'movement-engine/public/log';
import { accessFor, listTeamsFor, resolveTeamFor } from './core_teams';

/** A session-authenticated request carries the user's whole surface; only an
 *  api key narrows it, and only to the scopes minted on that key. */
const FULL_SCOPES: readonly string[] = ['*'];

/**
 * What a credential resolved to, before the shared tail runs. A product door
 * produces one of these too — `requestedTeamId` is how it says which team its
 * credential decided, and it goes through the same membership gate as a
 * client-supplied `x-request-team-id`.
 */
interface ResolvedIdentity {
  userId: string;
  apiKey?: { id: string; teamId: string | null; scopes: readonly string[] };
  requestedTeamId?: string | null;
  /** The `/public/` + `NO_AUTH_` identity: client team overrides are ignored,
   *  because a browser that has ever signed in carries the team cookie and
   *  PUBLIC_USER is a member of nothing. */
  isPublic?: boolean;
}

/**
 * The refusal shape the express funnel needs: today's exact status codes and
 * bodies, which the `PrincipalResult` contract (401/403 + message) cannot all
 * express. `authenticate()` maps them onto the contract for callers that only
 * speak it.
 */
interface CoreRefusal {
  status: number;
  body?: unknown;
}

interface CoreAuthSuccess {
  ok: true;
  principal: Principal;
  /** Core-internal facts the composed Context still carries: the user's home
   *  team is a preference, not authorization (C-6), so it is not on the
   *  Principal — but `ctx.user.defaultTeamId` is still read across the app. */
  defaultTeamId: string;
}

type CoreAuthOutcome = CoreAuthSuccess | ({ ok: false } & CoreRefusal);

const refuse = (status: number, body?: unknown): CoreAuthOutcome => ({ ok: false, status, body });

const errorBody = (code: number, message: string) => ({ error: { code, message } });

function apiKeyFromRequest(req: PrincipalRequest): string | null {
  const authHeader = req.header('authorization');
  if (authHeader?.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
    return authHeader.slice(7);
  }
  const apiKeyHeader = req.header('x-api-key');
  if (apiKeyHeader?.startsWith(API_KEY_PREFIX)) {
    return apiKeyHeader;
  }
  return null;
}

const isPublicUrl = (url: string) =>
  url.includes('/public/') || /\/api\/trpc(\/|\/.*\.)NO_AUTH_/.test(url);

/** The team the client asked to act as: the header, or the cookie the browser
 *  keeps in step with it. The literal string `"undefined"` is a client that
 *  stringified a missing value, not a team id — it has always been ignored, and
 *  honouring it would 403 the request against a team that cannot exist. */
function requestedTeamFromClient(req: PrincipalRequest): string | null {
  const requested = req.header('x-request-team-id') ?? req.cookie('listen_fire_team_id');
  if (requested === undefined || requested === '' || requested === 'undefined') return null;
  return requested;
}

/** Which credential this request carries, or a refusal. */
async function resolveCredential(req: PrincipalRequest): Promise<ResolvedIdentity | CoreRefusal> {
  if (isPublicUrl(req.url)) {
    return { userId: getEnvVar('PUBLIC_USER_ID'), isPublic: true };
  }

  const cookie = req.cookie(AUTH_COOKIE);
  if (cookie) {
    try {
      const user = await getCookieAuthUser(cookie);
      return { userId: user.id };
    } catch (e) {
      // Log the real cause server-side (the client only ever sees the generic
      // message, so we don't leak auth internals) — a verified token whose user
      // lookup fails (e.g. missing user_email / no granted access) otherwise
      // surfaces as an indistinguishable "expired session".
      logger.warn(
        `[auth] cookie session rejected: ${(e as Error)?.name} - ${(e as Error)?.message}`,
      );
      return { status: 401, body: errorBody(401, 'Invalid or expired session') };
    }
  }

  const key = apiKeyFromRequest(req);
  if (key !== null) {
    const result = await ApiKeyService.validateKey(key);
    if (!result.valid) {
      return { status: 401, body: errorBody(401, 'Invalid API key') };
    }
    return {
      userId: result.apiKey.userId,
      apiKey: {
        id: result.apiKey.id,
        teamId: result.apiKey.teamId,
        scopes: result.apiKey.scopes,
      },
    };
  }

  // No recognised credential. A bare 403 with no body, as it has always been.
  return { status: 403 };
}

/**
 * The shared tail: impersonation overlay → acting-team resolution → access.
 * Exported because product doors resolve their own credential and then join
 * here — the membership gate must not have a second implementation.
 */
async function completeAuthentication(
  identity: ResolvedIdentity,
  req: PrincipalRequest,
): Promise<CoreAuthOutcome> {
  let user;
  try {
    user = await unauthorisedGetUserById(identity.userId);
  } catch (e) {
    // The credential checked out and named a user this database does not have
    // (or has not granted access to). The caller still gets the generic 401 —
    // it must not learn which — but this is a DEPLOYMENT fault, not a stale
    // session, and it says so here: a missing `PUBLIC_USER_ID` row silently
    // reading as "your session expired" is exactly how an unprovisioned
    // install looks like a user problem.
    logger.warn(
      `[auth] credential resolved to a user this install cannot serve: ${identity.userId}` +
        `${identity.isPublic === true ? ' (the PUBLIC_USER_ID identity)' : ''} — ` +
        `${(e as Error)?.name}: ${(e as Error)?.message}`,
    );
    return refuse(401, errorBody(401, 'Invalid or expired session'));
  }

  // Impersonation: a platform admin carrying the impersonation cookie acts as
  // the target user for this request.
  const impersonateUserId = req.cookie(IMPERSONATE_COOKIE);
  if (impersonateUserId && user.isPlatformAdmin) {
    try {
      user = await unauthorisedGetUserById(impersonateUserId);
    } catch {
      return refuse(400, errorBody(400, 'Impersonation target not found'));
    }
  }

  const apiKeyTeamId = identity.apiKey?.teamId ?? null;
  const requestedTeamId = identity.isPublic
    ? null
    : (identity.requestedTeamId ?? requestedTeamFromClient(req));

  const resolution = await resolveActingTeam({
    userId: user.id,
    defaultTeamId: user.defaultTeamId,
    apiKeyTeamId,
    xRequestTeamId: requestedTeamId,
  });
  if (!resolution.ok) {
    return refuse(resolution.status, errorBody(resolution.status, resolution.message));
  }

  const access = await accessFor({ userId: user.id, teamId: resolution.teamId });
  if (access === null) {
    // `resolveActingTeam` has already refused this pair, so reaching here means
    // the membership vanished between the two reads. Refusing rather than
    // defaulting is the point: there is no path where a missing membership
    // means write (D44b).
    return refuse(403, errorBody(403, 'The requested team is not one you have access to.'));
  }

  return {
    ok: true,
    defaultTeamId: user.defaultTeamId,
    principal: {
      teamId: resolution.teamId,
      userId: user.id,
      access,
      scopes: identity.apiKey?.scopes ?? FULL_SCOPES,
      // The key's own pin (null when user-anchored). Non-api-key requests are
      // never pinned.
      pinnedTeamId: apiKeyTeamId,
      credentialId: identity.apiKey?.id,
    },
  };
}

/** The whole core chain: credential, then tail. */
async function authenticateCore(req: PrincipalRequest): Promise<CoreAuthOutcome> {
  const credential = await resolveCredential(req);
  if (!('userId' in credential)) {
    return { ok: false, ...credential };
  }
  return completeAuthentication(credential, req);
}

/** The human-readable half of a refusal, for callers that answer with a
 *  message rather than a body (the websocket's TRPCError). */
function refusalMessage(outcome: CoreAuthOutcome): string {
  if (outcome.ok) return '';
  const body = outcome.body;
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { message } = (body as { error: { message?: string } }).error;
    if (message !== undefined) return message;
  }
  return 'Unauthenticated';
}

/** The contract's 401/403 vocabulary. The one refusal that is neither (a
 *  malformed impersonation cookie, 400 on the express path) reads as a refusal
 *  to a contract caller. */
function toPrincipalResult(outcome: CoreAuthOutcome): PrincipalResult {
  if (outcome.ok) return { ok: true, principal: outcome.principal };
  return {
    ok: false,
    status: outcome.status === 401 ? 401 : 403,
    message: refusalMessage(outcome),
  };
}

function createCorePrincipalProvider(): PrincipalProvider {
  return {
    async authenticate(req: PrincipalRequest): Promise<PrincipalResult> {
      return toPrincipalResult(await authenticateCore(req));
    },
    listTeams: listTeamsFor,
    resolveTeam: resolveTeamFor,
  };
}

export {
  type CoreAuthOutcome,
  type ResolvedIdentity,
  authenticateCore,
  completeAuthentication,
  createCorePrincipalProvider,
  refusalMessage,
};
