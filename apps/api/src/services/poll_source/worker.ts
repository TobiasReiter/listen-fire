// Poll-source worker — the platform half of the PollSource seam
// (plans/2026-06-19-granola-adapter). Two work handlers, siblings of the cron
// pair in `movement_scheduler/worker.ts`.
//
// Every movement-derived trigger whose `kind` resolves to a registered
// PollSource owns one `poll_source:<triggerId>` work row, due once its
// `poll_last_at` is older than the effective interval
// (`config.every` or `config.pollIntervalSeconds`, else the source default, P4). A due row pulls the
// source's new events, INJECTS each into the same dispatch path a webhook uses
// (`dispatchTriggerByIdEvent` — the one event pipeline), and re-arms itself one
// interval later. The opaque `poll_checkpoint` advances only after a successful
// pull; a failed pull throws, so the drain retries that row alone with backoff
// and one broken source never starves the rest. The periodic `poll_reconcile`
// keeps exactly one row per poll-source trigger.

import { sql } from 'kysely';
import { durationToMs, isValidDuration } from 'movement-lang';
import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { Trigger, TriggerId } from '../../generated/kysely/automations/Trigger';
import type { DiscriminableEvent, EventType } from 'movement-engine/public/adapter';
import type { WorkHandler } from '../work/kinds';

import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import {
  getAdapter,
  getPollSource,
  hasAdapter,
  isPollSource,
  resolveAdapterSlug,
} from '../translation_graph/adapters/registry';
import { dispatchDiscriminableEvent } from '../translation_graph/triggers/dispatch_event';
import { registerWorkHandler } from '../work/drain';
import { enqueueWork, listWorkByKind, removeWork } from '../work/store';

/** One row per poll-source trigger, due at its next poll. */
export function pollWorkKey(triggerId: string): string {
  return `poll_source:${triggerId}`;
}

const pollSourcePayloadSchema = z.object({
  triggerId: z.custom<TriggerId>((value) => z.uuid().safeParse(value).success),
});

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

interface PollTriggerRow {
  id: string;
  teamId: string;
  kind: string;
  config: unknown;
  credentialsId: string | undefined;
  movementId: string | null;
  checkpoint: unknown;
  lastPolledAt: Date | null;
}

function activeTriggers() {
  return getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', 'is not', null)
    .where('run_mode', '!=', 'off')
    .select([
      'id',
      'team_id',
      'kind',
      'config',
      'credentials_id',
      'movement_id',
      'poll_checkpoint',
      'poll_last_at',
    ]);
}

function toPollTriggerRow(
  r: Pick<
    Trigger,
    | 'id'
    | 'team_id'
    | 'kind'
    | 'config'
    | 'credentials_id'
    | 'movement_id'
    | 'poll_checkpoint'
    | 'poll_last_at'
  >,
): PollTriggerRow {
  return {
    id: r.id as unknown as string,
    teamId: r.team_id as unknown as string,
    kind: r.kind,
    config: r.config,
    credentialsId: (r.credentials_id as unknown as string | null) ?? undefined,
    movementId: (r.movement_id as unknown as string | null) ?? null,
    checkpoint: r.poll_checkpoint ?? undefined,
    lastPolledAt: r.poll_last_at,
  };
}

async function loadCandidates(): Promise<PollTriggerRow[]> {
  const rows = await activeTriggers().execute();
  return rows.filter((r) => isPollSource(r.kind)).map(toPollTriggerRow);
}

async function loadCandidate(triggerId: string): Promise<PollTriggerRow | null> {
  const row = await activeTriggers()
    .where('id', '=', triggerId as TriggerId)
    .executeTakeFirst();
  return row && isPollSource(row.kind) ? toPollTriggerRow(row) : null;
}

/**
 * The cadence to gate on: the listen's own interval or the source default.
 * From language version 5 the listen spells it `every: 5m`; versions 1-4 spell
 * it `pollIntervalSeconds: 300`. The trigger row carries whichever it was
 * written as, and a run of versions 1-4 can never have written `every`.
 */
function effectiveIntervalMs(config: unknown, sourceDefaultSeconds: number): number {
  const settings = (config ?? {}) as { every?: unknown; pollIntervalSeconds?: unknown };
  if (typeof settings.every === 'string' && isValidDuration(settings.every.trim())) {
    const ms = durationToMs(settings.every.trim());
    if (ms > 0) return ms;
  }
  const override = settings.pollIntervalSeconds;
  const seconds = typeof override === 'number' && override > 0 ? override : sourceDefaultSeconds;
  return seconds * SECOND;
}

/** The trigger's poll cadence, or null when its source is no longer registered. */
function pollIntervalMs(row: PollTriggerRow): number | null {
  const source = getPollSource({
    adapterType: row.kind,
    teamId: row.teamId as TeamId,
    credentialsId: row.credentialsId,
  });
  return source ? effectiveIntervalMs(row.config, source.pollIntervalSeconds) : null;
}

async function armPoll(row: PollTriggerRow, dueAt: Date): Promise<void> {
  await enqueueWork({
    kind: 'poll_source',
    key: pollWorkKey(row.id),
    teamId: row.teamId,
    payload: { triggerId: row.id },
    dueAt,
  });
}

/** Polls one source, then arms its row one interval later. */
export const pollSourceHandler: WorkHandler = {
  async run(payload, ctx) {
    const { triggerId } = pollSourcePayloadSchema.parse(payload);
    const row = await loadCandidate(triggerId);
    if (!row) return;
    await pollOne(row, ctx.now);
    const intervalMs = pollIntervalMs(row);
    if (intervalMs === null) return;
    await armPoll(row, new Date(ctx.now.getTime() + intervalMs));
  },
};

/** The periodic `poll_reconcile`: one `poll_source` row per poll-source trigger,
 *  and none for a trigger that was paused or deleted. */
export const pollReconcileHandler: WorkHandler = {
  async run(_payload, ctx) {
    const { now } = ctx;
    const [candidates, rows] = await Promise.all([
      loadCandidates(),
      listWorkByKind('poll_source'),
    ]);
    // A leased row's handler re-arms it after its pull; an enqueue now would
    // replace that time with one computed before the pull.
    const leasedKeys = new Set(
      rows
        .filter((row) => row.leaseUntil !== null && row.leaseUntil > now)
        .map((row) => row.key),
    );
    const activeKeys = new Set<string>();
    for (const candidate of candidates) {
      const key = pollWorkKey(candidate.id);
      activeKeys.add(key);
      if (leasedKeys.has(key)) continue;
      try {
        const intervalMs = pollIntervalMs(candidate);
        if (intervalMs === null) continue;
        const dueAt = candidate.lastPolledAt
          ? new Date(candidate.lastPolledAt.getTime() + intervalMs)
          : now;
        await armPoll(candidate, dueAt);
      } catch (err) {
        logger.error('[PollSource] reconcile failed for trigger', {
          triggerId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const row of rows) {
      if (!activeKeys.has(row.key)) await removeWork({ key: row.key });
    }
  },
};

export function registerPollWork(): void {
  registerWorkHandler('poll_source', pollSourceHandler);
  registerWorkHandler('poll_reconcile', pollReconcileHandler);
}

async function pollOne(
  row: PollTriggerRow,
  now: Date,
  opts: { force?: boolean; surfaceErrors?: boolean } = {},
): Promise<{ eventCount: number }> {
  const source = getPollSource({
    adapterType: row.kind,
    teamId: row.teamId as TeamId,
    credentialsId: row.credentialsId,
  });
  if (!source) return { eventCount: 0 }; // de-registered between load and here

  if (
    !opts.force &&
    row.lastPolledAt &&
    now.getTime() - row.lastPolledAt.getTime() < effectiveIntervalMs(row.config, source.pollIntervalSeconds)
  ) {
    return { eventCount: 0 }; // not due
  }

  const result = await source.getEvents({
    config: row.config,
    checkpoint: row.checkpoint,
    ...(row.movementId !== null ? { movementId: row.movementId } : {}),
  });

  // The Adapter (same slug) supplies the event-type union for discrimination.
  const adapter = hasAdapter(row.kind)
    ? getAdapter({
        adapterType: row.kind,
        teamId: row.teamId as TeamId,
        credentialsId: row.credentialsId,
      })
    : null;
  const eventTypes = adapter?.listEventTypes ? await adapter.listEventTypes() : [];

  for (const event of result.events) {
    await dispatchPolledEvent({ row, event, eventTypes, now, surfaceErrors: opts.surfaceErrors });
  }

  // Advance the checkpoint + interval mark ONLY after a successful pull.
  await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({ poll_checkpoint: jsonb(result.checkpoint ?? null) as never, poll_last_at: now })
    .where('id', '=', row.id as TriggerId)
    .execute();

  return { eventCount: result.events.length };
}

async function dispatchPolledEvent(input: {
  row: PollTriggerRow;
  event: DiscriminableEvent;
  eventTypes: readonly EventType[];
  now: Date;
  surfaceErrors?: boolean;
}): Promise<void> {
  const { row, event, eventTypes, now } = input;
  await dispatchDiscriminableEvent({
    triggerId: row.id as TriggerId,
    movementId: row.movementId,
    event,
    adapterType: resolveAdapterSlug(row.kind),
    triggerType: 'poll',
    eventTypes,
    teamId: row.teamId as TeamId,
    now,
    ...(input.surfaceErrors ? { surfaceErrors: true } : {}),
  });
}

/**
 * Force ONE poll trigger to pull + dispatch NOW, bypassing the interval gate —
 * the in-process entry `dev:inject granola` rides (mirrors how `dev:inject cron`
 * fires a cron trigger off-schedule). Same `pollOne` path the handler runs, so it
 * exercises the real getEvents → discriminate → dispatch → run pipeline. Surfaces
 * the engine error inline (like the test-harness webhook injects) instead of just
 * logging it, so a failing movement run reports its smoking-gun message.
 */
export async function pollTriggerNow(input: {
  triggerId: string;
  now?: Date;
}): Promise<{ found: boolean; eventCount: number }> {
  const now = input.now ?? new Date();
  const row = await loadCandidate(input.triggerId);
  if (!row) return { found: false, eventCount: 0 };
  const { eventCount } = await pollOne(row, now, { force: true, surfaceErrors: true });
  return { found: true, eventCount };
}
