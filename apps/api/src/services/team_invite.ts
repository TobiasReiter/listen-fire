// Team invites — a pending membership, keyed by email.
//
// An invite is not a capability any more: it carries no token, no expiry and no
// email. An admin writes an address down; the next time somebody signs in with a
// verified claim on that address, the row becomes a membership and disappears.
// So the invite list is exactly "who may join, and hasn't yet", and the act of
// inviting is the whole act.
//
// That makes this module the door on sign-in as well as the invite store: an
// address that is neither an existing account nor a pending invite has no way
// in, and `resolveSignInForVerifiedEmail` is where every sign-in path asks.

import type { TeamId } from '../generated/kysely/core/Team';
import type { UserId } from '../generated/kysely/core/User';
import type { TeamInviteId } from '../generated/kysely/core/TeamInvite';

import { logger } from 'movement-engine/public/log';
import { getCoreQb } from '../lib/kysely';
import { ProvisioningService } from './provisioning';

/** Discriminated so the caller maps each refusal to its own message. */
type AddInviteResult =
  | { status: 'created'; inviteId: TeamInviteId }
  | { status: 'already_member' }
  | { status: 'already_invited' };

/**
 * Record a pending membership for an email. No seat arithmetic, no email, no
 * link: the row IS the invitation. Refuses only what would be a no-op — an
 * address already on the team, or already pending on it.
 */
async function addInvite(input: {
  teamId: TeamId;
  email: string;
  invitedBy: UserId;
}): Promise<AddInviteResult> {
  const lower = input.email.toLowerCase().trim();

  const member = await getCoreQb(['team_membership', 'user_email'])
    .selectFrom('team_membership')
    .innerJoin('user_email', 'user_email.user_id', 'team_membership.user_id')
    .select('team_membership.id')
    .where('team_membership.team_id', '=', input.teamId)
    .where('user_email.email', '=', lower)
    .executeTakeFirst();
  if (member) return { status: 'already_member' };

  const pending = await getCoreQb(['team_invite'])
    .selectFrom('team_invite')
    .select('id')
    .where('team_id', '=', input.teamId)
    .where('email', '=', lower)
    .executeTakeFirst();
  if (pending) return { status: 'already_invited' };

  const invite = await getCoreQb(['team_invite'])
    .insertInto('team_invite')
    .values({ team_id: input.teamId, email: lower, invited_by: input.invitedBy })
    .returning('id')
    .executeTakeFirstOrThrow();

  logger.info('[team-invite] added', { teamId: input.teamId, inviteId: invite.id });
  return { status: 'created', inviteId: invite.id };
}

/** Withdraw a pending invite (idempotent — a row that is gone is a no-op). */
async function revokeInvite(input: { teamId: TeamId; inviteId: TeamInviteId }): Promise<void> {
  await getCoreQb(['team_invite'])
    .deleteFrom('team_invite')
    .where('id', '=', input.inviteId)
    .where('team_id', '=', input.teamId)
    .execute();
}

/** The team's pending invites, for the settings page. */
async function listPendingInvites(teamId: TeamId) {
  return getCoreQb(['team_invite'])
    .selectFrom('team_invite')
    .select(['id', 'email', 'invited_by', 'created_at'])
    .where('team_id', '=', teamId)
    .orderBy('created_at', 'desc')
    .execute();
}

/** Every team with a pending invite for this address, oldest first. */
async function pendingInvitesFor(email: string) {
  return getCoreQb(['team_invite'])
    .selectFrom('team_invite')
    .select(['id', 'team_id'])
    .where('email', '=', email)
    .orderBy('created_at', 'asc')
    .execute();
}

/**
 * Turn every pending invite for this (already verified) address into a
 * membership on its team, then drop the invite rows. Idempotent: the membership
 * insert ignores a conflict, and a claimed invite no longer exists to re-claim.
 *
 * Write access, because a team with no plan has no reason to hand out a lesser
 * one — the only distinction the product still draws is member vs not.
 */
async function claimInvitesForVerifiedEmail(input: {
  email: string;
  userId: UserId;
}): Promise<{ claimed: TeamId[] }> {
  const lower = input.email.toLowerCase();
  const invites = await pendingInvitesFor(lower);
  if (invites.length === 0) return { claimed: [] };

  for (const invite of invites) {
    await getCoreQb(['team_membership'])
      .insertInto('team_membership')
      .values({ user_id: input.userId, team_id: invite.team_id, access: 'write' })
      .onConflict((oc) => oc.columns(['user_id', 'team_id']).doNothing())
      .execute();
  }
  await getCoreQb(['team_invite'])
    .deleteFrom('team_invite')
    .where(
      'id',
      'in',
      invites.map((i) => i.id),
    )
    .execute();

  logger.info('[team-invite] claimed', { userId: input.userId, teams: invites.length });
  return { claimed: invites.map((i) => i.team_id) };
}

/** Sign-in outcome: an account to issue a session for, or the closed door. */
type SignInResolution =
  | { status: 'ok'; userId: UserId; teamId: TeamId; email: string; created: boolean }
  | { status: 'not_invited' };

/**
 * The one door every sign-in path goes through once it holds a VERIFIED email.
 *
 * Three cases, in order: an existing account signs in (claiming any invites
 * waiting for it on the way); an unknown address with a pending invite becomes
 * an account on that team; anything else is refused. There is no self-serve
 * team creation — the bootstrap admin is the seed and every other member is
 * somebody an admin wrote down.
 *
 * A removed member is a user whose access was withdrawn (`granted_access_at`
 * null). Re-adding them is an invite like any other: the claim gives back a
 * membership and access is restored here.
 */
async function resolveSignInForVerifiedEmail(input: {
  email: string;
  /** Display name from the identity provider, for a freshly provisioned user. */
  name?: string | null;
}): Promise<SignInResolution> {
  const lower = input.email.toLowerCase().trim();

  const existing = await getCoreQb(['user', 'user_email'])
    .selectFrom('user_email')
    .innerJoin('user', 'user.id', 'user_email.user_id')
    .select(['user.id as id', 'user.default_team_id as defaultTeamId'])
    .where('user_email.email', '=', lower)
    .executeTakeFirst();

  if (existing) {
    await claimInvitesForVerifiedEmail({ email: lower, userId: existing.id });
    const membership = await getCoreQb(['team_membership'])
      .selectFrom('team_membership')
      .select(['team_id'])
      .where('user_id', '=', existing.id)
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    if (!membership) return { status: 'not_invited' };

    // Access follows membership: a re-added member gets theirs back here, which
    // is also what makes their next request authenticate again.
    await getCoreQb(['user'])
      .updateTable('user')
      .set({ granted_access_at: new Date() })
      .where('id', '=', existing.id)
      .where('granted_access_at', 'is', null)
      .execute();

    const teamId = await defaultTeamFor(existing.id, existing.defaultTeamId, membership.team_id);
    return { status: 'ok', userId: existing.id, teamId, email: lower, created: false };
  }

  const invites = await pendingInvitesFor(lower);
  const first = invites[0];
  if (!first) return { status: 'not_invited' };

  const { userId } = await ProvisioningService.provisionUser({
    teamId: first.team_id,
    email: lower,
    name: input.name ?? null,
    access: 'write',
    termsAccepted: true,
  });
  // The first invite is spent by the provision itself; the rest (if the address
  // was written down on several teams) become memberships here.
  await claimInvitesForVerifiedEmail({ email: lower, userId });

  return { status: 'ok', userId, teamId: first.team_id, email: lower, created: true };
}

/**
 * The team a session lands in: the user's stated preference when they are still
 * a member of it, else their oldest membership (and the preference is corrected
 * to match, so a removed member does not keep pointing at a team they left).
 */
async function defaultTeamFor(
  userId: UserId,
  preferred: TeamId,
  fallback: TeamId,
): Promise<TeamId> {
  const stillAMember = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('id')
    .where('user_id', '=', userId)
    .where('team_id', '=', preferred)
    .executeTakeFirst();
  if (stillAMember) return preferred;

  await getCoreQb(['user'])
    .updateTable('user')
    .set({ default_team_id: fallback })
    .where('id', '=', userId)
    .execute();
  return fallback;
}

export const TeamInviteService = {
  addInvite,
  pendingInvitesFor,
  revokeInvite,
  listPendingInvites,
  claimInvitesForVerifiedEmail,
  resolveSignInForVerifiedEmail,
};
export type { AddInviteResult, SignInResolution };
