// The movement scheduler — the platform half of the cron adapter.
//
// `listen to timer { schedule: "0 9 * * 1" } fire digest` derives an
// ordinary `automations.trigger` row (kind 'cron', the schedule in config).
// This module is the event source for those rows, as two work handlers:
// each cron trigger owns one `fire_cron:<triggerId>` work row due at its
// next occurrence, and the periodic `cron_reconcile` keeps exactly one such
// row per active trigger (arming new ones, removing rows whose trigger was
// paused or deleted). A due row dispatches one tick through
// `dispatchTriggerByIdEvent` — uniform dispatch, uniform run_mode gating,
// uniform trigger_run recording, exactly like an inbound webhook — and
// re-arms itself for the occurrence after.
//
// Checkpointing mirrors the scheduled-input poller's convention:
// `trigger.cron_last_fired_at` is the scheduler-owned mark (trigger
// reconciliation on deploy never touches it). First sight establishes the checkpoint without
// firing (a freshly saved listener fires at its NEXT occurrence, not
// retroactively); after that, any occurrence due since the mark fires
// ONCE (missed occurrences collapse into one tick — a scheduler that was
// down for three Mondays does not fire three digests) and the mark
// advances. Schedules are five-field cron, UTC, validated at check time
// by the SAME parser (@listen-fire/shared/cron).
//
// Process safety: a work row is held by one lease at a time, and the due
// time is always recomputed from the checkpoint, never trusted from the row,
// so a stale or duplicated row cannot fire an occurrence twice.

import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { WorkHandler } from '../work/kinds';

import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/services/logger';
import {
  CRON_ADAPTER_TYPE,
  type CronTickPayload,
} from '../translation_graph/adapters/cron';
import { dispatchTriggerByIdEvent } from '../translation_graph/triggers/router';
import { registerWorkHandler } from '../work/drain';
import { enqueueWork, listWorkByKind, removeWork } from '../work/store';

import { CronParseError, nextCronOccurrence, parseCron, type CronSchedule } from '#shared/cron';

/** One row per cron trigger, due at its next occurrence. */
export function cronWorkKey(triggerId: string): string {
  return `fire_cron:${triggerId}`;
}

const fireCronPayloadSchema = z.object({
  triggerId: z.custom<TriggerId>((value) => z.uuid().safeParse(value).success),
});

interface CronTriggerRow {
  id: TriggerId;
  teamId: string;
  name: string;
  schedule: string | null;
  timezone: string | null;
  lastFiredAt: Date | null;
}

function activeCronTriggers() {
  return getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('kind', '=', CRON_ADAPTER_TYPE)
    .where('movement_id', 'is not', null)
    .where('run_mode', '!=', 'off')
    .select(['id', 'team_id', 'name', 'config', 'cron_last_fired_at']);
}

function toCronTriggerRow(r: {
  id: TriggerId;
  team_id: string;
  name: string;
  config: unknown;
  cron_last_fired_at: Date | null;
}): CronTriggerRow {
  const config = (r.config ?? {}) as { schedule?: unknown; timezone?: unknown };
  return {
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    schedule: typeof config.schedule === 'string' ? config.schedule : null,
    timezone: typeof config.timezone === 'string' ? config.timezone : null,
    lastFiredAt: r.cron_last_fired_at,
  };
}

async function loadActiveCronTriggers(): Promise<CronTriggerRow[]> {
  const rows = await activeCronTriggers().execute();
  return rows.map(toCronTriggerRow);
}

async function loadActiveCronTrigger(triggerId: TriggerId): Promise<CronTriggerRow | null> {
  const row = await activeCronTriggers().where('id', '=', triggerId).executeTakeFirst();
  return row ? toCronTriggerRow(row) : null;
}

async function advanceCheckpoint(triggerId: TriggerId, to: Date): Promise<void> {
  await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({ cron_last_fired_at: to })
    .where('id', '=', triggerId)
    .execute();
}

interface ParsedSchedule {
  expression: string;
  cron: CronSchedule;
}

// Null when the trigger can never fire. Logged rather than thrown: a throw
// would retry with backoff forever, while an edit to the schedule is picked
// up by the next reconcile.
function scheduleOf(trigger: CronTriggerRow): ParsedSchedule | null {
  if (trigger.schedule === null) {
    // The checker requires the key, so this is drift worth logging, not crashing.
    logger.warn('[MovementScheduler] cron trigger has no schedule in config', {
      triggerId: trigger.id,
    });
    return null;
  }
  try {
    const cron = parseCron(trigger.schedule, {
      ...(trigger.timezone !== null ? { timezone: trigger.timezone } : {}),
    });
    return { expression: trigger.schedule, cron };
  } catch (err) {
    if (!(err instanceof CronParseError)) throw err;
    logger.warn('[MovementScheduler] invalid schedule on cron trigger', {
      triggerId: trigger.id,
      schedule: trigger.schedule,
      error: err.message,
    });
    return null;
  }
}

async function armOccurrenceAfter(input: {
  trigger: CronTriggerRow;
  schedule: ParsedSchedule;
  after: Date;
}): Promise<void> {
  const due = nextCronOccurrence(input.schedule.cron, input.after);
  if (due === null) return;
  await enqueueWork({
    kind: 'fire_cron',
    key: cronWorkKey(input.trigger.id),
    teamId: input.trigger.teamId,
    payload: { triggerId: input.trigger.id },
    dueAt: due,
  });
}

/** Fires one cron trigger if its occurrence came due since the checkpoint,
 *  then arms the row for the next occurrence. */
export const fireCronHandler: WorkHandler = {
  async run(payload, ctx) {
    const { triggerId } = fireCronPayloadSchema.parse(payload);
    const { now } = ctx;
    const trigger = await loadActiveCronTrigger(triggerId);
    if (!trigger) return;
    const schedule = scheduleOf(trigger);
    if (!schedule) return;

    if (trigger.lastFiredAt === null) {
      // First sight: establish the checkpoint and fire at the NEXT
      // occurrence (a freshly saved listener does not fire retroactively).
      await advanceCheckpoint(trigger.id, now);
      await armOccurrenceAfter({ trigger, schedule, after: now });
      return;
    }

    // From the checkpoint, not the row's due_at: missed occurrences collapse
    // into this one tick, and an early or duplicate row fires nothing.
    const due = nextCronOccurrence(schedule.cron, trigger.lastFiredAt);
    if (due === null) return;
    if (due.getTime() > now.getTime()) {
      await armOccurrenceAfter({ trigger, schedule, after: trigger.lastFiredAt });
      return;
    }

    // Advance the mark BEFORE dispatching so a slow/crashing dispatch can't
    // double-fire on a re-claim. The next occurrence is armed before
    // dispatching too: a re-arm survives a throwing dispatch's release.
    await advanceCheckpoint(trigger.id, now);
    await armOccurrenceAfter({ trigger, schedule, after: now });

    const tick: CronTickPayload = {
      firedAt: due.toISOString(),
      schedule: schedule.expression,
    };
    const event: TriggerEvent = {
      pipelineInputId: `trigger:${trigger.id}`,
      adapterType: CRON_ADAPTER_TYPE,
      triggerType: 'webhook',
      payload: tick,
      occurredAt: due.toISOString(),
    };
    const outcome = await dispatchTriggerByIdEvent({
      triggerId: trigger.id,
      event,
      teamId: trigger.teamId as TeamId,
    });
    if (outcome.errors !== undefined && outcome.errors.length > 0) {
      logger.error('[MovementScheduler] cron firing reported errors', {
        triggerId: trigger.id,
        name: trigger.name,
        errors: outcome.errors.map((e) => e.message),
      });
    } else {
      logger.info('[MovementScheduler] cron listener fired', {
        triggerId: trigger.id,
        name: trigger.name,
        due: due.toISOString(),
      });
    }
  },
};

/** The periodic `cron_reconcile`: one `fire_cron` row per active cron trigger,
 *  and none for a trigger that was paused or deleted. Failures are contained
 *  per trigger — one broken listener never starves the rest. */
export const cronReconcileHandler: WorkHandler = {
  async run(_payload, ctx) {
    const { now } = ctx;
    const [triggers, rows] = await Promise.all([
      loadActiveCronTriggers(),
      listWorkByKind('fire_cron'),
    ]);
    // A leased row's handler re-arms it from the checkpoint it just moved;
    // an enqueue now would replace that time with a stale one.
    const leasedKeys = new Set(
      rows
        .filter((row) => row.leaseUntil !== null && row.leaseUntil > now)
        .map((row) => row.key),
    );
    const activeKeys = new Set<string>();
    for (const trigger of triggers) {
      const key = cronWorkKey(trigger.id);
      activeKeys.add(key);
      if (leasedKeys.has(key)) continue;
      try {
        const schedule = scheduleOf(trigger);
        if (!schedule) continue;
        if (trigger.lastFiredAt === null) {
          await advanceCheckpoint(trigger.id, now);
          await armOccurrenceAfter({ trigger, schedule, after: now });
        } else {
          await armOccurrenceAfter({ trigger, schedule, after: trigger.lastFiredAt });
        }
      } catch (err) {
        logger.error('[MovementScheduler] cron reconcile failed for trigger', {
          triggerId: trigger.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const row of rows) {
      if (!activeKeys.has(row.key)) await removeWork({ key: row.key });
    }
  },
};

export function registerCronWork(): void {
  registerWorkHandler('fire_cron', fireCronHandler);
  registerWorkHandler('cron_reconcile', cronReconcileHandler);
}
