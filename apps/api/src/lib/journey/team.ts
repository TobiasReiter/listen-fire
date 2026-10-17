import { sql } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NewTeamJourney, TeamJourneyUpdate, TeamJourneyTeamId } from '../../generated/kysely/public/TeamJourney';

import { getCoreQb, getQb } from '../kysely';
import { logger } from 'movement-engine/public/log';
import { emitOpsEventSafely } from './emit';
import { JOURNEY_LAUNCH_AT } from './cohort';
import OpsEventType from '../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../generated/kysely/public/OpsSeverity';
import { TEAM_MILESTONE_COLUMNS, TeamMilestone, teamMilestoneTitle } from './types';

/**
 * `team_journey` is keyed BY `team_id`, so once its foreign key into
 * `team` went (D3 — the identity family lives in `core` now) kanel branded
 * the column as that table's own id. One converter beats a cast per call site.
 */
function journeyKey(id: string): TeamJourneyTeamId {
  return id as unknown as TeamJourneyTeamId;
}


/** Team-anchored twin of recordUserMilestone. Same transition contract. */
export async function recordTeamMilestone(
  teamId: string,
  options: { milestone: TeamMilestone },
): Promise<boolean> {
  const column = TEAM_MILESTONE_COLUMNS[options.milestone];

  // See user.ts for why the `as never` is confined to the dynamic-column
  // assignments rather than the whole object.
  const values = { team_id: journeyKey(teamId) } as NewTeamJourney;
  values[column] = sql`now()` as never;

  const updates = {} as TeamJourneyUpdate;
  updates[column] = sql`now()` as never;
  updates.updated_at = sql`now()` as never;

  const row = await getQb(['team_journey'])
    .insertInto('team_journey')
    .values(values)
    .onConflict((oc) =>
      oc
        .column('team_id')
        .doUpdateSet(updates)
        // This WHERE is the whole transition-detection design: without it,
        // ON CONFLICT always matches and re-fires the update (and the feed
        // event below) on every single call. Covered by the "is idempotent
        // per team" integration test — do not remove without replacing that
        // coverage.
        .where(sql.ref(`team_journey.${column}`), 'is', null),
    )
    .returning('team_id')
    .executeTakeFirst();

  if (!row) return false;

  // See user.ts: the RECORD means "the first we observed", the feed EVENT
  // claims "their first, ever" — only announce for teams created inside the
  // instrumented cohort.
  const team = await getCoreQb(['team'])
    .selectFrom('team')
    .where('id', '=', teamId as TeamId)
    .select('created_at')
    .executeTakeFirst();

  const title = teamMilestoneTitle(options.milestone);
  if (title && team && team.created_at >= JOURNEY_LAUNCH_AT) {
    await emitOpsEventSafely({
      type: OpsEventType.ONBOARDING,
      severity: OpsSeverity.info,
      teamId,
      title,
      detail: { milestone: options.milestone, teamId },
    });
  }

  logger.debug('team journey milestone', { teamId, milestone: options.milestone });
  return true;
}

export { journeyKey };
