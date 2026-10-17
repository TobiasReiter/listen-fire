// The team-members settings surface: who is on the team, who is invited, and
// everything a team needs to manage its own people — invite or add someone,
// create a service account, change a member's access, name, addresses or phone
// number, and remove them. The platform admin app can do the same; the writes
// they share live in `TeamMembershipService` so the two cannot drift.
//
// Inviting is unlimited and sends nothing: `TeamInviteService.addInvite` writes
// a pending membership and the person joins the next time they sign in. Any
// write-access member may manage the team.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { TeamInviteId } from '../../../generated/kysely/core/TeamInvite';

import { currentContext } from '../../../services/context';
import { TeamInviteService } from '../../../services/team_invite';
import {
  TeamMembershipService,
  type Access,
  type CreatedMember,
} from '../../../services/team_membership';
import { trpc } from '../trpc';
import { UserService } from '../../../services/user';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { neverAsAny } from 'movement-engine/public/types';

/** Throw unless the acting user holds write access on the team. */
async function requireWriteAccess(teamId: TeamId, userId: UserId): Promise<void> {
  const membership = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('access')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (membership?.access !== 'write') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only members with write access can manage the team.',
    });
  }
}

/** How many teams each of these people belongs to. */
async function teamCounts(userIds: readonly UserId[]): Promise<Map<UserId, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id', (eb) => eb.fn.countAll<string>().as('teams')])
    .where('user_id', 'in', userIds)
    .groupBy('user_id')
    .execute();
  return new Map(rows.map((r) => [r.user_id, Number(r.teams)]));
}

/**
 * The target of a per-member act must be on the acting team: NOT_FOUND
 * otherwise, so a stranger's id reveals nothing.
 *
 * An act on the person's IDENTITY — their name, or an address or number they
 * sign in with — also needs this team to be their ONLY team. Sign-in finds a
 * person by any of their addresses, so an address this team's admin adds is a
 * way in to every team the person belongs to; only a sole team may write one.
 * A platform admin's identity is never this team's to write, sole team or not:
 * a way in to that account is a way in to every team.
 */
async function requireMember(
  teamId: TeamId,
  userId: string,
  { identity = false }: { identity?: boolean } = {},
): Promise<UserId> {
  const membership = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('user_id')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId as UserId)
    .executeTakeFirst();
  if (!membership) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That person is not a member of this team.' });
  }
  if (identity) {
    const user = await getCoreQb(['user'])
      .selectFrom('user')
      .select('is_platform_admin')
      .where('id', '=', membership.user_id)
      .executeTakeFirstOrThrow();
    if (user.is_platform_admin) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'This account is a platform admin; only platform admins can change its sign-in details.',
      });
    }
    const teams = (await teamCounts([membership.user_id])).get(membership.user_id) ?? 0;
    if (teams > 1) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'This account also belongs to another team; only they can change their sign-in details.',
      });
    }
  }
  return membership.user_id;
}

/** The acting team, once the actor is known to be allowed to manage it. */
async function managedTeam(): Promise<TeamId> {
  const ctx = currentContext();
  const teamId = ctx.user.teamId as TeamId;
  await requireWriteAccess(teamId, ctx.user.id as UserId);
  return teamId;
}

const accessSchema = z.enum(['read', 'write']);

const ADDRESS_TAKEN_MESSAGE = 'That address is already in use.';

const LAST_ADMIN_MESSAGE =
  'This is the team’s last admin — give another member write access before changing this one.';

const teamMembersRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Everything the /settings/team page renders in one read. */
    overview: userProcedure.query(async () => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;

      const members = await getCoreQb(['team_membership', 'user'])
        .selectFrom('team_membership')
        .innerJoin('user', 'user.id', 'team_membership.user_id')
        .select([
          'user.id as userId',
          'user.username as username',
          'user.is_platform_admin as platformAdmin',
          'team_membership.access as access',
          'team_membership.created_at as joinedAt',
        ])
        .where('team_membership.team_id', '=', teamId)
        .orderBy('team_membership.created_at', 'asc')
        .execute();
      const memberIds = members.map((m) => m.userId);

      const emails =
        memberIds.length === 0
          ? []
          : await getCoreQb(['user_email'])
              .selectFrom('user_email')
              .select(['user_id', 'email', 'is_primary', 'is_service_email'])
              .where('user_id', 'in', memberIds)
              .orderBy('is_primary', 'desc')
              .orderBy('created_at', 'asc')
              .execute();

      // Phone numbers live in automations and users in core; the carve forbids
      // one query across both, so this is a second read keyed on the ids.
      const phones =
        memberIds.length === 0
          ? []
          : await getAutomationsQb(['phone_number'])
              .selectFrom('phone_number')
              .select(['user_id', 'phone_number'])
              .where('user_id', 'in', memberIds)
              .execute();

      const counts = await teamCounts(memberIds);

      const invites = await TeamInviteService.listPendingInvites(teamId);

      const viewerMembership = members.find((m) => m.userId === ctx.user.id);

      return {
        // Who is looking, so the page can offer only what they may do.
        viewer: {
          userId: ctx.user.id as UserId,
          access:
            viewerMembership === undefined
              ? ('read' as const)
              : accessSchema.parse(viewerMembership.access),
        },
        members: members.map((m) => {
          const own = emails.filter((e) => e.user_id === m.userId);
          const primary = own.find((e) => e.is_primary);
          return {
            userId: m.userId,
            username: m.username,
            email: primary === undefined ? null : String(primary.email),
            emails: own.map((e) => ({ email: String(e.email), isPrimary: e.is_primary })),
            phoneNumber: phones.find((p) => p.user_id === m.userId)?.phone_number ?? null,
            access: accessSchema.parse(m.access),
            isServiceAccount: own.some((e) => e.is_service_email),
            // Whether this team may change their name, addresses and number
            // (see `requireMember`).
            soleTeam: (counts.get(m.userId) ?? 0) <= 1,
            platformAdmin: m.platformAdmin,
            joinedAt: m.joinedAt,
          };
        }),
        invites: invites.map((i) => ({
          id: i.id,
          email: String(i.email),
          createdAt: i.created_at,
        })),
      };
    }),

    /** Add a teammate by email. They join the next time they sign in. */
    invite: userProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const userId = ctx.user.id as UserId;
        await requireWriteAccess(teamId, userId);

        const result = await TeamInviteService.addInvite({
          teamId,
          email: input.email,
          invitedBy: userId,
        });

        switch (result.status) {
          case 'created':
            return { invited: true as const };
          case 'already_member':
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'That email is already a member of this team.',
            });
          case 'already_invited':
            throw new TRPCError({ code: 'CONFLICT', message: 'That email is already invited.' });
          default:
            return neverAsAny(result);
        }
      }),

    /** Withdraw a pending invite. */
    revokeInvite: userProcedure
      .input(z.object({ inviteId: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        await requireWriteAccess(teamId, ctx.user.id as UserId);
        await TeamInviteService.revokeInvite({
          teamId,
          inviteId: input.inviteId as TeamInviteId,
        });
        return { revoked: true as const };
      }),

    /** Remove a member: their membership ends and their sessions die with it. */
    remove: userProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        await requireWriteAccess(teamId, ctx.user.id as UserId);

        const result = await TeamMembershipService.removeMember({
          teamId,
          userId: input.userId as UserId,
        });

        switch (result.status) {
          case 'removed':
            return { removed: true as const, signedOut: result.signedOut };
          case 'not_a_member':
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'That person is not a member of this team.',
            });
          case 'last_admin':
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'This is the team’s last admin — add another admin before removing this one.',
            });
          default:
            return neverAsAny(result);
        }
      }),

    /** Put someone on the team now, rather than when they next sign in. */
    addMember: userProcedure
      .input(
        z.object({
          email: z.string().email(),
          username: z.string().trim().min(1),
          access: accessSchema,
        }),
      )
      .mutation(async ({ input }): Promise<{ id: UserId; email: string }> => {
        const teamId = await managedTeam();
        await currentContext().enterTransaction();
        const result = await TeamMembershipService.addMember({ teamId, ...input });
        switch (result.status) {
          case 'added':
            return result.member;
          case 'last_admin':
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: LAST_ADMIN_MESSAGE });
          case 'email_taken':
            throw new TRPCError({ code: 'CONFLICT', message: ADDRESS_TAKEN_MESSAGE });
          default:
            return neverAsAny(result);
        }
      }),

    /** A mailbox that acts as a member — see `TeamMembershipService.createServiceAccount`. */
    createServiceAccount: userProcedure
      .input(z.object({ email: z.string().email(), access: accessSchema }))
      .mutation(async ({ input }): Promise<CreatedMember> => {
        const teamId = await managedTeam();
        await currentContext().enterTransaction();
        const result = await TeamMembershipService.createServiceAccount({ teamId, ...input });
        switch (result.status) {
          case 'created':
            return result.member;
          case 'email_taken':
            throw new TRPCError({ code: 'CONFLICT', message: ADDRESS_TAKEN_MESSAGE });
          default:
            return neverAsAny(result);
        }
      }),

    setAccess: userProcedure
      .input(z.object({ userId: z.string().uuid(), access: accessSchema }))
      .mutation(async ({ input }): Promise<{ access: Access }> => {
        const teamId = await managedTeam();
        const userId = await requireMember(teamId, input.userId);

        const result = await TeamMembershipService.changeAccess({
          teamId,
          userId,
          access: input.access,
        });
        switch (result.status) {
          case 'changed':
            return { access: input.access };
          case 'not_a_member':
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'That person is not a member of this team.',
            });
          case 'last_admin':
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: LAST_ADMIN_MESSAGE });
          default:
            return neverAsAny(result);
        }
      }),

    rename: userProcedure
      .input(z.object({ userId: z.string().uuid(), username: z.string().trim().min(1) }))
      .mutation(async ({ input }) => {
        const teamId = await managedTeam();
        const userId = await requireMember(teamId, input.userId, { identity: true });
        await UserService.updateUsername({ userId, newUsername: input.username });
        return { username: input.username };
      }),

    addEmail: userProcedure
      .input(
        z.object({
          userId: z.string().uuid(),
          email: z.string().email(),
          isPrimary: z.boolean().default(false),
        }),
      )
      .mutation(async ({ input }) => {
        const teamId = await managedTeam();
        const userId = await requireMember(teamId, input.userId, { identity: true });

        const taken = await getCoreQb(['user_email'])
          .selectFrom('user_email')
          .select('id')
          .where('email', '=', input.email.toLowerCase().trim())
          .executeTakeFirst();
        if (
          taken ||
          (await TeamMembershipService.invitedToAnotherTeam({ teamId, email: input.email }))
        ) {
          throw new TRPCError({ code: 'CONFLICT', message: ADDRESS_TAKEN_MESSAGE });
        }

        await currentContext().enterTransaction();
        await UserService.addEmail({ userId, email: input.email, isPrimary: input.isPrimary });
        return { email: input.email.toLowerCase() };
      }),

    /** One number per person: adding one replaces whatever they had. */
    addPhone: userProcedure
      .input(z.object({ userId: z.string().uuid(), phoneNumber: z.string().trim().min(1) }))
      .mutation(async ({ input }) => {
        const teamId = await managedTeam();
        const userId = await requireMember(teamId, input.userId, { identity: true });

        await currentContext().enterTransaction();
        if (await UserService.phoneNumberHeldByAnother({ userId, phoneNumber: input.phoneNumber })) {
          throw new TRPCError({ code: 'CONFLICT', message: 'That number is already in use.' });
        }
        await UserService.addPhoneNumber({ userId, phoneNumber: input.phoneNumber });
        return { phoneNumber: input.phoneNumber };
      }),
  });
};

export { teamMembersRouter };
