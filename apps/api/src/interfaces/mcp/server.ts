import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import { getEnvVar } from '../../lib/utils/environment';
import { isClientAbort } from '../../lib/middleware/context';
import { logger } from 'movement-engine/public/log';
import { describeRoutes, validateCallApiBody } from './registry';

const PORT = process.env.PORT ?? 3000;

// The server's own icon, declared on Implementation.icons (MCP spec) so
// connector UIs render the product mark instead of scraping a favicon. The
// file is the apps/web app icon, copied into apps/api/public (served by the
// express.static mount) so the URL lives on the same origin as the MCP
// endpoints regardless of how the web app is deployed.
function serverIcons() {
  const base = getEnvVar('API_BASE_URL', { devDefault: `http://localhost:${PORT}` }).replace(
    /\/$/,
    '',
  );
  return [{ src: `${base}/listen-fire-icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] }];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ZodShape = Record<string, z.ZodType>;

/** The MCP tool-call return shape (text content + optional error flag). */
type McpToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /** Out-of-band data for a client that asked for it — never model context. */
  _meta?: Record<string, unknown>;
};

/**
 * An MCP App (SEP-1865): an HTML view the client renders in the chat, handed
 * the result of the tool that nominated it.
 *
 * The view is a resource on this server, fetched over the same authenticated
 * connection the tools ride, and it is INERT for any client that doesn't
 * implement the extension — the declaration lives in `_meta`, which such a
 * client ignores, and the data with it.
 *
 * @see https://modelcontextprotocol.io/extensions/apps/overview
 */
interface ToolApp {
  /** The `ui://` resource the client fetches and renders. */
  resourceUri: string;
  title: string;
  description: string;
  /** The view itself: ONE self-contained HTML document. */
  html: () => Promise<string>;
  /** What the view draws, attached to the result's `_meta`. */
  data: (result: McpToolResult) => Promise<Record<string, unknown> | undefined>;
}

/** MIME type the extension reserves for an app view (exact string, required). */
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The tool-side declaration, in both spellings the extension defines: the
 * nested field is current, the flat key is the pre-GA form. The reference SDK
 * emits both, and a host that reads only the one we omitted renders nothing —
 * silently — so we emit both too.
 */
function appToolMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri }, 'ui/resourceUri': resourceUri };
}

/**
 * Attach what the view draws — and never fail the call over a picture. A tool
 * that can't produce its data returns the result it always returned, and the
 * view falls back to what that result already says.
 */
async function withAppData(result: McpToolResult, app: ToolApp): Promise<McpToolResult> {
  if (result.isError) return result;
  const data = await app.data(result).catch(() => undefined);
  if (!data) return result;
  return { ...result, _meta: { ...result._meta, ...data } };
}

/**
 * A top-level MCP tool. It resolves EITHER by proxying an internal REST
 * `endpoint` (the router does the loopback call) OR by running a direct
 * `handler` in-process — exactly one must be set. A `handler` runs inside the
 * already-authenticated request `Context`, so it can call domain services or
 * the tRPC procedures (via a caller) directly, with no REST round-trip.
 */
interface TopLevelTool {
  /** Human display name (≤64 chars) — required for the Anthropic connectors
   *  directory, which also requires every tool to carry a safety annotation
   *  (readOnlyHint or destructiveHint). Enforced at registration. */
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: ZodShape;
  /** The internal API endpoint this tool proxies (mutually exclusive with `handler`). */
  endpoint?: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    /**
     * The internal API path. May contain `:param` segments — matching tool
     * args are substituted into the path (and removed from the body/query).
     * E.g. path `/v1/knowledge/nodes/:id/edges` with arg `id` → the value is
     * spliced into the URL, not sent in the body.
     */
    path: string;
    /** How to map tool args to the request. Defaults to 'body' for POST, 'query' for GET. */
    inputLocation?: 'query' | 'body';
  };
  /** An in-process handler (mutually exclusive with `endpoint`). */
  handler?: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;
  /** An in-chat view for this tool's result (MCP Apps). Ignored by clients
   *  that don't implement the extension. */
  app?: ToolApp;
}

/**
 * Substitute `:param` segments in a path template from the supplied args,
 * returning the resolved path plus the remaining (non-path) args.
 */
function resolvePathParams(
  path: string,
  args: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const rest = { ...args };
  const resolved = path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = rest[name];
    delete rest[name];
    return encodeURIComponent(String(value ?? ''));
  });
  return { path: resolved, rest };
}

interface McpRouterOptions {
  name: string;
  domain: string;
  instructions?: string;
  /** Top-level tools exposed directly in the tool list (no describe_api needed) */
  tools?: Record<string, TopLevelTool>;
  /**
   * Expose the generic `describe_api` / `call_api` discovery shim.
   * Defaults to true. A FLAT surface (every op a named top-level tool) sets
   * this false — an agent should never discover-then-invoke through a generic
   * shim for everyday ops.
   */
  genericApiTools?: boolean;
}

// ---------------------------------------------------------------------------
// Friendly-tool boot guard
// ---------------------------------------------------------------------------

// Anthropic connectors-directory + friendly-wording contract: names must be
// API-legal, and neither names nor titles may leak internal vocabulary —
// these strings render in Claude's tool chips and permission prompts.
// Enforced at router creation (module load in server.ts), so a bad tool
// fails the boot, not a user's session.
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const INTERNAL_WORDS = new Set([
  'movement', 'movements', 'ask', 'asks', 'catalog', 'catalogs',
  'instance', 'instances', 'credential', 'credentials', 'book', 'books',
]);

function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function assertFriendlyTool(
  toolName: string,
  tool: Pick<TopLevelTool, 'title' | 'annotations'>,
): void {
  if (!TOOL_NAME_RE.test(toolName)) {
    throw new Error(`MCP tool ${toolName}: name must be 1-64 chars matching ^[a-zA-Z0-9_-]+$`);
  }
  if (tool.title.length === 0 || tool.title.length > 64) {
    throw new Error(`MCP tool ${toolName}: title must be 1-64 chars (got ${tool.title.length})`);
  }
  if (tool.annotations.readOnlyHint === undefined && tool.annotations.destructiveHint === undefined) {
    throw new Error(`MCP tool ${toolName}: annotations must set readOnlyHint or destructiveHint`);
  }
  const leaked = [...tokens(toolName), ...tokens(tool.title)].find((t) => INTERNAL_WORDS.has(t));
  if (leaked) {
    throw new Error(`MCP tool ${toolName}: internal vocabulary "${leaked}" must not reach users — see the friendly-wording spec`);
  }
}

/**
 * Every tool's input must survive the trip to JSON Schema, because that is the
 * only form a client ever sees it in.
 *
 * The SDK converts a tool's zod input INSIDE its `tools/list` handler, so a
 * type with no JSON Schema spelling (`z.date()` is the one that bites: the
 * shape is read off a tRPC procedure, where a `Date` is a perfectly good
 * in-process input) throws there and nowhere else. The whole list fails — not
 * the one tool — and the client is handed a JSON-RPC error inside an HTTP 200,
 * which reads as a connector that authenticates fine and then offers no tools
 * at all. Convert it here, at registration, with the SAME options the list
 * handler uses, so the failure lands on the deploy instead.
 */
function assertRepresentableSchema(toolName: string, inputSchema: ZodShape): void {
  const schema = normalizeObjectSchema(z.object(inputSchema));
  if (!schema) return;
  try {
    toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' });
  } catch (err) {
    throw new Error(
      `MCP tool ${toolName}: input schema cannot be published as JSON Schema — ${
        err instanceof Error ? err.message : String(err)
      }. Declare the wire type (a string) and narrow to the in-process type inside the schema.`,
    );
  }
}

/** The directory portal reads tool metadata from the `annotations` object: it
 *  wants the display `title` INSIDE annotations (not only the top-level
 *  `Tool.title` the SDK emits from `registerTool({ title })`), and an explicit
 *  `readOnlyHint` on every tool so it can classify read vs write — a write tool
 *  carrying only `destructiveHint` reads back as "missing readOnlyHint". Mirror
 *  the title into annotations and make readOnlyHint explicit (defaulting to
 *  `false` for the write tools that only declared `destructiveHint`). */
function directoryAnnotations(title: string, annotations: ToolAnnotations): ToolAnnotations {
  return {
    ...annotations,
    title,
    readOnlyHint: annotations.readOnlyHint ?? false,
  };
}

// ---------------------------------------------------------------------------
// Internal API caller
// ---------------------------------------------------------------------------

/** A call to the internal API with the caller's credentials already attached. */
type LocalApiCall = (
  method: string,
  path: string,
  options?: {
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    mcp?: { tool: string; domain: string };
  },
) => Promise<McpToolResult>;

function callLocalApi(
  req: Parameters<RequestHandler>[0],
  method: string,
  path: string,
  options?: {
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    mcp?: { tool: string; domain: string };
  },
) {
  const url = new URL(`http://localhost:${PORT}/api${path}`);
  if (options?.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.headers.authorization) {
    headers['Authorization'] = req.headers.authorization;
  }
  if (req.headers.cookie) {
    headers['Cookie'] = req.headers.cookie;
  }
  // Identity resolves on this loopback request, not out here — so the tool
  // name has to travel with it for the journey tap to see both at once.
  if (options?.mcp) {
    headers['X-Mcp-Tool'] = options.mcp.tool;
    headers['X-Mcp-Domain'] = options.mcp.domain;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);

  // GET can't carry a body; everything else (POST/PATCH/DELETE) forwards it.
  // DELETE tools (deleteEntity/deleteRelationship) rely on the body to receive
  // their args — notably `team` for a multi-team user — so it must not be dropped.
  return fetch(url, {
    method,
    headers,
    signal: controller.signal,
    ...(options?.body && method !== 'GET' ? { body: JSON.stringify(options.body) } : {}),
  })
    .then(async (response) => {
      const responseBody = await response.text();
      return {
        content: [{ type: 'text' as const, text: responseBody }],
        isError: response.status >= 400,
      };
    })
    .catch((err) => {
      if (controller.signal.aborted) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Request timed out after 55 seconds. Try narrowing your query.' }) }],
          isError: true as const,
        };
      }
      throw err;
    })
    .finally(() => clearTimeout(timeout));
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * The server a single request answers from.
 *
 * Built per request because the transport is stateless — which also means no
 * tool may depend on what was negotiated during `initialize`: this server
 * never saw it. Everything a client is offered is therefore unconditional,
 * and everything conditional lives in metadata the client is free to ignore.
 *
 * `callApi` is how an endpoint-backed tool reaches the internal API; it is a
 * parameter so a test can build the very server a client talks to without an
 * HTTP request behind it.
 */
function buildMcpServer(options: McpRouterOptions, callApi: LocalApiCall): McpServer {
  const { name, domain, instructions, tools = {}, genericApiTools = true } = options;
  const server = new McpServer({ name, version: '1.0.0', icons: serverIcons() }, { instructions });

  /** A tool resolves in-process, or by proxying the internal API. */
  function runTool(
    toolName: string,
    tool: TopLevelTool,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> | McpToolResult {
    if (tool.handler) return tool.handler(args);
    const { method, path, inputLocation } = tool.endpoint!;
    const location = inputLocation ?? (method === 'GET' ? 'query' : 'body');
    const { path: resolvedPath, rest } = resolvePathParams(path, args);
    return callApi(method, resolvedPath, { [location]: rest, mcp: { tool: toolName, domain } });
  }

  // Register top-level tools — each resolves via a direct in-process handler
  // or by proxying an internal API endpoint.
  for (const [toolName, tool] of Object.entries(tools)) {
    server.registerTool(toolName, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: directoryAnnotations(tool.title, tool.annotations),
      ...(tool.app ? { _meta: appToolMeta(tool.app.resourceUri) } : {}),
    }, async (args) => {
      const result = await runTool(toolName, tool, args as Record<string, unknown>);
      return tool.app ? withAppData(result, tool.app) : result;
    });
  }

  // The views those tools nominate. One registration per view, however many
  // tools point at it — the client fetches it once and renders it per call.
  const views = new Map(
    Object.values(tools)
      .filter((tool): tool is TopLevelTool & { app: ToolApp } => tool.app !== undefined)
      .map((tool) => [tool.app.resourceUri, tool.app]),
  );
  for (const [uri, app] of views) {
    server.registerResource(
      app.title,
      uri,
      { title: app.title, description: app.description, mimeType: APP_MIME_TYPE },
      async () => ({
        contents: [{ uri, mimeType: APP_MIME_TYPE, text: await app.html() }],
      }),
    );
  }

  // Generic discovery + call tools (for advanced / less common operations).
  // A FLAT surface (genericApiTools: false) omits these — every op it needs
  // is a named top-level tool, so there is nothing left to discover-then-call.
  if (genericApiTools) {
    server.registerTool('describe_api', {
      title: 'List available API endpoints',
      description: `List additional ${domain} API endpoints not covered by the top-level tools. Returns method, path, description, and input schema for each.`,
      annotations: directoryAnnotations('List available API endpoints', { readOnlyHint: true }),
    }, async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(describeRoutes(domain), null, 2) }],
    }));

    server.registerTool('call_api', {
      title: 'Call an API endpoint',
      description: `Call a ${domain} API endpoint by path. Use describe_api to discover available endpoints first.`,
      annotations: directoryAnnotations('Call an API endpoint', { destructiveHint: true }),
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
        path: z.string().describe('API path (from describe_api)'),
        query: z.record(z.string(), z.unknown()).optional().describe('Query parameters'),
        body: z.record(z.string(), z.unknown()).optional().describe('JSON body'),
      },
    }, async ({ method, path, query, body }) => {
      // Validate against the registered schema for this route (if any)
      // BEFORE forwarding — describe_api only documents the shape, it never
      // enforced it, which let a caller pass a field the registry doesn't
      // advertise (e.g. acquirer_id on the generic events write) straight
      // through to REST.
      const validation = validateCallApiBody(domain, method, path, body);
      if (!validation.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: validation.error }) }],
          isError: true,
        };
      }
      return callApi(method, path, { query, body });
    });
  }

  return server;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

function createMcpRouter(options: McpRouterOptions): ReturnType<typeof Router> {
  const router = Router();

  for (const [toolName, tool] of Object.entries(options.tools ?? {})) {
    assertFriendlyTool(toolName, tool);
    assertRepresentableSchema(toolName, tool.inputSchema);
    if (!tool.endpoint === !tool.handler) {
      throw new Error(`MCP tool ${toolName}: set exactly one of endpoint or handler`);
    }
  }

  const handler: RequestHandler = async (req, res) => {
    const server = buildMcpServer(options, (method, path, callOptions) =>
      callLocalApi(req, method, path, callOptions),
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // The client closing its own connection — a GET's long-lived SSE
      // stream ending, or a POST session torn down mid-request — is routine,
      // not a bug in the request. Note it once and release the session
      // rather than staying silent (the previous bare `return` gave no
      // signal this was even happening) or rethrowing into an unhandled
      // rejection.
      if (req.destroyed || res.destroyed || isClientAbort(err)) {
        logger.info('[mcp] client closed the stream', { domain: options.domain, sessionId: transport.sessionId });
        return;
      }
      throw err;
    }
  };

  router.post('/', handler);
  router.get('/', handler);
  router.delete('/', handler);

  return router;
}

export { createMcpRouter, buildMcpServer, assertFriendlyTool, assertRepresentableSchema, directoryAnnotations, APP_MIME_TYPE };
export type { TopLevelTool, ToolApp, McpRouterOptions, McpToolResult, LocalApiCall };
