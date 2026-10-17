// Who linked Telegram, for one team: the platform's record the `/start`
// handshake writes (`automations.telegram_identity`, handshake.ts), as the
// Telegram module reads it. Team-clamped — `UNIQUE(team_id, telegram_user_id)`
// makes a lookup exact, and a row owned by another team is invisible.

import type { LinkedIdentity, ModuleIdentities } from 'module-kit';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../../lib/kysely';

function linkedIdentity(row: { telegram_user_id: string; email: string; linked_at: Date | string }): LinkedIdentity {
  return {
    externalId: row.telegram_user_id,
    email: row.email,
    linkedAt: row.linked_at instanceof Date ? row.linked_at.toISOString() : String(row.linked_at),
  };
}

export function telegramIdentities(teamId: TeamId): ModuleIdentities {
  return {
    list: async () => {
      const rows = await getAutomationsQb(['telegram_identity'] as const)
        .selectFrom('telegram_identity')
        .where('team_id', '=', teamId as never)
        .select(['telegram_user_id', 'email', 'linked_at'])
        .orderBy('linked_at', 'asc')
        .execute();
      return rows.map(linkedIdentity);
    },
    find: async (externalId) => {
      const row = await getAutomationsQb(['telegram_identity'])
        .selectFrom('telegram_identity')
        .where('telegram_user_id', '=', externalId)
        .where('team_id', '=', teamId as unknown as string)
        .select(['telegram_user_id', 'email', 'linked_at'])
        .executeTakeFirst();
      return row === undefined ? null : linkedIdentity(row);
    },
  };
}
