import type { MessageThoughts } from './agent_types';
import type { AgentUpdate } from '../openai/types';
import type { AgentConversationId } from '../../generated/kysely/public/AgentConversation';

import { currentContext } from '../../services/context';
import { logger } from 'movement-engine/public/log';
import { getNavigation } from '../../services/navigation_state';
import {
  buildRecentThoughtsPrefix,
  compactIfDue,
  selectRecentWindowAssistantIds,
} from '../../services/agent_running_state';
import { mq } from '../message_queue';
import {
  getAgent,
  initAgentRegistry,
  type AgentDomain,
  type AgentInvocationFunnelContext,
  type AgentResult,
} from './agent_registry';
import { HandoffSignal, HandBackSignal, buildHandoffToolDefinitions, buildHandoffToolImpls } from './handoff';
import { attachEditorActionDeriver } from './editor_actions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HANDOFF_DEPTH = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationTurnOptions {
  conversationId: string;
  /** The user's message. Omitted on recursive handoff/hand-back re-entry. */
  userMessage?: string;
  sessionId: string;
  /** Domain-specific options forwarded to the agent runner */
  domainOptions?: Record<string, unknown>;
}

interface PersistedMessage {
  id: string;
  role: string;
  content: string;
  agent: string | null;
  messageType: string;
  metadata: Record<string, unknown> | null;
  context: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// History filtering
// ---------------------------------------------------------------------------

/**
 * Filter conversation messages to build the context window for a given agent.
 *
 * An agent sees:
 * - Its own chat messages (agent tag matches or is null + conversation agent_type matches)
 * - Referral messages addressed to it
 * - Discharge messages addressed to it
 *
 * M4: when `recentWindowAssistantIds` is supplied, assistant messages
 * whose id is in the set get their `metadata.thoughts` (extended
 * thinking + tool-call trace) prepended to their text content via the
 * `<prior_thinking>` / `<prior_tool_calls>` wrapper. This is the
 * sliding-window mechanism — the recent K assistant turns ride
 * verbatim with their reasoning visible to the model on the next
 * turn, while older turns are summarised into the system-prompt
 * running-state paragraph by Haiku.
 *
 * Why prepended-into-text rather than native Anthropic `thinking`
 * blocks: see `buildRecentThoughtsPrefix` in
 * `services/agent_running_state.ts` for the signature-validation
 * constraint that forces path (b).
 *
 */
function filterHistoryForAgent(
  messages: PersistedMessage[],
  activeAgent: AgentDomain,
  conversationAgentType: string,
  recentWindowAssistantIds?: Set<string>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const msg of messages) {
    // Resolve effective agent: null → conversation's agent_type (legacy
    // compat), then collapse retired domains onto unified so the unified
    // agent inherits its predecessors' history.
    const effectiveAgent = normalizeAgentDomain(
      (msg.agent as AgentDomain) ?? mapAgentType(conversationAgentType),
    );

    if (msg.messageType === 'chat') {
      if (effectiveAgent !== activeAgent) continue;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      let content = msg.content;
      if (msg.role === 'assistant' && msg.context) {
        content = `${content}\n\n[${msg.context}]`;
      }

      // M4: enrich recent-window assistant turns with their captured
      // thoughts so the model sees its own prior reasoning. Stays a
      // no-op for assistant turns outside the window (those get the
      // gist via the running-state summary instead) and for turns
      // with no captured thoughts (text-only / pre-M2 rows).
      if (
        msg.role === 'assistant' &&
        recentWindowAssistantIds &&
        recentWindowAssistantIds.has(msg.id)
      ) {
        const thoughts = (msg.metadata as Record<string, unknown> | null)?.thoughts as
          | MessageThoughts
          | undefined;
        const prefix = buildRecentThoughtsPrefix(thoughts);
        if (prefix) content = `${prefix}${content}`;
      }

      history.push({ role: msg.role, content });
    } else if (msg.messageType === 'referral' || msg.messageType === 'discharge') {
      const meta = msg.metadata as Record<string, unknown> | null;
      const addressedTo = meta?.to as string | undefined;
      if (addressedTo && normalizeAgentDomain(addressedTo as AgentDomain) === activeAgent) {
        // Inject as a user message so the agent sees it as context
        history.push({ role: 'user', content: msg.content });
      }
    }
    // Skip document_event and other types
  }

  return history;
}

/**
 * Map legacy agent_type values to AgentDomain.
 *
 * Every retired knowledge domain (query / ontology / output / output-v3 /
 * movement / system / setup / translation) collapses onto the unified
 * agent — see `normalizeAgentDomain` below.
 */
function mapAgentType(_agentType: string): AgentDomain {
  return 'unified';
}

/**
 * Collapse retired knowledge domains onto the unified agent.
 *
 * Conversations (and persisted message tags / referral addresses) created
 * before the unification carry domains like 'query' or 'ontology'. At
 * dispatch and history-filtering time these are all the same agent now —
 * the unified consultant sees its predecessors' history as its own.
 */
function normalizeAgentDomain(domain: AgentDomain | (string & {})): AgentDomain {
  switch (domain) {
    case 'query':
    case 'ontology':
    case 'output':
    case 'output-v3':
    case 'movement':
    case 'system':
    // Setup now collapses too — the onboarding funnel lands users on the
    // universal agent, primed with the funnel context (rendered as a
    // system block), instead of routing to a separate setup agent. The
    // setup agent has been deleted; legacy conversations/messages tagged
    // 'setup' still collapse here.
    case 'setup':
    // The TG chat-authoring agent has been retired; legacy convos tagged
    // 'translation' collapse onto the unified agent.
    case 'translation':
      return 'unified';
    default:
      return domain as AgentDomain;
  }
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/**
 * Run a single conversation turn. This is the unified entry point that replaces
 * the three separate agent tRPC background workers.
 *
 * Flow:
 * 1. Load conversation state (active_agent, handoff_depth)
 * 2. Filter message history for the active agent
 * 3. Dispatch to the agent via the registry
 * 4. Persist the response with agent tag
 * 5. Handle handoff/hand-back signals (recursive dispatch)
 */
export async function runConversationTurn(options: ConversationTurnOptions): Promise<AgentResult> {
  await initAgentRegistry();

  const { conversationId, sessionId, domainOptions } = options;
  const ctx = currentContext();
  const prisma = ctx.prisma;

  // Agent execution must NOT be attributed to the tab that requested it:
  // the chat request carried that tab's origin (inherited into this
  // background context), but the agent's writes should refresh EVERY tab,
  // including the requester's — they can't see the result otherwise. Clear
  // it so the resource-change emits downstream carry no origin.
  ctx.originId = undefined;

  // 1. Load conversation — the acting team's, or none.
  //
  // This is the seam the whole turn hangs off: every message write below is
  // keyed by `conversationId`, and the team the agent runs as comes off this
  // row. Scoping it here is what makes all of that in-team by construction, and
  // it is why the loaded `teamId` can be handed to the agent as authoritative.
  // Callers already check ownership at their own door; this is the guarantee
  // that does not depend on them remembering to.
  const conversation = await prisma.agentConversation.findFirstOrThrow({
    where: { id: conversationId, teamId: ctx.user.teamId },
    include: { agentMessages: { orderBy: { createdAt: 'asc' } } },
  });

  const activeAgent = normalizeAgentDomain(conversation.activeAgent as AgentDomain);
  const handoffDepth = conversation.handoffDepth;
  const agentConfig = getAgent(activeAgent);

  // 2. Filter history
  const allMessages = conversation.agentMessages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
    agent: msg.agent,
    messageType: msg.messageType,
    metadata: msg.metadata as Record<string, unknown> | null,
    context: msg.context,
    createdAt: msg.createdAt,
  }));

  // M4: when the agent has running-state enabled, identify the
  // recent K assistant turns that should ride verbatim with their
  // prior thoughts in the messages array. Empty set otherwise — older
  // M3-only call sites and opted-out agents see plain string history.
  //
  // We pick the window from the FULL persisted assistant list (not
  // filtered-for-agent yet) so cross-agent handoff turns are scored
  // by the same window the compaction service sees. The downstream
  // filter only keeps in-window ids that survive the agent filter,
  // which is exactly what we want — we don't want to enrich messages
  // the agent isn't supposed to see.
  const recentWindowAssistantIds = agentConfig.enableRunningState
    ? selectRecentWindowAssistantIds(allMessages)
    : undefined;

  const conversationHistory = filterHistoryForAgent(
    allMessages,
    activeAgent,
    conversation.agentType,
    recentWindowAssistantIds,
  );

  // 3. Build handoff tools
  const handoffToolDefs = buildHandoffToolDefinitions(agentConfig.canHandoffTo);
  const handoffToolImpls = buildHandoffToolImpls();

  // 3b. M3: Haiku running-state compaction. Runs BEFORE the tombstone
  //     write so the in-progress turn never gets fed into its own
  //     summary (the cursor advances past whatever was already
  //     persisted, not the slot we're about to write). Failures are
  //     swallowed inside the service — the agent still runs with a
  //     stale running state, which is strictly better than crashing
  //     the turn. Opt-in per agent via `enableRunningState`.
  let runningState: string | null = null;
  if (agentConfig.enableRunningState) {
    try {
      const snapshot = await compactIfDue(conversationId);
      runningState = snapshot.runningState;
    } catch (err) {
      logger.warn('[orchestrator] compactIfDue failed; running state unchanged', {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Write tombstone for restart recovery
  const tombstone = await prisma.agentMessage.create({
    data: {
      conversationId,
      role: 'assistant',
      content: '',
      agent: activeAgent,
      messageType: 'chat',
      metadata: { status: 'in_progress', startedAt: Date.now() },
    },
  });

  const emitUpdate = (update: Omit<AgentUpdate, 'sessionId' | 'timestamp'>) => {
    mq.agentUpdates.update.publish({
      sessionId,
      timestamp: Date.now(),
      ...update,
    });
  };

  // 4b. Snapshot navigation state at turn-start. The orchestrator
  //     surfaces this to the agent so tools have access to whatever
  //     pinned named references the prior turn (or the handing-off
  //     agent) left. Mutation goes through the NavigationState service
  //     directly from tool implementations — this is a read-only
  //     turn-start view.
  const navigationState = await getNavigation(conversationId as AgentConversationId);

  // 4c. Activity layer (V2). Observe this session's tool-call stream and
  //     project it into the semantic editor-action vocabulary the
  //     live-authoring view replays. Pure read-and-project at the
  //     orchestration seam — the agent and its tools are untouched. Torn
  //     down in `finally` so a turn never leaks a listener.
  // activity layer
  const detachEditorActions = attachEditorActionDeriver(sessionId);

  try {
    // 5. Dispatch to agent with handoff tools injected
    const result = await agentConfig.run({
      message: options.userMessage ?? '',
      sessionId,
      teamId: conversation.teamId,
      conversationId,
      conversationHistory,
      domainOptions,
      funnelContext: (conversation.funnelContext as AgentInvocationFunnelContext | null) ?? null,
      additionalToolDefs: handoffToolDefs,
      additionalToolImpls: handoffToolImpls,
      navigationState,
      runningState,
    });

    // 6. Normal completion — update tombstone → real message
    await prisma.agentMessage.update({
      where: { id: tombstone.id },
      data: {
        content: result.text,
        context: result.context ?? null,
        metadata: {
          trace: result.trace,
          suggestedActions: result.suggestedActions,
          attachments: result.attachments,
        } as any,
      },
    });

    await prisma.agentConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return result;
  } catch (error) {
    // 7. Handle handoff signal
    if (error instanceof HandoffSignal) {
      await prisma.agentMessage.delete({ where: { id: tombstone.id } }).catch(() => {});

      if (handoffDepth >= MAX_HANDOFF_DEPTH) {
        logger.warn('[orchestrator] handoff depth exceeded', { conversationId, depth: handoffDepth });
        return {
          text: "I've reached the limit of how many specialists I can consult in one go. Could you help me break this into smaller steps?",
          trace: [],
          suggestedActions: [],
          attachments: [],
        };
      }

      // Persist referral message
      await prisma.agentMessage.create({
        data: {
          conversationId,
          role: 'system',
          content: error.referral,
          agent: activeAgent,
          messageType: 'referral',
          metadata: { from: activeAgent, to: error.to } as any,
        },
      });

      // Update conversation to new agent
      await prisma.agentConversation.update({
        where: { id: conversationId },
        data: {
          activeAgent: error.to,
          handoffDepth: handoffDepth + 1,
          updatedAt: new Date(),
        },
      });

      emitUpdate({
        type: 'tool_call',
        message: `Handing off to ${error.to} agent...`,
        data: { handoff: { from: activeAgent, to: error.to } },
      });

      logger.info('[orchestrator] handoff', {
        conversationId,
        from: activeAgent,
        to: error.to,
        depth: handoffDepth + 1,
      });

      // Recurse — the referral is now persisted, new agent will see it via history filtering
      return runConversationTurn({
        conversationId,
        sessionId,
        domainOptions,
      });
    }

    // 8. Handle hand-back signal
    if (error instanceof HandBackSignal) {
      await prisma.agentMessage.delete({ where: { id: tombstone.id } }).catch(() => {});

      // Find who delegated to us via the most recent referral
      const lastReferral = await prisma.agentMessage.findFirst({
        where: {
          conversationId,
          messageType: 'referral',
          metadata: { path: ['to'], equals: activeAgent },
        },
        orderBy: { createdAt: 'desc' },
      });

      const returnTo: AgentDomain = normalizeAgentDomain(
        ((lastReferral?.metadata as any)?.from as AgentDomain) ?? 'unified',
      );

      // Persist discharge message
      await prisma.agentMessage.create({
        data: {
          conversationId,
          role: 'system',
          content: error.discharge,
          agent: activeAgent,
          messageType: 'discharge',
          metadata: { from: activeAgent, to: returnTo } as any,
        },
      });

      await prisma.agentConversation.update({
        where: { id: conversationId },
        data: {
          activeAgent: returnTo,
          handoffDepth: Math.max(0, handoffDepth - 1),
          updatedAt: new Date(),
        },
      });

      emitUpdate({
        type: 'tool_call',
        message: `Returning to ${returnTo} agent...`,
        data: { handBack: { from: activeAgent, to: returnTo } },
      });

      logger.info('[orchestrator] hand_back', {
        conversationId,
        from: activeAgent,
        to: returnTo,
        depth: Math.max(0, handoffDepth - 1),
      });

      // Recurse — the discharge is now persisted for the returning agent
      return runConversationTurn({
        conversationId,
        sessionId,
        domainOptions,
      });
    }

    // 9. Genuine error — clean up tombstone and rethrow
    await prisma.agentMessage.delete({ where: { id: tombstone.id } }).catch(() => {});

    logger.error('[orchestrator] agent turn failed', {
      conversationId,
      activeAgent,
      error: String(error),
    });
    throw error;
  } finally {
    detachEditorActions();
  }
}
