import { logger } from 'movement-engine/services/logger';

// Active-agent abort registry + per-conversation session tracking (extracted
// from the retired query_agent.ts; used by the unified web-chat view + shutdown).
const activeAgents = new Map<string, AbortController>();

// Track active sessions by conversationId so clients can reconnect
const activeSessionsByConversation = new Map<string, { sessionId: string; status: string }>();

export function getActiveSession(conversationId: string): { sessionId: string; status: string } | null {
  return activeSessionsByConversation.get(conversationId) ?? null;
}

export function registerActiveSession(conversationId: string, sessionId: string, status = 'Working on it…'): void {
  activeSessionsByConversation.set(conversationId, { sessionId, status });
}

export function clearActiveSession(conversationId: string): void {
  activeSessionsByConversation.delete(conversationId);
}

export function abortAgent(sessionId: string): boolean {
  const controller = activeAgents.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// Abort all active agents and wait for them to finish persisting their results.
// Used during graceful shutdown so interrupted messages get saved to the DB.
export function shutdownAgents(timeoutMs = 10_000): Promise<void> {
  const count = activeAgents.size;
  if (count === 0) return Promise.resolve();

  logger.info(`[query_agent] shutting down ${count} active agent(s)`);
  for (const controller of activeAgents.values()) {
    controller.abort();
  }

  // Wait until all agents have cleaned up (they delete themselves from the map in their finally block)
  return new Promise((resolve) => {
    const deadline = setTimeout(resolve, timeoutMs);
    const poll = setInterval(() => {
      if (activeAgents.size === 0) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 100);
  });
}
