// A firing always runs as somebody, inside its team.
//
// Every way a movement fires off a REQUEST inherits that request's Context —
// tRPC and REST get one from the auth middleware, the WhatsApp door builds its
// own, the dev CLIs wrap explicitly. The BACKGROUND workers (the cron
// scheduler, the pollers, the two resume workers, the callback firer) call
// straight in with none, and the services that scope themselves by the ambient
// identity then throw. The one that hurt is text persistence: every page a
// plugin fetches is stored through it, the plugin's catch turns the throw into
// a warning, and a scheduled movement quietly fetched nothing on every run.
//
// So the Context is established HERE, at the seam every firing passes through,
// rather than in each worker — a seventh worker cannot forget it.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { Context, unsafeCurrentContext } from '../../context';
import { runInSystemContext } from '../../context/utils';
import { userPrincipal } from '../../principal';
import { logger } from 'movement-engine/services/logger';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';

/**
 * Run one firing inside a Context bound to its team. A Context already in
 * scope is left alone: a request-driven firing must stay attributed to the
 * person who asked for it, never re-attributed to the listener's author.
 */
async function withFiringContext<T>(
  firing: { teamId: TeamId; triggerId: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (unsafeCurrentContext() !== undefined) return fn();

  let ctx: Context | undefined;
  try {
    const userId = await firingActor(firing);
    if (userId === undefined) {
      // Nobody to act as at all — an orphaned trigger, or a team with no
      // members left. Say so: the team-scoped reads inside the run will fail.
      logger.warn('[MovementEngine] firing has no user to act as — running system-scoped', {
        triggerId: firing.triggerId,
        teamId: firing.teamId,
      });
    } else {
      ctx = new Context();
      ctx.bindPrincipal(userPrincipal({ userId, teamId: firing.teamId as unknown as string }));
    }
  } catch (err) {
    // Establishing the identity must never be the thing that crashes a
    // dispatch — the firing's own error containment is INSIDE `fn`.
    logger.error('[MovementEngine] could not resolve the firing identity — running system-scoped', {
      triggerId: firing.triggerId,
      teamId: firing.teamId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return ctx === undefined ? runInSystemContext(fn) : ctx.runAsync(fn);
}

/**
 * Who a background firing acts as: the person who authored the listener, while
 * they are still on the team. Failing that, the team's longest-standing member
 * with write access — an authorless or inherited trigger still belongs to the
 * team, and the team is what scopes everything the run touches.
 */
async function firingActor(firing: {
  teamId: TeamId;
  triggerId: string;
}): Promise<string | undefined> {
  const trigger = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .select('created_by_user_id')
    .where('id', '=', firing.triggerId as TriggerId)
    .executeTakeFirst();
  return teamActor({
    teamId: firing.teamId,
    preferredUserId: (trigger?.created_by_user_id as unknown as string | null) ?? null,
  });
}

/** `preferredUserId` while they are still on the team, else the team's
 *  longest-standing member with write access. */
async function teamActor(input: {
  teamId: TeamId;
  preferredUserId: string | null;
}): Promise<string | undefined> {
  const members = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id', 'access'])
    .where('team_id', '=', input.teamId)
    .orderBy('created_at', 'asc')
    .execute();
  const preferred = input.preferredUserId;
  if (preferred !== null && members.some((m) => (m.user_id as unknown as string) === preferred)) {
    return preferred;
  }
  const fallback = members.find((m) => m.access === 'write') ?? members[0];
  return fallback === undefined ? undefined : (fallback.user_id as unknown as string);
}

/**
 * Background work on a team's automations that is not a firing — the deploy
 * check validating them — runs inside the team as the firing fallback's member,
 * for the reason a firing does: team-scoped services read the ambient identity.
 */
async function withTeamContext<T>(teamId: TeamId, fn: () => Promise<T>): Promise<T> {
  const userId = await teamActor({ teamId, preferredUserId: null });
  if (userId === undefined) return runInSystemContext(fn);
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId: teamId as unknown as string }));
  return ctx.runAsync(fn);
}

export { withFiringContext, withTeamContext };
