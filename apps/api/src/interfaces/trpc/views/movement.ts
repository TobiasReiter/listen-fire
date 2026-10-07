/**
 * tRPC surface for the movement-script editor.
 *
 * Movements are TEXT-CANONICAL: the `automations.movement` row's `source`
 * column is the program; the movement engine executes it directly, and
 * the listener triggers are derived rows
 * (see services/translation_graph/movement/store.ts).
 *
 *   - `catalog` — the team's `CatalogSnapshot` SKELETON (movement-lang):
 *     adapters, credentials, plugins and kg from DB + manifests only — no
 *     external introspection, so it returns fast. The browser checks and
 *     autocompletes OFFLINE against it; no per-keystroke round-trips.
 *   - `describeInstance` — one (adapter, credential) pair's instance
 *     schema, introspected on demand (TTL-cached server-side). The editor
 *     requests these for the constructions the source references and
 *     merges them into its snapshot; diagnostics tighten as schemas
 *     arrive (the checker is silent on unknown schemas by design).
 *   - `save` — upsert the source row, then gate (checkProgram + the dry
 *     interpretability scan) + reconcile the file's derived listener
 *     triggers (one `automations.trigger` row per `listen` statement).
 *     Diagnostics come back alongside the saved row id; the text always
 *     survives.
 *   - `get` / `list` — read back the canonical source + runtime validity +
 *     derived listeners (channel, key, trigger id, run_mode) — round-trip:
 *     re-opening a movement shows the exact text that was saved.
 *     operational pause state); everything else is derived from the text.
 *     Both also carry the file's FACETS (automation/library, derived from
 *     the text — the source is canonical, so nothing kind-like is stored)
 *     and who imports it (`usedBy` count on list, full dependent list on
 *     get).
 *   - `delete` — remove the movement and every derived trigger.
 */

import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getQb, getAutomationsQb } from '../../../lib/kysely';
import { runCostSummaries } from '../../../lib/llm_usage';
import { summariseRun } from './triggers';
import {
  describeMovementInstance,
  movementCatalogSnapshotForTeam,
  type DescribedInstance,
} from '../../../services/translation_graph/movement/catalog';
import {
  deleteMovement,
  getMovement,
  listMovements,
  saveMovement,
  type MovementDetail,
  type MovementListenerInfo,
  type MovementListItem,
  type SaveMovementResult,
} from '../../../services/translation_graph/movement/provision';
import {
  runMovementNow,
  type MovementRunNowResult,
} from '../../../services/translation_graph/movement/run_now';
import {
  checkMovementDependents,
  movementDependents,
  movementFileFacets,
  movementUsageIndex,
  type DependentCheckResult,
  type MovementDependent,
  type MovementFileFacets,
} from '../../../services/translation_graph/movement/files';
import { validateMovementForTeam } from '../../../services/translation_graph/movement/authoring';
import {
  storyViewForMovement,
  type StoryViewResult,
} from '../../../services/translation_graph/movement/story_view';
import { listMovementRows } from '../../../services/translation_graph/movement/store';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { UserService } from '../../../services/user';
import { userProcedure as sharedUserProcedure } from '../procedures';

export type MovementRunItem = {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  nodesWritten: number;
  dryRun: boolean;
  summary: string;
  /** The lane (trigger name) that produced this run. */
  lane: string;
  /** Model-call cost this run incurred, rolled up from `llm_usage` — zero
   *  when the run made no model calls (or ran before cost tracking). */
  costMicrodollars: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Fetch all `trigger_run` rows for the triggers of a given movement, merged
 * across lanes and annotated with the originating trigger's name. Factored
 * out of the procedure for testability.
 */
export async function movementRunsImpl(params: {
  teamId: TeamId;
  movementId: string;
}): Promise<MovementRunItem[]> {
  const { teamId, movementId } = params;

  const triggerRows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', teamId)
    .where('movement_id', '=', movementId as MovementId)
    .select(['id', 'name'])
    .execute();

  if (triggerRows.length === 0) return [];

  const triggerIds = triggerRows.map((r) => r.id as unknown as TriggerId);
  const laneByTriggerId = new Map(
    triggerRows.map((r) => [r.id as unknown as string, r.name]),
  );

  const runRows = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('trigger_id', 'in', triggerIds)
    .select([
      'id',
      'trigger_id',
      'status',
      'nodes_written',
      'dry_run',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  const costByRunId = await runCostSummaries(
    runRows.map((r) => r.id as unknown as TriggerRunId),
  );

  return runRows.map((row) => {
    const cost = costByRunId.get(row.id as unknown as string);
    return {
      id: row.id as unknown as string,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
      failureReason: row.failure_reason,
      nodesWritten: row.nodes_written,
      dryRun: row.dry_run,
      summary: summariseRun({
        status: row.status,
        failed_at: row.failed_at,
        failure_reason: row.failure_reason,
        nodes_written: row.nodes_written,
      }),
      lane: laneByTriggerId.get(row.trigger_id as unknown as string) ?? '',
      costMicrodollars: cost?.costMicrodollars ?? 0,
      calls: cost?.calls ?? 0,
      inputTokens: cost?.inputTokens ?? 0,
      outputTokens: cost?.outputTokens ?? 0,
    };
  });
}

export type MovementEventItem = {
  id: string;
  /** The lane (trigger name) the event arrived on. */
  lane: string;
  /** The channel the event came through — source adapter slug. */
  adapterType: string;
  status: string;
  failureReason: string | null;
  occurredAt: Date;
  createdAt: Date;
};

/**
 * The arrival ledger for a movement: every stored `trigger_event` across its
 * triggers, newest first, annotated with the lane it landed on. Distinct from
 * `movementRunsImpl` — an event lands whether or not anything ran as a result,
 * which is the whole point of keeping the receipt.
 */
export async function movementEventsImpl(params: {
  teamId: TeamId;
  movementId: string;
}): Promise<MovementEventItem[]> {
  const { teamId, movementId } = params;

  const triggerRows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', teamId)
    .where('movement_id', '=', movementId as MovementId)
    .select(['id', 'name'])
    .execute();

  if (triggerRows.length === 0) return [];

  const laneByTriggerId = new Map(
    triggerRows.map((r) => [r.id as unknown as string, r.name]),
  );

  const eventRows = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('team_id', '=', teamId)
    .where('trigger_id', 'in', [...laneByTriggerId.keys()])
    .select([
      'id',
      'trigger_id',
      'adapter_type',
      'status',
      'failure_reason',
      'occurred_at',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  return eventRows.map((row) => ({
    id: row.id as unknown as string,
    lane: laneByTriggerId.get(row.trigger_id) ?? '',
    adapterType: row.adapter_type,
    status: row.status,
    failureReason: row.failure_reason,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  }));
}

/**
 * Fetch the most recent `trigger_run` for each of the given trigger IDs,
 * keyed by trigger ID. Triggers with no runs are absent from the map.
 * Ordered by `created_at DESC`; the first row per trigger_id is the latest.
 */
export async function latestRunsByTriggerId(params: {
  teamId: TeamId;
  triggerIds: string[];
}): Promise<Map<string, MovementRunItem>> {
  const { teamId, triggerIds } = params;
  if (triggerIds.length === 0) return new Map();

  const rows = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('trigger_id', 'in', triggerIds as unknown as TriggerId[])
    .select([
      'id',
      'trigger_id',
      'status',
      'nodes_written',
      'dry_run',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .execute();

  // First pass: pick the latest row per trigger (rows arrive newest-first).
  const latestRows: typeof rows = [];
  const seenTriggers = new Set<string>();
  for (const row of rows) {
    const triggerId = row.trigger_id as unknown as string;
    if (seenTriggers.has(triggerId)) continue;
    seenTriggers.add(triggerId);
    latestRows.push(row);
  }

  // Cost only for the runs that survived the dedup, not the whole history.
  const costByRunId = await runCostSummaries(
    latestRows.map((r) => r.id as unknown as TriggerRunId),
  );

  const result = new Map<string, MovementRunItem>();
  for (const row of latestRows) {
    const triggerId = row.trigger_id as unknown as string;
    const cost = costByRunId.get(row.id as unknown as string);
    result.set(triggerId, {
      id: row.id as unknown as string,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
      failureReason: row.failure_reason,
      nodesWritten: row.nodes_written,
      dryRun: row.dry_run,
      summary: summariseRun({
        status: row.status,
        failed_at: row.failed_at,
        failure_reason: row.failure_reason,
        nodes_written: row.nodes_written,
      }),
      lane: '',
      costMicrodollars: cost?.costMicrodollars ?? 0,
      calls: cost?.calls ?? 0,
      inputTokens: cost?.inputTokens ?? 0,
      outputTokens: cost?.outputTokens ?? 0,
    });
  }
  return result;
}

/** A listener row enriched with the most recent run for that lane. */
type MovementListenerWithRun = MovementListenerInfo & {
  lastRun: MovementRunItem | null;
};

/** List rows carry the file's text-derived facets + who imports it. */
type MovementListItemResponse = Omit<MovementListItem, 'listeners'> & {
  /** How many other files import this one. */
  usedBy: number;
  listeners: MovementListenerWithRun[];
};

type MovementDetailResponse = MovementDetail & {
  facets: MovementFileFacets;
  /** The files importing this one (direct importers). */
  dependents: MovementDependent[];
};

type SaveMovementResponse = SaveMovementResult & {
  /** After a shipped save: a fresh verdict for every file importing this
   *  one (their imports resolve the new text). Null on a failed save.
   *  Dependents' stored validity is never rewritten here. */
  dependentChecks: DependentCheckResult[] | null;
};

const movementRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    catalog: userProcedure.query(async () => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;
      return movementCatalogSnapshotForTeam(teamId);
    }),

    /**
     * The same snapshot, TYPED FOR ONE PROGRAM: instance schemas filled by the
     * compile path, so the editor checks against exactly what `save` will
     * compute — including positioned instances (`spreadsheet:`) and narrowing
     * refinements (`WHERE \`Title\` == …`), neither of which the editor could
     * previously express.
     *
     * A MUTATION because a tRPC query serializes its input into the URL, and the
     * program is the input. It reads nothing and writes nothing; the verb is
     * about where the bytes ride, and the alternative — sending the names the
     * program mentions instead of the program — is what forced the editor to
     * assemble its own thinner schema in the first place.
     */
    catalogForSource: userProcedure
      .input(z.object({ source: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        return movementCatalogSnapshotForTeam(teamId, { source: input.source });
      }),

    describeInstance: userProcedure
      .input(
        z.object({
          /** Adapter slug (the construction's callee). */
          adapter: z.string(),
          /** Credential IMPORT name from the snapshot; omit for
           *  credential-free adapters like email. */
          credentialName: z.string().optional(),
          /**
           * Scope the (expensive) per-type describes to these type names.
           * Omitted still means the full surface — which is what the editor
           * asks for today, and the reason this endpoint was the last consumer
           * of the eager instance schema.
           *
           * The agent-facing REST route has had this (and `position`) all
           * along; the editor could not express a narrow question at all, so
           * it asked for everything on every construction. Exposing them here
           * is what lets the editor walk the same graph, by the same
           * addresses, as the agent.
           *
           */
          types: z.array(z.string()).optional(),
          /**
           * WHERE TO STAND — an address a previous call handed back, echoed
           * verbatim. Absent is the root. Never constructed by the caller: an
           * address is only ever learned by walking.
           */
          position: z.string().optional(),
          /**
           * The names the edited source mentions (`referencedNames(source)`).
           * Scopes the describes to the types actually named, so the editor and
           * the compiler agree on the schema for one source.
           *
           * NAMES, not the source: this is a query, so its input rides in the
           * URL and a movement of any size would overrun it.
           */
          mentions: z.array(z.string()).optional(),
          /** Skip the server's TTL cache and re-introspect. */
          forceRefresh: z.boolean().optional(),
        }),
      )
      .query(async ({ input }): Promise<DescribedInstance> => {
        const ctx = currentContext();
        return describeMovementInstance({
          teamId: ctx.user.teamId as TeamId,
          adapter: input.adapter,
          ...(input.credentialName !== undefined
            ? { credentialName: input.credentialName }
            : {}),
          ...(input.types !== undefined ? { types: input.types } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...(input.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {}),
        });
      }),

    save: userProcedure
      .input(
        z.object({
          source: z.string(),
          /** Existing movement row (the editor's re-save path). */
          id: z.string().uuid().optional(),
          /** Display name override; defaults to the declaration's name. */
          name: z.string().optional(),
          /** The updatedAt the editor loaded — for the concurrency guard.
           *  Omit to force an overwrite of whatever's stored. */
          baseUpdatedAt: z.string().optional(),
          /** Explicit consent to ship a non-valid save (the editor's
           *  "save anyway" confirmation). */
          acknowledgeErrors: z.boolean().optional(),
        }),
      )
      .mutation(async ({ input }): Promise<SaveMovementResponse> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId;
        const result = await saveMovement({
          teamId,
          source: input.source,
          userId: ctx.user.id,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.baseUpdatedAt !== undefined ? { baseUpdatedAt: input.baseUpdatedAt } : {}),
          ...(input.acknowledgeErrors !== undefined
            ? { acknowledgeErrors: input.acknowledgeErrors }
            : {}),
        });

        // Dependent revalidation: a shipped save changes what files importing
        // this one resolve (imports read the saved TEXT), so re-check each
        // direct importer and report the verdicts with the save. Their
        // stored validity stays untouched — it's assessed by each file's
        // OWN saves and runs.
        if (!result.ok) return { ...result, dependentChecks: null };
        const dependentChecks = await checkMovementDependents({
          teamId,
          name: result.movementName,
          validate: validateMovementForTeam,
        });
        return { ...result, dependentChecks };
      }),

    get: userProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }): Promise<MovementDetailResponse | null> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId;
        const detail = await getMovement({ teamId, id: input.id });
        if (!detail) return null;
        const dependents = await movementDependents({ teamId, name: detail.name });
        return { ...detail, facets: movementFileFacets(detail.source), dependents };
      }),

    /**
     * The same movement, told as a story instead of shown as code: the
     * checked program projected to a `StoryIR` and joined with the display
     * vocabulary its systems declare, so the page that draws it names none
     * of them. Read-only, static (no run data), and it always carries the
     * movement's validity — an unreadable file gets a typed no-story rather
     * than a picture nobody checked.
     *
     */
    story: userProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }): Promise<StoryViewResult | null> => {
        const ctx = currentContext();
        return storyViewForMovement({ teamId: ctx.user.teamId, id: input.id });
      }),

    list: userProcedure.query(async (): Promise<MovementListItemResponse[]> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;
      const [items, rows] = await Promise.all([
        listMovements(teamId),
        listMovementRows(teamId),
      ]);
      const usage = movementUsageIndex(rows);

      const allTriggerIds = items.flatMap((item) => item.listeners.map((l) => l.triggerId));
      const latestRuns = await latestRunsByTriggerId({ teamId, triggerIds: allTriggerIds });

      return items.map((item) => ({
        ...item,
        usedBy: usage.get(item.name)?.length ?? 0,
        listeners: item.listeners.map((l) => ({
          ...l,
          lastRun: (() => {
            const run = latestRuns.get(l.triggerId);
            return run ? { ...run, lane: l.name } : null;
          })(),
        })),
      }));
    }),

    delete: userProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input }): Promise<{ deleted: boolean }> => {
        const ctx = currentContext();
        const deleted = await deleteMovement({ teamId: ctx.user.teamId, id: input.id });
        return { deleted };
      }),

    /**
     * All runs for a movement, merged across its lanes (triggers), newest
     * first. Each item carries a `lane` — the trigger's name — so the caller
     * can group or filter by lane.
     */
    runs: userProcedure
      .input(z.object({ movementId: z.string().uuid() }))
      .query(async ({ input }): Promise<MovementRunItem[]> => {
        const ctx = currentContext();
        return movementRunsImpl({
          teamId: ctx.user.teamId as TeamId,
          movementId: input.movementId,
        });
      }),

    /**
     * The arrival ledger: every inbound event the movement's triggers caught,
     * merged across lanes, newest first — whether or not it ran anything.
     */
    events: userProcedure
      .input(z.object({ movementId: z.string().uuid() }))
      .query(async ({ input }): Promise<MovementEventItem[]> => {
        const ctx = currentContext();
        return movementEventsImpl({
          teamId: ctx.user.teamId as TeamId,
          movementId: input.movementId,
        });
      }),

    /**
     * "Run now" — inject an invocation event on the movement's MANUAL
     * channel (`go = manual()` + `listen to go {} fire <movement>`),
     * through normal trigger dispatch. The event carries the pressing member, so
     * `@user_*` / `@actor_*` resolve to them; a listener whose written
     * instances are all `dry_run: true` rehearses (writes captured, not
     * committed). Real writes otherwise.
     */
    runNow: userProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          /** Free-form text supplied with the run (optional). */
          text: z.string().optional(),
          /** Files supplied with the run (optional). */
          files: z
            .array(
              z.object({
                filename: z.string().min(1),
                contentType: z.string().min(1),
                /** Base64-encoded file bytes. */
                contentBase64: z.string().min(1),
              }),
            )
            .optional(),
        }),
      )
      .mutation(async ({ input }): Promise<MovementRunNowResult> => {
        const ctx = currentContext();
        const user = await UserService.getById(ctx.user.id);
        return runMovementNow({
          teamId: ctx.user.teamId,
          movementId: input.id,
          text: input.text,
          files: input.files,
          actor: {
            email: user.email,
            ...(user.username !== null ? { name: user.username } : {}),
          },
        });
      }),
  });
};

export { movementRouter };
