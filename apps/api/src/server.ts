import http from 'node:http';
import util from 'node:util';

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import * as trpcExpress from '@trpc/server/adapters/express';

import './services';
import { prismaClient } from './prisma';
import { initSentry } from './lib/sentry';
import * as Sentry from '@sentry/node';
import { logger } from './services/logger';
import { currentContext } from './services/context';

// Diagnostic: log unhandled promise rejections in detail so we can identify
// the source of empty-reason rejections leaking from Playwright/SDK internals.
process.on('unhandledRejection', (reason, promise) => {
  const reasonType =
    reason === undefined
      ? 'undefined'
      : reason === null
        ? 'null'
        : reason instanceof Error
          ? `Error(${reason.constructor.name})`
          : typeof reason;
  logger.error('[unhandledRejection]', {
    reasonType,
    reasonMessage: reason instanceof Error ? reason.message : undefined,
    reasonStack: reason instanceof Error ? reason.stack : undefined,
    reasonInspect: util.inspect(reason, { showHidden: true, depth: 4 }),
    promiseInspect: util.inspect(promise, { showHidden: true, depth: 2 }),
    handlerStack: new Error('captured at unhandledRejection handler').stack,
  });
});
import { requireEnv } from './lib/utils/environment';
import { assertModelMapConfigured, modelKeyWarning, providerCredentialsPresent, resolveModel } from './lib/models/map';
import { assertKnowledgeLlmModelConfigured, isKnowledgeLlmConfigured, knowledgeLlmModel } from './lib/knowledge/llm';
import { assertJevConfigured } from './lib/jev/client';
import { assertRunCostCapConfigured } from './lib/run_spend';
import { assertExtractionTiersConfigured } from './services/movement_engine/ai_tiers';
import { assertMaxCallDepthConfigured } from './services/movement_engine/call_depth';
import { assertWriteLockTimeoutConfigured } from './services/write_locks/write_locks';
import { healthCheck, workersHealthCheck } from './lib/middleware/health_check';
import { rootHandler } from './lib/middleware/root_handler';
import { HEALTH_CHECK_ENDPOINT, WORKERS_HEALTH_ENDPOINT } from './constants';
import { publicRouter, privateRouter } from './interfaces/rest';
import { preAuthRouter } from './interfaces/rest/capabilities';
import { contextTransactionHandler } from './lib/middleware/context_transaction';
import { customHeadersExtractor } from './lib/middleware/custom_request_headers';
import { jsonBodyParser, urlencodedBodyParser } from './lib/middleware/body_parser';
import { compressResponses } from './lib/middleware/compression';
import { expressLogger } from './lib/middleware/logging';
import { contextInjector } from './lib/middleware/context';
import { authorisationHandler } from './lib/middleware/authorisation';
import { createAuthenticationHandler } from './lib/middleware/authentication';
import {
  inboundEmailDoor,
  mailgunEventDoor,
  resendInboundDoor,
} from './services/translation_graph/adapters/email/inbound_auth';
import { sentryScopeHandler } from './lib/middleware/sentry_scope';
import { startup as startBackgroundProcesses } from './startup';
import { startEventLoopWatchdogIfEnabled } from './services/event_loop_watchdog';
import { linkTrpcWsServer, trpcRouter } from './interfaces/trpc';
import { webhookSyncRouter } from './interfaces/rest/webhookSync';
import { telegramBuiltinRouter } from './interfaces/rest/telegramBuiltin';
import { slackEventsRouter } from './interfaces/rest/slackEvents';
import { slackInteractivityRouter } from './interfaces/rest/slackInteractivity';
import { filesRouter } from './interfaces/rest/files';
import { asksRouter } from './interfaces/rest/asks';
import { storyRouter } from './interfaces/rest/story';
import { callbacksRouter } from './interfaces/rest/callbacks';
import { connectRouter } from './interfaces/rest/connect';
import { initialiseWebSockets } from './lib/webSockets';
import { shutdownAgents } from './lib/knowledge/agent_sessions';
import { createOAuthRouter } from './interfaces/mcp/oauth';
import { createProtectedResourceRouter, mcpAuthChallenge, MCP_BASE_PATH } from './interfaces/mcp/protected_resource';
import { mountMcpConnectors } from './interfaces/mcp/connectors';
import { registerAllRoutes } from './interfaces/mcp/register_routes';
import { mounts, mountedProducts } from './products';

registerAllRoutes();

requireEnv('NODE_ENV');

// Where this deployment's model names go, and whether every place the model
// map sends one can actually be called. Checked here rather than at the first
// model call: a run is the wrong place to find out a map line is wrong.
assertModelMapConfigured();
// Each extraction tier's model must be one that map can reach here.
assertExtractionTiersConfigured();
assertKnowledgeLlmModelConfigured();

// Same posture, one env var over: a deployment that turns on the Jev entity
// judge without its key believes duplicate merges are getting a second
// opinion when they are not.
assertJevConfigured();

// An optional cost cap set to something that is not a positive number of
// dollars is a deployment that believes its runs are capped when they are not.
assertRunCostCapConfigured();

// A call depth limit set to something that is not a positive whole number is
// a deployment that believes its recursions are bounded when they are not.
assertMaxCallDepthConfigured();

// A lock wait set to something that is not a positive whole number of
// milliseconds would fail every contended write, or never let one give up.
assertWriteLockTimeoutConfigured();

// A blocked event loop is the one failure this process cannot narrate: the
// health check goes unanswered, the logs stop mid-sentence, and the platform
// restarts us with nothing to show for it. The watchdog watches from another
// thread, so it can still say so. Armed before anything else starts — a stall
// during boot is as invisible as one under load — and `EVENT_LOOP_WATCHDOG=0`
// turns it off.
const eventLoopWatchdog = startEventLoopWatchdogIfEnabled();

const PORT = process.env.PORT ?? 3000;

const app = express();
initSentry();

async function main() {
  const httpServer = http.createServer(app);
  const { sockets, upgrade } = initialiseWebSockets(['trpc']);
  httpServer.on('upgrade', upgrade);
  linkTrpcWsServer(sockets.trpc);

  // express middleware is iterated through in series
  // in the order they're used
  app.get('/', rootHandler);
  app.use(express.static('public'));
  app.use(expressLogger);
  app.use(cookieParser());
  app.use(customHeadersExtractor);
  // The trigger doors, all automations' (7_automations.md §5). Each needs the
  // raw body for HMAC signature verification, so they mount before the JSON
  // parser.
  if (mounts('automations')) {
    app.use('/api/public/webhook-sync', express.raw({ type: 'application/json' }), webhookSyncRouter);
    // Shared built-in Telegram bot — single global inbound entry, no per-team
    // subscription URL; routes by sender identity (raw body, no signature).
    app.use('/api/public/telegram', express.raw({ type: 'application/json' }), telegramBuiltinRouter);
    // The "Listen-Fire" Slack app's Events door — one URL for the app, all workspace
    // installs deliver here, routed by team_id. Raw body for HMAC signature
    // verification (SLACK_MOVEMENTS_SIGNING_SECRET).
    app.use('/api/public/slack', express.raw({ type: 'application/json' }), slackEventsRouter);
    // The same app's Interactivity door — native answer buttons deliver their
    // block-action here (urlencoded, so raw over ANY content type for the HMAC).
    app.use('/api/public/slack-actions', express.raw({ type: '*/*' }), slackInteractivityRouter);
    // Resend signs its webhooks over the exact bytes it sent (Svix), so the
    // inbound-mail callback keeps its raw body. It is not a router mount — the
    // route itself lives on the private surface, behind the door — just the
    // parser, claimed before the JSON one gets to it.
    app.use('/api/resend', express.raw({ type: 'application/json' }));
  }
  app.use(jsonBodyParser);
  app.use(urlencodedBodyParser);
  app.use(cors());
  app.use(contextInjector);
  app.get(HEALTH_CHECK_ENDPOINT, healthCheck());
  // Worker liveness for whatever products this process mounts (ST-11). Public,
  // like the probe above, and mounted with it rather than under a product:
  // there is no product to hang it on when the answer spans all of them.
  app.get(WORKERS_HEALTH_ENDPOINT, workersHealthCheck());
  // The capability-link doors — automations' (7_automations.md §5). Each is
  // authorised by the token in its own URL, so they mount before the auth
  // middleware (like OAuth / webhook-sync).
  if (mounts('automations')) {
    // Public file pass-through — the signed token is the authorisation.
    app.use('/api/files', filesRouter);
    // Public story links — a movement's picture, drawn for whoever holds the
    // URL. GET-only, and there is no verb here that changes anything.
    app.use('/api/story', storyRouter);
    // The callback door — `cb_`-prefixed opaque ids ARE the authorisation (the
    // action's value is baked into the stored body at mint time). GET renders a
    // confirm page and never fires; POST is the only resolving verb, and BYO
    // servers call the same one.
    app.use('/api/cb', callbacksRouter);
    // Author-time credential-connect links — the single-use connect token in
    // the URL is the authorisation; the landing page either drives the real
    // adapter OAuth in the user's browser or renders a key-entry form.
    app.use('/api/connect', connectRouter);
  }
  // The human answer door. It is asks' router, but automations embeds the asks
  // store as a library and serves the same routes for its own `await` parks —
  // one router, one mount point either way (D30(f), 4_asks.md §5). So it is
  // here wherever EITHER product is.
  if (mounts('asks') || mounts('automations')) {
    app.use('/api/asks', asksRouter);
  }
  // MCP OAuth is core's (D7): the authorization server, its metadata, and the
  // 401 challenge that starts a connector's flow. A static-stub deployment
  // authenticates by API key and serves none of it.
  if (mounts('core')) {
    // OAuth endpoints must be public (before auth middleware)
    app.use(createOAuthRouter());
    // RFC 9728 Protected Resource Metadata — the MCP connector reads it to
    // discover the authorization server. Public, like the OAuth routes.
    app.use(createProtectedResourceRouter());
    // The MCP resource servers must answer a credential-less request with a 401
    // OAuth challenge (not the gate's bare 403), so the connector starts OAuth.
    // A request that already carries a credential falls through to the auth gate.
    app.use(MCP_BASE_PATH, mcpAuthChallenge);
  }
  // The public API surface (marketing integrations grid, waitlist, icons,
  // feature flags, AND the login/auth callbacks) sits BETWEEN authentication and
  // the granted-access gate. Authentication establishes the ambient Principal
  // and the Context's identity (PUBLIC_USER for `/public/` URLs); the
  // granted-access gate runs only for the private surface below, so public
  // routes get a working authenticated context but aren't 403'd.
  //
  // The doors are the branches core does not own: an inbound email's sender
  // decides its team, and Mailgun's signature is the credential. Registered
  // here, by the composition root, so core names no product (core plan §4).
  // The pre-authentication surface: what this deployment runs, and (static
  // identity only) how to log into it. Ahead of the auth funnel because the
  // static provider refuses an anonymous request whatever its path.
  app.use('/api/public', preAuthRouter);
  app.use(
    createAuthenticationHandler({
      doors: [inboundEmailDoor, resendInboundDoor, mailgunEventDoor],
    }),
  );
  app.use('/api/public', publicRouter);
  app.use(authorisationHandler);
  app.use(sentryScopeHandler);
  app.use(
    '/api/trpc',
    compressResponses(),
    trpcExpress.createExpressMiddleware({
      router: trpcRouter,
      createContext: () => ({
        // auth is already handled by express, no-op. Type needed for websockets
        authorise: async () => {},
      }),
      onError: ({ error }) => {
        // onError is sync (void) — recording the error on the context is
        // fire-and-forget, so it must NEVER throw out of its own .catch:
        // a thrown rejection here has no awaiter and leaks as an
        // unhandledRejection (a crash risk under strict modes). Log instead.
        void currentContext()
          .error(error)
          .catch((err) => {
            logger.error('[trpc onError] failed to record error on context', {
              cause: err instanceof Error ? err.message : String(err),
            });
          });
      },
    }),
  );
  app.use('/api', privateRouter);
  // Every MCP connector advertises itself at API_BASE_URL (capabilities, OAuth
  // discovery, its icon). A production process without it would answer every
  // page's capabilities fetch with a 500, so refuse here, at boot, by name.
  if (process.env.NODE_ENV === 'production' && (mounts('automations') || mounts('knowledge') || mounts('valuations'))) {
    requireEnv('API_BASE_URL');
  }
  // A keyless deployment is supported and boots on purpose — the platform
  // client reads its key on first call rather than on import, exactly so that
  // it can. What is not supported is finding out only when the first agent
  // request fails, so the process says it at boot as well. This is not "is any
  // vendor key set anywhere" — MODEL_MAP can route every model this process
  // actually calls around a missing one — it is whether the default agent
  // model and knowledge's own chat model resolve to a provider with
  // credentials here.
  const defaultAgentModel = resolveModel('claude-sonnet-5');
  const bootModelKeyWarning = modelKeyWarning([
    { resolved: defaultAgentModel, configured: providerCredentialsPresent(defaultAgentModel.provider) },
    { resolved: resolveModel(knowledgeLlmModel()), configured: isKnowledgeLlmConfigured() },
  ]);
  if (bootModelKeyWarning) logger.warn(bootModelKeyWarning);
  // Each product serves its own MCP connector, and only where it runs.
  mountMcpConnectors(app);
  Sentry.setupExpressErrorHandler(app);
  app.use(contextTransactionHandler);

  startBackgroundProcesses();
  await new Promise<void>((resolve) => httpServer.listen({ port: PORT }, resolve));

  const handleShutdown = async () => {
    console.warn('Shutting down server — draining active agents...');
    await shutdownAgents(10_000);
    console.warn('Agents drained, closing server');
    // The watchdog holds an inspector session on this thread; a process that
    // exits with one attached waits for a debugger that is never coming.
    await eventLoopWatchdog?.stop();
    httpServer.close(async () => {
      await prismaClient.$disconnect();
      process.exit(0);
    });
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  console.warn(`
    🚀  Server ready at http://localhost:${PORT}
    products: ${mountedProducts().join(', ')}
  `);
  return { app };
}

void main().finally(async () => {
  await prismaClient.$disconnect();
});
