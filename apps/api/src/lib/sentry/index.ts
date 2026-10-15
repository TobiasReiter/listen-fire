import * as Sentry from '@sentry/node';

import { HEALTH_CHECK_ENDPOINT, isProd } from '../../constants';
import { logger } from 'movement-engine/services/logger';

const environment = process.env.NODE_ENV ?? 'development';
const isDev = environment === 'development';

let sentryInitialized = false;

function initSentry(): void {
  if (sentryInitialized) {
    logger.info('Initializing Sentry after it has already been initialized');
    return;
  }

  Sentry.init({
    dsn: isDev ? undefined : process.env.SENTRY_DSN,
    environment,
    release: process.env.SENTRY_RELEASE,

    beforeSend: (event) => (isDev ? null : event),

    beforeSendTransaction: (event) =>
      event.request?.url?.endsWith(HEALTH_CHECK_ENDPOINT) === true ? null : event,

    ignoreErrors: [
      // Network errors that aren't actionable
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'socket hang up',
      // Client disconnected mid-request (e.g. Claude Code MCP closing SSE stream)
      /^aborted$/,
      // Prisma client known errors (constraint violations, timeouts) — handle in app code
      'PrismaClientKnownRequestError',
    ],

    tracesSampler: (samplingContext) => {
      if (isDev) return 0;

      const url = samplingContext.attributes?.['http.target'] as string | undefined;

      // Always drop health checks
      if (url?.endsWith(HEALTH_CHECK_ENDPOINT)) return 0;

      // In production, sample 5% of normal traffic
      if (isProd) return 0.05;

      // Staging/test: sample everything
      return 1;
    },
  });

  sentryInitialized = true;
}

function getSentry(): typeof Sentry {
  if (!sentryInitialized) {
    throw new Error('Sentry has not been initialized');
  }
  return Sentry;
}

export { getSentry, initSentry };
