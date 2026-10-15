/**
 * tRPC surface for the automations UI. Reads `automations.trigger` rows for
 * the active team.
 *
 * A `automations.trigger` row is purely a movement's `listen` dispatch
 * index: it carries no orchestration / object code. A trigger is live
 * iff `movement_id IS NOT NULL`, and the detail page renders it via its
 * movement (movement_id → movement row) rather than an orchestration
 * program tree. Execution reads the canonical movement text — the TG
 * editor and orchestration storage are gone (kill-tg phase 6).
 *
 * Counterpart to `/sources` + `/destinations`, reading the trigger
 * substrate instead of the legacy `pipeline_input` / `pipeline_output`
 * tables.
 *
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { sql } from 'kysely';
import { observable } from '@trpc/server/observable';

import type { TriggerRunEvent } from '../../../lib/message_queue/queues/triggerRuns';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { currentContext } from '../../../services/context';
import { mq } from '../../../lib/message_queue';
import { trpc } from '../trpc';
import { getAutomationsQb, getCoreQb, getKnowledgeQb, getQb } from '../../../lib/kysely';
import { runMovementTestRun } from '../../../services/translation_graph/movement/test_run';
import { describeAutomation } from '../../../lib/automation/describe';
import {
  deriveAutomationStatus,
  statusLabel,
  type AutomationStatus,
} from '../../../lib/automation/status';
import {
  getTriggerConfigSchema,
  siblingKindsForAdapter,
  listAdapterCapabilities,
  adapterRequiredCredentialType,
  resolveAdapterSlug,
} from '../../../services/translation_graph/adapters/registry';
import {
  zodFromConfigBlocks,
  firstTriggerConfigError,
  isValueBlock,
  type ConfigBlock,
} from 'movement-engine/services/translation_graph/triggerConfig';
import { findSiblingTriggerByConfigValue } from '../../../services/translation_graph/storage/tg_table';
import {
  listTriggerEvents,
  replayTriggerEvent,
} from '../../../services/translation_graph/triggers/event_store';
import {
  parseRunMode,
  type TriggerRunMode,
} from '../../../services/translation_graph/triggers/run_mode';
import { runMovementNow } from '../../../services/translation_graph/movement/run_now';
import { clearGuardPaused } from '../../../services/loop_guard';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { reportedFailureReason } from '../../../services/translation_graph/runs/trigger_run';
import { UserService } from '../../../services/user';
import { userProcedure as sharedUserProcedure } from '../procedures';

export type TriggerListItem = {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  configSummary: string;
  boundTgCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A source a user can start a manual automation from — surfaced in the
 * "Create automation" modal's source picker. `connected` is false when
 * the adapter needs a credential the team hasn't authorised yet; such
 * sources still appear (flagged "connect first") so the picker shows the
 * full menu of what the system supports.
 */
export type CreatableSource = {
  adapterType: string;
  name: string;
  /** Uppercase trigger kind the created `automations.trigger.kind` takes. */
  triggerKind: string;
  needsConnection: boolean;
  connected: boolean;
};

export type TriggerDetail = {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  config: unknown;
  credentialsId: string | null;
  provisionedBySetupAgent: boolean;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Retired with the TG storage layer (kill-tg phase 6). Schema types
   * and bound TGs no longer exist; both are kept on the shape (always
   * empty) so the web detail page stays type-stable.
   */
  schemaTypes: Array<{ id: string; name: string }>;
  entries: Array<never>;
};

const triggersRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /**
     * Has the active team done anything yet? True iff at least one
     * `knowledge.node` row OR at least one `automations.trigger` row
     * exists. Drives the root-page redirect: empty teams land on
     * `/setup` (the prospect funnel), seeded teams land on `/model`.
     *
     * Lives on the triggers router rather than knowledge because
     * either signal counts as "the team has done something" — the
     * shape stays a single boolean to keep the caller dumb.
     */
    teamHasContent: userProcedure.query(async (): Promise<{ hasContent: boolean }> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;

      const nodeRow = await getKnowledgeQb(['node'])
        .selectFrom('node')
        .where('team_id', '=', teamId)
        .select('id')
        .limit(1)
        .executeTakeFirst();
      if (nodeRow) return { hasContent: true };

      const triggerRow = await getAutomationsQb(['trigger'])
        .selectFrom('trigger')
        .where('team_id', '=', teamId)
        .select('id')
        .limit(1)
        .executeTakeFirst();
      return { hasContent: !!triggerRow };
    }),

    /**
     * List every trigger in the active team's scope. Triggers are
     * movement listen-dispatch indices now — they carry no bound TGs.
     */
    list: userProcedure.query(async (): Promise<TriggerListItem[]> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;

      const rows = await getAutomationsQb(['trigger'])
        .selectFrom('trigger')
        .where('team_id', '=', teamId)
        .select(['id', 'name', 'kind', 'config', 'created_at', 'updated_at'])
        .orderBy('created_at', 'desc')
        .execute();

      return rows.map((row) => ({
        id: row.id as unknown as string,
        name: row.name,
        kind: row.kind,
        kindLabel: kindToLabel(row.kind),
        configSummary: summariseConfig(row.kind, row.config),
        // Movements carry no bound TGs (kill-tg phase 6).
        boundTgCount: 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    }),

    /**
     * Fetch a single trigger by id. Used by the `/triggers/[id]` detail
     * page. Bound TGs and schema types retired with the TG storage layer
     * (kill-tg phase 6); `entries`/`schemaTypes` stay on the shape but are
     * always empty.
     */
    get: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }): Promise<TriggerDetail> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const trigger = await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('id', '=', input.id as TriggerId)
          .where('team_id', '=', teamId)
          .select([
            'id',
            'name',
            'kind',
            'config',
            'credentials_id',
            'provisioned_by_setup_agent',
            'created_at',
            'updated_at',
          ])
          .executeTakeFirst();

        if (!trigger) throw new Error(`Trigger ${input.id} not found`);

        return {
          id: trigger.id as unknown as string,
          name: trigger.name,
          kind: trigger.kind,
          kindLabel: kindToLabel(trigger.kind),
          config: trigger.config,
          credentialsId: (trigger.credentials_id as unknown as string | null) ?? null,
          provisionedBySetupAgent: trigger.provisioned_by_setup_agent,
          createdAt: trigger.created_at,
          updatedAt: trigger.updated_at,
          schemaTypes: [],
          entries: [],
        };
      }),

    /**
     * Plain-English view of a single automation, tailored for the
     * `/automations/[id]` redesign (U4).
     *
     */
    getAutomationDetail: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }): Promise<AutomationDetail> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const trigger = await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('id', '=', input.id as TriggerId)
          .where('team_id', '=', teamId)
          .select([
            'id',
            'name',
            'kind',
            'config',
            'credentials_id',
            'run_mode',
            'movement_id',
            'created_at',
            // Loop-guard pause state — surfaced so the detail page can show a
            // "Paused by safety guard — Resume" control distinct from run_mode.
            'guard_paused_at',
            'guard_paused_reason',
            'guard_paused_signal',
          ])
          .executeTakeFirst();
        if (!trigger) throw new Error(`Automation ${input.id} not found`);

        // Movement-derived listener: the trigger row is compiled from a
        // `listen` line in a movement script, so the detail page points at
        // the movement instead of offering the orchestration editor.
        const movementId = (trigger.movement_id as unknown as string | null) ?? null;
        let movement: { id: string; name: string } | null = null;
        if (movementId !== null) {
          const movementRow = await getAutomationsQb(['movement'])
            .selectFrom('movement')
            .where('id', '=', movementId as MovementId)
            .where('team_id', '=', teamId)
            .select(['id', 'name'])
            .executeTakeFirst();
          if (movementRow) {
            movement = { id: movementRow.id as unknown as string, name: movementRow.name };
          }
        }

        const recentRunRows = await getAutomationsQb(['trigger_run'])
          .selectFrom('trigger_run')
          .where('team_id', '=', teamId)
          .where('trigger_id', '=', input.id)
          .select([
            'id',
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
          .limit(10)
          .execute();

        const recentEvents = recentRunRows.map((row) => ({
          id: row.id as unknown as string,
          status: row.status,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          failedAt: row.failed_at,
          failureReason: reportedFailureReason(row),
          nodesWritten: row.nodes_written,
          // A dry run captured writes but committed nothing — surface it so
          // the activity feed reads as a preview, not a real write.
          dryRun: row.dry_run,
          summary: summariseRun({
            status: row.status,
            failed_at: row.failed_at,
            failure_reason: row.failure_reason,
            nodes_written: row.nodes_written,
          }),
        }));

        const lastRun = recentEvents[0] ?? null;
        // `running`/`parked` (async interaction) are in-flight, not terminal —
        // they don't drive the automation pill (→ null, "no terminal run yet").
        const lastRunStatus: 'success' | 'partial' | 'failed' | null = lastRun
          ? lastRun.failedAt
            ? 'failed'
            : lastRun.status === 'success' || lastRun.status === 'partial' || lastRun.status === 'failed'
              ? (lastRun.status as 'success' | 'partial' | 'failed')
              : null
          : null;
        // A movement-derived trigger DOES something (its movement runs
        // when an event arrives) — no TG bodies to inspect post-kill-tg.
        const status: AutomationStatus = deriveAutomationStatus({
          hasNonEmptyTgBody: movementId !== null,
          lastRunStatus,
          lastRunAt: lastRun ? new Date(lastRun.startedAt) : null,
          triggerCreatedAt: trigger.created_at,
        });

        const summarySentence = describeAutomation({
          trigger: { kind: trigger.kind, config: trigger.config },
          tgBodies: [],
        });

        // The orchestration program tree was retired with the TG storage
        // layer (kill-tg phase 6). Movement-derived triggers render via
        // the movement link instead; the web page treats `program === null`
        // as "renders elsewhere".
        const program: null = null;

        // Why the status is what it is — surfaced under the pill. "Setting
        // up" means genuinely not done (no actions); a live automation that
        // hasn't fired yet gets a calm "untested" note rather than a
        // misleading status downgrade.
        const statusDetail: string | null =
          status === 'error'
            ? recentEvents[0]?.failureReason
              ? `The last run failed: ${recentEvents[0].failureReason}`
              : 'The last run failed — see recent events below.'
            : status === 'setting_up'
              ? "It doesn't do anything yet. Add an action below, or ask the assistant to set one up."
              : status === 'live' && recentEvents.length === 0
                ? "Live and listening — it just hasn't received a matching event yet."
                : null;

        // Source credential binding. When the source adapter needs a
        // credential, surface the team's connections of that type so the
        // detail page can let the user attach one — the gap manual
        // automations leave (they're created with credentials_id null).
        const requiredCredentialType = adapterRequiredCredentialType(trigger.kind);
        const boundCredentialsId =
          (trigger.credentials_id as unknown as string | null) ?? null;
        let credentialOptions: Array<{ id: string; name: string }> = [];
        let boundCredentialName: string | null = null;
        if (requiredCredentialType) {
          const credRows = await getAutomationsQb(['external_service_credentials'])
            .selectFrom('external_service_credentials')
            .where('team_id', '=', teamId)
            .where('type', '=', requiredCredentialType)
            .select(['id', 'name'])
            .orderBy('name', 'asc')
            .execute();
          credentialOptions = credRows.map((r) => ({
            id: r.id as unknown as string,
            name: r.name,
          }));
          boundCredentialName =
            credentialOptions.find((o) => o.id === boundCredentialsId)?.name ?? null;
        }

        return {
          id: trigger.id as unknown as string,
          name: trigger.name,
          kind: trigger.kind,
          kindLabel: kindToLabel(trigger.kind),
          summarySentence,
          status,
          statusLabel: statusLabel(status),
          statusDetail,
          runMode: parseRunMode(trigger.run_mode),
          // Loop-guard pause: a live, automatic mechanism, distinct from the
          // retired run_mode 'off' — the UI offers "Resume" and explains why
          // the guard stepped in.
          guardPaused: trigger.guard_paused_at
            ? {
                pausedAt: trigger.guard_paused_at.toISOString(),
                reason: trigger.guard_paused_reason,
                signal: trigger.guard_paused_signal,
              }
            : null,
          program,
          // The trigger's incoming feed, so the branch editor's condition
          // expression editor can offer the right fields (a `dynamic`
          // source ref keyed on the trigger's adapter + credentials).
          triggerSource: {
            // The editor operates in adapter-slug space (its source picker
            // and every TG source ref use the slug); resolve the trigger's
            // routing kind ('WEB') to the canonical slug ('web') so the
            // branch editor's field resolution matches.
            adapterKind: resolveAdapterSlug(trigger.kind),
            credentialsId: boundCredentialsId,
          },
          connection: {
            requiredCredentialType,
            credentialsId: boundCredentialsId,
            credentialName: boundCredentialName,
            options: credentialOptions,
          },
          movement,
          recentEvents,
        };
      }),

    /**
     * The durable receipt log: every inbound event stored for a trigger,
     * and playback — re-dispatch any stored event through normal trigger
     * dispatch (a replay acts like a fresh arrival; it records a new run).
     */
    listTriggerEvents: userProcedure
      .input(
        z.object({
          triggerId: z.string().min(1),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        return listTriggerEvents({
          teamId: ctx.user.teamId as TeamId,
          triggerId: input.triggerId,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      }),

    replayTriggerEvent: userProcedure
      .input(z.object({ eventId: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        return replayTriggerEvent({
          teamId: ctx.user.teamId as TeamId,
          eventId: input.eventId,
        });
      }),

    /**
     * Live "Recent activity" — pushes each newly-recorded firing for THIS
     * trigger to the automation detail page so the list updates without a
     * refetch. Backed by the in-process message queue (`mq.triggerRuns`),
     * published from the `TriggerRunRecorder`; the client merges these on top
     * of the initial `getAutomationDetail.recentEvents` page. Keyed per
     * trigger.
     */
    /**
     * Team-wide run lifecycle ticks for the sidebar's "running" badge:
     * `started` / `finished` edges, so the client can count in-flight
     * runs. Event type inlined (not imported from the queue module): a
     * queue-type import into this router drags the native MQ → node:stream
     * into the tRPC dts bundle and breaks codegen.
     */
    onRunActivity: procedure
      .subscription(async ({ ctx: { authorise } }) => {
        await authorise();
        const teamId = currentContext().user.teamId as unknown as string;
        const queue = mq.triggerRunActivity
          .node({ name: `triggerRunActivity.teamId.${teamId}`, type: 'queue' })
          .attachTo(mq.triggerRunActivity.activityByTeamId);
        type Activity = {
          teamId: string;
          runId: string;
          triggerId: string;
          phase: 'started' | 'finished';
        };
        return observable<Activity>((emit) => {
          const onMessage = (evt: Activity) => {
            if (evt.teamId !== teamId) return;
            emit.next(evt);
          };
          queue.on('message', onMessage);
          return () => queue.off('message', onMessage);
        });
      }),

    onRecentActivity: procedure
      .input(z.object({ triggerId: z.string().min(1) }))
      .subscription(async ({ ctx: { authorise }, input: { triggerId } }) => {
        // Subscriptions run over the WS transport, where the user context
        // isn't populated by the HTTP `userProcedure` middleware — it's
        // `authorise()` that fills it. Call it first (mirrors the legacy
        // dealList subscriptions), then read `currentContext()`. Using
        // `userProcedure` here would throw "Missing user" because its
        // middleware reads the (still-empty) context before authorise runs.
        await authorise();
        const ctx = currentContext();
        const teamId = ctx.user.teamId as unknown as string;
        // The node name MUST equal the direct exchange's `keyPrefix + value`
        // (`triggerRun.recorded.triggerId.<id>`) — that's the key
        // `recordedByTriggerId` routes on (native.ts: destinations.get).
        const queue = mq.triggerRuns
          .node({
            name: `triggerRun.recorded.triggerId.${triggerId}`,
            type: 'queue',
          })
          .attachTo(mq.triggerRuns.recordedByTriggerId);
        return observable<AutomationRecentEvent>((emit) => {
          const onMessage = (run: TriggerRunEvent) => {
            // Defence: the direct exchange already routes by triggerId, but
            // scope to the team too so a stray cross-team event can't leak.
            if (run.teamId !== teamId) return;
            emit.next({
              id: run.id,
              status: run.status,
              startedAt: new Date(run.startedAt),
              completedAt: run.completedAt ? new Date(run.completedAt) : null,
              failedAt: run.failedAt ? new Date(run.failedAt) : null,
              failureReason: run.failureReason,
              nodesWritten: run.nodesWritten,
              dryRun: run.dryRun,
              summary: summariseRun({
                status: run.status,
                failed_at: run.failedAt ? new Date(run.failedAt) : null,
                failure_reason: run.failureReason,
                nodes_written: run.nodesWritten,
              }),
            });
          };
          queue.on('message', onMessage);
          return () => queue.off('message', onMessage);
        });
      }),

    /**
     * Read a trigger's editable configuration: the adapter-declared config
     * BLOCKS (value blocks with label/help/widget + prefix/suffix,
     * presentation `section` blocks, action affordances) plus the current
     * values from `trigger.config` (keyed by each value block's `key`). The
     * automation detail page walks the blocks and renders the rich form. An
     * empty `blocks` array means the trigger kind has no user-editable settings
     * (the page hides the section).
     *
     */
    getTriggerConfig: userProcedure
      .input(z.object({ id: z.string().min(1) }))
      .query(
        async ({
          input,
        }): Promise<{
          blocks: ConfigBlock[];
          values: Record<string, string>;
        }> => {
          const ctx = currentContext();
          const teamId = ctx.user.teamId as TeamId;
          const trigger = await getAutomationsQb(['trigger'])
            .selectFrom('trigger')
            .where('id', '=', input.id as TriggerId)
            .where('team_id', '=', teamId)
            .select(['kind', 'config'])
            .executeTakeFirst();
          if (!trigger) throw new Error(`Automation ${input.id} not found`);

          const blocks = getTriggerConfigSchema({ kind: trigger.kind, teamId });
          if (!blocks || blocks.length === 0) {
            return { blocks: [], values: {} };
          }
          const config = (trigger.config ?? {}) as Record<string, unknown>;
          const values: Record<string, string> = {};
          for (const block of blocks) {
            if (!isValueBlock(block)) continue;
            const raw = config[block.key];
            values[block.key] = raw == null ? '' : String(raw);
          }
          return { blocks: [...blocks], values };
        },
      ),

    /**
     * Persist edited trigger configuration. Validates the submitted
     * values against the adapter's declared schema, enforces any
     * `unique` field across sibling kinds (excluding self), then merges
     * the validated values into `trigger.config` — structural keys the
     * form doesn't manage (e.g. `destination`) are preserved. Team-scoped;
     * a cross-team id returns the same not-found error a missing row would.
     *
     */
    updateTriggerConfig: userProcedure
      .input(
        z.object({
          id: z.string().min(1),
          values: z.record(z.string(), z.unknown()),
        }),
      )
      .mutation(
        async ({
          input,
        }): Promise<{ id: string; values: Record<string, string> }> => {
          const ctx = currentContext();
          const teamId = ctx.user.teamId as TeamId;
          const trigger = await getAutomationsQb(['trigger'])
            .selectFrom('trigger')
            .where('id', '=', input.id as TriggerId)
            .where('team_id', '=', teamId)
            .select(['id', 'kind', 'config'])
            .executeTakeFirst();
          if (!trigger) throw new Error(`Automation ${input.id} not found`);

          const blocks = getTriggerConfigSchema({ kind: trigger.kind, teamId });
          if (!blocks || blocks.length === 0) {
            throw new Error('This automation has no editable settings.');
          }

          const parsed = zodFromConfigBlocks(blocks).safeParse(input.values);
          if (!parsed.success) {
            throw new Error(firstTriggerConfigError(parsed.error));
          }
          const validated = parsed.data as Record<string, unknown>;

          // Enforce adapter-declared uniqueness across the kinds that
          // share this adapter (e.g. all email-style inbound kinds). Only
          // value blocks carry `key`/`unique`; presentation/action blocks
          // contribute nothing here.
          const siblingKinds = siblingKindsForAdapter(trigger.kind);
          for (const block of blocks) {
            if (!isValueBlock(block) || block.kind === 'select' || !block.unique) {
              continue;
            }
            const value = validated[block.key];
            if (value == null || value === '') continue;
            const conflict = await findSiblingTriggerByConfigValue({
              teamId,
              kinds: siblingKinds,
              fieldKey: block.key,
              value: String(value),
              excludeTriggerId: trigger.id as unknown as string,
            });
            if (conflict) {
              throw new Error(
                `"${String(value)}" is already in use by another automation. Pick a different ${block.label.toLowerCase()}.`,
              );
            }
          }

          const existing = (trigger.config ?? {}) as Record<string, unknown>;
          const nextConfig = { ...existing, ...validated };
          await getAutomationsQb(['trigger'])
            .updateTable('trigger')
            .set({
              config: sql`${JSON.stringify(nextConfig)}::jsonb` as unknown as never,
              updated_at: sql`now()`,
            })
            .where('id', '=', trigger.id as TriggerId)
            .where('team_id', '=', teamId)
            .execute();

          const values: Record<string, string> = {};
          for (const block of blocks) {
            if (!isValueBlock(block)) continue;
            const raw = validated[block.key];
            values[block.key] = raw == null ? '' : String(raw);
          }
          return { id: trigger.id as unknown as string, values };
        },
      ),

    /**
     * Rename a trigger (the user-facing name of an automation). The
     * `/automations/[id]` page exposes inline-rename via this mutation
     * (C2). Scoped to the active team — cross-team writes throw, so a
     * stolen id from another tenant returns the same not-found error
     * shape as a missing row.
     *
     */
    renameTrigger: userProcedure
      .input(
        z.object({
          triggerId: z.string().min(1),
          name: z.string().trim().min(1).max(200),
        }),
      )
      .mutation(async ({ input }): Promise<{ id: string; name: string }> => {
        const ctx = currentContext();
        return renameTriggerImpl({
          triggerId: input.triggerId,
          name: input.name,
          teamId: ctx.user.teamId as TeamId,
        });
      }),

    /**
     * Delete an automation (the `automations.trigger` row). The bound TGs
     * are reusable transforms that may be shared, so they are NOT
     * deleted — only the trigger + its orchestration go. Team-scoped;
     * a stolen/cross-team id returns the same not-found error a missing
     * row would.
     */
    deleteTrigger: userProcedure
      .input(z.object({ triggerId: z.string().min(1) }))
      .mutation(async ({ input }): Promise<{ id: string }> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const result = await getAutomationsQb(['trigger'])
          .deleteFrom('trigger')
          .where('id', '=', input.triggerId as TriggerId)
          .where('team_id', '=', teamId)
          .returning('id')
          .executeTakeFirst();
        if (!result) throw new Error(`Automation ${input.triggerId} not found`);
        return { id: result.id as unknown as string };
      }),

    /**
     * Test run — fire a synthetic event at this automation's movement and
     * return what it WOULD do, without touching any live system. Runs the
     * movement engine with `dryRun: true` so target adapters are wrapped and
     * writes are captured, never performed. Optional `seed` biases the
     * synthetic scenario. Team-scoped: a stolen/cross-team id returns
     * not-found.
     *
     * The TG `simulate` core this used to call retired with the TG engine
     * (kill-tg SD-1) — the movement engine is the sole executor, so a Test
     * run IS a movement dry-run.
     *
     */
    dryRunTrigger: userProcedure
      .input(
        z.object({
          triggerId: z.string().min(1),
          seed: z.string().trim().max(500).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const owned = await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('id', '=', input.triggerId as TriggerId)
          .where('team_id', '=', teamId)
          .select('id')
          .executeTakeFirst();
        if (!owned) throw new Error(`Automation ${input.triggerId} not found`);
        return runMovementTestRun({
          teamId,
          triggerId: input.triggerId,
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        });
      }),

    // `setRunMode` was here. It is GONE, and nothing replaces it: run_mode has
    // no writer outside the movement-text reconciliation in
    // movement/provision.ts. The dry_run⇄live axis is derived from the script
    // on every save, so a toggle would be overwritten; and the operator pause
    // (`off`) is retired in favour of the one pause authority — commenting the
    // `listen` line out. See services/translation_graph/triggers/run_mode.ts.

    /**
     * Resume an automation the loop guard paused (manual recovery, P7). Clears
     * the guard-paused state, resets the guard's rate/budget windows so it
     * starts clean, and logs who resumed it. Auto-resume is deliberately NOT the
     * default — the looping condition usually persists and would oscillate.
     *
     * The events captured while paused are recorded as replayable
     * `trigger_event` rows; reprocessing them is the follow-on replay UX.
     *
     */
    resumeGuardPaused: userProcedure
      .input(z.object({ triggerId: z.string().min(1) }))
      .mutation(async ({ input }): Promise<{ resumed: boolean }> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        // Team-scope the lookup before touching guard state.
        const owned = await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('id', '=', input.triggerId as TriggerId)
          .where('team_id', '=', teamId)
          .select('id')
          .executeTakeFirst();
        if (!owned) throw new Error(`Automation ${input.triggerId} not found`);
        return clearGuardPaused({
          triggerId: input.triggerId,
          teamId: teamId as unknown as string,
          resumedBy: ctx.user.id,
        });
      }),

    /**
     * Bind (or clear, with null) the source credential on an automation.
     * The gap manual automations leave: a source that needs a connection is
     * created with `credentials_id` null. Validates that the credential
     * belongs to the team AND matches the type the source adapter requires,
     * so a mismatched connection can't be attached.
     */
    setTriggerCredential: userProcedure
      .input(
        z.object({
          triggerId: z.string().min(1),
          credentialsId: z.string().min(1).nullable(),
        }),
      )
      .mutation(async ({ input }): Promise<{ id: string; credentialsId: string | null }> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const trigger = await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('id', '=', input.triggerId as TriggerId)
          .where('team_id', '=', teamId)
          .select(['kind'])
          .executeTakeFirst();
        if (!trigger) throw new Error(`Automation ${input.triggerId} not found`);

        if (input.credentialsId !== null) {
          const requiredType = adapterRequiredCredentialType(trigger.kind);
          if (!requiredType) {
            throw new Error('This automation’s source needs no connection.');
          }
          const cred = await getAutomationsQb(['external_service_credentials'])
            .selectFrom('external_service_credentials')
            .where('id', '=', input.credentialsId as never)
            .where('team_id', '=', teamId)
            .select(['type'])
            .executeTakeFirst();
          if (!cred) throw new Error('That connection was not found.');
          if (cred.type !== requiredType) {
            throw new Error('That connection is the wrong type for this source.');
          }
        }

        const updated = await getAutomationsQb(['trigger'])
          .updateTable('trigger')
          .set({
            credentials_id: (input.credentialsId as never) ?? null,
            updated_at: sql`CURRENT_TIMESTAMP` as never,
          })
          .where('id', '=', input.triggerId as TriggerId)
          .where('team_id', '=', teamId)
          .returning(['id', 'credentials_id'])
          .executeTakeFirst();
        if (!updated) throw new Error(`Automation ${input.triggerId} not found`);
        return {
          id: updated.id as unknown as string,
          credentialsId: (updated.credentials_id as unknown as string | null) ?? null,
        };
      }),

    /**
     * The sources a user can start a manual automation from — every
     * adapter that can originate an automation (`canSource`), folded with
     * the active team's connected credentials so the picker can flag the
     * ones that need a connection first. Derived from the static adapter
     * manifests (no hardcoded list); the trigger kind each source maps to
     * is its first declared `triggerKinds[]` value.
     *
     */
    listCreatableSources: userProcedure.query(
      async (): Promise<CreatableSource[]> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const connectedRows = await getAutomationsQb(['external_service_credentials'])
          .selectFrom('external_service_credentials')
          .where('team_id', '=', teamId)
          .select(['type'])
          .execute();
        const connectedTypes = new Set(connectedRows.map((r) => r.type));

        return listAdapterCapabilities()
          .filter((c) => c.canSource)
          .map((c) => {
            const needsConnection = c.requiredCredentialType !== null;
            const connected =
              !needsConnection ||
              connectedTypes.has(c.requiredCredentialType as ExternalServiceType);
            return {
              adapterType: c.adapterType,
              name: c.displayName,
              triggerKind: c.triggerKinds[0] ?? c.adapterType.toUpperCase(),
              needsConnection,
              connected,
            };
          });
      },
    ),

    /**
     * Manually create an automation (a `automations.trigger`) for users who
     * know what they want, skipping the conversational setup agent. The
     * new trigger has no orchestration yet — it does nothing until the user
     * authors "What happens" on the detail page. A blank manual automation
     * is inert because liveness is content-derived (the dispatcher only
     * fires triggers whose orchestration references a TG with roots).
     * Returns the new id so the UI can navigate to it.
     *
     */
    createAutomation: userProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(200),
          sourceKind: z.string().trim().min(1),
        }),
      )
      .mutation(async ({ input }): Promise<{ id: string }> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const source = listAdapterCapabilities().find(
          (c) =>
            c.canSource &&
            (c.adapterType === input.sourceKind ||
              c.triggerKinds.includes(input.sourceKind)),
        );
        if (!source) {
          throw new Error(`"${input.sourceKind}" can't start an automation.`);
        }
        // Model A: `trigger.kind` IS the source adapter slug — the adapter
        // the trigger interprets events with.
        const triggerKind = source.adapterType;

        // Attach an existing credential of the source's required type when
        // the team has one; otherwise leave it null (the user wires the
        // connection up later from the detail page / Connections).
        let credentialsId: ExternalServiceCredentialsId | null = null;
        if (source.requiredCredentialType !== null) {
          const cred = await getAutomationsQb(['external_service_credentials'])
            .selectFrom('external_service_credentials')
            .where('team_id', '=', teamId)
            .where('type', '=', source.requiredCredentialType as ExternalServiceType)
            .orderBy('created_at', 'desc')
            .select(['id'])
            .executeTakeFirst();
          credentialsId = (cred?.id as ExternalServiceCredentialsId | undefined) ?? null;
        }

        const pipelineConfigurationId =
          await ensureActivePipelineConfiguration(teamId);

        const triggerId = randomUUID();
        await getAutomationsQb(['trigger'])
          .insertInto('trigger')
          .values({
            id: triggerId as unknown as TriggerId,
            team_id: teamId,
            pipeline_configuration_id: pipelineConfigurationId,
            name: input.name,
            kind: triggerKind,
            config: sql`'{}'::jsonb` as unknown as never,
            credentials_id: credentialsId,
            provisioned_by_setup_agent: false,
            created_by_user_id: ctx.user.id as never,
          } as never)
          .execute();

        return { id: triggerId };
      }),

    /**
     * Submit text and/or files directly to an automation — the "send to this
     * automation" affordance on the automation page. A thin wrapper over the
     * one on-demand invocation service (`runMovementNow`): it has the trigger
     * id + text + files + session, injects a manual invocation through the SAME
     * path real events use (`dispatchTriggerByIdEvent`), respecting the
     * dispatcher's authoring gate.
     *
     * Legacy trigger-keyed entry, kept working for the apps/web Send box
     * pending UI consolidation onto the movement-keyed `movement.runNow`
     * (Chunk E).
     */
    submitWebEvent: userProcedure
      .input(
        z.object({
          triggerId: z.string().min(1),
          text: z.string().optional(),
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
      .mutation(
        async ({ input }): Promise<{ ranCount: number; errors: string[] }> => {
          const ctx = currentContext();
          const user = await UserService.getById(ctx.user.id);
          const result = await runMovementNow({
            teamId: ctx.user.teamId,
            triggerId: input.triggerId,
            text: input.text,
            files: input.files,
            actor: {
              email: user.email,
              ...(user.username !== null ? { name: user.username } : {}),
            },
          });
          return result.ok
            ? { ranCount: 1, errors: [] }
            : { ranCount: 0, errors: result.errors };
        },
      ),
  });
};

/**
 * Resolve the team's active `pipeline_configuration`, creating one (and
 * marking it active) if the team has none. A `automations.trigger` row
 * requires a non-null `pipeline_configuration_id`; this mirrors the
 * setup-agent's provisioning helper without reaching into it (that path
 * is owned by a sibling task).
 */
async function ensureActivePipelineConfiguration(
  teamId: TeamId,
): Promise<PipelineConfigurationId> {
  const team = await getCoreQb(['team'])
    .selectFrom('team')
    .where('id', '=', teamId)
    .select(['id', 'active_pipeline_configuration_id', 'name'])
    .executeTakeFirst();
  if (!team) throw new Error('No team found');
  if (team.active_pipeline_configuration_id) {
    return team.active_pipeline_configuration_id as PipelineConfigurationId;
  }

  const newId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    .values({
      id: newId,
      team_id: teamId,
      name: `${team.name} configuration`,
    } as never)
    .execute();
  await getCoreQb(['team'])
    .updateTable('team')
    .set({ active_pipeline_configuration_id: newId })
    .where('id', '=', teamId)
    .execute();
  return newId;
}

/**
 * DB-bound implementation of `renameTrigger`. Pulled out of the
 * procedure body so unit tests can exercise it without standing up
 * a real tRPC router. Throws on stolen-id / wrong-team — same shape
 * the procedure throws.
 */
export async function renameTriggerImpl(params: {
  triggerId: string;
  name: string;
  teamId: TeamId;
}): Promise<{ id: string; name: string }> {
  const result = await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({ name: params.name, updated_at: sql`CURRENT_TIMESTAMP` as never })
    .where('id', '=', params.triggerId as TriggerId)
    .where('team_id', '=', params.teamId)
    .returning(['id', 'name'])
    .executeTakeFirst();

  if (!result) {
    throw new Error(`Automation ${params.triggerId} not found`);
  }

  return {
    id: result.id as unknown as string,
    name: result.name,
  };
}

// ── Automation detail types + helpers ──────────────────────────────────────

export interface AutomationRecentEvent {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  /** Total records written across the firing's steps. */
  nodesWritten: number;
  /** True when the firing ran in dry-run mode — it captured writes but
   *  committed nothing. The activity feed badges it as a preview. */
  dryRun: boolean;
  summary: string;
}

export interface AutomationDetail {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  summarySentence: string;
  status: AutomationStatus;
  statusLabel: string;
  /** Why the automation is in this status (mainly for "Setting up" /
   *  "Error"); null when the status is self-explanatory. */
  statusDetail: string | null;
  /** Per-automation liveness, READ-ONLY: dry_run (runs but captures writes
   *  instead of committing) or live, both derived from the movement text on
   *  every save. `off` still appears on rows that predate the operator-pause
   *  removal; nothing can set it any more. */
  runMode: TriggerRunMode;
  /** Set when the loop guard has paused this automation (distinct from the
   *  retired run_mode 'off'). The UI offers a "Resume" control and shows why
   *  the guard stepped in. Null when not safety-paused. */
  guardPaused: { pausedAt: string; reason: string | null; signal: string | null } | null;
  /** The orchestration program tree was retired with the TG storage layer
   *  (kill-tg phase 6). Movement-derived triggers render via the movement
   *  link, so this is always null; kept on the shape for web type-stability. */
  program: null;
  /** The trigger's incoming feed (adapter + credentials), used by the
   *  branch editor to resolve condition fields. */
  triggerSource: { adapterKind: string; credentialsId: string | null };
  /** The source's credential binding. `requiredCredentialType` is null when
   *  the source needs no connection (the UI hides the control then).
   *  Otherwise the UI shows the bound credential (or "not connected") and
   *  lets the user pick from `options` (the team's connections of that type). */
  connection: {
    requiredCredentialType: ExternalServiceType | null;
    credentialsId: string | null;
    credentialName: string | null;
    options: Array<{ id: string; name: string }>;
  };
  /** When the trigger is a listener compiled from a movement script, the
   *  movement it belongs to — the detail page links there instead of
   *  offering the orchestration editor. Null for hand-built automations. */
  movement: { id: string; name: string } | null;
  recentEvents: AutomationRecentEvent[];
}

export function summariseRun(row: {
  status: string;
  failed_at: Date | null;
  failure_reason: string | null;
  nodes_written: number;
}): string {
  if (row.failed_at !== null) {
    return row.failure_reason ? `Failed: ${row.failure_reason}` : 'Failed';
  }
  // In-flight runs (async interaction) aren't done — narrate the live state
  // rather than claiming a finished outcome (§5.3).
  if (row.status === 'parked') return 'Waiting on a response';
  if (row.status === 'running') return 'Running';
  const verbed =
    row.status === 'partial' ? 'Partially processed' : 'Processed';
  const n = row.nodes_written;
  const writes =
    n > 0 ? ` — ${n} ${n === 1 ? 'record' : 'records'} written` : ' — no records written';
  return `${verbed}${writes}`;
}

/**
 * User-facing label for an adapter slug. Falls back to a title-cased
 * version of the raw slug for kinds we haven't pinned a friendly label
 * for yet — better than leaking `CUSTOM_EMAIL` into the UI.
 */
function kindToLabel(kind: string): string {
  const labels: Record<string, string> = {
    MAILGUN: 'Email',
    CUSTOM_EMAIL: 'Email',
    INBOUND_EMAIL: 'Email',
    GMAIL: 'Email',
    TWILIO: 'WhatsApp',
    INBOUND_WHATSAPP: 'WhatsApp',
    SLACK: 'Slack',
    AIRTABLE: 'Airtable',
    ATTIO: 'Webhook',
    AFFINITY: 'Webhook',
    API: 'API',
    WEB: 'Web',
    CHROME_EXTENSION: 'Chrome',
    WEB_QUESTION: 'Question',
    GRANOLA: 'Granola',
    EVERTRACE: 'Evertrace',
    DEALROOM: 'Dealroom',
    NATIVE_VALUATIONS: 'Listen-Fire Valuations',
    KG_MUTATION: 'Knowledge change',
  };
  if (labels[kind]) return labels[kind];
  return kind
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Single-line summary of a trigger's config. Kept narrow: surfaces just
 * the routing key for email-style triggers (the `key` shows up as a
 * plus-suffix in the inbound address; we label it "Tag" for users —
 * "Plus-suffix" is substrate jargon per the 2026-05-29 redesign), and a
 * generic JSON shape hint for everything else. Empty configs render as
 * a dash so the table cell isn't a visual void.
 */
function summariseConfig(kind: string, config: unknown): string {
  if (!config || typeof config !== 'object') return '—';
  const obj = config as Record<string, unknown>;
  if (typeof obj.key === 'string' && obj.key.length > 0) {
    return `Tag: ${obj.key}`;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) return '—';
  return keys.join(', ');
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export { triggersRouter };
