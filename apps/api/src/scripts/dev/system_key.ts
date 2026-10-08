/**
 * The dev loop's system-scope API key: what the push-tick shape's scheduler
 * and the API's own tick notifier authenticate the drain tick with.
 *
 *   pnpm dev:system-key        # prints the key's plaintext on the last line
 *
 * A key's plaintext exists only at mint, so the existing key cannot be printed
 * again: each call revokes the live `dev-loop-scheduler` key and mints its
 * replacement, leaving exactly one. Its owner is the dev-loop team, provisioned
 * as `dev:seed` does. `dev/loop.sh` calls it before the API boots, because the
 * API's tick notifier reads the key at boot.
 */
import './_profile_loader';

import { getCoreQb } from '../../lib/kysely';
import { ApiKeyService } from '../../services/api_key';
import { ensureDevLoopTeam } from './_lib';

const KEY_NAME = 'dev-loop-scheduler';

async function main(): Promise<void> {
  const seed = await ensureDevLoopTeam();
  await getCoreQb(['api_key'])
    .updateTable('api_key')
    .set({ revoked_at: new Date() })
    .where('name', '=', KEY_NAME)
    .where('revoked_at', 'is', null)
    .execute();
  const { key } = await ApiKeyService.createForOwner({
    name: KEY_NAME,
    scopes: ['system'],
    teamId: seed.teamId,
    createdBy: seed.userId,
  });
  console.log(key);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
