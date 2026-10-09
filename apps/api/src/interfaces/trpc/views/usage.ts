import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserEmailId } from '../../../generated/kysely/core/UserEmail';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { checkUsage, getBillingContacts, type UsageStatus } from '../../../services/usage';
import { getCoreQb, getQb } from '../../../lib/kysely';
import { userProcedure as sharedUserProcedure } from '../procedures';

const usageRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getUsageSummary: userProcedure.query(async () => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId;

      const pipelineUsage = await checkUsage(teamId, 'pipeline_run');
      const queryUsage = await checkUsage(teamId, 'query_input');

      // If no config exists, return null — UI shows "no limits configured"
      if (!pipelineUsage && !queryUsage) return null;

      const qb = getQb(['team_usage_config']);
      const config = await qb
        .selectFrom('team_usage_config')
        .select(['alert_threshold_pct', 'week_starts_on'])
        .where('team_id', '=', teamId as TeamId)
        .executeTakeFirst();

      return {
        pipelineRuns: pipelineUsage,
        queryInputs: queryUsage,
        alertThresholdPct: config?.alert_threshold_pct ?? 80,
        weekStartsOn: config?.week_starts_on ?? 1,
      };
    }),

    getBillingContacts: userProcedure.query(async () => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId;

      // Get all team user emails with billing contact status
      const qb = getCoreQb(['user_email', 'user']);
      const emails = await qb
        .selectFrom('user_email')
        .innerJoin('user', 'user.id', 'user_email.user_id')
        .select([
          'user_email.id',
          'user_email.email',
          'user_email.is_billing_contact',
          'user.id as userId',
        ])
        .where('user.default_team_id', '=', teamId as TeamId)
        .where('user.granted_access_at', 'is not', null)
        .where('user_email.is_primary', '=', true)
        .orderBy('user_email.email', 'asc')
        .execute();

      return emails.map((e) => ({
        id: e.id,
        email: e.email,
        isBillingContact: e.is_billing_contact,
        userId: e.userId,
      }));
    }),

    setBillingContact: userProcedure
      .input(
        z.object({
          userEmailId: z.string(),
          isBillingContact: z.boolean(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId;

        // Verify the email belongs to a user on this team
        const qb = getCoreQb(['user_email', 'user']);
        const email = await qb
          .selectFrom('user_email')
          .innerJoin('user', 'user.id', 'user_email.user_id')
          .select(['user_email.id'])
          .where('user_email.id', '=', input.userEmailId as UserEmailId)
          .where('user.default_team_id', '=', teamId as TeamId)
          .executeTakeFirst();

        if (!email) throw new Error('Email not found');

        await qb
          .updateTable('user_email')
          .set({ is_billing_contact: input.isBillingContact })
          .where('id', '=', input.userEmailId as UserEmailId)
          .execute();

        return { success: true };
      }),
  });
};

export { usageRouter };
