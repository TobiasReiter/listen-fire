// The Automation connector's REST surface (`/api/v1/automation`, coarse scope
// `automation`). This is the lead connector: author + run movements, manage
// triggers, read the catalog, connect credentials, and answer the asks a
// running movement raises. It is FULLY INDEPENDENT of the Knowledge connector —
// an `automation`-scoped key reaches none of the KG read/edit endpoints, and a
// movement that targets the `kg` adapter writes server-side under the team's
// own access (the engine never consults the caller's api-key scope), so an
// automation key needs no `knowledge` grant to move data into the graph.
//
// The movement / catalog / handbook / teams routes are mounted by
// `mountAutomationToolRoutes` (colocated with their handlers in
// knowledge_agent_tools.ts, shared with the in-app agent). The asks surface
// lives here.

import { randomUUID } from "node:crypto";

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { currentPrincipal } from 'principal';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AskId } from '../../../generated/kysely/asks/Ask';

import { answerForTeam, listOpenAsksForTeam } from '../../../services/interaction/answer_surfaces';
import { mountAutomationToolRoutes } from './knowledge_agent_tools';
import { teamSetForReads, teamNames, resolveToolTeam, ToolTeamError } from './team_scope';
import { emitOpsEvent } from '../../../lib/ops/emit';
import OpsEventType from '../../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../../generated/kysely/public/OpsSeverity';
import { UserService } from '../../../services/user';
import { requireScope } from './require_scope';

const AUTOMATION_SCOPE = 'automation';

function internalError(res: Parameters<RequestHandler>[1], err: unknown) {
  if (err instanceof ToolTeamError) {
    return res.status(400).json({ error: err.message, ...(err.teams ? { teams: err.teams } : {}) });
  }
  const traceId = randomUUID();
  console.error(`[automation-api:${traceId}]`, err);
  return res.status(500).json({ error: 'internal_error', message: 'An internal error occurred.', traceId });
}

// ── Asks (async user interaction — the agent answer surface) ──
//
// A running movement can pause to ask a human a question (the `ask` clause). An
// agent driving the movement polls `GET /v1/automation/reviews` for the team's open
// asks and resolves them with `POST /v1/automation/reviews/:id/answer`. Both are
// team-clamped to the connection's teams — the agent answers the same durable
// `interaction_request` the human link would, validated against the ask's result
// type by `recordAnswer`; the resume worker then drives the parked run forward.

// Spans every team the connection covers (unpinned → all the user's teams;
// pinned → the one), tagging each ask with the team it belongs to.
const listAsksHandler: RequestHandler = async (_req, res) => {
  try {
    const teams = await teamSetForReads();
    const names = await teamNames(teams);
    const perTeam = await Promise.all(
      teams.map(async (t) =>
        (await listOpenAsksForTeam(t as unknown as TeamId)).map((a) => ({
          requestId: a.requestId,
          interactionType: a.interactionType,
          resultType: a.resultType,
          title: typeof a.args.title === 'string' ? a.args.title : undefined,
          args: a.args,
          teamId: t,
          teamName: names.get(t) ?? t,
        })),
      ),
    );
    return res.status(200).json({ data: perTeam.flat() });
  } catch (err) {
    return internalError(res, err);
  }
};

const answerAskSchema = z.object({
  answer: z.unknown(),
});

const answerAskHandler: RequestHandler = async (req, res) => {
  const parseResult = answerAskSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.flatten() });
  }

  const requestId = req.params.id as unknown as AskId;
  // Resolve the ask across every team the connection covers — answer it in
  // whichever team owns it. `not_found` in one team just means it lives in
  // another; only surface the final miss.
  const teams = await teamSetForReads();
  let lastOutcome: Awaited<ReturnType<typeof answerForTeam>> | undefined;
  for (const t of teams) {
    lastOutcome = await answerForTeam({
      teamId: t as unknown as TeamId,
      requestId,
      answer: parseResult.data.answer,
    });
    if (lastOutcome.ok || lastOutcome.reason !== 'not_found') break;
  }
  const outcome = lastOutcome!;
  if (!outcome.ok) {
    const status = outcome.reason === 'not_found' ? 404 : outcome.reason === 'already_resolved' ? 409 : 400;
    return res.status(status).json({ error: outcome.reason, message: outcome.message });
  }
  return res.status(200).json({
    requestId: outcome.result.requestId,
    runId: outcome.result.runId,
    answer: outcome.result.answer,
    status: 'answered',
  });
};

// ── Feedback (friction report → the ops feed) ──
//
// When the user or the agent hits friction using Listen-Fire — something confusing,
// broken, or missing — the agent can send an outline straight to the operator's
// ops feed. It records a SUPPORT ops_event (severity `warn`, so it also fires a
// web-push to the operator PWA — best-effort, a no-op if push isn't configured).
// `goal` is what the user was trying to achieve; `friction` is what went wrong.
// The team defaults to the acting team unless a specific `team` is passed.

const feedbackSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  friction: z.string().trim().min(1).max(8000),
  team: z.string().optional(),
});

const feedbackHandler: RequestHandler = async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  const { goal, friction, team } = parsed.data;

  try {
    // A passed team is validated for membership; omitted → the acting team
    // (feedback isn't team-specific, so never block on team ambiguity).
    const teamId =
      team !== undefined ? await resolveToolTeam(team) : currentPrincipal().teamId;

    // Best-effort: stamp who reported it so the operator knows who to follow up.
    // A machine principal (api key, static stub) has no person to name — the
    // report still lands, unattributed. Reaching for one through `Context.user`
    // threw instead, taking the whole route with it.
    const reporterId = currentPrincipal().userId;
    const reporterEmail =
      reporterId === undefined
        ? null
        : await UserService.getById(reporterId)
            .then((u) => u.email)
            .catch(() => null);

    const title = `Feedback: ${goal.length > 120 ? `${goal.slice(0, 117)}…` : goal}`;

    await emitOpsEvent({
      type: OpsEventType.SUPPORT,
      severity: OpsSeverity.warn,
      teamId,
      title,
      detail: { goal, friction, reporterEmail, source: 'automation-mcp' },
    });

    return res.status(200).json({ status: 'received' });
  } catch (err) {
    return internalError(res, err);
  }
};

const automationRouter: ReturnType<typeof Router> = Router();

automationRouter.use(requireScope(AUTOMATION_SCOPE));

// asks
automationRouter.get('/reviews', listAsksHandler);
automationRouter.post('/reviews/:id/answer', answerAskHandler);

// feedback → ops feed
automationRouter.post('/feedback', feedbackHandler);

// movements, catalog, handbook, connect, teams — shared with the in-app agent.
mountAutomationToolRoutes(automationRouter);

export { automationRouter };
