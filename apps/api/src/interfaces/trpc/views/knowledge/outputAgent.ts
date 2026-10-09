// Output agent tRPC router

import { z } from 'zod';
import { observable } from '@trpc/server/observable';

import type { AgentUpdate } from '../../../../lib/openai/types';

import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { runOutputAgent } from '../../../../lib/knowledge/output_agent';
import { mq } from '../../../../lib/message_queue';
import { LlmUsageContext } from '../../../../lib/llm_usage';
import { userProcedure as sharedUserProcedure } from '../../procedures';

const AGENT_TYPE = 'output_agent';

const outputAgentRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    ask: userProcedure
      .input(
        z.object({
          message: z.string(),
          sessionId: z.string(),
          conversationId: z.string().optional(),
          outputId: z.string().optional(),
          currentConfig: z.unknown().nullable(),
          adapterType: z.string(),
          credentialsId: z.string().nullable(),
        }),
      )
      .mutation(async ({ input: { message, sessionId, conversationId, outputId, currentConfig, adapterType, credentialsId } }) => {
        const ctx = currentContext();
        const prisma = ctx.prisma;
        const teamId = ctx.user.teamId;

        let convId = conversationId;
        let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        if (convId) {
          const conversation = await prisma.agentConversation.findFirst({
            where: { id: convId, teamId, agentType: AGENT_TYPE },
            include: { agentMessages: { orderBy: { createdAt: 'asc' } } },
          });
          if (!conversation) throw new Error('Conversation not found');
          conversationHistory = conversation.agentMessages.map((msg) => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          }));
        } else {
          const conversation = await prisma.agentConversation.create({
            data: { teamId, userId: ctx.user.id, agentType: AGENT_TYPE, title: message.slice(0, 100) },
          });
          convId = conversation.id;
        }

        await prisma.agentMessage.create({
          data: { conversationId: convId, role: 'user', content: message },
        });

        // Fire and forget — result delivered via onUpdate subscription
        const backgroundWork = async () => {
          const usageContext = new LlmUsageContext({ teamId, conversationId: convId! });
          const result = await usageContext.runAsync(() =>
            runOutputAgent(message, {
              sessionId,
              teamId,
              conversationHistory,
              currentConfig: currentConfig as any,
              adapterType,
              credentialsId,
            }),
          );

          await prisma.agentMessage.create({
            data: { conversationId: convId, role: 'assistant', content: result.text },
          });

          await prisma.agentConversation.updateMany({
            where: { id: convId, teamId },
            data: { updatedAt: new Date() },
          });

          if (outputId && result.config) {
            // `outputId` arrives from the client unverified — the only thing
            // keeping this write inside the acting team is the condition here,
            // so it is an updateMany (a no-op on someone else's row) rather
            // than an update by id. An output has no team of its own; it takes
            // one from its configuration, the same way `output_agent`'s own
            // save does.
            await prisma.pipelineOutput.updateMany({
              where: { id: outputId, pipelineConfiguration: { teamId } },
              data: { config: result.config as any, configVersion: 3, updatedAt: new Date() },
            });
          }
        };

        backgroundWork().catch((err) => console.error('Output agent background error:', err));

        return { conversationId: convId };
      }),

    getConversation: userProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const conversation = await ctx.prisma.agentConversation.findFirst({
          where: { id: input.conversationId, teamId: ctx.user.teamId, agentType: AGENT_TYPE },
          include: { agentMessages: { orderBy: { createdAt: 'asc' } } },
        });
        if (!conversation) throw new Error('Conversation not found');
        return conversation;
      }),

    listConversations: userProcedure.query(async () => {
      const ctx = currentContext();
      return ctx.prisma.agentConversation.findMany({
        where: { teamId: ctx.user.teamId, userId: ctx.user.id, agentType: AGENT_TYPE },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        include: { agentMessages: { take: 1, orderBy: { createdAt: 'asc' } } },
      });
    }),

    onUpdate: procedure
      .input(z.object({ sessionId: z.string() }))
      .subscription(async ({ input: { sessionId } }) => {
        return observable<AgentUpdate>((emit) => {
          const onMessage = (update: AgentUpdate) => {
            if (update.sessionId === sessionId) {
              emit.next(update);
            }
          };
          mq.agentUpdates.bySessionId.on('message', onMessage);
          return () => {
            mq.agentUpdates.bySessionId.off('message', onMessage);
          };
        });
      }),
  });
};

export { outputAgentRouter };
