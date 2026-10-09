// The membership question, asked from the WhatsApp doors. Both of them run
// outside any Context — the inbound webhook builds its own — so
// `PermissionService.hasAccess`, which reads the ambient Context's client, is
// not available to them; this is the same `team_membership` read against the
// global connection.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb } from '../../lib/kysely';

/** Whether a `team_membership(user_id, team_id)` row exists — the sole
 *  authority on where a person may act (C-6/D20). */
async function isTeamMember(userId: string, teamId: string): Promise<boolean> {
  const row = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .where('user_id', '=', userId as UserId)
    .where('team_id', '=', teamId as TeamId)
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

export { isTeamMember };
