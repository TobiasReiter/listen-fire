import { z } from 'zod';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TeamUsageConfigId } from '../../../../generated/kysely/public/TeamUsageConfig';

import { trpc } from '../../trpc';
import { getQb } from '../../../../lib/kysely';

const usageConfigRouter = (procedure: typeof trpc.procedure) => {
  return trpc.router({
    getForTeam: procedure
      .input(z.object({ teamId: z.string().uuid() }))
      .query(async ({ input }) => {
        const row = await getQb(['team_usage_config'])
          .selectFrom('team_usage_config')
          .selectAll()
          .where('team_id', '=', input.teamId as TeamId)
          .executeTakeFirst();

        return row ?? null;
      }),

    upsert: procedure
      .input(
        z.object({
          teamId: z.string().uuid(),
          maxWeeklyPipelineRuns: z.number().int().min(0),
          maxWeeklyQueryInputs: z.number().int().min(0),
          additionalPipelineRuns: z.number().int().min(0).default(0),
          additionalQueryInputs: z.number().int().min(0).default(0),
          alertThresholdPct: z.number().int().min(0).max(100).default(80),
          weekStartsOn: z.number().int().min(0).max(6).default(1),
        }),
      )
      .mutation(async ({ input }) => {
        const existing = await getQb(['team_usage_config'])
          .selectFrom('team_usage_config')
          .select('id')
          .where('team_id', '=', input.teamId as TeamId)
          .executeTakeFirst();

        if (existing) {
          await getQb(['team_usage_config'])
            .updateTable('team_usage_config')
            .set({
              max_weekly_pipeline_runs: input.maxWeeklyPipelineRuns,
              max_weekly_query_inputs: input.maxWeeklyQueryInputs,
              additional_pipeline_runs: input.additionalPipelineRuns,
              additional_query_inputs: input.additionalQueryInputs,
              alert_threshold_pct: input.alertThresholdPct,
              week_starts_on: input.weekStartsOn,
              updated_at: new Date(),
            })
            .where('id', '=', existing.id)
            .execute();
        } else {
          await getQb(['team_usage_config'])
            .insertInto('team_usage_config')
            .values({
              id: crypto.randomUUID() as TeamUsageConfigId,
              team_id: input.teamId as TeamId,
              max_weekly_pipeline_runs: input.maxWeeklyPipelineRuns,
              max_weekly_query_inputs: input.maxWeeklyQueryInputs,
              additional_pipeline_runs: input.additionalPipelineRuns,
              additional_query_inputs: input.additionalQueryInputs,
              alert_threshold_pct: input.alertThresholdPct,
              week_starts_on: input.weekStartsOn,
            })
            .execute();
        }

        return { success: true };
      }),
  });
};

export { usageConfigRouter };
