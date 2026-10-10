import { randomUUID } from "node:crypto";

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { currentPrincipal } from 'principal';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { currentContext } from '../../../services/context';
import { catchingRoutes } from '../async_route';
import { listTgRuns, getTgRun } from '../../../services/system_debug';
import { runConversationTurn } from '../../../lib/knowledge/orchestrator';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { drainUntilIdle, recordExternalDrainPass } from '../../../services/work/drain';
import { mounts } from '../../../products';
import { engineChoice, engineFallback } from '../../../services/movement_engine/rust_engine';
import { dryRunDurationSummary, rustEvalStats, rustRunStats } from '../../../services/movement_engine/rust_stats';
import {
  requireSystemAction,
  requireSystemCaller,
  requireTenantCaller,
} from '../../../services/system_auth';

function internalError(res: Parameters<RequestHandler>[1], err: unknown) {
  const traceId = randomUUID();
  console.error(`[system-api:${traceId}]`, err);
  return res.status(500).json({
    error: 'internal_error',
    message: 'An internal error occurred.',
    traceId,
  });
}

/** The floor under every route in this router — see `async_route.ts` for why an
 *  unwrapped async handler HANGS rather than 500s. Two of the four handlers
 *  below read identity before their own try/catch, which is exactly the shape
 *  that used to leave the socket unanswered. */
const route = catchingRoutes(internalError);

/**
 * The tenant these routes act in, read off the Principal rather than through
 * `Context.user`. `user` is user-SHAPED and throws when there is no user, and
 * an api key minted for a service — or the static single-tenant stub a coreless
 * deployment boots with — is a machine principal with none (D2). Every read
 * below wanted a team id, not a person.
 */
function actingTeamId(): TeamId {
  return currentPrincipal().teamId as TeamId;
}

/**
 * The acting USER, for the one route that needs a person rather than a tenant.
 * Absent for a machine principal.
 */
function actingUserId(): string | undefined {
  return currentPrincipal().userId;
}

/**
 * Starting a conversation binds it to an owner: `agent_conversation.user_id` is
 * NOT NULL, so there is no null upstream of this throw for attribution to
 * degrade to, and inventing a user id to satisfy the column is the failure mode
 * the carve exists to prevent. So it refuses, naming the credential that works.
 * Continuing an EXISTING conversation is tenancy and keeps working.
 */
const NO_ACTING_USER = {
  error:
    'Starting a conversation records who owns it, but this connection authenticates as a machine (an API key with no user behind it). Reconnect with a user-anchored credential, or continue an existing conversation.',
};

const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Messages ──

const listTgRunsQuerySchema = paginationSchema.extend({
  triggerId: z.string().optional(),
  status: z.string().optional(),
});

const listTgRunsHandler: RequestHandler = async (req, res) => {
  const parsed = listTgRunsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  }
  try {
    const data = await listTgRuns({
      teamId: actingTeamId(),
      triggerId: parsed.data.triggerId,
      status: parsed.data.status,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return res.status(200).json({ data });
  } catch (err) {
    return internalError(res, err);
  }
};

const getTgRunHandler: RequestHandler = async (req, res) => {
  try {
    const data = await getTgRun({
      teamId: actingTeamId(),
      runId: req.params.id as TriggerRunId,
    });
    if (!data) return res.status(404).json({ error: 'Trigger run not found' });
    return res.status(200).json(data);
  } catch (err) {
    return internalError(res, err);
  }
};

// ── Chat (system agent) ──

const startConversationSchema = z.object({
  message: z.string().min(1).max(50000),
});

const startConversationHandler: RequestHandler = async (req, res) => {
  const teamId = actingTeamId();
  const userId = actingUserId();
  if (userId === undefined) {
    return res.status(400).json(NO_ACTING_USER);
  }

  const ctx = currentContext();
  const parsed = startConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }

  const { message } = parsed.data;

  try {
    const conversation = await ctx.prisma.agentConversation.create({
      data: {
        teamId,
        userId,
        agentType: 'knowledge_system',
        activeAgent: 'system',
        title: message.slice(0, 100),
      },
    });

    await ctx.prisma.agentMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
        agent: 'system',
        messageType: 'chat',
      },
    });

    const sid = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const usageContext = new LlmUsageContext({ teamId, conversationId: conversation.id });
    const result = await usageContext.runAsync(() =>
      runConversationTurn({
        conversationId: conversation.id,
        userMessage: message,
        sessionId: sid,
      }),
    );

    return res.status(200).json({
      conversationId: conversation.id,
      response: result.text,
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const sendMessageSchema = z.object({
  message: z.string().min(1).max(50000),
});

const sendMessageHandler: RequestHandler = async (req, res) => {
  const ctx = currentContext();
  const teamId = actingTeamId();

  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }

  const conversationId = req.params.id;
  const { message } = parsed.data;

  try {
    const conversation = await ctx.prisma.agentConversation.findFirst({
      where: { id: conversationId, teamId },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    await ctx.prisma.agentMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: message,
        agent: conversation.activeAgent,
        messageType: 'chat',
      },
    });

    const sid = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const usageContext = new LlmUsageContext({ teamId, conversationId });
    const result = await usageContext.runAsync(() =>
      runConversationTurn({
        conversationId,
        userMessage: message,
        sessionId: sid,
      }),
    );

    const updatedConv = await ctx.prisma.agentConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    return res.status(200).json({
      conversationId,
      response: result.text,
      activeAgent: updatedConv.activeAgent,
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const drainBodySchema = z
  .object({
    // Bounded so one call cannot hold a request open for an unbounded drain.
    limit: z.number().int().positive().max(100).optional(),
    maxPasses: z.number().int().positive().max(50).optional(),
  })
  .strict();

/** The tick a scheduler calls when `AUTOMATIONS_DRAIN_MODE=external`. Each call
 *  drains until idle (bounded by `maxPasses`), records the drain worker's pulse
 *  as a loop pass would, and reports what it did. Any instance answers it, and
 *  ticks may overlap: each claims a disjoint set of rows, and each run is
 *  stepped under its own lease. */
const drainAutomationsHandler: RequestHandler = async (req, res) => {
  const body = drainBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: 'invalid_body', issues: body.error.issues });
  }
  const result = await drainUntilIdle({ owner: `http:${randomUUID()}`, ...body.data });
  recordExternalDrainPass(result);
  return res.status(200).json(result);
};

/** What the movement engines did in THIS process since it started: which
 *  engine `MOVEMENT_ENGINE` chose, and the Rust engine's counters (why each
 *  run it did not run went to the TypeScript engine, by reason; what it ran,
 *  declined and asked its host; what the evaluator switch answered; and, in
 *  `runs.dryRun`, what its admission would have refused each run the
 *  TypeScript engine ran for, by first and every reason and by version). The
 *  counters are per process and start at zero with it, so each instance
 *  answers for itself, over its uptime. */
const engineStatsHandler: RequestHandler = (_req, res) => {
  const uptimeSeconds = Math.round(process.uptime());
  return res.status(200).json({
    engine: engineChoice(),
    fallback: engineFallback(),
    uptimeSeconds,
    since: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    // The recent dry runs' cost rides with their counts.
    runs: { ...rustRunStats, dryRun: { ...rustRunStats.dryRun, durationMs: dryRunDurationSummary() } },
    evaluator: rustEvalStats,
  });
};

const systemRouter: ReturnType<typeof Router> = Router();

// Who may call these routes is the system caller verifiers' question
// (services/system_auth): the `system` API key by default.
systemRouter.use(requireSystemCaller());

// The run listings and the system agent act in the tenant of the key's owner.
const tenant = requireTenantCaller();

systemRouter.get('/tg-runs', tenant, route(listTgRunsHandler));
systemRouter.get('/tg-runs/:id', tenant, route(getTgRunHandler));
systemRouter.get('/engine-stats', route(engineStatsHandler));
systemRouter.post('/conversations', tenant, route(startConversationHandler));
systemRouter.post('/conversations/:id/messages', tenant, route(sendMessageHandler));
// `system` is mounted on every installation, so the route gates itself the way
// index.ts gates the automations routers: absent, not refused, without the unit.
if (mounts('automations')) {
  systemRouter.post('/automations/drain', requireSystemAction('drain'), route(drainAutomationsHandler));
}

export { systemRouter };
