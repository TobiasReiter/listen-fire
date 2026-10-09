/**
 * The deploy check against the active dev-loop stack — the same check the
 * `migrate` one-shot runs on a real deployment (../deploy_check.ts).
 *
 *   pnpm deploy:check              # run it (a no-op if this release already ran)
 *   pnpm deploy:check --summary    # print the last run's summary
 *
 * To run it again on the same release, delete that release's row:
 *   DELETE FROM automations.deploy_check WHERE release_tag = 'dev';
 */
import './_profile_loader';
import { deployCheckMain } from '../deploy_check';

deployCheckMain()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
