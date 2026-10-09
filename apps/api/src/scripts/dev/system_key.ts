/**
 * The dev loop's system-scope API key: what the push-tick shape's scheduler
 * and the API's own tick notifier authenticate the drain tick with.
 *
 *   pnpm dev:system-key        # prints the key's plaintext on the last line
 *
 * A key's plaintext exists only at mint, so the existing key cannot be printed
 * again: each call revokes the dev-loop team's live `dev-loop-scheduler` key
 * and mints its replacement, leaving exactly one. Its owner is the dev-loop
 * team, provisioned as `dev:seed` does. `dev/loop.sh` calls it before the API
 * boots, because the API's tick notifier reads the key at boot.
 */
import './_profile_loader';
import { ensureDevLoopTeam } from './_lib';
import { rotateSchedulerKey } from './lib/scheduler_key';

async function main(): Promise<void> {
  const seed = await ensureDevLoopTeam();
  console.log(await rotateSchedulerKey({ teamId: seed.teamId, userId: seed.userId }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
