// Core's `Directory` (D16, reshaped by D22 then D28): the human contact facts
// an opaque Principal can't supply, read straight off `user` / `user_email` /
// `team_membership`.
//
// Every lookup is team-scoped, and a person outside the team is NOT a person
// with `hasAccess: false` — they are `null`. The two answers say different
// things: `null` means "nobody by that identity belongs to this team", while
// `hasAccess: false` means "we know them, and they may not act". Collapsing
// them is how a flat lookup silently admits an ungranted user (D28).
//
// Membership has exactly one arm: a `team_membership` row. `default_team_id` is
// a landing preference and never admits anybody (C-6) — the backfill gave every
// home team a real membership row, so the arm that used to read it would now
// only ever admit people who are NOT members.

import type { Directory, DirectoryTeamAssociation, DirectoryUser } from 'principal';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb } from '../../lib/kysely';

interface PersonRow {
  id: UserId;
  name: string | null;
  username: string;
  granted_access_at: Date | null;
  email: string | null;
}

function toDirectoryUser(row: PersonRow): DirectoryUser {
  return {
    id: row.id,
    email: row.email ?? undefined,
    displayName: row.name ?? row.username,
    // Membership put them in the team; activation says whether they may act.
    hasAccess: row.granted_access_at !== null,
  };
}

/** The team's members, each with their primary email. One shape for all four
 *  lookups so they cannot drift apart. */
function teamPeople(teamId: string) {
  return getCoreQb(['user', 'user_email', 'team_membership'])
    .selectFrom('user as u')
    .innerJoin('team_membership as m', (join) =>
      join.onRef('m.user_id', '=', 'u.id').on('m.team_id', '=', teamId as TeamId),
    )
    .leftJoin('user_email as ue', (join) =>
      join.onRef('ue.user_id', '=', 'u.id').on('ue.is_primary', '=', true),
    )
    .select(['u.id', 'u.name', 'u.username', 'u.granted_access_at', 'ue.email']);
}

const coreDirectory: Directory = {
  async userById({ id, teamId }): Promise<DirectoryUser | null> {
    const row = await teamPeople(teamId)
      .where('u.id', '=', id as UserId)
      .executeTakeFirst();
    return row === undefined ? null : toDirectoryUser(row);
  },

  async userByEmail({ email, teamId }): Promise<DirectoryUser | null> {
    // Exact match on the trimmed, lower-cased address — the same normalisation
    // every existing email→user resolver applies (`lookupTeamUserByEmail`).
    // Plus-addressing is deliberately not retried here: that second pass is
    // opt-in per `user_email` row, and D23 deletes the columns it reads.
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes('@')) return null;

    const row = await teamPeople(teamId)
      .innerJoin('user_email as match', 'match.user_id', 'u.id')
      .where('match.email', '=', normalized)
      .executeTakeFirst();
    return row === undefined ? null : toDirectoryUser(row);
  },

  async members(teamId): Promise<DirectoryUser[]> {
    const rows = await teamPeople(teamId).orderBy('u.username').execute();
    return rows.map(toDirectoryUser);
  },

  async team(id): Promise<{ id: string; name: string } | null> {
    const row = await getCoreQb(['team'])
      .selectFrom('team')
      .where('id', '=', id as TeamId)
      .select(['id', 'name'])
      .executeTakeFirst();
    return row === undefined ? null : { id: row.id, name: row.name };
  },

  async teamsForEmail(email): Promise<DirectoryTeamAssociation[]> {
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes('@')) return [];

    // Memberships only. The home team used to be unioned in here because
    // acting-team resolution honoured it without a membership row; after C-6's
    // backfill it IS a membership, so that arm would only add associations for
    // people who are not members of the team it names.
    const rows = await getCoreQb(['user', 'user_email', 'team_membership'])
      .selectFrom('user_email as ue')
      .innerJoin('user as u', 'u.id', 'ue.user_id')
      .innerJoin('team_membership as m', 'm.user_id', 'u.id')
      .where('ue.email', '=', normalized)
      .select(['u.id as user_id', 'm.team_id as team_id'])
      .execute();

    const associations: DirectoryTeamAssociation[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.user_id} ${row.team_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      associations.push({ userId: row.user_id, teamId: row.team_id });
    }
    return associations;
  },
};

export { coreDirectory };
