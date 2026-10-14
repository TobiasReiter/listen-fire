// Mint an automation API key for the dev-loop team, the way
// apps/api/src/scripts/dev/measure_authoring_loop.ts does. Prints KEY=<key>.
// Run from apps/api (see capture.sh) so its tsconfig paths and .env apply.
import '../../../../apps/api/src/scripts/dev/_profile_loader';
import '../../../../apps/api/src/services';
import { ApiKeyService } from '../../../../apps/api/src/services/api_key';
import { getCoreQb } from '../../../../apps/api/src/lib/kysely';

(async () => {
  const teamId = process.env.TEST_HARNESS_TEAM_ID;
  if (!teamId) throw new Error('TEST_HARNESS_TEAM_ID is unset; run `pnpm dev:seed` first');
  const [member] = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id'])
    .where('team_id', '=', teamId as never)
    .limit(1)
    .execute();
  const { key } = await ApiKeyService.createForOwner({
    name: `hero-demo-${Date.now()}`,
    scopes: ['*', 'automation'],
    teamId,
    createdBy: member?.user_id as unknown as string,
  });
  process.stdout.write(`KEY=${key}\n`);
  process.exit(0);
})();
