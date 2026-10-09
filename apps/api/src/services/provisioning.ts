// Account provisioning — the single source of truth for "everything a new
// team + admin user needs".
//
// Both the admin `createTeamWithAdmin` procedure and the self-serve signup
// bootstrap provision through here, so the two paths can never drift on which
// rows a fully-working account requires. The complete row set is:
//
//   1. team
//   2. pipeline_configuration (+ team.active_pipeline_configuration_id link)
//   3. user            — granted_access_at + completed_registration_at stamped
//   4. user_email       — primary email (the email -> user auth mapping)
//   5. team_membership  — admin ('write') access
//
// Written in Kysely (`getQb`), not the authorised Prisma client: that client's
// `team_membership.upsert` is a generated `notImplemented` stub, which is what
// broke the original self-serve signup. Self-serve layers its trial grant +
// waitlist flip on top of this; nothing account-shaped lives only there.

import type { TeamId } from '../generated/kysely/core/Team';
import type { UserId } from '../generated/kysely/core/User';
import type { PipelineConfigurationId } from '../generated/kysely/public/PipelineConfiguration';

import { getCoreQb, getQb } from '../lib/kysely';

export type ProvisionedTeam = {
  teamId: TeamId;
  pipelineConfigurationId: PipelineConfigurationId;
};

export type ProvisionedUser = {
  userId: UserId;
  username: string;
  email: string;
};

/**
 * Create a team and its active pipeline_configuration. No users — pair with
 * `provisionUser` to add admins.
 *
 * `id` pins the row instead of minting one, for an installation whose identity
 * was decided before its database existed — the self-hosted installer writes
 * one team id once and every unit reads it, so the team the operator signs in
 * to and the team the seeded data lands in are the same team.
 *
 * Pinning implies ADOPTING: a pinned id may already be a row, put there by an
 * earlier boot or by whatever seeded first, and minting a second team would
 * split the installation in two. So the existing row is taken as-is (its name
 * is left alone — renaming somebody's team is not provisioning), and only the
 * pieces it is missing are added.
 */
async function provisionTeam({
  name,
  id,
}: {
  name: string;
  id?: TeamId;
}): Promise<ProvisionedTeam> {
  const existingTeam =
    id === undefined
      ? undefined
      : await getCoreQb(['team'])
          .selectFrom('team')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst();

  const team =
    existingTeam ??
    (await getCoreQb(['team'])
      .insertInto('team')
      .values({ id, name })
      .returning('id')
      .executeTakeFirstOrThrow());

  // Read rather than assume: an adopted team already has a configuration, and
  // a second one would leave the team pointing at whichever was linked last.
  const existingConfiguration = await getQb(['pipeline_configuration'])
    .selectFrom('pipeline_configuration')
    .select('id')
    .where('team_id', '=', team.id)
    .executeTakeFirst();

  const pipelineConfiguration =
    existingConfiguration ??
    (await getQb(['pipeline_configuration'])
      .insertInto('pipeline_configuration')
      .values({ team_id: team.id, name })
      .returning('id')
      .executeTakeFirstOrThrow());

  await getCoreQb(['team'])
    .updateTable('team')
    .set({ active_pipeline_configuration_id: pipelineConfiguration.id })
    .where('id', '=', team.id)
    .execute();

  return { teamId: team.id, pipelineConfigurationId: pipelineConfiguration.id };
}

/**
 * Create a fully-formed user on an existing team: user (access granted +
 * registration complete) → primary user_email → team_membership. `username`
 * defaults to the email-local part.
 *
 * The FIRST user on a team is also flagged `is_billing_contact` on their primary
 * email — the account holder a team-wide notice should reach, as distinct from
 * later joiners.
 */
async function provisionUser({
  teamId,
  email,
  username,
  name,
  access = 'write',
  termsAccepted = false,
  personal = false,
}: {
  teamId: TeamId;
  email: string;
  username?: string;
  /** Human display name collected at signup (OAuth profile / form field). Stored
   *  on `user.name`; distinct from `username` (the email-local handle). */
  name?: string | null;
  access?: 'read' | 'write';
  /** Stamp `user.terms_accepted_at` — set by self-serve signup/login (which show
   *  the terms), left false for admin-provisioned accounts. */
  termsAccepted?: boolean;
  /** A team-of-one workspace vs a shared team → `team_membership.is_personal`,
   *  which is what `listTeams` reports. */
  personal?: boolean;
}): Promise<ProvisionedUser> {
  const lower = email.toLowerCase();
  const resolvedUsername = (username ?? lower.split('@')[0]).toLowerCase();
  const trimmedName = name?.trim() || null;
  const now = new Date();

  // First user on the team? (checked before inserting this user). The team
  // creator — personal signer or workspace founder — becomes the billing contact.
  const existingUser = await getCoreQb(['user'])
    .selectFrom('user')
    .select('id')
    .where('default_team_id', '=', teamId)
    .limit(1)
    .executeTakeFirst();
  const isFirstUser = !existingUser;

  const user = await getCoreQb(['user'])
    .insertInto('user')
    .values({
      default_team_id: teamId,
      username: resolvedUsername,
      name: trimmedName,
      is_platform_admin: false,
      granted_access_at: now,
      completed_registration_at: now,
      terms_accepted_at: termsAccepted ? now : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await getCoreQb(['user_email'])
    .insertInto('user_email')
    .values({ user_id: user.id, email: lower, is_primary: true, is_billing_contact: isFirstUser })
    .execute();

  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    .values({ user_id: user.id, team_id: teamId, access, is_personal: personal })
    .execute();

  return { userId: user.id, username: resolvedUsername, email: lower };
}

/**
 * Create a brand-new team with a single admin user and the full row set a
 * working account needs. Pure account scaffolding — no billing, no waitlist
 * side effects.
 */
async function provisionTeamWithAdmin({
  email,
  teamName,
  teamId: pinnedTeamId,
  username,
  name,
  termsAccepted = false,
  personal = false,
}: {
  email: string;
  teamName?: string;
  /** Pin the team's id instead of minting one — see `provisionTeam`. */
  teamId?: TeamId;
  username?: string;
  /** Human display name for the admin user — see provisionUser. Does not affect
   *  the team name (personal teams stay named after the email). */
  name?: string | null;
  /** Stamp the admin user's `terms_accepted_at` — true for self-serve signup. */
  termsAccepted?: boolean;
  /** A personal (team-of-one) workspace — see provisionUser. */
  personal?: boolean;
}): Promise<{ teamId: TeamId; userId: UserId; pipelineConfigurationId: PipelineConfigurationId }> {
  const lower = email.toLowerCase();
  const { teamId, pipelineConfigurationId } = await provisionTeam({
    name: teamName ?? lower,
    id: pinnedTeamId,
  });
  const { userId } = await provisionUser({
    teamId,
    email: lower,
    username,
    name,
    termsAccepted,
    personal,
  });
  return { teamId, userId, pipelineConfigurationId };
}

export const ProvisioningService = { provisionTeam, provisionUser, provisionTeamWithAdmin };
