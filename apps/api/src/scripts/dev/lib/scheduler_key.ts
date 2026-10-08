// The dev loop's system-scope key for the push-tick shape's scheduler and the
// API's own tick notifier (`pnpm dev:system-key`, ../system_key.ts).

import { getCoreQb } from '../../../lib/kysely';
import { ApiKeyService } from '../../../services/api_key';

export const SCHEDULER_KEY_NAME = 'dev-loop-scheduler';

/** Revoke this owner's live scheduler key and mint its replacement. A key's
 *  plaintext exists only at mint, so "the" key is whichever was minted last.
 *  Only this team's and this user's keys are touched: a same-named key
 *  anywhere else is someone else's. */
export async function rotateSchedulerKey(owner: { teamId: string; userId: string }): Promise<string> {
  const live = await getCoreQb(['api_key'])
    .selectFrom('api_key')
    .where('name', '=', SCHEDULER_KEY_NAME)
    .where('team_id', '=', owner.teamId as never)
    .where('created_by', '=', owner.userId as never)
    .where('revoked_at', 'is', null)
    .select(['id'])
    .execute();
  for (const { id } of live) await ApiKeyService.revokeById(id);
  const { key } = await ApiKeyService.createForOwner({
    name: SCHEDULER_KEY_NAME,
    scopes: ['system'],
    teamId: owner.teamId,
    createdBy: owner.userId,
  });
  return key;
}
