// Which user (and, for an author-time connect LINK, which connect token) an
// OAuth attempt belongs to, by its state, until the attempt expires. The
// mechanism is the connect flow's (`createPendingStates`); the binding is the
// platform's.

import { createPendingStates } from 'movement-engine/public/secrets';

interface FlowEntry {
  userId: string;
  // Set only for the author-time connect-LINK flow: the connect_token whose
  // landing page started this OAuth. When present, the connector callback
  // redirects back to the connect-landing `/complete` route (which persists the
  // credential server-side) instead of the popup's web BroadcastChannel page.
  connectToken?: string;
}

const flows = createPendingStates<FlowEntry>();

function bindFlowToUser(state: string, userId: string, options?: { connectToken?: string }) {
  flows.put(state, { userId, ...(options?.connectToken ? { connectToken: options.connectToken } : {}) });
}

// Read without consuming — concurrent requests (React strict mode) may need
// the same state. The entry expires on its own.
function getFlowUserId(state: string): string | undefined {
  return flows.peek(state)?.userId;
}

/** The connect_token bound to this OAuth flow, if it was a connect-LINK flow. */
function getFlowConnectToken(state: string): string | undefined {
  return flows.peek(state)?.connectToken;
}

function extractStateFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('state') ?? undefined;
  } catch {
    return undefined;
  }
}

export { bindFlowToUser, getFlowUserId, getFlowConnectToken, extractStateFromUrl };
