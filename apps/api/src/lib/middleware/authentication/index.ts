// The authentication middleware: express in, ambient Principal out.
//
// The ~200-line if/else that used to live here is gone. Which credential a
// request carries is now `CorePrincipalProvider`'s question (core plan §4), and
// the branches core cannot answer — a Mailgun signature, a sender-keyed inbound
// address — are inbound DOORS the product that owns them supplies. What is left
// here is the express-shaped part nothing else can do: turn the answer into a
// request context (the ambient Principal, the Context's identity, the api-key
// facts on `res.locals`) and turn a refusal into a response.

import { RequestHandler, Request, Response } from 'express';
import { runWithPrincipalSync, type Principal } from 'principal';
import { ZodError } from 'zod';

import type { InboundDoor } from './doors';
import type { CoreAuthOutcome } from '../../../services/principal/core_provider';

import { currentContext } from '../../../services/context';
import {
  authenticateRequest,
  completeDoorAuthentication,
  installContextIdentity,
} from '../../../services/principal';
import { recordUserMilestone } from '../../journey';
import { logger } from 'movement-engine/public/log';

/** Everything a request needs to act as this principal. */
function installIdentity(req: Request, res: Response, outcome: CoreAuthOutcome & { ok: true }) {
  const { principal } = outcome;
  installContextIdentity(outcome);

  // The REST v1 routers' `requireScope` reads these. A session request has no
  // credential of its own, so it has no entry here — leaving those routes
  // api-key-only, exactly as before.
  if (principal.credentialId !== undefined) {
    res.locals.apiKeyId = principal.credentialId;
    res.locals.apiKeyScopes = principal.scopes;
  }

  recordFirstMcpCall(req, principal);
}

// First MCP call. Gated on the domain header so a plain REST hit with the same
// key doesn't count. Fire-and-forget: instrumentation never blocks a request.
//
// `credentialId && mcpDomain === 'automation'` is THE definition of "this is a
// genuine automation-MCP call" — both the milestone and the Context stash must
// agree on it. The cookie is checked before the api key, and `callLocalApi`
// (interfaces/mcp/server.ts) deliberately forwards both `Authorization` and
// `Cookie`, so a request that carries a session cookie takes the cookie branch
// and carries no credential even though `x-mcp-domain` is present. Stashing on
// the header alone (previously) let that request pass
// `journeyContext?.mcpDomain === 'automation'` in `saveMovement` and stamp
// `first_automation_saved` while `first_mcp_call` was never recorded — a
// non-monotonic user journey. Gating both consumers on the same condition
// closes that gap.
function recordFirstMcpCall(req: Request, principal: Principal) {
  const mcpDomain = req.get('x-mcp-domain');
  if (principal.credentialId === undefined || mcpDomain !== 'automation') return;
  if (principal.userId === undefined) return;

  currentContext().mcpDomain = mcpDomain;
  void recordUserMilestone(principal.userId, {
    milestone: 'first_mcp_call',
    teamId: principal.teamId,
    tool: req.get('x-mcp-tool') ?? undefined,
  }).catch((e) => logger.warn('journey: first_mcp_call record failed', { error: e }));
}

/** Requests whose refusal was deferred: they go on with no principal, to a
 *  surface that authenticates them itself. */
const deferredRequests = new WeakSet<Request>();

/** Whether this request's refusal was deferred (the access gate lets it by). */
function authenticationDeferred(req: Request): boolean {
  return deferredRequests.has(req);
}

function createAuthenticationHandler(options: {
  doors: readonly InboundDoor[];
  /**
   * A request this claims goes on, unauthenticated, when this funnel refuses
   * it: the surface it reaches has callers of its own whose credentials the
   * funnel does not know (the system surface's verifiers, services/system_auth).
   */
  defer?: (req: Request) => boolean;
}): RequestHandler {
  const { doors, defer } = options;

  const authenticate: RequestHandler = async (req, res, next) => {
    const door = doors.find((candidate) => candidate.matches(req));

    let outcome: CoreAuthOutcome;
    if (door !== undefined) {
      const identity = await door.authenticate(req, res);
      // The door answered the request itself (refused signature, accepted
      // no-op). Nothing further to authenticate.
      if (identity === null) return;
      outcome = await completeDoorAuthentication(identity, req);
    } else {
      outcome = await authenticateRequest(req);
    }

    if (!outcome.ok) {
      if (defer?.(req) === true) {
        deferredRequests.add(req);
        next();
        return;
      }
      res.status(outcome.status).send(outcome.body);
      return;
    }

    installIdentity(req, res, outcome);
    runWithPrincipalSync(outcome.principal, () => next());
  };

  // Express 4 does not catch async middleware rejections — without this wrapper
  // a throw anywhere in `authenticate` (e.g. an inbound door's payload
  // validation rejecting a malformed webhook) produces NO response at all: the
  // request hangs until the sender's timeout, and webhook providers then retry
  // the same bad payload indefinitely.
  return async function authenticationHandler(req, res, next) {
    try {
      await authenticate(req, res, next);
    } catch (err) {
      logger.error(`[auth] authentication handler threw for ${req.method} ${req.originalUrl}`, {
        error: err,
      });
      if (res.headersSent) return;
      if (err instanceof ZodError) {
        res.status(400).send({ error: { code: 400, message: 'Malformed request payload' } });
        return;
      }
      res.status(500).send({ error: { code: 500, message: 'Internal error' } });
    }
  };
}

export { authenticationDeferred, createAuthenticationHandler };
