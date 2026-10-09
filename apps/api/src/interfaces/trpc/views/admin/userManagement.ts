import { z } from 'zod';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { trpc } from '../../trpc';
import { currentContext } from '../../../../services/context';
import { ProvisioningService } from '../../../../services/provisioning';
import {
  TeamMembershipService,
  type CreatedMember,
} from '../../../../services/team_membership';
import { getCoreQb, getQb } from '../../../../lib/kysely';
import { UserEmailId } from '../../../../generated/kysely/core/UserEmail';
import { UserId } from '../../../../generated/kysely/core/User';
import { OpsDetailLevel } from '../../../../lib/ops/types';
import {
  GLOBAL_DEFAULT_OPS_DETAIL_LEVEL,
  setTeamDetailLevel as setTeamDetailLevelService,
} from '../../../../services/team/ops_detail';
import { neverAsAny } from '../../../../lib/utils/types';

const userSchema = z.object({
  email: z.string().email(),
  username: z.string().min(1),
});

const accessSchema = z.enum(['read', 'write']);

const userManagementRouter = (procedure: typeof trpc.procedure) => {
  return trpc.router({
    getTeams: procedure.query(async () => {
      // The name is core's, the ops-detail dial is automations'; a team with no
      // settings row is on the global default.
      const rows = await getQb(['core.team', 'automations.team_settings'])
        .selectFrom('core.team as t')
        .leftJoin('automations.team_settings as ts', 'ts.team_id', 't.id')
        .select(['t.id', 't.name', 'ts.ops_detail_level'])
        .orderBy('t.name', 'asc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        ops_detail_level: r.ops_detail_level ?? GLOBAL_DEFAULT_OPS_DETAIL_LEVEL,
      }));
    }),

    setTeamDetailLevel: procedure
      .input(
        z.object({
          teamId: z.string(),
          level: z.nativeEnum(OpsDetailLevel),
        }),
      )
      .mutation(async ({ input }) => {
        await setTeamDetailLevelService(input.teamId as unknown as string, input.level);
        return { ok: true };
      }),

    searchUsersByEmail: procedure
      .input(z.object({ emailPrefix: z.string().min(1) }))
      .query(async ({ input }) => {
        const results = await getCoreQb(['user', 'user_email', 'team'])
          .selectFrom('user_email as ue')
          .innerJoin('user as u', 'u.id', 'ue.user_id')
          .innerJoin('team as t', 't.id', 'u.default_team_id')
          .select(['u.id', 'u.username', 'u.default_team_id as teamId', 't.name as teamName', 'ue.email'])
          .where('ue.email', 'ilike', `${input.emailPrefix}%`)
          .limit(20)
          .execute();

        return results.map((r) => ({
          id: r.id,
          username: r.username,
          teamId: r.teamId,
          team: { name: r.teamName },
          emails: [{ email: r.email }],
        }));
      }),

    createTeamWithAdmin: procedure
      .input(
        z.object({
          teamName: z.string().min(1),
          users: z.array(userSchema).default([]),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        const { teamId, pipelineConfigurationId } = await ProvisioningService.provisionTeam({
          name: input.teamName,
        });

        const createdUsers = await Promise.all(
          input.users.map(async (userData) => {
            const { userId } = await ProvisioningService.provisionUser({
              teamId,
              email: userData.email,
              username: userData.username,
            });
            return { id: userId, username: userData.username, email: userData.email };
          }),
        );

        return {
          team: { id: teamId, name: input.teamName },
          pipelineConfiguration: { id: pipelineConfigurationId, name: input.teamName },
          users: createdUsers,
        };
      }),

    addUserToTeam: procedure
      .input(
        z.object({
          teamId: z.string().uuid(),
          access: accessSchema,
          email: z.string().email(),
          username: z.string().min(1),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        const user = await ctx.prisma.user.create({
          data: {
            username: input.username,
            defaultTeamId: input.teamId,
            grantedAccessAt: new Date(),
            completedRegistrationAt: new Date(),
          },
        });

        await ctx.prisma.userEmail.create({
          data: {
            userId: user.id,
            email: input.email,
            isPrimary: true,
          },
        });

        await ctx.prisma.teamMembership.create({
          data: {
            userId: user.id,
            teamId: input.teamId,
            access: input.access,
          },
        });

        return { id: user.id, username: user.username, email: input.email };
      }),

    createServiceAccount: procedure
      .input(
        z.object({
          teamId: z.string().uuid(),
          access: accessSchema,
          email: z.string().email(),
        }),
      )
      .mutation(async ({ input }): Promise<CreatedMember> => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        const result = await TeamMembershipService.createServiceAccount({
          teamId: input.teamId as TeamId,
          email: input.email,
          access: input.access,
        });
        switch (result.status) {
          case 'created':
            return result.member;
          case 'email_taken':
            throw new Error(`Email ${input.email} is already in use`);
          default:
            return neverAsAny(result);
        }
      }),

    grantTeamAccess: procedure
      .input(
        z.object({
          userId: z.string().uuid(),
          teamId: z.string().uuid(),
          access: accessSchema,
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: input.userId },
          select: { id: true, username: true },
        });

        const team = await ctx.prisma.team.findUniqueOrThrow({
          where: { id: input.teamId },
          select: { name: true },
        });

        await TeamMembershipService.grantAccess({
          userId: input.userId as UserId,
          teamId: input.teamId as TeamId,
          access: input.access,
        });

        return { username: user.username, teamName: team.name, access: input.access };
      }),

    addEmailToUser: procedure
      .input(
        z.object({
          userId: z.string().uuid(),
          email: z.string().email(),
          isPrimary: z.boolean().default(false),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: input.userId },
          select: { id: true, username: true },
        });

        const existing = await ctx.prisma.userEmail.findUnique({
          where: { email: input.email },
        });

        if (existing) {
          throw new Error(`Email ${input.email} is already in use`);
        }

        await ctx.prisma.userEmail.create({
          data: {
            userId: input.userId,
            email: input.email,
            isPrimary: input.isPrimary,
          },
        });

        return { username: user.username, email: input.email };
      }),

    addPhoneNumberToUser: procedure
      .input(
        z.object({
          userId: z.string().uuid(),
          phoneNumber: z.string().min(1),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: input.userId },
          select: { id: true, username: true },
        });

        const { UserService } = await import('../../../../services/user');
        await UserService.addPhoneNumber({ userId: input.userId, phoneNumber: input.phoneNumber });

        return { username: user.username, phoneNumber: input.phoneNumber };
      }),

    getUserContactInfo: procedure
      .input(z.object({ userId: z.string().uuid() }))
      .query(async ({ input }) => {
        const ctx = currentContext();

        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: input.userId },
          select: { id: true, username: true, defaultTeamId: true },
        });

        const emails = await ctx.prisma.userEmail.findMany({
          where: { userId: input.userId },
          select: {
            id: true,
            email: true,
            isPrimary: true,
            isServiceEmail: true,
            acceptsPlusAddressing: true,
          },
          orderBy: { isPrimary: 'desc' },
        });

        const phoneNumber = await ctx.prisma.phoneNumber.findFirst({
          where: { userId: input.userId },
          select: { id: true, phoneNumber: true },
        });

        return { username: user.username, teamId: user.defaultTeamId, emails, phoneNumber };
      }),

    updateUsername: procedure
      .input(z.object({ userId: z.string().uuid(), username: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.prisma.user.update({
          where: { id: input.userId },
          data: { username: input.username },
        });
        return { ok: true };
      }),

    moveUserToTeam: procedure
      .input(
        z.object({
          userEmail: z.string().email(),
          newTeamId: z.string().uuid(),
          access: accessSchema,
          newUsername: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        const userEmail = await ctx.prisma.userEmail.findUnique({
          where: { email: input.userEmail },
          include: { user: true },
        });

        if (!userEmail) {
          throw new Error(`User with email ${input.userEmail} not found`);
        }

        const user = await ctx.prisma.user.update({
          where: { id: userEmail.userId },
          data: {
            defaultTeamId: input.newTeamId,
            ...(input.newUsername && { username: input.newUsername }),
          },
        });

        await ctx.prisma.teamMembership.upsert({
          where: {
            userId_teamId: {
              userId: user.id,
              teamId: input.newTeamId,
            },
          },
          create: {
            userId: user.id,
            teamId: input.newTeamId,
            access: input.access,
          },
          update: {
            access: input.access,
          },
        });

        return { id: user.id, username: user.username, email: input.userEmail };
      }),

    listUserMemberships: procedure
      .input(z.object({ userId: z.string().uuid() }))
      .query(async ({ input }) => {
        const user = await getCoreQb(['user'])
          .selectFrom('user')
          .select('default_team_id')
          .where('id', '=', input.userId as UserId)
          .executeTakeFirstOrThrow();

        const memberships = await getCoreQb(['team_membership', 'team'])
          .selectFrom('team_membership as tm')
          .innerJoin('team as t', 't.id', 'tm.team_id')
          .select(['tm.team_id as teamId', 't.name as teamName', 'tm.access', 'tm.is_personal'])
          .where('tm.user_id', '=', input.userId as UserId)
          .orderBy('t.name', 'asc')
          .execute();

        return memberships.map((m) => ({
          teamId: m.teamId as unknown as string,
          teamName: m.teamName,
          access: m.access,
          isPersonal: m.is_personal,
          isHomeTeam: m.teamId === user.default_team_id,
        }));
      }),

    removeUserFromTeam: procedure
      .input(z.object({ teamId: z.string().uuid(), userId: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const teamId = input.teamId as TeamId;
        const userId = input.userId as UserId;

        const membership = await getCoreQb(['team_membership'])
          .selectFrom('team_membership')
          .select(['access', 'is_personal'])
          .where('team_id', '=', teamId)
          .where('user_id', '=', userId)
          .executeTakeFirst();

        if (!membership) {
          throw new Error("This user isn't a member of that team.");
        }
        if (membership.is_personal) {
          throw new Error("This is the user's personal workspace and can't be removed.");
        }

        const user = await getCoreQb(['user'])
          .selectFrom('user')
          .select('default_team_id')
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();

        if (user.default_team_id === teamId) {
          throw new Error(
            "This is the user's home team — move them to another team before removing this membership.",
          );
        }

        if (membership.access === 'write') {
          const anotherAdmin = await getCoreQb(['team_membership'])
            .selectFrom('team_membership')
            .select('id')
            .where('team_id', '=', teamId)
            .where('access', '=', 'write')
            .where('user_id', '!=', userId)
            .limit(1)
            .executeTakeFirst();

          if (!anotherAdmin) {
            throw new Error(
              "Can't remove the team's last admin (write-access member). Grant another member write access first.",
            );
          }
        }

        await getCoreQb(['team_membership'])
          .deleteFrom('team_membership')
          .where('team_id', '=', teamId)
          .where('user_id', '=', userId)
          .execute();

        return { removed: true as const };
      }),
  });
};

export { userManagementRouter };
