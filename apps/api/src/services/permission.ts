import * as db from '@prisma/client';

import type { UserId } from '../generated/kysely/core/User';
import type { TeamId } from '../generated/kysely/core/Team';

import { currentContext } from './context';
import { getCoreQb } from '../lib/kysely';

/**
 * Flat team-membership access. `team_membership(user_id, team_id, access)` is
 * the single source of truth for which teams a user can act in and at what
 * level ('read' | 'write'). It replaced the legacy
 * user_role -> role -> role_permission -> permission RBAC chain.
 */
class Permission {
  /**
   * Grant (or upgrade) a user's membership of a team. Idempotent on
   * (user_id, team_id): inserts the row, or updates `access` if one exists.
   *
   * Written in Kysely, not the authorised Prisma client: that client's
   * `team_membership.upsert` is a generated `notImplemented` stub (see
   * generated/casl), so the Prisma path threw "not implemented" in every
   * authorised context — breaking invite-based account creation and any
   * membership grant. Conflict target is the `(user_id, team_id)` unique
   * index (`team_membership_user_id_team_id_key`).
   */
  async grantMembership({
    userId,
    teamId,
    access,
  }: {
    userId: string;
    teamId: string;
    access: 'read' | 'write';
  }): Promise<db.TeamMembership> {
    const row = await getCoreQb(['team_membership'])
      .insertInto('team_membership')
      .values({ user_id: userId as UserId, team_id: teamId as TeamId, access })
      .onConflict((oc) => oc.columns(['user_id', 'team_id']).doUpdateSet({ access }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      userId: row.user_id,
      teamId: row.team_id,
      access: row.access,
      isPersonal: row.is_personal,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /** The user's flat team memberships — the source of truth for which teams an
   *  identity may act in. */
  async getMemberships(userId: string): Promise<db.TeamMembership[]> {
    const ctx = currentContext();

    return ctx.prisma.teamMembership.findMany({
      where: { userId },
    });
  }

  /**
   * Whether the user has a `team_membership` row for the given team — the
   * single membership check used by the auth-resolution seam to validate a
   * candidate acting team. Read unauthorised: it gates the very context the
   * authorised client would need to query through.
   *
   * Note: a user's home team (`user.team_id`) is always allowed by the seam
   * regardless of this check — that allowance is the seam's responsibility,
   * not this method's. This answers only "is there a membership row".
   */
  async hasAccess(userId: string, teamId: string): Promise<boolean> {
    const ctx = currentContext();

    const row = await ctx.prisma.teamMembership.findFirst({
      where: { userId, teamId },
      select: { id: true },
    });

    return row !== null;
  }
}

const PermissionService = new Permission();

export { PermissionService };
