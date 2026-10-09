/**
 * tRPC surface for the control tower (async user interaction chunk 7b, 3b/§5.6).
 * The operator surface that answers "what's waiting on a human, and what can I do
 * about it":
 *
 *   - listParkedRuns / listOpenAsks — pure reads over `trigger_run` +
 *     `interaction_request` (never the heavy `parked_run.state` blob).
 *   - answerAskOnBehalf / redeliverAsk / abortRun — operator actions, each
 *     delegating to the existing engine primitive (recordAnswer /
 *     redeliverAskDelivery / failRunAndCancelRequests). The operator is an authed
 *     user, so no token is involved.
 *
 * Everything is team-scoped via `userProcedure` + the service-layer ownership
 * checks (a cross-team id reads as not-found).
 *
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AskId } from '../../../generated/kysely/asks/Ask';

import { currentContext } from '../../../services/context';
import { UserService } from '../../../services/user';
import { trpc } from '../trpc';
import {
  listParkedRuns,
  listTeamRuns,
  type ParkedRunSummary,
  type TeamRunSummary,
} from '../../../services/interaction/observability';
import { abortRun, resumeRun } from '../../../services/interaction/operator';
import { RunBusy } from '../../../services/movement_engine/run_lease';
import {
  listAskRecordsForTeam,
  answerAskRecordForTeam,
  type AskRecordSummary,
} from '../../../services/interaction/ask_records';
import { userProcedure as sharedUserProcedure } from '../procedures';

const controlTowerRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Every parked run for the team — what's waiting, on what automation, since
     *  when, and how many asks it's still waiting on. */
    listParkedRuns: userProcedure.query(async (): Promise<ParkedRunSummary[]> => {
      const ctx = currentContext();
      return listParkedRuns(ctx.user.teamId as TeamId);
    }),

    /** The team's questions on the ask store — open ones (answerable in place)
     *  and recently settled ones. */
    listAskRecords: userProcedure.query(async (): Promise<AskRecordSummary[]> => {
      const ctx = currentContext();
      return listAskRecordsForTeam(ctx.user.teamId as TeamId);
    }),

    /** Answer a new-store question in place — the same lattice transition every
     *  door drives (link page, Slack buttons, MCP). The answer is validated
     *  against the question's answer type, then any run waiting on it resumes. */
    answerAskRecord: userProcedure
      .input(z.object({ askId: z.string().min(1), answer: z.unknown() }))
      .mutation(async ({ input }): Promise<{ askId: string; state: string }> => {
        const ctx = currentContext();
        return answerAskRecordForTeam({
          askId: input.askId as unknown as AskId,
          answer: input.answer,
          teamId: ctx.user.teamId as TeamId,
        });
      }),

    /** Cancel a parked/running run and all its open asks (§5.7 manual abort). */
    abortRun: userProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(async ({ input }): Promise<{ runId: string }> => {
        const ctx = currentContext();
        const user = await UserService.getById(ctx.user.id);
        return abortRun({
          runId: input.runId,
          teamId: ctx.user.teamId as TeamId,
          abortedBy: user.username ?? user.email ?? undefined,
        });
      }),

    /** Resume a run paused at its cost limit: every branch it suspended carries
     *  on, with the run's usage reset. */
    resumeRun: userProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(async ({ input }): Promise<{ runId: string; resumed: number }> => {
        const ctx = currentContext();
        try {
          return await resumeRun({ runId: input.runId, teamId: ctx.user.teamId as TeamId });
        } catch (err) {
          if (err instanceof RunBusy) throw new TRPCError({ code: 'CONFLICT', message: err.message });
          throw err;
        }
      }),

    /** Every running/parked run for the team, newest first — the runs view
     *  (runs-cancel task 6). */
    listRuns: userProcedure.query(async (): Promise<TeamRunSummary[]> => {
      const ctx = currentContext();
      return listTeamRuns(ctx.user.teamId as TeamId);
    }),
  });
};

export { controlTowerRouter };
