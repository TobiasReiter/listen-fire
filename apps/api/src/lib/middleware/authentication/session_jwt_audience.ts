import { logger } from 'movement-engine/services/logger';

/**
 * The `audience` claim on our OWN self-signed HS256 session + realtime tokens.
 * There is no Auth0 and hasn't been for a long time, so the var is
 * `SESSION_JWT_AUDIENCE` — but its VALUE is baked into every live session
 * cookie and realtime token, so changing the value (not just the name)
 * signs everyone out at once. Hence accept-both: a deployment can carry the
 * legacy `AUTH0_AUDIENCE` through the rename and swap the key at its leisure,
 * as long as the value stays identical.
 *
 * Resolved once per process, so the legacy-name warning is logged once rather
 * than on every request that mints or verifies a token.
 */
let resolved: string | undefined;

function sessionJwtAudience(): string {
  if (resolved !== undefined) return resolved;

  const current = process.env.SESSION_JWT_AUDIENCE;
  if (current !== undefined) return (resolved = current);

  const legacy = process.env.AUTH0_AUDIENCE;
  if (legacy !== undefined) {
    logger.warn(
      'Resolved the session JWT audience from the legacy AUTH0_AUDIENCE variable. ' +
        'Rename it to SESSION_JWT_AUDIENCE, keeping the VALUE identical — changing the ' +
        'value invalidates every live session cookie and realtime token.',
    );
    return (resolved = legacy);
  }

  throw new Error(
    'The SESSION_JWT_AUDIENCE environment variable is required (legacy name: AUTH0_AUDIENCE). ' +
      'It is the audience claim on the session and realtime tokens this deployment signs; ' +
      'without it no one can log in.',
  );
}

export { sessionJwtAudience };
