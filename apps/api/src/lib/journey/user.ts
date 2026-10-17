import { sql } from 'kysely';

import type { UserId } from '../../generated/kysely/core/User';
import type { NewUserJourney, UserJourneyUpdate, UserJourneyUserId } from '../../generated/kysely/public/UserJourney';

import { getCoreQb, getQb } from '../kysely';
import { logger } from 'movement-engine/public/log';
import { emitOpsEventSafely } from './emit';
import { JOURNEY_LAUNCH_AT } from './cohort';
import OpsEventType from '../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../generated/kysely/public/OpsSeverity';
import { USER_MILESTONE_COLUMNS, UserMilestone, userMilestoneTitle } from './types';

/**
 * `user_journey` is keyed BY `user_id`, so once its foreign key into
 * `user` went (D3 — the identity family lives in `core` now) kanel branded
 * the column as that table's own id. One converter beats a cast per call site.
 */
function journeyKey(id: string): UserJourneyUserId {
  return id as unknown as UserJourneyUserId;
}


/**
 * Record a user journey milestone. Idempotent and safe to call on every
 * occurrence — the DB decides what's first.
 *
 * The single statement below is the whole design: ON CONFLICT ... DO UPDATE
 * ... WHERE <col> IS NULL matches nothing when the milestone is already set,
 * so RETURNING yields a row IFF this call was the transition. No read-then-
 * write race, and no call site ever asks "have we already recorded this?".
 *
 */
export async function recordUserMilestone(
  userId: string,
  options: { milestone: UserMilestone; teamId?: string | null; tool?: string },
): Promise<boolean> {
  const column = USER_MILESTONE_COLUMNS[options.milestone];

  // `values`/`updates` are typed against the generated Insertable/Updateable
  // shapes, so static keys (user_id, first_mcp_tool, updated_at) stay type-
  // checked — a typo there is a compile error. Only the milestone column
  // itself is dynamic (a closed const map, never user input); the `as never`
  // is confined to those two assignments rather than the whole object.
  const values = { user_id: journeyKey(userId) } as NewUserJourney;
  values[column] = sql`now()` as never;

  const updates = {} as UserJourneyUpdate;
  updates[column] = sql`now()` as never;
  updates.updated_at = sql`now()` as never;

  // first_mcp_tool MUST be in BOTH values and updates. In production the row
  // already exists by the time the first call lands (mcp_connected is recorded
  // at the OAuth grant), so this ALWAYS takes the UPDATE path — putting the
  // tool only in `values` leaves the column NULL for every real user while the
  // feed title still looks correct, because that title is built from the
  // in-memory arg. The WHERE below gates the whole update, so the tool can
  // never clobber an earlier one.
  if (options.milestone === 'first_mcp_call' && options.tool) {
    values.first_mcp_tool = options.tool;
    updates.first_mcp_tool = options.tool;
  }

  const row = await getQb(['user_journey'])
    .insertInto('user_journey')
    .values(values)
    .onConflict((oc) =>
      oc
        .column('user_id')
        .doUpdateSet(updates)
        .where(sql.ref(`user_journey.${column}`), 'is', null),
    )
    .returning('user_id')
    .executeTakeFirst();

  if (!row) return false;

  // The RECORD means "the first we observed"; the feed EVENT claims "their
  // first, ever" — true only for subjects we've watched since signup. A
  // pre-launch user's first real activity after deploy is not their actual
  // first, so record it (above, unconditionally) but only announce it when
  // the user's own signup falls inside the instrumented cohort. One extra
  // query, but only on a genuine transition (once per user per milestone,
  // ever).
  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .where('id', '=', userId as UserId)
    .select('created_at')
    .executeTakeFirst();

  if (user && user.created_at >= JOURNEY_LAUNCH_AT) {
    // The milestone is the record; the feed event is only the notification.
    // The transition is one-shot, so a throwing emit would lose the event
    // forever — swallow and log rather than propagate.
    await emitOpsEventSafely({
      type: OpsEventType.ONBOARDING,
      severity: OpsSeverity.info,
      teamId: options.teamId ?? null,
      title: userMilestoneTitle(options.milestone, options.tool),
      detail: { milestone: options.milestone, userId, tool: options.tool ?? null },
    });
  }

  logger.debug('journey milestone', { userId, milestone: options.milestone });
  return true;
}

export { journeyKey };
