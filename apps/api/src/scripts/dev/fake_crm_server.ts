/**
 * The durable dev-loop fake-CRM fixture.
 *
 *   pnpm dev:fake-crm
 *
 * Serves the fake CRM (`fake_crm_adapter.ts`) behind the remote-adapter wire
 * protocol on this profile's `FAKE_REMOTE_ADAPTER_PORT`, and stays up for the
 * life of the dev loop — `dev/loop.sh` starts it alongside fake-channels.
 *
 * Why durable: `acme_crm` is installed as a `remote_adapter` ROW, and a row
 * outlives the process that wrote it. When the server bound an ephemeral port,
 * every consumer of that row (the graph explorer) hit a dead
 * socket the moment the installing script exited. A profile-assigned port makes
 * the installed URL a standing promise instead of a snapshot, so the one remote
 * adapter in the loop is inspectable like every other system.
 *
 * The write ledger is in-memory and per-process: restarting the loop forgets
 * the Companies written to it, which is the same deal fake-channels offers.
 *
 * Its `/dev/` routes push `emit` / `wake` to this stack's API (`API_BASE_URL`),
 * naming the dev-loop team (`TEST_HARNESS_TEAM_ID`) in the team header.
 */
import './_profile_loader';

import {
  FAKE_CRM_ADAPTER_TYPE,
  FAKE_CRM_SECRET,
  fakeCrmPort,
  startFakeCrmServer,
} from './fake_crm_adapter';

async function main(): Promise<void> {
  const port = fakeCrmPort();
  const apiBaseUrl = process.env.API_BASE_URL;
  const teamId = process.env.TEST_HARNESS_TEAM_ID;
  const host = apiBaseUrl ? { apiBaseUrl, ...(teamId ? { teamId } : {}) } : undefined;
  const server = await startFakeCrmServer({ secret: FAKE_CRM_SECRET, port, ...(host ? { host } : {}) });
  console.log(`[fake-crm] '${FAKE_CRM_ADAPTER_TYPE}' listening at ${server.baseUrl}`);
  console.log(
    host
      ? `[fake-crm] pushes emit/wake to ${host.apiBaseUrl}${host.teamId ? ` (team ${host.teamId})` : ''}`
      : '[fake-crm] no API_BASE_URL — the /dev/ routes cannot push',
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
