// The admission dry run's daily roll-up: what the Rust engine would have
// refused the runs the TypeScript engine ran for, by reason, language version
// and automation, kept past this process's life. The dry run itself is the
// engine's (rust_engine.ts `dryAdmitRun`) and only holds its verdicts; this
// host side drains them and writes them where operator events already live
// (`ops_event`, one row per process per day, rewritten as the day goes on), so
// it needs no table of its own. That store's retention (14 days) bounds the
// window a report can read.
//
// Tenant data never enters a row: reasons, versions, and automation ids,
// which are opaque.

import { sql } from 'kysely';
import { z } from 'zod';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { OpsEventId } from '../../generated/kysely/public/OpsEvent';

import { getAutomationsQb, getQb } from '../../lib/kysely';
import { OpsEventType, OpsSeverity } from '../../lib/ops/types';
import { logger } from 'movement-engine/services/logger';
import {
  OTHER_REASONS,
  REASONS_KEPT,
  cappedKey,
  emptyAdmissionTally,
  holdAdmissionVerdict,
  takeAdmissionVerdicts,
  tallyVerdict,
  type AdmissionTally,
  type AdmissionVerdict,
} from 'movement-engine/services/movement_engine/rust_stats';

/** What a roll-up row's `detail` says it is. */
export const ADMISSION_ROLLUP_KIND = 'engine_admission_dry_run';

/** A run whose automation could not be named (a run with no trigger run row,
 *  a dev script's). */
export const UNKNOWN_AUTOMATION = 'unknown';

const tallySchema = z.object({
  sampled: z.number(),
  admitted: z.number(),
  first: z.record(z.string(), z.number()),
  all: z.record(z.string(), z.number()),
});

const rollupSchema = z.object({
  kind: z.literal(ADMISSION_ROLLUP_KIND),
  /** The UTC day the verdicts were persisted on, `YYYY-MM-DD`. */
  day: z.string(),
  /** By the language version runs were pinned to. */
  versions: z.record(z.string(), tallySchema),
  /** Refused runs by reason, then by automation id: `first` by the first
   *  reason, `all` by every reason. */
  automations: z.object({
    first: z.record(z.string(), z.record(z.string(), z.number())),
    all: z.record(z.string(), z.record(z.string(), z.number())),
  }),
  /** Refused runs, by reason, of automations past the `AUTOMATIONS_KEPT`
   *  a reason names. */
  overflow: z
    .object({ first: z.record(z.string(), z.number()), all: z.record(z.string(), z.number()) })
    .default({ first: {}, all: {} }),
});

export type AdmissionRollup = z.infer<typeof rollupSchema>;

/** True of every operator event but a roll-up row: the ops views read
 *  runs and notices, and a roll-up is neither. */
export const notAdmissionRollup = sql<boolean>`(ops_event.detail->>'kind') is distinct from ${ADMISSION_ROLLUP_KIND}`;

/** A row's `detail` read as a roll-up; undefined for any other event. */
export function readAdmissionRollup(detail: unknown): AdmissionRollup | undefined {
  const parsed = rollupSchema.safeParse(detail);
  return parsed.success ? parsed.data : undefined;
}

function emptyRollup(day: string): AdmissionRollup {
  return { kind: ADMISSION_ROLLUP_KIND, day, versions: {}, automations: { first: {}, all: {} }, overflow: { first: {}, all: {} } };
}

/** How many automations a reason names in a row; the runs of any more are
 *  counted, not named. The row is rewritten every flush, so it stays small. */
export const AUTOMATIONS_KEPT = 100;

/** Adds `verdict`, for the run of `automation`, to `rollup`. Reasons past
 *  `REASONS_KEPT` count as `OTHER_REASONS`, as the tallies count them. */
export function addVerdict(rollup: AdmissionRollup, verdict: AdmissionVerdict, automation: string): void {
  tallyVerdict((rollup.versions[String(verdict.languageVersion)] ??= emptyAdmissionTally()), verdict.reasons);
  const [first] = verdict.reasons;
  if (first === undefined) return;
  const name = (which: 'first' | 'all', reason: string) => {
    const named = (rollup.automations[which][reason] ??= {});
    if (Object.hasOwn(named, automation) || Object.keys(named).length < AUTOMATIONS_KEPT) bump(named, automation);
    else bump(rollup.overflow[which], reason);
  };
  const kept = (which: 'first' | 'all', reason: string) => cappedKey(rollup.automations[which], reason, REASONS_KEPT, OTHER_REASONS);
  name('first', kept('first', first));
  const named = new Set<string>();
  for (const reason of verdict.reasons) {
    const key = kept('all', reason);
    if (named.has(key)) continue;
    named.add(key);
    name('all', key);
  }
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTriggerRunId(value: string): value is TriggerRunId {
  return UUID.test(value);
}

/** Each run's automation (its trigger id), off its trigger run row. */
async function automationsOfRuns(runIds: readonly string[]): Promise<Map<string, string>> {
  const ids = runIds.filter(isTriggerRunId);
  if (ids.length === 0) return new Map();
  const rows = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .select(['id', 'trigger_id'])
    .where('id', 'in', ids)
    .execute();
  return new Map<string, string>(rows.map((row) => [row.id, row.trigger_id]));
}

/** This process's row for the day it is writing, and everything in it. */
let open: { id?: OpsEventId; rollup: AdmissionRollup } | undefined;

/**
 * Persists every verdict the dry runs hold into this process's row for
 * `now`'s day (a new row on a new day), and answers how many it wrote. A
 * verdict is counted on the day it is persisted, not the day it was found:
 * at most a flush interval apart. A failed write hands the verdicts back to
 * be held for the next flush.
 */
export async function flushAdmissionRollup(
  options: { now?: Date; automationsOf?: (runIds: readonly string[]) => Promise<Map<string, string>> } = {},
): Promise<number> {
  const verdicts = takeAdmissionVerdicts();
  if (verdicts.length === 0) return 0;
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  try {
    const automations = await (options.automationsOf ?? automationsOfRuns)([...new Set(verdicts.map((v) => v.runId))]);
    const current = open?.rollup.day === day ? open : { rollup: emptyRollup(day) };
    const rollup: AdmissionRollup = structuredClone(current.rollup);
    for (const verdict of verdicts) addVerdict(rollup, verdict, automations.get(verdict.runId) ?? UNKNOWN_AUTOMATION);
    if (current.id === undefined) {
      open = { id: await insertRollup(day, rollup), rollup };
    } else {
      const updated = await getQb(['ops_event'])
        .updateTable('ops_event')
        .set({ detail: rollup, updated_at: new Date() })
        .where('id', '=', current.id)
        .executeTakeFirst();
      // The row is gone (swept, or deleted by hand): the day's counts open a
      // new one rather than vanish with it.
      open = updated.numUpdatedRows > 0n ? { id: current.id, rollup } : { id: await insertRollup(day, rollup), rollup };
    }
    return verdicts.length;
  } catch (error) {
    for (const verdict of verdicts) holdAdmissionVerdict(verdict);
    throw error;
  }
}

async function insertRollup(day: string, rollup: AdmissionRollup): Promise<OpsEventId> {
  const row = await getQb(['ops_event'])
    .insertInto('ops_event')
    .values({
      type: OpsEventType.AUTOMATION,
      severity: OpsSeverity.info,
      team_id: null,
      title: `Rust admission dry run, ${day}`,
      detail: rollup,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** How often a drain pass persists the verdicts held. */
const FLUSH_EVERY_MS = 60_000;

let lastFlushAt = 0;
let flushing = false;

/** A drain pass's hook: a flush, at most once a minute and one at a time.
 *  Every automations process drains, in either drain mode, so every process
 *  that runs movements flushes what it found. */
export function flushAdmissionRollupOnPass(now: number = Date.now()): void {
  if (flushing || now - lastFlushAt < FLUSH_EVERY_MS) return;
  lastFlushAt = now;
  flushing = true;
  flushAdmissionRollup()
    .catch((error: unknown) => logger.warn('admission dry run roll-up flush failed', { error }))
    .finally(() => {
      flushing = false;
    });
}

/** Forgets this process's open row, as a fresh process starts. */
export function resetAdmissionRollupForTests(): void {
  open = undefined;
  lastFlushAt = 0;
  flushing = false;
}

// ── The report ────────────────────────────────────────────────────────────────

/** Every roll-up row persisted in the last `days` days. */
export async function readAdmissionRollups(days: number): Promise<AdmissionRollup[]> {
  const rows = await getQb(['ops_event'])
    .selectFrom('ops_event')
    .select(['detail'])
    .where('type', '=', OpsEventType.AUTOMATION)
    // In the database's clock, as the column's default stamps it: the column
    // has no zone, so a client's instant would be read in the session's.
    .where('created_at', '>=', sql<Date>`now() - make_interval(days => ${days})`)
    .where('parent_run_id', 'is', null)
    .where(sql`detail->>'kind'`, '=', ADMISSION_ROLLUP_KIND)
    .execute();
  return rows.flatMap((row) => readAdmissionRollup(row.detail) ?? []);
}

/** One reason's line in the burn-down: the runs it blocked, how many
 *  automations those were (at least: past `AUTOMATIONS_KEPT` a row counts
 *  runs, not automations — `unnamedRuns`), and the ones with the most runs. */
export interface ReasonDemand {
  reason: string;
  runs: number;
  automations: number;
  unnamedRuns: number;
  top: Array<{ automation: string; runs: number }>;
}

export interface AdmissionReport {
  days: string[];
  total: AdmissionTally;
  versions: Record<string, AdmissionTally>;
  /** Most demanded first. */
  first: ReasonDemand[];
  all: ReasonDemand[];
}

const TOP_AUTOMATIONS = 5;

/** The roll-ups summed: the burn-down in demand order. */
export function summariseAdmissionRollups(rollups: readonly AdmissionRollup[]): AdmissionReport {
  const total = emptyAdmissionTally();
  const versions: Record<string, AdmissionTally> = {};
  const byReason = { first: new Map<string, Map<string, number>>(), all: new Map<string, Map<string, number>>() };
  const unnamed = { first: new Map<string, number>(), all: new Map<string, number>() };
  for (const rollup of rollups) {
    for (const [version, tally] of Object.entries(rollup.versions)) {
      addTally(total, tally);
      addTally((versions[version] ??= emptyAdmissionTally()), tally);
    }
    for (const which of ['first', 'all'] as const) {
      for (const [reason, counts] of Object.entries(rollup.automations[which])) {
        const into = byReason[which].get(reason) ?? new Map<string, number>();
        for (const [automation, runs] of Object.entries(counts)) into.set(automation, (into.get(automation) ?? 0) + runs);
        byReason[which].set(reason, into);
      }
      for (const [reason, runs] of Object.entries(rollup.overflow[which])) {
        unnamed[which].set(reason, (unnamed[which].get(reason) ?? 0) + runs);
        if (!byReason[which].has(reason)) byReason[which].set(reason, new Map());
      }
    }
  }
  return {
    days: [...new Set(rollups.map((rollup) => rollup.day))].sort(),
    total,
    versions,
    first: demandOrder(byReason.first, unnamed.first),
    all: demandOrder(byReason.all, unnamed.all),
  };
}

function addTally(into: AdmissionTally, from: AdmissionTally): void {
  into.sampled += from.sampled;
  into.admitted += from.admitted;
  for (const which of ['first', 'all'] as const) {
    for (const [reason, runs] of Object.entries(from[which])) into[which][reason] = (into[which][reason] ?? 0) + runs;
  }
}

const byRunsThenName = <T>(runs: (item: T) => number, name: (item: T) => string) => (a: T, b: T): number =>
  runs(b) - runs(a) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);

function demandOrder(byReason: Map<string, Map<string, number>>, unnamed: Map<string, number>): ReasonDemand[] {
  return [...byReason]
    .map(([reason, counts]) => {
      const automations = [...counts].map(([automation, runs]) => ({ automation, runs }));
      automations.sort(byRunsThenName((a) => a.runs, (a) => a.automation));
      const unnamedRuns = unnamed.get(reason) ?? 0;
      return {
        reason,
        runs: automations.reduce((sum, a) => sum + a.runs, unnamedRuns),
        automations: automations.length,
        unnamedRuns,
        top: automations.slice(0, TOP_AUTOMATIONS),
      };
    })
    .sort(byRunsThenName((r) => r.runs, (r) => r.reason));
}
