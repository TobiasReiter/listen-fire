import { initTRPC } from '@trpc/server';

import { logger } from 'movement-engine/services/logger';
import { UnmountedProduct } from './product_gate';

/**
 * `authorise` is the one thing the base context carries, and it is the seam
 * identity arrives through: a no-op over HTTP (express authenticated the
 * request and made the Principal ambient long before tRPC sees it), the real
 * credential chain over the websocket. It returns nothing on purpose — this
 * type is re-exported to the frontends through `packages/trpc`, and a
 * `Principal` in it would drag the identity package into every browser bundle.
 * The protected procedures read the identity it established instead; see
 * `procedures.ts`.
 */
const trpc = initTRPC.context<{ authorise: () => Promise<void> }>().create({
  errorFormatter: (opts) => {
    // Only genuine server faults belong at error level. Two kinds of client
    // error are expected churn rather than news, and log at debug: auth
    // failures (a stale WS cookie reconnecting every couple of seconds), and
    // the product gate refusing a procedure this deployment does not run —
    // which every page of a carved-up install provokes on purpose. Other
    // client errors (bad request, a genuine missing route) stay at warn.
    const routine =
      opts.error.code === 'UNAUTHORIZED' ||
      opts.error.code === 'FORBIDDEN' ||
      opts.error.cause instanceof UnmountedProduct;
    const level =
      opts.error.code === 'INTERNAL_SERVER_ERROR' ? 'error' : routine ? 'debug' : 'warn';
    logger[level](
      `tRPC ${opts.type} error on "${opts.path ?? '<no-path>'}": ${opts.error.message}`,
      opts.error,
    );
    return {
      ...opts.shape,
    };
  },
});

export { trpc };
