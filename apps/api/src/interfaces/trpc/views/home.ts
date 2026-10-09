/**
 * Home dashboard tRPC surface (U3 of the 2026-05-29 UI redesign).
 *
 * One query — `getDashboard` — that returns everything the `/` page
 * needs in a single payload:
 *
 *   - `kind`              — discriminator the client uses to pick the
 *                           rendering state (empty | needs_setup | live).
 *   - `automations`       — derived status + activity counts per
 *                           trigger so the list and the status-pill
 *                           panel can share a source of truth.
 *   - `recentEvents`      — last N runs across all automations,
 *                           shaped as a flat feed.
 *   - `thingsWaiting`     — anything user-actionable: automations in
 *                           setup-incomplete state, automations in
 *                           error, unanswered questions.
 *   - `stats`             — the headline counts the page leads with
 *                           (active automations, events today, runs and
 *                           failures over 7 days, unanswered questions).
 *
 * Read-only. The page chrome (sidebar etc.) is the same shared shell
 * U2 wired; this router only produces data.
 *
 */

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getKnowledgeQb, getAutomationsQb, getQb } from '../../../lib/kysely';
import {
  deriveAutomationStatus,
  statusLabel,
  type AutomationStatus,
} from '../../../lib/automation/status';
import { describeSource } from '../../../lib/automation/describe';
import { resolveAutomationName } from '../../../lib/automation/naming';
import { listAskRecordsForTeam } from '../../../services/interaction/ask_records';
import { userProcedure as sharedUserProcedure } from '../procedures';

/**
 * Tri-state discriminator. Drives which sections the page renders.
 * Keeping the kind on the server avoids the client re-deriving it
 * from row counts and disagreeing with the status pills below.
 */
export type DashboardKind = 'empty' | 'needs_setup' | 'live';

export type DashboardAutomation = {
  id: string;
  name: string;
  description: string;
  status: AutomationStatus;
  statusLabel: string;
  eventsToday: number;
  lastEventAt: Date | null;
  /** The movement this trigger dispatches into, or `null` for a legacy
   *  movement-less trigger. Lets the client link to the movement page
   *  (run history + editing live there now) instead of the trigger's
   *  config-only page. */
  movementId: string | null;
};

export type DashboardEvent = {
  id: string;
  at: Date;
  status: 'success' | 'partial' | 'failed';
  description: string;
  automationId: string | null;
  automationName: string | null;
  /** See `DashboardAutomation.movementId`. */
  movementId: string | null;
  /** True when the firing ran in dry-run (preview) mode — it captured
   *  writes but committed nothing. The feed badges it as a preview. */
  dryRun: boolean;
};

export type DashboardThingWaiting = {
  kind: 'setup_incomplete' | 'error' | 'ask';
  message: string;
  /** The automation this points at, or `null` for an entry that isn't about
   *  one automation (the aggregate unanswered-questions entry). */
  automationId: string | null;
  actionUrl: string;
};

/**
 * The headline counts the page leads with. Each is the subject of a tile that
 * links to where the corresponding action lives.
 */
export type DashboardStats = {
  activeAutomations: number;
  eventsToday: number;
  runs7d: number;
  failures7d: number;
  openAsks: number;
};

export type DashboardPayload = {
  kind: DashboardKind;
  automations: DashboardAutomation[];
  recentEvents: DashboardEvent[];
  thingsWaiting: DashboardThingWaiting[];
  stats: DashboardStats;
};

const RECENT_EVENTS_LIMIT = 10;

const EMPTY_STATS: DashboardStats = {
  activeAutomations: 0,
  eventsToday: 0,
  runs7d: 0,
  failures7d: 0,
  openAsks: 0,
};

const homeRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /**
     * Single-shot home payload. One query for the whole page so the
     * client doesn't have to orchestrate three loading states. Cost
     * is bounded — we fetch triggers (typically <10), their entries,
     * their bound TGs (deduped), the last 10 runs across the team,
     * and per-trigger run counts for the last 24h.
     */
    getDashboard: userProcedure.query(async (): Promise<DashboardPayload> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;

      // ---- Empty-team short-circuit ----------------------------------
      // An empty team has no knowledge.node rows AND no automations.trigger
      // rows. We return the `empty` discriminator and let the page
      // render the inline setup funnel. Skipping the rest of the query
      // also keeps the empty-state page snappy.
      const nodeRow = await getKnowledgeQb(['node'])
        .selectFrom('node')
        .where('team_id', '=', teamId)
        .select('id')
        .limit(1)
        .executeTakeFirst();

      const triggers = await getAutomationsQb(['trigger'])
        .selectFrom('trigger')
        .where('team_id', '=', teamId)
        .select(['id', 'name', 'kind', 'config', 'movement_id', 'created_at'])
        .orderBy('created_at', 'desc')
        .execute();

      if (!nodeRow && triggers.length === 0) {
        return {
          kind: 'empty',
          automations: [],
          recentEvents: [],
          thingsWaiting: [],
          stats: EMPTY_STATS,
        };
      }

      // ---- Liveness ---------------------------------------------------
      // A trigger is a movement's `listen` dispatch index — it carries no
      // orchestration / object code (execution reads the canonical movement
      // text). Liveness is movement-derived: a trigger "does something" iff
      // `movement_id` is set (storage/authored.ts) — so the dashboard pill
      // agrees with the detail page.
      const triggerIds = triggers.map((t) => t.id as unknown as string);
      const hasAuthoredByTriggerId = new Map<string, boolean>();
      for (const t of triggers) {
        hasAuthoredByTriggerId.set(
          t.id as unknown as string,
          (t.movement_id as unknown as string | null) != null,
        );
      }

      // ---- Recent firings --------------------------------------------
      // trigger_run keys on the trigger id (the automation).
      const triggerIdSet = new Set(triggerIds);

      const runs = triggerIdSet.size
        ? await getAutomationsQb(['trigger_run'])
            .selectFrom('trigger_run')
            .where('team_id', '=', teamId)
            .where('trigger_id', 'in', Array.from(triggerIdSet))
            .select([
              'id',
              'trigger_id',
              'trigger_type',
              'status',
              'record_id',
              'steps',
              'dry_run',
              'started_at',
              'completed_at',
              'failed_at',
            ])
            .orderBy('started_at', 'desc')
            .limit(200)
            .execute()
        : [];

      // ---- Windowed counts -------------------------------------------
      // Counted in the database rather than off the 200-run page above, so the
      // headline numbers don't silently cap on a busy team — and so a tile
      // never disagrees with the per-automation rows it sits above.
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const triggerIdList = Array.from(triggerIdSet);

      const dayCounts = triggerIdList.length
        ? await getAutomationsQb(['trigger_run'])
            .selectFrom('trigger_run')
            .where('team_id', '=', teamId)
            .where('trigger_id', 'in', triggerIdList)
            .where('started_at', '>=', dayAgo)
            .select(({ fn }) => ['trigger_id', fn.count<string>('id').as('count')])
            .groupBy('trigger_id')
            .execute()
        : [];
      const eventsTodayByTrigger = new Map(
        dayCounts.map((row) => [row.trigger_id, Number(row.count)]),
      );

      const weekCountsByStatus = triggerIdList.length
        ? await getAutomationsQb(['trigger_run'])
            .selectFrom('trigger_run')
            .where('team_id', '=', teamId)
            .where('trigger_id', 'in', triggerIdList)
            .where('started_at', '>=', weekAgo)
            .select(({ fn }) => ['status', fn.count<string>('id').as('count')])
            .groupBy('status')
            .execute()
        : [];

      // Aggregate per-trigger from the run rows we already have.
      const lastRunByTrigger = new Map<
        string,
        { status: 'success' | 'partial' | 'failed'; at: Date }
      >();
      for (const run of runs) {
        const triggerId = triggerIdSet.has(run.trigger_id) ? run.trigger_id : undefined;
        if (!triggerId) continue;
        // Only TERMINAL runs drive the automation pill. A `running`/`parked`
        // run (async interaction) is in-flight — it must not override a prior
        // terminal status nor be miscounted as a success.
        const terminal = terminalRunStatus(run.status);
        if (terminal !== null) {
          const existing = lastRunByTrigger.get(triggerId);
          if (!existing || new Date(run.started_at) > existing.at) {
            lastRunByTrigger.set(triggerId, {
              status: terminal,
              at: new Date(run.started_at),
            });
          }
        }
      }

      // ---- Display names -----------------------------------------------
      // A movement-derived trigger's own `name` is the internal
      // `movement/<file>/<lane>` dispatch key — resolve the real movement
      // (one hop via `movement_id`) so the feed and "needs your attention"
      // list never leak it.
      const movementIds = [
        ...new Set(
          triggers
            .map((t) => t.movement_id)
            .filter((id): id is MovementId => id != null),
        ),
      ];
      const movementNameById = movementIds.length
        ? new Map(
            (
              await getAutomationsQb(['movement'])
                .selectFrom('movement')
                .where('id', 'in', movementIds)
                .where('team_id', '=', teamId)
                .select(['id', 'name'])
                .execute()
            ).map((m) => [m.id as unknown as string, m.name]),
          )
        : new Map<string, string>();

      // ---- Per-automation summary ------------------------------------
      const automations: DashboardAutomation[] = triggers.map((trigger) => {
        const triggerId = trigger.id as unknown as string;
        const lastRun = lastRunByTrigger.get(triggerId) ?? null;
        const status = deriveAutomationStatus({
          hasNonEmptyTgBody: hasAuthoredByTriggerId.get(triggerId) ?? false,
          lastRunStatus: lastRun?.status ?? null,
          lastRunAt: lastRun?.at ?? null,
          triggerCreatedAt: new Date(trigger.created_at),
        });
        const name = resolveAutomationName(
          { name: trigger.name, movementId: trigger.movement_id as unknown as string | null },
          movementNameById,
        );
        return {
          id: triggerId,
          name,
          description: describeSource(trigger.kind, trigger.config),
          status,
          statusLabel: statusLabel(status),
          eventsToday: eventsTodayByTrigger.get(triggerId) ?? 0,
          lastEventAt: lastRun?.at ?? null,
          movementId: trigger.movement_id as unknown as string | null,
        };
      });

      // ---- Recent events feed ----------------------------------------
      const automationsById = new Map(automations.map((a) => [a.id, a]));
      const recentEvents: DashboardEvent[] = runs
        // In-flight runs (`running`/`parked`) haven't produced an outcome to
        // narrate yet — the feed shows terminal firings only.
        .filter((run) => terminalRunStatus(run.status) !== null)
        .slice(0, RECENT_EVENTS_LIMIT)
        .map((run): DashboardEvent => {
          const triggerId = triggerIdSet.has(run.trigger_id) ? run.trigger_id : null;
          const automation = triggerId ? automationsById.get(triggerId) ?? null : null;
          const adapters = firingAdapters(run.steps);
          return {
            id: run.id as unknown as string,
            at: new Date(run.started_at),
            status: normaliseRunStatus(run.status),
            description: describeRun({
              status: normaliseRunStatus(run.status),
              automationName: automation?.name ?? null,
              sourceAdapterType: adapters.source,
              targetAdapterType: adapters.target,
              recordId: run.record_id,
            }),
            automationId: triggerId,
            automationName: automation?.name ?? null,
            movementId: automation?.movementId ?? null,
            dryRun: run.dry_run,
          };
        });

      // ---- Things waiting on you -------------------------------------
      const openAsks = (await listAskRecordsForTeam(teamId)).filter(
        (record) => record.state === 'open',
      ).length;

      const thingsWaiting: DashboardThingWaiting[] = [];
      // Questions come first — they block a run that is parked right now,
      // where a broken automation is merely not progressing.
      if (openAsks > 0) {
        thingsWaiting.push({
          kind: 'ask',
          message:
            openAsks === 1
              ? '1 question waiting for an answer.'
              : `${openAsks} questions waiting for an answer.`,
          automationId: null,
          actionUrl: '/asks',
        });
      }
      for (const a of automations) {
        if (a.status === 'setting_up') {
          thingsWaiting.push({
            kind: 'setup_incomplete',
            message: `${a.name} is set up but not yet running.`,
            automationId: a.id,
            actionUrl: automationActionUrl(a),
          });
        } else if (a.status === 'error') {
          thingsWaiting.push({
            kind: 'error',
            message: `${a.name} had an error on its last run.`,
            automationId: a.id,
            actionUrl: automationActionUrl(a),
          });
        }
      }

      // ---- Headline counts -------------------------------------------
      const stats: DashboardStats = {
        activeAutomations: automations.filter((a) => a.status === 'live').length,
        eventsToday: automations.reduce((sum, a) => sum + a.eventsToday, 0),
        runs7d: weekCountsByStatus.reduce((sum, row) => sum + Number(row.count), 0),
        failures7d: weekCountsByStatus
          .filter((row) => row.status === 'failed')
          .reduce((sum, row) => sum + Number(row.count), 0),
        openAsks,
      };

      // ---- Page-level discriminator ----------------------------------
      const anyLive = automations.some((a) => a.status === 'live');
      const kind: DashboardKind = anyLive ? 'live' : 'needs_setup';

      return { kind, automations, recentEvents, thingsWaiting, stats };
    }),
  });
};

/**
 * Where a "things waiting" row should send you: the movement page (run
 * history + editing live there now) when the trigger dispatches into one,
 * else the trigger's own config-only page — the fallback legacy
 * movement-less triggers still need.
 */
function automationActionUrl(a: { id: string; movementId: string | null }): string {
  return a.movementId ? `/movements/${a.movementId}` : `/automations/${a.id}`;
}

function normaliseRunStatus(status: string): 'success' | 'partial' | 'failed' {
  if (status === 'partial') return 'partial';
  if (status === 'failed') return 'failed';
  return 'success';
}

/**
 * A run's TERMINAL outcome, or `null` while it is still in flight
 * (`running`/`parked` — the async-interaction states, §5.3). Callers that
 * aggregate outcomes (the automation pill, the events feed) skip `null` so an
 * in-flight run is never coerced to `success`.
 */
function terminalRunStatus(status: string): 'success' | 'partial' | 'failed' | null {
  if (status === 'running' || status === 'parked') return null;
  return normaliseRunStatus(status);
}

/**
 * One-line description of a single run for the activity feed.
 * Intentionally short — the feed is scannable, not a full audit log.
 * For a successful run we mention the automation name and the
 * source→target adapters; for failures we surface that fact prominently
 * so the user notices and clicks through.
 */
function describeRun(input: {
  status: 'success' | 'partial' | 'failed';
  automationName: string | null;
  sourceAdapterType: string | null;
  targetAdapterType: string | null;
  recordId: string | null;
}): string {
  const automation = input.automationName ?? 'An automation';
  if (input.status === 'failed') {
    return `${automation} hit an error processing an event.`;
  }
  const source = input.sourceAdapterType ? titleCase(input.sourceAdapterType) : null;
  const target = input.targetAdapterType ? titleCase(input.targetAdapterType) : null;
  if (source && target) {
    return `${automation} synced a record from ${source} to ${target}.`;
  }
  if (target) {
    return `${automation} wrote a record to ${target}.`;
  }
  return `${automation} processed an event.`;
}

/**
 * Derive the firing's source / target adapter from its steps jsonb: the
 * first non-null source and the last non-null target across the chain. Used
 * only for the dashboard's plain-English run description.
 */
function firingAdapters(steps: unknown): {
  source: string | null;
  target: string | null;
} {
  if (!Array.isArray(steps)) return { source: null, target: null };
  let source: string | null = null;
  let target: string | null = null;
  for (const step of steps as Array<Record<string, unknown>>) {
    const s = typeof step?.sourceAdapterType === 'string' ? step.sourceAdapterType : null;
    const t = typeof step?.targetAdapterType === 'string' ? step.targetAdapterType : null;
    if (source === null && s) source = s;
    if (t) target = t;
  }
  return { source, target };
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export { homeRouter };
