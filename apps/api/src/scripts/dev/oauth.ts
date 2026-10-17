/**
 * Dev-loop provisioning CLI for the OAuth refresh proof.
 *
 *   pnpm dev:oauth setup
 *
 * Signs a Dropbox credential in against the fake OAuth provider in
 * fake-channels (the real authorize redirect and code exchange) and saves one
 * movement, `oauth_refresh_proof`, whose manual run creates a folder in the fake
 * Dropbox with it. Then:
 *
 *   pnpm dev:inject oauth-expire          # stored token stale, provider refuses it
 *   pnpm dev:movement run oauth_refresh_proof
 *   pnpm dev:inspect oauth                # one refresh_token call, rotated tokens, stored credential
 *   pnpm dev:inspect dropbox              # (admin state) the uploaded file
 *
 * See docs/dev-loop.md, "Fake OAuth provider".
 */

import './_profile_loader';
import '../../services';

import { ensureDevLoopTeam } from './_lib';
import { ensureDevLoopDropboxCredential, DEV_LOOP_DROPBOX_CREDENTIAL_NAME } from './lib/dev_oauth';
import { saveMovement } from '../../services/translation_graph/movement/provision';

function proofFile(): string {
  return `
import { manual, dropbox } from adapters
import { \`${DEV_LOOP_DROPBOX_CREDENTIAL_NAME}\` } from credentials

runs = connect manual
drive = connect dropbox using \`${DEV_LOOP_DROPBOX_CREDENTIAL_NAME}\`

function oauth_refresh_proof(go: <runs-[:Invocation]->>) {
  write drive-[:Folders]-> {
    Name: "oauth-refresh-proof"
  }
}

listen to runs {} fire oauth_refresh_proof
`;
}

async function main() {
  const command = process.argv[2] ?? 'setup';
  if (command !== 'setup') {
    console.error(`Unknown command '${command}'. Use: setup`);
    process.exit(1);
  }
  const seed = await ensureDevLoopTeam();
  const credential = await ensureDevLoopDropboxCredential({ teamId: seed.teamId });
  const movement = await saveMovement({ teamId: seed.teamId, source: proofFile() });
  console.log(
    JSON.stringify(
      {
        ok: movement.ok,
        teamId: seed.teamId,
        credential,
        movement: movement.ok ? { name: movement.movementName } : { errors: movement.errors, diagnostics: movement.diagnostics },
        nextSteps: [
          'pnpm dev:inject oauth-expire',
          'pnpm dev:movement run oauth_refresh_proof',
          'pnpm dev:inspect oauth',
        ],
      },
      null,
      2,
    ),
  );
  if (!movement.ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
