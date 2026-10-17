import { RequestHandler } from 'express';

import { Context } from '../../services/context';
import { logger } from 'movement-engine/public/log';

/**
 * The client closing its own connection mid-request — a browser navigating
 * away, an MCP connector's long-lived SSE stream ending — surfaces here as
 * Node's own `ConnResetException` ({@link https://github.com/nodejs/node/blob/main/lib/_http_server.js}
 * `abortIncoming`), always with this message (the `interfaces/mcp/server.ts`
 * transport wrapper matches the same string). Routine, not a bug in the
 * request.
 */
function isClientAbort(err: unknown): boolean {
  return err instanceof Error && err.message === 'aborted';
}

const contextInjector: RequestHandler = (req, res, next) => {
  const ctx = new Context({ xRequestId: req.xRequestId, originId: req.xOriginId });
  ctx
    .run(() => {
      res.on('prefinish', () => ctx.end());
      req.on('error', (err) => ctx.error(err));

      next();
    })
    .catch((err) => {
      // `next()` above already handed this request to Express's own
      // downstream handling — by the time this settles there is nothing left
      // here to respond to, only to record. Previously this rethrew into a
      // floating (never awaited, never caught) promise, which is exactly an
      // unhandled rejection: every request whose client disconnected before
      // the Context closed — most visibly an MCP connector's SSE stream,
      // open for minutes — logged one in production.
      if (isClientAbort(err)) {
        logger.info('[context] client closed the connection', { xRequestId: ctx.id });
        return;
      }
      logger.error('[context] context run failed', {
        xRequestId: ctx.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
};

export { contextInjector, isClientAbort };
