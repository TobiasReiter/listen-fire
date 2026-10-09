/**
 * The dev loop's stand-in OpenID Connect issuer.
 *
 *   pnpm dev:fake-issuer
 *
 * Serves the fake issuer (`services/system_auth/__test__/fake_issuer.ts`) on
 * `FAKE_ISSUER_PORT`, for as long as the loop runs: `dev/loop.sh` starts it when
 * `SYSTEM_AUTH_MODES` names oidc under the push-tick shape, and the scheduler
 * mints each tick's token from its `/mint` endpoint. The key pair is generated
 * at start, so a restart invalidates every token minted before it.
 */
import { startFakeIssuer } from '../../services/system_auth/__test__/fake_issuer';

async function main(): Promise<void> {
  const port = Number(process.env.FAKE_ISSUER_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('FAKE_ISSUER_PORT must be a port number');
  const issuer = await startFakeIssuer({ port });
  console.log(`[fake-issuer] issuer ${issuer.url} (discovery, /jwks, /mint?sub=…&aud=…)`);
  const stop = () => {
    void issuer.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error('[fake-issuer] failed to start', error);
  process.exit(1);
});
