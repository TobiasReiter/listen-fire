import { z } from 'zod';
import { sql } from 'kysely';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { DealflowPipelineId } from '../../../../generated/kysely/public/DealflowPipeline';
import type { AgentConversationId } from '../../../../generated/kysely/public/AgentConversation';

import { getQb } from '../../../../lib/kysely';
import { trpc } from '../../trpc';

const llmUsageRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    summary: procedure
      .input(
        z.object({
          teamId: z.string().uuid().optional(),
          startDate: z.string().datetime(),
          endDate: z.string().datetime(),
        }),
      )
      .query(async ({ input }) => {
        const qb = getQb(['llm_usage', 'core.team']);

        let query = qb
          .selectFrom('llm_usage as u')
          .innerJoin('core.team as t', 'u.team_id', 't.id')
          .select([
            'u.team_id',
            't.name as team_name',
            sql<number>`count(*)::int`.as('call_count'),
            sql<number>`sum(u.input_tokens)::int`.as('total_input_tokens'),
            sql<number>`sum(u.output_tokens)::int`.as('total_output_tokens'),
            sql<number>`sum(u.cache_read_tokens)::int`.as('total_cache_read_tokens'),
            sql<number>`sum(u.cost_microdollars)::int`.as('total_cost_microdollars'),
          ])
          .where('u.created_at', '>=', new Date(input.startDate))
          .where('u.created_at', '<=', new Date(input.endDate))
          .groupBy(['u.team_id', 't.name'])
          .orderBy(sql`sum(u.cost_microdollars)`, 'desc');

        if (input.teamId) {
          query = query.where('u.team_id', '=', input.teamId as TeamId);
        }

        return query.execute();
      }),

    byModel: procedure
      .input(
        z.object({
          teamId: z.string().uuid().optional(),
          startDate: z.string().datetime(),
          endDate: z.string().datetime(),
        }),
      )
      .query(async ({ input }) => {
        const qb = getQb(['llm_usage']);

        let query = qb
          .selectFrom('llm_usage as u')
          .select([
            'u.provider',
            'u.model',
            sql<number>`count(*)::int`.as('call_count'),
            sql<number>`sum(u.input_tokens)::int`.as('total_input_tokens'),
            sql<number>`sum(u.output_tokens)::int`.as('total_output_tokens'),
            sql<number>`sum(u.cost_microdollars)::int`.as('total_cost_microdollars'),
          ])
          .where('u.created_at', '>=', new Date(input.startDate))
          .where('u.created_at', '<=', new Date(input.endDate))
          .groupBy(['u.provider', 'u.model'])
          .orderBy(sql`sum(u.cost_microdollars)`, 'desc');

        if (input.teamId) {
          query = query.where('u.team_id', '=', input.teamId as TeamId);
        }

        return query.execute();
      }),

    byLabel: procedure
      .input(
        z.object({
          teamId: z.string().uuid().optional(),
          startDate: z.string().datetime(),
          endDate: z.string().datetime(),
        }),
      )
      .query(async ({ input }) => {
        const qb = getQb(['llm_usage']);

        let query = qb
          .selectFrom('llm_usage as u')
          .select([
            sql<string>`coalesce(u.label, '(unlabeled)')`.as('label'),
            'u.call_type',
            sql<number>`count(*)::int`.as('call_count'),
            sql<number>`sum(u.input_tokens)::int`.as('total_input_tokens'),
            sql<number>`sum(u.output_tokens)::int`.as('total_output_tokens'),
            sql<number>`sum(u.cost_microdollars)::int`.as('total_cost_microdollars'),
          ])
          .where('u.created_at', '>=', new Date(input.startDate))
          .where('u.created_at', '<=', new Date(input.endDate))
          .groupBy([sql`coalesce(u.label, '(unlabeled)')`, 'u.call_type'])
          .orderBy(sql`sum(u.cost_microdollars)`, 'desc');

        if (input.teamId) {
          query = query.where('u.team_id', '=', input.teamId as TeamId);
        }

        return query.execute();
      }),

    byPipeline: procedure
      .input(
        z.object({
          teamId: z.string().uuid().optional(),
          startDate: z.string().datetime(),
          endDate: z.string().datetime(),
          limit: z.number().min(1).max(100).default(50),
        }),
      )
      .query(async ({ input }) => {
        const qb = getQb(['llm_usage', 'dealflow_pipeline', 'core.team']);

        let query = qb
          .selectFrom('llm_usage as u')
          .innerJoin('dealflow_pipeline as dp', 'u.pipeline_id', 'dp.id')
          .innerJoin('core.team as t', 'u.team_id', 't.id')
          .select([
            'u.pipeline_id',
            't.name as team_name',
            'dp.created_at as pipeline_created_at',
            sql<number>`count(*)::int`.as('call_count'),
            sql<number>`sum(u.input_tokens)::int`.as('total_input_tokens'),
            sql<number>`sum(u.output_tokens)::int`.as('total_output_tokens'),
            sql<number>`sum(u.cost_microdollars)::int`.as('total_cost_microdollars'),
          ])
          .where('u.created_at', '>=', new Date(input.startDate))
          .where('u.created_at', '<=', new Date(input.endDate))
          .where('u.pipeline_id', 'is not', null)
          .groupBy(['u.pipeline_id', 't.name', 'dp.created_at'])
          .orderBy('dp.created_at', 'desc')
          .limit(input.limit);

        if (input.teamId) {
          query = query.where('u.team_id', '=', input.teamId as TeamId);
        }

        return query.execute();
      }),

    byConversation: procedure
      .input(
        z.object({
          teamId: z.string().uuid().optional(),
          startDate: z.string().datetime(),
          endDate: z.string().datetime(),
          limit: z.number().min(1).max(100).default(50),
        }),
      )
      .query(async ({ input }) => {
        const qb = getQb(['llm_usage', 'agent_conversation', 'core.team']);

        let query = qb
          .selectFrom('llm_usage as u')
          .innerJoin('agent_conversation as nc', 'u.conversation_id', 'nc.id')
          .innerJoin('core.team as t', 'u.team_id', 't.id')
          .select([
            'u.conversation_id',
            't.name as team_name',
            'nc.title as conversation_title',
            'nc.created_at as conversation_created_at',
            sql<number>`count(*)::int`.as('call_count'),
            sql<number>`sum(u.input_tokens)::int`.as('total_input_tokens'),
            sql<number>`sum(u.output_tokens)::int`.as('total_output_tokens'),
            sql<number>`sum(u.cost_microdollars)::int`.as('total_cost_microdollars'),
          ])
          .where('u.created_at', '>=', new Date(input.startDate))
          .where('u.created_at', '<=', new Date(input.endDate))
          .where('u.conversation_id', 'is not', null)
          .groupBy(['u.conversation_id', 't.name', 'nc.title', 'nc.created_at'])
          .orderBy('nc.created_at', 'desc')
          .limit(input.limit);

        if (input.teamId) {
          query = query.where('u.team_id', '=', input.teamId as TeamId);
        }

        return query.execute();
      }),

    pipelineDetail: procedure
      .input(z.object({ pipelineId: z.string().uuid() }))
      .query(async ({ input }) => {
        return getQb(['llm_usage'])
          .selectFrom('llm_usage')
          .selectAll()
          .where('pipeline_id', '=', input.pipelineId as DealflowPipelineId)
          .orderBy('created_at', 'asc')
          .execute();
      }),

    conversationDetail: procedure
      .input(z.object({ conversationId: z.string().uuid() }))
      .query(async ({ input }) => {
        return getQb(['llm_usage'])
          .selectFrom('llm_usage')
          .selectAll()
          .where('conversation_id', '=', input.conversationId as AgentConversationId)
          .orderBy('created_at', 'asc')
          .execute();
      }),

    teams: procedure.query(async () => {
      return getQb(['llm_usage', 'core.team'])
        .selectFrom('llm_usage as u')
        .innerJoin('core.team as t', 'u.team_id', 't.id')
        .select(['u.team_id', 't.name as team_name'])
        .groupBy(['u.team_id', 't.name'])
        .orderBy('t.name', 'asc')
        .execute();
    }),
  });

export { llmUsageRouter };
