// This deployment's OAuth app at a provider, from the environment the
// connect flow reads, for a module line's `hostApp`.

import type { OAuth2ClientApp } from 'movement-engine/public/secrets';

export function oauthAppFromEnv(
  names: { clientId: string; clientSecret: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): OAuth2ClientApp | undefined {
  const clientId = env[names.clientId];
  const clientSecret = env[names.clientSecret];
  if (clientId === undefined || clientId === '' || clientSecret === undefined || clientSecret === '') return undefined;
  return { clientId, clientSecret };
}
