import expressWinston from 'express-winston';

import { logger } from 'movement-engine/public/log';
import { HEALTH_CHECK_ENDPOINT } from '../../constants';

/**
 * Logs request informat
 *
 * NOTE: the CF-Connecting-IP will list the real client IP since Render is behind Cloudflare
 */
const expressLogger = expressWinston.logger({
  transports: [logger],
  meta: true,
  colorize: true,
  msg: '{{req.get("CF-Connecting-IP")}} {{req.method}} {{res.statusCode}} {{req.url}} {{req.body.query?.split(" ")[0]}} {{req.body.operationName}}  {{res.responseTime}}ms',
  requestWhitelist: ['ip'],
  ignoredRoutes: [HEALTH_CHECK_ENDPOINT],
});

export { expressLogger };
