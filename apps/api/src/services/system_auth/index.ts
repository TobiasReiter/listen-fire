// The system surface's door: which verifiers this deployment runs (from
// `SYSTEM_AUTH_MODES`), the boot check on their settings, and the express
// middleware the system router puts in front of every route.
//
// One thing reaches outside the router. The host's authentication runs before
// any router and refuses a credential it does not recognise, which is every
// credential but its own API key and session. So when a verifier other than the
// API key one is registered, the host lets a request to the surface that it
// refused go on to the surface, unauthenticated, and the verifiers decide
// (`defersToSystemCaller`). With the default mode nothing is deferred.

import type { Request, RequestHandler, Response } from 'express';

import { neverAsAny } from '../../lib/utils/types';
import { apiKeyVerifier } from './api_key';
import { createOidcVerifier } from './oidc';
import {
  identifySystemCaller,
  registerSystemCallerVerifier,
  registeredSystemCallerVerifiers,
  type HostCredential,
  type SystemAction,
  type SystemCaller,
  type SystemCallerRequest,
  type SystemCallerVerifier,
} from './verifier';

type Env = Record<string, string | undefined>;

const MODES_VAR = 'SYSTEM_AUTH_MODES';
const OIDC_ISSUER_VAR = 'SYSTEM_AUTH_OIDC_ISSUER';
const OIDC_AUDIENCE_VAR = 'SYSTEM_AUTH_OIDC_AUDIENCE';
const OIDC_ALLOWED_SUBJECTS_VAR = 'SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS';

const SYSTEM_SURFACE_PATH = '/api/v1/system';

type SystemAuthMode = 'api_key' | 'oidc';

interface OidcSettings {
  issuer: string;
  audience: string;
  allowedSubjects: string[];
}

type SystemAuthModeConfig = { mode: 'api_key' } | { mode: 'oidc'; oidc: OidcSettings };

interface SystemAuthConfig {
  modes: SystemAuthModeConfig[];
}

function listOf(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function isMode(raw: string): raw is SystemAuthMode {
  return raw === 'api_key' || raw === 'oidc';
}

function oidcSettings(env: Env): OidcSettings {
  const issuer = env[OIDC_ISSUER_VAR]?.trim() ?? '';
  const audience = env[OIDC_AUDIENCE_VAR]?.trim() ?? '';
  const allowedSubjects = listOf(env[OIDC_ALLOWED_SUBJECTS_VAR]);
  const missing = [
    ...(issuer === '' ? [OIDC_ISSUER_VAR] : []),
    ...(audience === '' ? [OIDC_AUDIENCE_VAR] : []),
    ...(allowedSubjects.length === 0 ? [OIDC_ALLOWED_SUBJECTS_VAR] : []),
  ];
  if (missing.length > 0) {
    throw new Error(`${MODES_VAR} names oidc, which needs ${missing.join(', ')}.`);
  }
  if (!URL.canParse(issuer)) throw new Error(`${OIDC_ISSUER_VAR} is "${issuer}", which is not a URL.`);
  const { protocol } = new URL(issuer);
  // The keys every token is checked against come from the issuer, so a plain
  // http one is a key anyone on the path can replace. Allowed off production,
  // where the dev loop's fake issuer runs.
  if (protocol !== 'https:' && !(protocol === 'http:' && env.NODE_ENV !== 'production')) {
    throw new Error(`${OIDC_ISSUER_VAR} must be an https URL (got "${issuer}").`);
  }
  return { issuer, audience, allowedSubjects };
}

/** The deployment's system caller settings; throws, naming the variable, on
 *  any it cannot run. Unset means the API key alone, as before. */
function systemAuthConfig(env: Env = process.env): SystemAuthConfig {
  const named = listOf(env[MODES_VAR]);
  const modes: SystemAuthModeConfig[] = [];
  for (const raw of named.length === 0 ? ['api_key'] : named) {
    if (!isMode(raw)) throw new Error(`${MODES_VAR} names "${raw}"; the modes are api_key and oidc.`);
    if (modes.some(({ mode }) => mode === raw)) continue;
    modes.push(raw === 'oidc' ? { mode: raw, oidc: oidcSettings(env) } : { mode: raw });
  }
  return { modes };
}

/** Checked with the server's other boot-time configuration: a mode named
 *  without its settings fails the boot rather than refusing every tick. The
 *  system router is mounted on every installation, so there is no product gate. */
function assertSystemAuthConfigured(env: Env = process.env): void {
  systemAuthConfig(env);
}

/** Registers the configured modes' verifiers, in the order they are named. An
 *  embedder's own go through `registerSystemCallerVerifier`, before or after. */
function installSystemCallerVerifiers(env: Env = process.env): void {
  for (const config of systemAuthConfig(env).modes) {
    switch (config.mode) {
      case 'api_key':
        registerSystemCallerVerifier(apiKeyVerifier);
        break;
      case 'oidc':
        registerSystemCallerVerifier(createOidcVerifier(config.oidc));
        break;
      default:
        neverAsAny(config);
    }
  }
}

/** The verifiers asked: the registered ones, or the API key alone when none
 *  were (a process composed without the boot step, as the router's tests are). */
function activeVerifiers(): readonly SystemCallerVerifier[] {
  const registered = registeredSystemCallerVerifiers();
  return registered.length === 0 ? [apiKeyVerifier] : registered;
}

function isSystemSurface(path: string): boolean {
  return path === SYSTEM_SURFACE_PATH || path.startsWith(`${SYSTEM_SURFACE_PATH}/`);
}

/** Whether the host's authentication should let a request it refused go on to
 *  the system surface for the verifiers to decide. */
function defersToSystemCaller(req: Pick<Request, 'path'>): boolean {
  return isSystemSurface(req.path) && activeVerifiers().some((verifier) => verifier !== apiKeyVerifier);
}

/** What the host's authentication left on `res.locals` for an API key. */
function hostCredentialOf(res: Response): HostCredential | undefined {
  const scopes: unknown = res.locals.apiKeyScopes;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return undefined;
  const id: unknown = res.locals.apiKeyId;
  return { scopes, ...(typeof id === 'string' ? { id } : {}) };
}

const callers = new WeakMap<Request, SystemCaller>();

/** The caller `requireSystemCaller` accepted for this request. */
function systemCallerOf(req: Request): SystemCaller | undefined {
  return callers.get(req);
}

function refusalMessage(refusals: readonly { verifier: string; reason: string }[]): string {
  if (refusals.length === 1) return refusals[0].reason;
  return refusals.map(({ verifier, reason }) => `${verifier}: ${reason}`).join('; ');
}

/** The gate in front of every system route: some verifier must accept the
 *  request, or it is refused 403 with each verifier's reason. */
function requireSystemCaller(): RequestHandler {
  return (req, res, next) => {
    const request: SystemCallerRequest = {
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      headers: req.headers,
    };
    const hostCredential = hostCredentialOf(res);
    if (hostCredential !== undefined) request.hostCredential = hostCredential;
    identifySystemCaller(request, { verifiers: activeVerifiers(), callerAddress: req.ip ?? 'unknown' }).then(
      (outcome) => {
        if (!outcome.ok) {
          res.status(403).json({ error: refusalMessage(outcome.refusals) });
          return;
        }
        callers.set(req, outcome.caller);
        next();
      },
      next,
    );
  };
}

/** A route that does one system action: the accepted caller must hold it. */
function requireSystemAction(action: SystemAction): RequestHandler {
  return (req, res, next) => {
    const caller = systemCallerOf(req);
    if (caller === undefined || !caller.actions.includes(action)) {
      res.status(403).json({ error: `this system caller may not ${action}` });
      return;
    }
    next();
  };
}

/** A route that acts in a tenant: only a caller whose credential the host
 *  verified has one (its key's owner), so another verifier's caller is refused
 *  here rather than failing on the missing tenant inside the route. */
function requireTenantCaller(): RequestHandler {
  return (_req, res, next) => {
    if (hostCredentialOf(res) === undefined) {
      res.status(403).json({ error: 'this route acts in a tenant: call it with an API key holding the system scope' });
      return;
    }
    next();
  };
}

export {
  MODES_VAR,
  OIDC_ALLOWED_SUBJECTS_VAR,
  OIDC_AUDIENCE_VAR,
  OIDC_ISSUER_VAR,
  assertSystemAuthConfigured,
  defersToSystemCaller,
  installSystemCallerVerifiers,
  requireSystemAction,
  requireSystemCaller,
  requireTenantCaller,
  systemAuthConfig,
  systemCallerOf,
  type SystemAuthConfig,
  type SystemAuthMode,
};
export { registerSystemCallerVerifier, type SystemCallerVerifier } from './verifier';
