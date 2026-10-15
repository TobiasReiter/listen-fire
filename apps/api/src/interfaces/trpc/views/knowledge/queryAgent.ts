import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import * as db from '@prisma/client';
import { z } from 'zod';
import { observable } from '@trpc/server/observable';

import type { AgentUpdate } from '../../../../lib/openai/types';
import type { NodeTypeId } from '../../../../generated/kysely/knowledge/NodeType';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { AgentDomain } from '../../../../lib/knowledge/agent_registry';

import { services } from '../../../../adapters/registry';
import { currentContext } from '../../../../services/context';
import { UserService } from '../../../../services/user';
import { trpc } from '../../trpc';
import { abortAgent, getActiveSession, registerActiveSession, clearActiveSession } from '../../../../lib/knowledge/agent_sessions';
import { runConversationTurn } from '../../../../lib/knowledge/orchestrator';
import { mq } from '../../../../lib/message_queue';
import { LlmUsageContext } from '../../../../lib/llm_usage';
import { sendSlackNotification } from '../../../../lib/slack';
import { getKnowledgeQb } from '../../../../lib/kysely';
import { checkUsage, recordEvent, checkAndAlert, USAGE_EXHAUSTED_MESSAGES } from '../../../../services/usage';
import { logger } from 'movement-engine/services/logger';
import NodeTypeCategory from '../../../../generated/kysely/knowledge/NodeTypeCategory';
import { userProcedure as sharedUserProcedure } from '../../procedures';

const AGENT_TYPE = 'knowledge_query';

/**
 * Agent types whose conversations appear in the unified history list.
 * These are the web surfaces of the retired per-domain agents — the
 * orchestrator collapses all of them onto the unified agent at dispatch,
 * so any of these conversations can be resumed seamlessly.
 */
const UNIFIED_HISTORY_AGENT_TYPES = [
  'knowledge_query',
  'knowledge_unified',
  'knowledge_ontology',
  'output_agent',
  'knowledge_output',
  'knowledge_system',
  'knowledge_movement',
];

/** Plain-language origin labels for conversations created under a
 *  retired domain surface. Keyed by agentType first (the per-domain tRPC
 *  views each used their own), then by activeAgent for orchestrator-era
 *  rows. `null` means the conversation is native to the unified agent. */
const LEGACY_AGENT_TYPE_LABELS: Record<string, string> = {
  knowledge_ontology: 'Data model',
  output_agent: 'Destinations',
  knowledge_output: 'Destinations',
  knowledge_system: 'Activity',
  knowledge_movement: 'Movements',
};

const LEGACY_ACTIVE_AGENT_LABELS: Record<string, string> = {
  query: 'Query',
  ontology: 'Data model',
  output: 'Destinations',
  'output-v3': 'Destinations',
  translation: 'Destinations',
  movement: 'Movements',
  system: 'Activity',
  setup: 'Setup',
};

function legacyDomainLabel(conv: { agentType: string; activeAgent: string }): string | null {
  const byType = LEGACY_AGENT_TYPE_LABELS[conv.agentType];
  if (byType) return byType;
  if (conv.activeAgent === 'unified') return null;
  return LEGACY_ACTIVE_AGENT_LABELS[conv.activeAgent] ?? null;
}

/**
 * Does the acting team own this stored object?
 *
 * An `objectUri` is `s3://<bucket>/<uuid>/<filename>` — an opaque storage key
 * with no tenant in it, in one bucket shared by every team. So ownership is not
 * a property of the string; it is a property of whether one of the acting team's
 * OWN ROWS records it. Three do, and they are the three ways an object reaches a
 * conversation surface:
 *
 *  1. a `document` the team uploaded (`document.object_uri`, team-scoped column);
 *  2. the conversation's WORKING DOCUMENT (`agent_conversation
 *     .working_document_uri`, on a team-scoped row);
 *  3. an agent-GENERATED attachment, which has no document row at all — it is
 *     recorded only in `agent_message.metadata.attachments[]`, and reaches a team
 *     through its conversation. This is the case the UI actually downloads, so a
 *     check that only consulted `document` would have blanked the feature rather
 *     than narrowing it.
 *
 * `exposed_file` is deliberately NOT one of them: that table has no team column
 * because it IS the capability — an unguessable id served unauthenticated to a
 * third party (`interfaces/rest/files.ts`). It is not reachable from here.
 *
 */
async function ownsObject(objectUri: string): Promise<boolean> {
  const ctx = currentContext();
  const teamId = ctx.user.teamId;

  const [document, workingDocument, attachment] = await Promise.all([
    ctx.prisma.document.findFirst({ where: { objectUri, teamId }, select: { id: true } }),
    ctx.prisma.agentConversation.findFirst({
      where: { workingDocumentUri: objectUri, teamId },
      select: { id: true },
    }),
    ctx.prisma.agentMessage.findFirst({
      where: {
        agentConversation: { teamId },
        metadata: { path: ['attachments'], array_contains: [{ objectUri }] },
      },
      select: { id: true },
    }),
  ]);

  return document !== null || workingDocument !== null || attachment !== null;
}

const queryAgentRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /**
     * The knowledge chat entrypoint — routes to the unified agent via the
     * orchestrator. Supports handoffs, agent-tagged messages, and restart
     * recovery. (Replaced the legacy `ask` mutation, now removed.)
     */
    sendMessage: userProcedure
      .input(
        z.object({
          message: z.string(),
          sessionId: z.string(),
          conversationId: z.string().optional(),
          domain: z.enum(['unified', 'query', 'ontology', 'output', 'system']).optional(),
          documentIds: z.array(z.string()).optional(),
          documentMode: z.enum(['collaborating', 'input']).optional(),
          /** The user is watching (Follow armed) — author as a narrated build stage. */
          showMode: z.boolean().optional(),
          /**
           * Snapshot of the page the user is viewing, attached per turn by
           * the slide-over assistant panel. Rendered into the unified
           * agent's prompt as orientation — informs, never authorises.
           */
          pageContext: z
            .object({
              page: z.string().max(200),
              path: z.string().max(500).optional(),
              entities: z
                .array(
                  z.object({
                    kind: z.string().max(100),
                    id: z.string().max(200).optional(),
                    name: z.string().max(500).optional(),
                  }),
                )
                .max(50)
                .optional(),
              extras: z.record(z.string(), z.string()).optional(),
            })
            .optional(),
          /**
           * Onboarding-funnel leaf the user picked at `/setup`. Stored on
           * the conversation row on creation and read by the Setup agent
           * to prime its first turn. Only honoured when creating a new
           * conversation; ignored on resume.
           */
          funnelContext: z
            .object({
              leafSlug: z.string(),
              pain: z.string(),
              painShape: z.string(),
              domain: z.string(),
              primer: z.string().optional(),
              suggestedArc: z.enum(['integration-first', 'model-first']).nullable(),
              templateRef: z.string().optional(),
            })
            .optional(),
        }),
      )
      .mutation(async ({ input: { message, sessionId, conversationId, domain, documentIds, documentMode, funnelContext, pageContext, showMode } }) => {
        const ctx = currentContext();
        const prisma = ctx.prisma;
        const teamId = ctx.user.teamId;
        const userId = ctx.user.id;

        let convId = conversationId;

        if (convId) {
          const conversation = await prisma.agentConversation.findFirst({
            where: { id: convId, teamId },
          });
          if (!conversation) throw new Error('Conversation not found');
        } else {
          // New conversations default onto the unified agent — the
          // orchestrator already collapses the retired domains onto it
          // at dispatch, so this only changes the persisted tag.
          const activeDomain = domain ?? 'unified';
          const conversation = await prisma.agentConversation.create({
            data: {
              teamId,
              userId,
              agentType: AGENT_TYPE,
              activeAgent: activeDomain,
              title: message.slice(0, 100),
              ...(funnelContext ? { funnelContext } : {}),
            },
          });
          convId = conversation.id;
        }

        const resolvedMessage = message;

        // Read active agent from conversation to tag the user message correctly
        const conv = await prisma.agentConversation.findFirstOrThrow({
          where: { id: convId, teamId },
        });

        // Attached files: keep only documents that belong to this team,
        // and resolve their filenames so the conversation history can
        // render attachment chips without re-fetching document rows.
        let uploadedFiles: Array<{ documentId: string; filename: string }> = [];
        if (documentIds && documentIds.length > 0) {
          const docs = await prisma.document.findMany({
            where: { id: { in: documentIds }, teamId },
            select: { id: true, description: true },
          });
          const nameById = new Map(docs.map((d) => [d.id, d.description]));
          uploadedFiles = documentIds
            .filter((id) => nameById.has(id))
            .map((id) => ({ documentId: id, filename: nameById.get(id) ?? 'document' }));
        }

        // Write user message with agent tag
        await prisma.agentMessage.create({
          data: {
            conversationId: convId,
            role: 'user',
            content: resolvedMessage,
            agent: conv.activeAgent,
            messageType: 'chat',
            ...(uploadedFiles.length > 0
              ? {
                  metadata: {
                    uploadedDocumentIds: uploadedFiles.map((f) => f.documentId),
                    uploadedFiles,
                  },
                }
              : {}),
          },
        });

        // Usage gating
        await recordEvent({
          teamId,
          eventType: 'query_input',
          referenceId: convId,
          createdBy: userId,
        });
        const usage = await checkUsage(teamId, 'query_input');
        if (usage && !usage.allowed) {
          await prisma.agentMessage.create({
            data: {
              conversationId: convId,
              role: 'assistant',
              content: USAGE_EXHAUSTED_MESSAGES.query_input,
              agent: conv.activeAgent,
              messageType: 'chat',
            },
          });
          checkAndAlert(teamId, 'query_input').catch((err) =>
            logger.error('Usage alert failed', { error: String(err) }),
          );
          return { conversationId: convId! };
        }
        checkAndAlert(teamId, 'query_input').catch((err) =>
          logger.error('Usage alert failed', { error: String(err) }),
        );

        UserService.getById(userId).then((user) =>
          sendSlackNotification({
            type: 'LIVE_FEED',
            text: `:mag: [${conv.activeAgent}] ${user.email} — ${message.slice(0, 200)}`,
            opsTitle: `Web query from ${user.email}: ${message.slice(0, 80)}`,
          }).catch(() => {}),
        );

        // Fire and forget — result delivered via onUpdate subscription
        const backgroundWork = async () => {
          // Register session at the orchestrator level so it persists across handoffs
          registerActiveSession(convId!, sessionId);
          try {
            const usageContext = new LlmUsageContext({ teamId, conversationId: convId! });
            await usageContext.runAsync(() =>
              runConversationTurn({
                conversationId: convId!,
                userMessage: resolvedMessage,
                sessionId,
                domainOptions: {
                  channel: 'web',
                  uploadedDocumentIds:
                    uploadedFiles.length > 0
                      ? uploadedFiles.map((f) => f.documentId)
                      : undefined,
                  documentMode,
                  ...(pageContext ? { pageContext } : {}),
                  ...(showMode ? { showMode: true } : {}),
                },
              }),
            );
          } catch (error) {
            logger.error('[sendMessage] orchestrator failed', { conversationId: convId, error: String(error) });
            await prisma.agentMessage.create({
              data: {
                conversationId: convId!,
                role: 'assistant',
                content: 'Sorry, something went wrong while processing your message. Please try again.',
                agent: conv.activeAgent,
                messageType: 'chat',
              },
            });
          } finally {
            clearActiveSession(convId!);
          }
        };

        backgroundWork().catch((err) => logger.error('[sendMessage] background error', { error: String(err) }));

        return { conversationId: convId! };
      }),

    cancelAgent: userProcedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ input }) => {
        return { aborted: abortAgent(input.sessionId) };
      }),

    setDocumentMode: userProcedure
      .input(z.object({ conversationId: z.string(), mode: z.enum(['collaborating', 'input']) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.prisma.agentConversation.updateMany({
          where: { id: input.conversationId, teamId: ctx.user.teamId },
          data: { documentMode: input.mode },
        });
      }),

    getActiveSession: userProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(({ input }) => {
        return getActiveSession(input.conversationId);
      }),

    getConversation: userProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        // No agentType filter: conversations started under the retired
        // per-domain surfaces (ontology / output / system / movement)
        // open here and continue in the unified agent — the orchestrator
        // collapses those domains and inherits their history.
        const conversation = await ctx.prisma.agentConversation.findFirst({
          where: { id: input.conversationId, teamId: ctx.user.teamId },
          include: { agentMessages: { orderBy: { createdAt: 'asc' } } },
        });
        if (!conversation) throw new Error('Conversation not found');
        return {
          ...conversation,
          agentMessages: conversation.agentMessages.filter(
            (m) => m.role !== 'document_event' && m.messageType !== 'document_event',
          ),
        };
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

    /**
     * Every web conversation the user has had with the knowledge agents,
     * across the retired per-domain surfaces. Legacy conversations carry
     * a plain-language `legacyDomain` label ("Query", "Data model", …)
     * so the unified surface can badge their origin; opening any of them
     * continues in the unified agent with inherited history. Channel-
     * bound conversations (Slack / WhatsApp) and the still-independent
     * translation / setup surfaces are excluded.
     */
    listAllConversations: userProcedure.query(async () => {
      const ctx = currentContext();
      const conversations = await ctx.prisma.agentConversation.findMany({
        where: {
          teamId: ctx.user.teamId,
          userId: ctx.user.id,
          agentType: { in: UNIFIED_HISTORY_AGENT_TYPES },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        include: { agentMessages: { take: 1, orderBy: { createdAt: 'asc' } } },
      });
      return conversations.map((conv) => ({
        id: conv.id,
        title: conv.title,
        updatedAt: conv.updatedAt,
        preview: conv.agentMessages[0]?.content ?? null,
        legacyDomain: legacyDomainLabel({
          agentType: conv.agentType,
          activeAgent: conv.activeAgent,
        }),
      }));
    }),

    getWorkingDocument: userProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const conv = await ctx.prisma.agentConversation.findFirst({
          where: { id: input.conversationId, teamId: ctx.user.teamId, agentType: AGENT_TYPE },
          select: { workingDocumentUri: true, workingDocumentTitle: true },
        });
        if (!conv) throw new Error('Conversation not found');
        if (!conv.workingDocumentUri) return { content: '', title: conv.workingDocumentTitle };
        const file = await services.document.getFile({ objectUri: conv.workingDocumentUri });
        if (!file) return { content: '', title: conv.workingDocumentTitle };
        const chunks: Buffer[] = [];
        const reader = file.webStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
        return { content: Buffer.concat(chunks).toString('utf-8'), title: conv.workingDocumentTitle };
      }),

    updateWorkingDocument: userProcedure
      .input(
        z.object({
          conversationId: z.string(),
          content: z.string(),
          title: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const conv = await ctx.prisma.agentConversation.findFirst({
          where: { id: input.conversationId, teamId: ctx.user.teamId, agentType: AGENT_TYPE },
          select: { id: true, workingDocumentUri: true },
        });
        if (!conv) throw new Error('Conversation not found');
        const hadPreviousDoc = !!conv.workingDocumentUri;
        if (conv.workingDocumentUri) {
          await services.document.delete(conv.workingDocumentUri);
        }
        const buf = Buffer.from(input.content, 'utf-8');
        const result = await services.document.upload(Readable.from(buf), {
          filename: 'working-document.md',
          mimeType: 'text/markdown',
          contentLength: buf.length,
        });
        const updateData: Record<string, unknown> = {
          workingDocumentUri: result.objectUri,
          updatedAt: new Date(),
        };
        if (input.title !== undefined) updateData.workingDocumentTitle = input.title;
        await ctx.prisma.agentConversation.update({
          where: { id: conv.id },
          data: updateData,
        });
        const eventText = hadPreviousDoc
          ? 'The user manually edited the working document.'
          : 'The user created a new blank working document.';
        await ctx.prisma.agentMessage.create({
          data: { conversationId: conv.id, role: 'document_event', content: eventText },
        });
        return { success: true };
      }),

    discardWorkingDocument: userProcedure
      .input(z.object({ conversationId: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const conv = await ctx.prisma.agentConversation.findFirst({
          where: { id: input.conversationId, teamId: ctx.user.teamId, agentType: AGENT_TYPE },
          select: { id: true, workingDocumentUri: true },
        });
        if (!conv) throw new Error('Conversation not found');
        if (conv.workingDocumentUri) {
          await services.document.delete(conv.workingDocumentUri);
        }
        await ctx.prisma.agentConversation.update({
          where: { id: conv.id },
          data: { workingDocumentUri: null, workingDocumentTitle: null, updatedAt: new Date() },
        });
        await ctx.prisma.agentMessage.create({
          data: { conversationId: conv.id, role: 'document_event', content: 'The user discarded the working document.' },
        });
        return { success: true };
      }),

    // Minting a signed URL for whatever `objectUri` the client sends was a
    // cross-team read: the uri is `s3://<bucket>/<uuid>/<filename>`, an opaque
    // storage key that carries no tenant, and one shared bucket holds every
    // team's objects. Anyone holding a uri could download it as anyone.
    //
    // The mapping from an object back to a team is not in the key, so it has to
    // be LOOKED UP, and there are exactly three places this product records one
    // (`ownsObject` below). The check is an ownership proof, not a guess: an
    // object no row of the acting team's names is refused, which is the same
    // answer a team gets for an object that does not exist — a probe learns
    // nothing either way.
    getAttachmentUrl: userProcedure
      .input(z.object({ objectUri: z.string() }))
      .query(async ({ input }) => {
        if (!(await ownsObject(input.objectUri))) {
          throw new Error('Attachment not found');
        }
        const downloadUrl = await services.document.getDownloadUrl({ objectUri: input.objectUri });
        return { downloadUrl };
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

export { queryAgentRouter };
