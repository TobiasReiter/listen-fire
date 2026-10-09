// `listTeams` / `resolveTeam` for the core provider — the same decisions
// `interfaces/rest/v1/team_scope.ts` makes for the MCP surface today, taken
// against a Principal instead of the ambient Context, and raising
// `TeamScopeError` where that file raises `ToolTeamError` (same messages, same
// attached teams, so an agent caller recovers in one retry as before).
//
// Reads go through Kysely rather than `PermissionService`: membership is a
// two-column read, and core owns it (D15).

import { TeamScopeError, type Access, type Principal, type TeamRef } from 'principal';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb } from '../../lib/kysely';

interface Membership {
  teamId: string;
  access: Access;
  isPersonal: boolean;
}

async function membershipsOf(userId: string): Promise<Membership[]> {
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .where('user_id', '=', userId as UserId)
    .select(['team_id', 'access', 'is_personal'])
    .execute();

  return rows.map((row) => ({
    teamId: row.team_id,
    access: row.access === 'read' ? 'read' : 'write',
    isPersonal: row.is_personal,
  }));
}

/**
 * The access a principal has in a team, or `null` for none at all.
 *
 * Readonly membership in the acting team is what `read` means, derived where
 * the Principal is minted rather than in a later middleware.
 *
 * NO membership is not a lesser access, it is none: a user id paired with a
 * team they do not belong to gets `null`, and every caller refuses (D44b). The
 * `write` this used to return was the last echo of the home-team allowance —
 * invisible on the request path, where `resolveActingTeam` has already rejected
 * such a pair, and load-bearing in background work, where nothing else checks.
 *
 * A machine principal has no user to be a member. The system acting on its own
 * team IS what a machine principal means, so it keeps team-scoped write.
 */
async function accessFor({
  userId,
  teamId,
}: {
  userId?: string;
  teamId: string;
}): Promise<Access | null> {
  if (userId === undefined) return 'write';
  const inTeam = (await membershipsOf(userId)).filter((m) => m.teamId === teamId);
  if (inTeam.length === 0) return null;
  return inTeam.every((m) => m.access === 'read') ? 'read' : 'write';
}

async function teamNames(teamIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) return new Map();

  const rows = await getCoreQb(['team'])
    .selectFrom('team')
    .where(
      'id',
      'in',
      unique.map((id) => id as TeamId),
    )
    .select(['id', 'name'])
    .execute();

  return new Map(rows.map((row) => [row.id, row.name]));
}

async function teamRef(
  teamId: string,
  access: Access,
  isPersonal: boolean,
): Promise<TeamRef> {
  const names = await teamNames([teamId]);
  return { teamId, name: names.get(teamId) ?? teamId, access, isPersonal };
}

/** The one team a pinned or machine principal can act in. A machine principal
 *  has no memberships to span, so its own team is its whole world. */
async function singleTeamFor(p: Principal, userId: string | undefined): Promise<TeamRef> {
  const pinned = p.pinnedTeamId ?? p.teamId;
  const memberships = userId === undefined ? [] : await membershipsOf(userId);
  const membership = memberships.find((m) => m.teamId === pinned);
  // The access level is the principal's own, not a hardcoded 'write': a
  // read-only credential that lists its team as writable is a lie the caller
  // only discovers at the failed write.
  return teamRef(pinned, p.access, membership?.isPersonal ?? false);
}

/**
 * The teams this principal can act in: pinned (or machine) → just that team;
 * user-anchored → every team they are a member of.
 */
async function listTeamsFor(p: Principal): Promise<TeamRef[]> {
  const userId = p.userId;
  if (p.pinnedTeamId !== null || userId === undefined) {
    return [await singleTeamFor(p, userId)];
  }

  const memberships = await membershipsOf(userId);
  const names = await teamNames(memberships.map((m) => m.teamId));
  return memberships.map((m) => ({
    teamId: m.teamId,
    name: names.get(m.teamId) ?? m.teamId,
    access: m.access,
    isPersonal: m.isPersonal,
  }));
}

/**
 * The team a team-specific operation must run as.
 *
 *  - pinned (or machine): always that team; a divergent `requested` is rejected
 *    rather than honoured — the credential may not be escaped.
 *  - user-anchored + `requested`: allowed iff they are a member.
 *  - user-anchored + omitted: their single team if they have exactly one; with
 *    several, refuse and hand back the list, so the caller retries once instead
 *    of the write silently landing in the home team; with NONE, refuse outright
 *    — membership is the sole authority, so a user who belongs to nothing has
 *    nowhere to act (D44b/D45).
 */
async function resolveTeamFor(p: Principal, requested?: string): Promise<TeamRef> {
  const userId = p.userId;
  if (p.pinnedTeamId !== null || userId === undefined) {
    const pinned = p.pinnedTeamId ?? p.teamId;
    if (requested !== undefined && requested !== pinned) {
      throw new TeamScopeError(
        'This connection is scoped to a single team; remove the `team` argument (or pass that team).',
      );
    }
    return singleTeamFor(p, userId);
  }

  const memberships = await membershipsOf(userId);

  if (requested !== undefined) {
    const membership = memberships.find((m) => m.teamId === requested);
    if (membership === undefined) {
      throw new TeamScopeError(
        '`team` is not a team you can access. Call listTeams to see your teams.',
      );
    }
    return teamRef(requested, membership.access, membership.isPersonal);
  }

  if (memberships.length === 1) {
    const [only] = memberships;
    return teamRef(only.teamId, only.access, only.isPersonal);
  }

  if (memberships.length === 0) {
    // No membership rows at all is no team to act in — NOT the team the
    // credential happened to resolve as. That fallback was the last echo of the
    // home-team allowance D44b killed in `accessFor`, and an unreachable
    // unprincipled branch is exactly what a later refactor resurfaces (D45).
    throw new TeamScopeError(
      'You are not a member of any team, so there is nothing to act in. Ask a team admin to add you.',
      [],
    );
  }

  const names = await teamNames(memberships.map((m) => m.teamId));
  const teams: TeamRef[] = memberships.map((m) => ({
    teamId: m.teamId,
    name: names.get(m.teamId) ?? m.teamId,
    access: m.access,
    isPersonal: m.isPersonal,
  }));
  const inline = teams.map((t) => `${t.name} (${t.teamId})`).join('; ');
  throw new TeamScopeError(
    `You belong to ${memberships.length} teams — pass \`team\` to say which one to act in, then retry. Your teams: ${inline}.`,
    teams,
  );
}

export { accessFor, listTeamsFor, resolveTeamFor, membershipsOf, teamNames };
