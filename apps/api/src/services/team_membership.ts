// Joining, changing and ending a membership.
//
// The admin app and the team's own settings page share these writes, so the
// two doors cannot drift on what a membership or a service account is made of.
//
// Ending one:
//
// Sessions here are stateless bearer tokens (a signed JWT, 180 days) — there is
// no session table to delete rows from. What every authenticated request DOES
// re-read is the user row, and it only resolves a user whose access is granted
// (`identify_user.ts`). So withdrawing `granted_access_at` is what invalidates
// the live sessions: the next request on an outstanding token fails to resolve
// a user and the caller is signed out. It closes the sign-in door by the same
// stroke, and `resolveSignInForVerifiedEmail` re-opens it if an admin writes the
// address down again.
//
// Access is withdrawn only when the person has no team left. Somebody removed
// from one of two teams is still a member of the other, and their session must
// survive.

import type { Kysely } from 'kysely';
import type { TeamId } from '../generated/kysely/core/Team';
import type { UserId } from '../generated/kysely/core/User';
import type CoreSchema from '../generated/kysely/core/CoreSchema';

import { getCoreQb } from '../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { ProvisioningService } from './provisioning';

type Access = 'read' | 'write';

type MembershipDb = Kysely<Pick<CoreSchema, 'team_membership'>>;

type RemoveMemberResult =
  | { status: 'removed'; signedOut: boolean }
  | { status: 'not_a_member' }
  | { status: 'last_admin' };

type ChangeAccessResult =
  | { status: 'changed' }
  | { status: 'not_a_member' }
  | { status: 'last_admin' };

type CreatedMember = { id: UserId; username: string; email: string };

type AddMemberResult =
  | { status: 'added'; member: { id: UserId; email: string } }
  | { status: 'last_admin' }
  | { status: 'email_taken' };

type CreateServiceAccountResult =
  | { status: 'created'; member: CreatedMember }
  | { status: 'email_taken' };

async function upsertMembership(
  db: MembershipDb,
  input: { teamId: TeamId; userId: UserId; access: Access },
): Promise<void> {
  await db
    .insertInto('team_membership')
    .values({ user_id: input.userId, team_id: input.teamId, access: input.access })
    .onConflict((oc) => oc.columns(['user_id', 'team_id']).doUpdateSet({ access: input.access }))
    .execute();
}

/**
 * Whether another team holds a pending invite for this address. Sign-in claims
 * every pending invite for the address it verifies, so writing such an address
 * onto an account — a new one, or an existing one's extra address — hands that
 * account the other team's invite. Such an address counts as taken.
 */
async function invitedToAnotherTeam(input: { teamId: TeamId; email: string }): Promise<boolean> {
  const invite = await getCoreQb(['team_invite'])
    .selectFrom('team_invite')
    .select('id')
    .where('email', '=', input.email.toLowerCase().trim())
    .where('team_id', '!=', input.teamId)
    .executeTakeFirst();
  return invite !== undefined;
}

/**
 * Put someone on a team at the given access, or change the access they have.
 * Idempotent on (user_id, team_id). Written in Kysely: the authorised Prisma
 * client's `team_membership.upsert` is a `notImplemented` stub.
 */
async function grantAccess(input: { teamId: TeamId; userId: UserId; access: Access }): Promise<void> {
  await upsertMembership(getCoreQb(['team_membership']), input);
}

/**
 * Apply a change that may take write access away from a member, unless it
 * would leave the team with NOBODY holding write access — a team nobody can
 * administer cannot invite anybody back, so that is the one change with no
 * undo. The team's membership rows are locked for the check AND the write:
 * two admins demoting each other at once would otherwise each see the other
 * still standing and leave the team with none.
 */
async function withoutLosingLastAdmin(input: {
  teamId: TeamId;
  userId: UserId;
  /** Whether the target ends up without write access after `write`. */
  losesWriteAccess: boolean;
  write: (db: MembershipDb) => Promise<void>;
}): Promise<{ status: 'done' } | { status: 'not_a_member' } | { status: 'last_admin' }> {
  const run = async (db: MembershipDb) => {
    const memberships = await db
      .selectFrom('team_membership')
      .select(['user_id', 'access'])
      .where('team_id', '=', input.teamId)
      .forUpdate()
      .execute();

    const target = memberships.find((m) => m.user_id === input.userId);
    if (!target) return { status: 'not_a_member' as const };

    const admins = memberships.filter((m) => m.access === 'write');
    if (target.access === 'write' && input.losesWriteAccess && admins.length === 1) {
      return { status: 'last_admin' as const };
    }

    await input.write(db);
    return { status: 'done' as const };
  };

  const db = getCoreQb(['team_membership']);
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

/** Change an existing member's access, never demoting the team's last admin. */
async function changeAccess(input: {
  teamId: TeamId;
  userId: UserId;
  access: Access;
}): Promise<ChangeAccessResult> {
  const result = await withoutLosingLastAdmin({
    teamId: input.teamId,
    userId: input.userId,
    losesWriteAccess: input.access !== 'write',
    write: (db) => upsertMembership(db, input),
  });
  return result.status === 'done' ? { status: 'changed' } : result;
}

/**
 * Put a person on a team directly, without waiting for them to sign in. An
 * address that already has an account joins the team with that account — one
 * person, one user — at the given access.
 *
 * A pending invite for the same address on this team is superseded: it would
 * otherwise sit in the invite list for someone who is already a member.
 */
async function addMember(input: {
  teamId: TeamId;
  email: string;
  username: string;
  access: Access;
}): Promise<AddMemberResult> {
  const lower = input.email.toLowerCase().trim();

  const existing = await getCoreQb(['user_email'])
    .selectFrom('user_email')
    .select('user_id')
    .where('email', '=', lower)
    .executeTakeFirst();

  let id: UserId;
  if (existing) {
    // The account may belong to other teams too; nothing about it but its id
    // goes back to this one.
    id = existing.user_id;
    // Someone already on this team is changing access, and must not take the
    // team's last admin with them; anyone else simply joins.
    const changed = await changeAccess({ teamId: input.teamId, userId: id, access: input.access });
    if (changed.status === 'last_admin') return changed;
    if (changed.status === 'not_a_member') {
      await grantAccess({ teamId: input.teamId, userId: id, access: input.access });
    }
  } else {
    if (await invitedToAnotherTeam({ teamId: input.teamId, email: lower })) {
      return { status: 'email_taken' };
    }
    ({ userId: id } = await ProvisioningService.provisionUser({
      teamId: input.teamId,
      email: lower,
      access: input.access,
    }));
    // Provisioning lowercases the handle it derives from an address; a name
    // somebody typed is kept exactly as typed, as the admin app's add-user does.
    await getCoreQb(['user'])
      .updateTable('user')
      .set({ username: input.username.trim() })
      .where('id', '=', id)
      .execute();
  }

  await getCoreQb(['team_invite'])
    .deleteFrom('team_invite')
    .where('team_id', '=', input.teamId)
    .where('email', '=', lower)
    .execute();

  return { status: 'added', member: { id, email: lower } };
}

/**
 * A mailbox-shaped member: its address takes plus-addressing (so one account
 * can receive for many aliases) and is flagged as a service address rather
 * than a person's. Named by its address.
 */
async function createServiceAccount(input: {
  teamId: TeamId;
  email: string;
  access: Access;
}): Promise<CreateServiceAccountResult> {
  const email = input.email.toLowerCase().trim();

  const taken = await getCoreQb(['user_email'])
    .selectFrom('user_email')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (taken || (await invitedToAnotherTeam({ teamId: input.teamId, email }))) {
    return { status: 'email_taken' };
  }

  const now = new Date();
  const user = await getCoreQb(['user'])
    .insertInto('user')
    .values({
      username: email,
      default_team_id: input.teamId,
      granted_access_at: now,
      completed_registration_at: now,
    })
    .returning(['id', 'username'])
    .executeTakeFirstOrThrow();

  await getCoreQb(['user_email'])
    .insertInto('user_email')
    .values({
      user_id: user.id,
      email,
      is_primary: true,
      is_service_email: true,
      accepts_plus_addressing: true,
    })
    .execute();

  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    .values({ user_id: user.id, team_id: input.teamId, access: input.access })
    .execute();

  return { status: 'created', member: { id: user.id, username: user.username, email } };
}

/**
 * Remove someone from a team. Refuses to take the LAST write-access member off
 * a team (see `withoutLosingLastAdmin`).
 */
async function removeMember(input: {
  teamId: TeamId;
  userId: UserId;
}): Promise<RemoveMemberResult> {
  const guarded = await withoutLosingLastAdmin({
    teamId: input.teamId,
    userId: input.userId,
    losesWriteAccess: true,
    write: async (db) => {
      await db
        .deleteFrom('team_membership')
        .where('team_id', '=', input.teamId)
        .where('user_id', '=', input.userId)
        .execute();
    },
  });
  if (guarded.status !== 'done') return guarded;

  // A pending invite for the same address on this team would silently re-admit
  // them at their next sign-in, so removing a member withdraws that too.
  await getCoreQb(['team_invite', 'user_email'])
    .deleteFrom('team_invite')
    .where('team_id', '=', input.teamId)
    .where((eb) =>
      eb(
        'email',
        'in',
        eb
          .selectFrom('user_email')
          .select('email')
          .where('user_id', '=', input.userId),
      ),
    )
    .execute();

  const remaining = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('id')
    .where('user_id', '=', input.userId)
    .executeTakeFirst();
  if (remaining) {
    logger.info('[team-membership] removed from one team, still a member elsewhere', {
      teamId: input.teamId,
      userId: input.userId,
    });
    return { status: 'removed', signedOut: false };
  }

  await getCoreQb(['user'])
    .updateTable('user')
    .set({ granted_access_at: null })
    .where('id', '=', input.userId)
    .execute();

  logger.info('[team-membership] removed and signed out', {
    teamId: input.teamId,
    userId: input.userId,
  });
  return { status: 'removed', signedOut: true };
}

export const TeamMembershipService = {
  grantAccess,
  changeAccess,
  addMember,
  createServiceAccount,
  removeMember,
  invitedToAnotherTeam,
};
export type { Access, AddMemberResult, RemoveMemberResult, ChangeAccessResult, CreatedMember, CreateServiceAccountResult };
