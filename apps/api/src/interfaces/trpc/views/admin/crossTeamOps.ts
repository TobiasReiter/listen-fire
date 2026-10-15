// Cross-team admin operations — platform-admin-gated tRPC surface for the
// internal admin app. Every procedure here is CROSS-TEAM: it reuses the
// existing per-team service functions (all of which take an explicit
// `teamId`, no context baking) and either loops over every team or scopes
// to a single team when `teamId` is supplied. The admin guard is applied
// by the caller (admin/index.ts passes `adminProcedure`).

import { z } from 'zod';
import { sql } from 'kysely';

import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type OpsDetailLevel from '../../../../generated/kysely/automations/OpsDetailLevel';
import type { UserEmailId } from '../../../../generated/kysely/core/UserEmail';
import type { TriggerEventId } from '../../../../generated/kysely/automations/TriggerEvent';

import { trpc } from '../../trpc';
import { currentContext } from '../../../../services/context';
import { getAutomationsQb, getCoreQb, getQb } from '../../../../lib/kysely';
import { checkUsage, getBillingContacts } from '../../../../services/usage';
import { dispatchTriggerByIdEvent } from '../../../../services/translation_graph/triggers/router';
import { GLOBAL_DEFAULT_OPS_DETAIL_LEVEL } from '../../../../services/team/ops_detail';


/** Shared pagination + prefix-search input. Mirrors apps/web's offset
 *  pattern: OFFSET-based paging, case-insensitive PREFIX search, and a
 *  `total` count of all matching rows so the frontend can size the scroll. */
const paginationInput = {
  search: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
};

/** Enumerate ALL teams (admin = no team gate). Returns `{ id, name }`
 *  ordered by name. Used internally to attach team identity to cross-team
 *  rows; the paginated `listTeams` procedure is the frontend-facing source. */
async function allTeams(): Promise<Array<{ id: string; name: string }>> {
  const ctx = currentContext();
  return ctx.prisma.team.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

/** One page of teams matching an optional name prefix, plus the total count
 *  of matching teams. Prefix search is `name ILIKE search || '%'`. */
async function pageTeams(input: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{
  items: Array<{ id: string; name: string; ops_detail_level: OpsDetailLevel }>;
  total: number;
}> {
  const qb = getQb(['core.team', 'automations.team_settings']);

  // The name is core's, the ops-detail dial is automations'; a team with no
  // settings row is on the global default.
  let listQuery = qb
    .selectFrom('core.team as t')
    .leftJoin('automations.team_settings as ts', 'ts.team_id', 't.id')
    .select(['t.id', 't.name', 'ts.ops_detail_level'])
    .orderBy('t.name', 'asc')
    .limit(input.limit)
    .offset(input.offset);
  let countQuery = qb
    .selectFrom('core.team as t')
    .select(sql<number>`count(*)::int`.as('total'));

  if (input.search !== undefined && input.search.length > 0) {
    const prefix = `${input.search}%`;
    listQuery = listQuery.where('t.name', 'ilike', prefix);
    countQuery = countQuery.where('t.name', 'ilike', prefix);
  }

  const [items, countRow] = await Promise.all([
    listQuery.execute(),
    countQuery.executeTakeFirst(),
  ]);
  return {
    items: items.map((t) => ({
      id: t.id as unknown as string,
      name: t.name,
      ops_detail_level: t.ops_detail_level ?? GLOBAL_DEFAULT_OPS_DETAIL_LEVEL,
    })),
    total: countRow?.total ?? 0,
  };
}

const crossTeamOpsRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    // ── Teams (paginated/searchable enumeration) ─────────────────────────
    // The frontend-facing source of teams for infinite-scroll + prefix
    // search. Same row shape `userManagement.getTeams` exposes, wrapped in
    // `{ items, total }`.
    listTeams: procedure
      .input(z.object(paginationInput))
      .query(async ({ input }) => {
        return pageTeams(input);
      }),

    // ── Usage ────────────────────────────────────────────────────────────
    // Per team: the same two `checkUsage` calls + the `team_usage_config`
    // read that `usage.getUsageSummary` does, attached to team identity.
    //
    // PERF: the TEAMS are paged first (search + order + limit/offset), then
    // the per-team usage computation runs ONLY for that page's ≤200 teams —
    // never all 315. `total` is the count of teams matching the search.
    listUsageAcrossTeams: procedure
      .input(z.object(paginationInput))
      .query(async ({ input }) => {
        const { items: teams, total } = await pageTeams(input);
        const summaries = await Promise.all(
          teams.map(async (team) => {
            const [pipelineRuns, queryInputs] = await Promise.all([
              checkUsage(team.id, 'pipeline_run'),
              checkUsage(team.id, 'query_input'),
            ]);

            const config = await getQb(['team_usage_config'])
              .selectFrom('team_usage_config')
              .select(['alert_threshold_pct', 'week_starts_on'])
              .where('team_id', '=', team.id as TeamId)
              .executeTakeFirst();

            return {
              teamId: team.id,
              teamName: team.name,
              pipelineRuns,
              queryInputs,
              alertThresholdPct: config?.alert_threshold_pct ?? 80,
              weekStartsOn: config?.week_starts_on ?? 1,
            };
          }),
        );
        // pageTeams already ordered by name; keep that order.
        return { items: summaries, total };
      }),

    getBillingContacts: procedure
      .input(z.object({ teamId: z.string() }))
      .query(async ({ input }) => {
        return getBillingContacts(input.teamId);
      }),

    // Admin variant of the team-scoped `usage.setBillingContact`: the write
    // is cleanly addressable by `userEmailId` alone, so the only difference
    // from the team-context version is the absence of the same-team guard
    // (an admin acts across teams). Same DB write otherwise.
    setBillingContact: procedure
      .input(
        z.object({
          userEmailId: z.string(),
          isBillingContact: z.boolean(),
        }),
      )
      .mutation(async ({ input }) => {
        const qb = getCoreQb(['user_email']);
        const email = await qb
          .selectFrom('user_email')
          .select(['id'])
          .where('id', '=', input.userEmailId as UserEmailId)
          .executeTakeFirst();
        if (!email) throw new Error('Email not found');

        await qb
          .updateTable('user_email')
          .set({ is_billing_contact: input.isBillingContact })
          .where('id', '=', input.userEmailId as UserEmailId)
          .execute();

        return { success: true };
      }),

    // ── Trigger events (replay feed) ─────────────────────────────────────
    // Cross-team window over `public.trigger_event`, newest first, with
    // optional team/trigger filters. Team names attached from `listTeams`.
    listTriggerEvents: procedure
      .input(
        z.object({
          teamId: z.string().optional(),
          triggerId: z.string().optional(),
          ...paginationInput,
        }),
      )
      .query(async ({ input }) => {
        const teams = await allTeams();
        const teamNames = new Map(teams.map((t) => [t.id, t.name]));

        const qb = getAutomationsQb(['trigger_event']);
        const searchPrefix =
          input.search !== undefined && input.search.length > 0 ? `${input.search}%` : null;

        let listQuery = qb
          .selectFrom('trigger_event')
          .select([
            'id',
            'team_id',
            'trigger_id',
            'adapter_type',
            'trigger_type',
            'status',
            'failure_reason',
            'occurred_at',
            'created_at',
          ])
          .orderBy('created_at', 'desc')
          .limit(input.limit)
          .offset(input.offset);
        let countQuery = qb
          .selectFrom('trigger_event')
          .select(sql<number>`count(*)::int`.as('total'));

        if (input.teamId !== undefined) {
          listQuery = listQuery.where('team_id', '=', input.teamId as TeamId);
          countQuery = countQuery.where('team_id', '=', input.teamId as TeamId);
        }
        if (input.triggerId !== undefined) {
          listQuery = listQuery.where('trigger_id', '=', input.triggerId);
          countQuery = countQuery.where('trigger_id', '=', input.triggerId);
        }
        if (searchPrefix !== null) {
          listQuery = listQuery.where('adapter_type', 'ilike', searchPrefix);
          countQuery = countQuery.where('adapter_type', 'ilike', searchPrefix);
        }

        const rows = await listQuery.execute();
        const countRow = await countQuery.executeTakeFirst();

        const items = rows.map((row) => ({
          id: row.id as unknown as string,
          teamId: row.team_id as unknown as string,
          teamName: teamNames.get(row.team_id as unknown as string) ?? null,
          trigger_id: row.trigger_id,
          adapter_type: row.adapter_type,
          trigger_type: row.trigger_type,
          status: row.status,
          failure_reason: row.failure_reason,
          occurred_at: row.occurred_at,
          created_at: row.created_at,
        }));
        return { items, total: countRow?.total ?? 0 };
      }),

    // ── Replay (the safety-critical one) ─────────────────────────────────
    // Re-dispatch a stored trigger_event through the normal movement
    // dispatch path. `dryRun` DEFAULTS TO TRUE — a rehearsal whose writes
    // are captured, not committed. Only `dryRun: false` lets the live
    // dispatch proceed (which then still respects the trigger's own
    // `run_mode`). Admin = cross-team: the event is loaded by id with no
    // team gate, and its stored `team_id` scopes the dispatch.
    replayTriggerEvent: procedure
      .input(
        z.object({
          eventId: z.string(),
          dryRun: z.boolean().default(true),
        }),
      )
      .mutation(async ({ input }) => {
        const row = await getAutomationsQb(['trigger_event'])
          .selectFrom('trigger_event')
          .select(['team_id', 'trigger_id', 'payload'])
          .where('id', '=', input.eventId as TriggerEventId)
          .executeTakeFirst();
        if (!row) throw new Error(`Trigger event ${input.eventId} not found`);

        const result = await dispatchTriggerByIdEvent({
          triggerId: row.trigger_id,
          event: row.payload as unknown as TriggerEvent,
          teamId: row.team_id as TeamId,
          dryRun: input.dryRun,
        });

        const firings = result.movementFirings ?? [];
        const writeCount = firings.reduce((sum, f) => sum + f.writes, 0);
        const error =
          result.errors !== undefined && result.errors.length > 0
            ? result.errors.map((e) => e.message).join('; ')
            : undefined;

        return {
          dryRun: input.dryRun,
          status: error !== undefined ? 'error' : 'dispatched',
          droppedReason: result.droppedReason ?? null,
          firingCount: firings.length,
          writeCount,
          firings: firings.map((f) => ({
            movementName: f.movementName,
            writes: f.writes,
            dryRun: f.dryRun,
          })),
          ...(error !== undefined ? { error } : {}),
        };
      }),
  });

export { crossTeamOpsRouter };
