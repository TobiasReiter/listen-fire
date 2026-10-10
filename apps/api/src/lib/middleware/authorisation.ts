import { RequestHandler } from 'express';
import { maybePrincipal } from 'principal';

import { authenticationDeferred } from './authentication';

// The access gate for the private surface.
//
// It used to re-read `core.user` and check `grantedAccessAt` — a second lookup
// that could only ever agree with the first, because the core provider's
// `completeAuthentication` applies exactly that gate before it hands back a
// principal at all. Worse, it reached the answer through `ctx.user.id`, which
// THROWS for a machine principal: an api-key or static-stub request has no
// user by design (D2 — "machine principals are the same type with no userId"),
// so every private request in a self-hosted deployment died here, and died
// invisibly, since express 4 does not catch an async middleware's rejection —
// the request simply never got a response.
//
// So the gate asks the identity layer instead of core's tables: a principal
// exists precisely when a provider admitted this request, and which provider
// that was is not this file's business. It stays as an explicit refusal rather
// than being deleted because "the private surface requires an established
// identity" is worth asserting where it is relied upon. The one exception is a
// request authentication deferred to a surface that authenticates its own
// callers; that surface's gate is the assertion there.
const authorisationHandler: RequestHandler = (req, res, next) => {
  if (maybePrincipal() === undefined && !authenticationDeferred(req)) {
    res.status(403).send();
    return;
  }
  next();
};

export { authorisationHandler };
