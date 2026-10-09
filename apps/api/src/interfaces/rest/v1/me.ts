import { randomUUID } from "node:crypto";

import { Router, type RequestHandler, type Router as RouterType } from 'express';
import { maybePrincipal } from 'principal';

import { currentContext } from '../../../services/context';
import { catchingRoutes } from '../async_route';

function internalError(res: Parameters<RequestHandler>[1], err: unknown) {
  const traceId = randomUUID();
  console.error(`[me-api:${traceId}]`, err);
  return res.status(500).json({
    error: 'internal_error',
    message: 'An internal error occurred.',
    traceId,
  });
}

const route = catchingRoutes(internalError);

/**
 * The one v1 route the machine-principal sweep does NOT resolve by reading the
 * Principal: `/me` is a route ABOUT a person, so a caller with no person behind
 * it is not a caller whose tenant we should substitute — it is a caller this
 * route has nothing to describe.
 *
 * So a machine principal (an api key minted for a service, or the static
 * single-tenant stub a coreless deployment boots with, D2) gets a 404: the
 * resource genuinely does not exist for this credential. A 500 would report a
 * fault that isn't one, and reaching for `currentPrincipal().teamId` here would
 * answer a question nobody asked.
 *
 * The missing-ROW case answers the same way rather than throwing, which is the
 * case a self-hoster hits after setting the optional attribution variable
 * `LISTEN_FIRE_USER_ID`: there is an id, and — with no core identity product — no
 * `user` row anywhere for it to name.
 *
 */
const meHandler: RequestHandler = async (_req, res) => {
  const userId = maybePrincipal()?.userId;

  const user =
    userId === undefined
      ? null
      : await currentContext().prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            userEmails: { select: { email: true }, take: 1 },
          },
        });

  if (!user) {
    return res.status(404).json({
      error: 'not_found',
      message:
        userId === undefined
          ? 'This credential acts as a machine, not a person, so there is no user to describe.'
          : 'No user record exists for the id this credential acts as.',
    });
  }

  return res.json({
    id: user.id,
    name: user.username,
    email: user.userEmails[0]?.email ?? null,
  });
};

const meRouter: RouterType = Router();
meRouter.get('/me', route(meHandler));

export { meRouter };
