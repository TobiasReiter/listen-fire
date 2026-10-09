// In-process tRPC caller for flat MCP tools.
//
// MCP requests already run inside an authenticated `Context` (the auth + ability
// middleware run before the connectors are mounted), and the tRPC procedures
// read their auth/team from `currentContext()`, not from the tRPC context. So a
// tool handler can invoke a procedure directly through this caller — no loopback
// HTTP, no parallel REST route — and reuse the exact logic the web app uses.

import type { McpToolResult } from './server';

import { trpcRouter } from '../trpc';

/** A caller bound to the request's ambient (express-established) context. */
function getTrpcCaller() {
  return trpcRouter.createCaller({ authorise: async () => {} });
}

/** Wrap a JSON-serialisable value as an MCP text-content result. */
function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Run a handler body, returning its value as a tool result or a JSON error. */
async function toolHandler(fn: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) },
      ],
      isError: true,
    };
  }
}

export { getTrpcCaller, jsonResult, toolHandler };
