// The control-tower read queries (§5.6, 3b). PURE reads over `trigger_run` (the
// live run record) and `parked_run` (the live await/timer parks) — plus the
// automation name from `automations.trigger`. The heavy `parked_run.state` blob is
// NEVER touched (observability stays cheap). The team's open questions have their
// own new-store surface (ask_records.ts); what a run is "waiting on" here is its
// live `await` parks (an ask's Response, a Slack reply, …).
//
//   • listTeamRuns   → running + parked runs for the team, with what each waits on.
//   • listParkedRuns → every parked run, with the automation name, how long it's
//     been parked, and its await parks (P22 plain-language "waiting on" list).
//
// Team-scoping happens at the tRPC view; these take a `teamId` and filter on it.

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { MovementId } from '../../generated/kysely/automations/Movement';

import { getAutomationsQb } from '../../lib/kysely';
import { enclosingJoinAddress, encodeAddress, parseAddress } from 'movement-engine/public/addresses';
import { describeRunAwaits } from '../movement_engine/await_description';
import { resolveAutomationName } from '../../lib/automation/naming';

export interface ParkedRunSummary {
  runId: string;
  /** The automation's user-facing name (`automations.trigger.name`); a sensible
   *  fallback when the trigger is gone. */
  automationName: string;
  /** The source kind the run came in on (the trigger's adapter kind). */
  source: string;
  /** When the run started — drives the "since" age in the UI. */
  startedAt: Date;
  /** How many of this run's asks are still open (waiting on a human). */
  openAskCount: number;
  /** How many distinct fan-out / parallel groups in this run still have ≥2
   *  pending siblings — "waiting on 3 of 5" lives on the ask rows; this is the
   *  run-level hint that the run fanned out. */
  pendingJoinGroups: number;
  /** What this run is waiting on, in plain language — one line per live
   *  await/timer leaf (P22). Covers the new ask store, Slack replies, and
   *  recurring `until` checks; empty when the run's only holds are legacy asks
   *  (surfaced as the ask rows) or engine holds. */
  awaiting: string[];
}

export interface TeamRunSummary {
  runId: string;
  automationName: string;
  status: 'running' | 'parked';
  startedAt: Date;
  /** Why it's waiting, when parked. 'limit' (paused at its cost limit — the
   *  operator can resume it) | 'ask' | 'timer' | null (running). */
  waitingOn: 'limit' | 'ask' | 'timer' | null;
  openAskCount: number;
  cancelRequested: boolean;
}

/** The single most user-actionable park reason for a run, from its LIVE
 *  parked leaves' `park_reason`s (runs-cancel task 6). A fan-out can carry
 *  several different reasons across its leaves at once; we surface ONE label
 *  — the thing the user should look at first: an open `ask` beats a timer
 *  (the least actionable — it resolves itself). */
const WAITING_ON_PRIORITY: readonly {
  reason: string;
  label: NonNullable<TeamRunSummary['waitingOn']>;
}[] = [
  // Paused at its cost limit: nothing moves until an operator resumes it, so
  // it outranks every wait that would resolve on its own.
  { reason: 'limit', label: 'limit' },
  // An `await` park (an ask's Response, a Slack reply) — user-facing label 'ask'.
  { reason: 'await', label: 'ask' },
  { reason: 'timer', label: 'timer' },
];

export function deriveWaitingOn(parkReasons: Iterable<string>): TeamRunSummary['waitingOn'] {
  const reasons = new Set(parkReasons);
  for (const { reason, label } of WAITING_ON_PRIORITY) {
    if (reasons.has(reason)) return label;
  }
  return null;
}

/** Every running/parked run for a team, newest first (runs-cancel task 6, the
 *  control-tower runs view). One query over `trigger_run`, one grouped query
 *  over `parked_run` (live park reasons — NEVER the `state` blob; the
 *  await-park count IS the open-ask count), one over `automations.trigger`
 *  (names). */
export async function listTeamRuns(teamId: TeamId): Promise<TeamRunSummary[]> {
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('status', 'in', ['running', 'parked'])
    .select(['id', 'trigger_id', 'status', 'started_at', 'cancel_requested_at'])
    .orderBy('started_at', 'desc')
    .limit(100)
    .execute();
  if (runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);

  const parkedLeaves = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', 'in', runIds)
    .where('status', '=', 'parked')
    .select(['run_id', 'park_reason'])
    .execute();
  const reasonsByRun = new Map<string, string[]>();
  for (const leaf of parkedLeaves) {
    const runId = leaf.run_id as unknown as string;
    const list = reasonsByRun.get(runId) ?? [];
    list.push(leaf.park_reason);
    reasonsByRun.set(runId, list);
  }

  const names = await automationNames(runs.map((r) => r.trigger_id));

  return runs.map((run) => {
    const runId = run.id as unknown as string;
    const reasons = reasonsByRun.get(runId) ?? [];
    const status = run.status as 'running' | 'parked';
    return {
      runId,
      automationName: names.get(run.trigger_id) ?? 'an automation',
      status,
      startedAt: run.started_at,
      waitingOn: status === 'parked' ? deriveWaitingOn(reasons) : null,
      // What the run is waiting on now = its `await` parks (an ask's Response,
      // a Slack reply, …) — the legacy interaction_request count is gone.
      openAskCount: reasons.filter((r) => r === 'await').length,
      cancelRequested: run.cancel_requested_at !== null && run.cancel_requested_at !== undefined,
    };
  });
}

/** Parked runs for a team, newest first. One query over `trigger_run`, one over
 *  the open requests (for the per-run counts), one over `automations.trigger` (for
 *  the names) — no `parked_run.state` blob. */
export async function listParkedRuns(teamId: TeamId): Promise<ParkedRunSummary[]> {
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('status', '=', 'parked')
    .select(['id', 'trigger_id', 'trigger_type', 'started_at'])
    .orderBy('started_at', 'desc')
    .execute();
  if (runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  // The parked leaves a run is waiting on = its live `await` parks (the ask
  // Response / Slack reply watch-points). The legacy interaction_request store
  // is gone; `parked_run` is the substrate now.
  const awaitLeaves = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', 'in', runIds)
    .where('status', '=', 'parked')
    .where('park_reason', '=', 'await')
    .select(['run_id', 'address'])
    .execute();

  const byRun = new Map<string, string[]>();
  for (const leaf of awaitLeaves) {
    const runId = leaf.run_id as unknown as string;
    const list = byRun.get(runId) ?? [];
    list.push(leaf.address);
    byRun.set(runId, list);
  }

  const names = await automationNames(runs.map((r) => r.trigger_id));

  // What each run is waiting on, in plain language (P22). Parked runs are few
  // (a control-tower surface), so a per-run read is fine here.
  const awaitingByRun = new Map<string, string[]>();
  await Promise.all(
    runIds.map(async (id) => {
      awaitingByRun.set(id as unknown as string, await describeRunAwaits(id as TriggerRunId));
    }),
  );

  return runs.map((run) => {
    const runId = run.id as unknown as string;
    const addresses = byRun.get(runId) ?? [];
    return {
      runId,
      automationName: names.get(run.trigger_id) ?? 'an automation',
      source: run.trigger_type,
      startedAt: run.started_at,
      openAskCount: addresses.length,
      pendingJoinGroups: countPendingJoinGroups(addresses),
      awaiting: awaitingByRun.get(runId) ?? [],
    };
  });
}
/** How many distinct enclosing-join groups in this run have ≥2 pending siblings. */
export function countPendingJoinGroups(addresses: string[]): number {
  const counts = new Map<string, number>();
  for (const address of addresses) {
    const join = enclosingJoinAddress(parseAddress(address));
    if (join === null) continue;
    const key = encodeAddress(join);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let groups = 0;
  for (const count of counts.values()) if (count > 1) groups += 1;
  return groups;
}
/** Map trigger id → its user-facing automation name. A movement-derived
 *  trigger's own `name` is the internal `movement/<file>/<lane>` dispatch
 *  key, so this resolves the real movement (one hop via `movement_id`)
 *  rather than handing that string to `listTeamRuns` / `listParkedRuns`. */
async function automationNames(triggerIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(triggerIds)];
  if (unique.length === 0) return new Map();
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', 'in', unique as never)
    .select(['id', 'name', 'movement_id'])
    .execute();

  const movementIds = [
    ...new Set(rows.map((r) => r.movement_id).filter((id): id is MovementId => id != null)),
  ];
  const movementNameById = movementIds.length
    ? new Map(
        (
          await getAutomationsQb(['movement'])
            .selectFrom('movement')
            .where('id', 'in', movementIds)
            .select(['id', 'name'])
            .execute()
        ).map((m) => [m.id as unknown as string, m.name]),
      )
    : new Map<string, string>();

  const out = new Map<string, string>();
  for (const r of rows) {
    out.set(
      r.id as unknown as string,
      resolveAutomationName(
        { name: r.name, movementId: r.movement_id as unknown as string | null },
        movementNameById,
      ),
    );
  }
  return out;
}
