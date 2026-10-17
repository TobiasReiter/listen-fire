/**
 * Dev-loop e2e harness for a user-supplied "remote" adapter (a homespun CRM).
 *
 *   pnpm dev:remote-verify
 *
 * Prerequisites: the dev loop must be free (this holds no server of its own —
 * it runs a movement through the SAME dispatch path the API uses) and the
 * dev-loop team must be seeded (`pnpm dev:seed`). See REMOTE_ADAPTER_VERIFY.md.
 *
 * What it proves, end to end:
 *   1. an in-process fake CRM served behind the wire protocol (port 0);
 *   2. a `remote_adapter` row installed for the dev-loop team pointing at it,
 *      with a matching credential row holding the bearer secret;
 *   3. a movement that constructs `acme_crm()` and, on a manual invocation,
 *      writes a `Company` to it;
 *   4. `runMovementNow` firing that movement — and the write actually landing
 *      in the fake CRM's in-memory ledger over real HTTP.
 *
 * This is the write-target mirror of `dev:movement`: same `ensureDevLoopTeam`
 * + `saveMovement` + `runMovementNow` spine, with the remote-adapter install +
 * credential provisioning added.
 */

import './_profile_loader';
// Register the same service adapters the API server boots so the movement
// engine's dispatch path (and remote-adapter resolution) runs for real.
import '../../services';

import type { TeamId } from '../../generated/kysely/core/Team';

import { ensureDevLoopRemoteAdapter, ensureDevLoopTeam } from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';
import { runMovementNow } from '../../services/translation_graph/movement/run_now';
import { installRemoteAdapterFromManifest } from '../../services/translation_graph/adapters/remote/install';
import {
  FAKE_CRM_ADAPTER_TYPE,
  FAKE_CRM_SECRET,
  fakeCrmManifest,
  startFakeCrmServer,
} from './fake_crm_adapter';

/** The manual-invoked movement: construct `acme_crm`, and on a Run-now write a
 *  Company to it. Every name is the adapter's natural name (its displayName),
 *  resolved to the remote server's internal id at the wire boundary. */
const REMOTE_MOVEMENT = `
import { manual, acme_crm } from adapters
crm = connect acme_crm
runs = connect manual
function push_company(go: <runs-[:Invocation]->>) {
  write crm-[:Company]-> { Name: "Vireo Robotics" }
}
listen to runs {} fire push_company
`;

async function main(): Promise<void> {
  // 1. Stand up the fake CRM behind the wire protocol. This harness keeps its
  //    OWN ephemeral (port 0) server rather than leaning on the loop's durable
  //    fixture, so it proves the whole install→dispatch→wire path from nothing
  //    and needs no fixture to be running. The install it writes therefore
  //    points somewhere that dies with this process — see the `finally`.
  const server = await startFakeCrmServer({ secret: FAKE_CRM_SECRET });
  console.log(`[remote-verify] fake CRM listening at ${server.baseUrl}`);

  let seeded: { teamId: string; userId: string } | null = null;
  try {
    // 2. Ensure the dev-loop team exists.
    const seed = await ensureDevLoopTeam();
    const teamId = seed.teamId as TeamId;
    seeded = { teamId: seed.teamId, userId: seed.userId };

    // 3. Install the remote adapter AND provision its secret in one step — the
    //    real one-step flow: the manifest carries no credential, the secret is
    //    minted into an encrypted REMOTE credential (app_id = slug) and linked.
    const install = await installRemoteAdapterFromManifest({
      teamId,
      userId: seed.userId as never,
      manifest: fakeCrmManifest(server.baseUrl),
      secret: FAKE_CRM_SECRET,
    });
    console.log(
      `[remote-verify] installed remote adapter '${FAKE_CRM_ADAPTER_TYPE}' + minted its REMOTE credential (${install.credentialsId})`,
    );

    // 5. Save the movement (same path the editor uses).
    const saved = await saveMovement({ teamId, source: REMOTE_MOVEMENT });
    if (!saved.movementId || !saved.ok) {
      console.error('[remote-verify] FAIL — movement did not save live:');
      console.error(JSON.stringify(saved, null, 2));
      process.exitCode = 1;
      return;
    }

    // 6. Fire it through normal dispatch.
    const run = await runMovementNow({
      teamId,
      movementId: saved.movementId,
      actor: { email: 'dev-loop@example.com', name: 'Dev Loop' },
    });

    // 7. Assert the write landed in the fake CRM.
    const wrote = server.writes.find((w) => w.fields.Name === 'Vireo Robotics');
    const ok = run.ok && !!wrote;

    console.log(JSON.stringify({ run, fakeCrmWrites: server.writes }, null, 2));
    if (ok) {
      console.log(`[remote-verify] PASS — Company reached the fake CRM (recordCount=${run.ok ? run.recordCount : 0})`);
    } else {
      console.error('[remote-verify] FAIL — the Company write did not reach the fake CRM');
      process.exitCode = 1;
    }
  } finally {
    await server.close();
    // Hand `acme_crm` back to the durable fixture. Without this, the row this
    // run installed would keep naming the ephemeral port it just closed — the
    // exact staleness that made `acme_crm` uninspectable in the graph explorer.
    if (seeded) {
      const { baseUrl } = await ensureDevLoopRemoteAdapter(seeded);
      console.log(`[remote-verify] restored the durable '${FAKE_CRM_ADAPTER_TYPE}' install → ${baseUrl}`);
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
