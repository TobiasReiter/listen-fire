// trigger_run recording — one row per trigger FIRING (one event × one trigger),
// aggregating every orchestration step. A translation is a reusable building
// block, not a thing "run" in isolation; the firing is the unit of observation.
//
// The dispatcher creates one recorder per firing, feeds each step's result into
// it as the orchestration walk produces them, and calls `finish()` once — which
// computes the aggregate status, sums diagnostics + node writes, inserts the
// row, and publishes it live for the automation page's Recent Activity.

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { EvaluationResult } from '../engine/types';
import type { MovementRunResult } from '../../movement_engine/run';
import { isWriteEffect, type MovementTraceEntry } from '../../movement_engine/expression';
import { SECOND } from '../../../constants';
import { getAutomationsQb, getQb } from '../../../lib/kysely';
import { costMicrodollarsToUsd } from '../../../lib/llm_usage';
import { mq } from '../../../lib/message_queue';
import { logger } from '../../logger';
import {
  startOpsRun,
  addOpsRunMessage,
  completeOpsRun,
  failOpsRun,
  parkOpsRun,
  unparkOpsRun,
} from '../../../lib/ops/run';
import { recordTeamMilestone } from '../../../lib/journey';
import { describeRunAwaits } from '../../movement_engine/await_description';
import { revokeRunCallbacks } from '../../movement_engine/callback_store';
import OpsEventType from '../../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../../generated/kysely/public/OpsSeverity';
import { OpsDetailLevel } from '../../../lib/ops/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerEventId } from '../../../generated/kysely/automations/TriggerEvent';
import type { TriggerEvent } from '../triggers/types';

export type TriggerRunTriggerType =
  | 'webhook'
  | 'snapshot'
  | 'mutation'
  | 'extraction'
  | 'simulation';

export interface TriggerRunFiring {
  teamId: TeamId;
  /** The real trigger (automation) id that fired. */
  triggerId: string;
  /** Human-readable name of the trigger/automation (used in ops feed titles). */
  triggerName?: string;
  triggerType: TriggerRunTriggerType;
  triggerEvent: TriggerEvent;
  dryRun?: boolean;
  /** The movement version this run pinned at start (P11) — the source a
   *  parked run resumes against. Null for non-movement firings or movements
   *  not yet versioned (pre-versioning saves). */
  movementVersionId?: string | null;
  /**
   * Adopt an EXISTING trigger_run id rather than minting a new one — the
   * resume path (async user interaction §4.7): a parked run already created
   * its `trigger_run` (the `running`→`parked` row), and resume re-opens it so
   * `finish()` upserts THAT row to its terminal status (the FKs from
   * `interaction_request`/`parked_run` stay valid). Absent ⇒ a fresh firing
   * mints a new id, as before.
   */
  existingRunId?: TriggerRunId;
  /** The stored inbound receipt this firing was dispatched from, when there
   *  was one — how a re-claimed dispatch finds the run it already started. */
  triggerEventId?: TriggerEventId;
}

type StepStatus = 'success' | 'partial' | 'failed';

interface StepRow {
  tgId: string;
  tgName: string | null;
  sourceAdapterType: string | null;
  targetAdapterType: string | null;
  status: StepStatus;
  appliedActionPlans: unknown;
  diagnostics: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
  /** 'interpreter' when the step is a movement firing (runMovement).
   *  Absent = a translation-graph step. */
  engine?: 'interpreter';
  /** Movement-engine steps: the extraction call sites the step's
   *  per-field provenance references, interned by site id
   *  (`MovementRunResult.extractionSites`). */
  extractionSites?: Record<string, unknown>;
  /**
   * A PROVISIONAL step — the trace of a firing that is still going, written so
   * a running run can be inspected. It is not a record of anything that
   * finished, so every real write drops it before appending
   * ({@link committedSteps}) and the settle replaces it with the true step.
   */
  inProgress?: true;
}

/**
 * The steps already on the row that are REAL — an in-progress placeholder is
 * this run's own live trace, and appending to it rather than over it would
 * publish the same entries twice, once provisionally and once for real.
 */
function committedSteps(value: unknown): unknown[] {
  return persistedArray(value).filter(
    (step) => !(typeof step === 'object' && step !== null && 'inProgress' in step),
  );
}

/** How often a running firing republishes its trace. Fast enough that someone
 *  watching a slow run sees it move; slow enough that a busy run writes its row
 *  a handful of times a minute, not per entry. */
const LIVE_TRACE_INTERVAL = 5 * SECOND;

/**
 * Accumulates the steps of one firing, then records a single trigger_run.
 * Construct at the top of a firing; `recordStep` / `recordStepFailure` per
 * orchestration step; `finish()` exactly once at the end (even when the walk
 * threw — partial firings still record what happened).
 */
export class TriggerRunRecorder {
  private readonly id: TriggerRunId;
  /** When this run fired. Written to the row's `started_at` on the first
   *  segment, and READ BACK from it by a resume (`adoptOpsRun`) so every
   *  segment of a parked run agrees on when the run began. */
  private startedAt = new Date();
  private readonly steps: StepRow[] = [];
  /** How many of `steps` are already on the row — the append cursor of the step
   *  channel. A park snapshot advances it so a later flush appends only what
   *  came after it, and no step's writes are counted twice. */
  private flushedSteps = 0;
  private finished = false;
  private opsRunId: string | null = null;
  /** True once a `running` row has been inserted (a parking firing creates
   *  the run row lazily at park time — §5.2). A non-parking firing never
   *  calls this, so `finish()` inserts the row once, exactly as before. */
  private started = false;
  /** The in-flight `ensureStarted` insert, memoized so CONCURRENT callers (a
   *  `parallel { ask; ask }` fires both branches at once) all AWAIT the same
   *  insert — without this, the second branch sees `started=true` and races
   *  ahead of the uncommitted row, FK-violating its `interaction_request`. */
  private startPromise?: Promise<void>;
  /** The running interpreter's trace, held by reference while it runs. */
  private liveTrace?: MovementTraceEntry[];
  private liveTraceTimer?: ReturnType<typeof setInterval>;
  /** How much of the live trace is already on the row — skips a write when the
   *  run has thought about nothing since the last tick. */
  private flushedLiveTrace = 0;
  /** What the run spent before this segment — read back off the row by
   *  `adoptOpsRun()` on a resume, zero for a fresh firing. */
  private priorSpent = 0;
  /** What the run had spent when last resumed from a limit pause — the cost
   *  cap counts from here. Read back by `adoptOpsRun()`; zero when fresh. */
  private capBaseline = 0;
  /** Whether the run is paused at a limit (`trigger_run.limit_pause`), read
   *  back by `adoptOpsRun()`: a branch woken by an ordinary event then holds
   *  the pause rather than running past it. */
  private pausedAtLimit = false;

  constructor(private readonly firing: TriggerRunFiring) {
    // Adopt the parked run's id on resume; otherwise mint a fresh one.
    this.id = firing.existingRunId ?? (randomUUID() as TriggerRunId);
    // A resumed run's row already exists (the park inserted it) — treat the
    // recorder as already started so `ensureStarted()` is a no-op and
    // `finish()` UPSERTs the existing row to its terminal status.
    if (firing.existingRunId !== undefined) this.started = true;
    // Live "a run started" edge — paired with the `finished` tick in
    // finish() so the UI can count what's running now. Best-effort;
    // dry-runs are excluded (nothing real is firing).
    if (!firing.dryRun) {
      mq.triggerRunActivity.activity
        .publish({
          teamId: firing.teamId as unknown as string,
          runId: this.id,
          triggerId: firing.triggerId,
          phase: 'started',
        })
        .catch(() => {});
    }
  }

  /** The run row's id — the FK every park row (`interaction_request`,
   *  `parked_run`) hangs off. Stable for the firing's whole life. */
  get triggerRunId(): TriggerRunId {
    return this.id;
  }

  /** The team this firing belongs to — the park sink stamps it on the rows. */
  get teamId(): TeamId {
    return this.firing.teamId;
  }

  /**
   * When this run fired — the engine's pinned clock instant, so `@current_date`
   * and `DATE.TODAY(zone)` answer the same thing in every segment of a run that
   * parked and resumed. On a resume this is the ORIGINAL firing's instant, read
   * back off the row by `adoptOpsRun()`; call that first.
   */
  get firedAt(): Date {
    return this.startedAt;
  }

  /**
   * What this run spent on priced work in its earlier segments, in
   * microdollars — the seed of the resumed segment's spend account, so the cost
   * cap holds across every park. Zero for a fresh firing. On a resume it is
   * read back off the row by `adoptOpsRun()`; call that first.
   */
  get priorSpentMicrodollars(): number {
    return this.priorSpent;
  }

  /** What the run had spent when it was last resumed from a limit pause —
   *  the point the cost cap counts from. Call `adoptOpsRun()` first. */
  get capBaselineMicrodollars(): number {
    return this.capBaseline;
  }

  /** Whether the run is paused at a limit right now. Call `adoptOpsRun()` first. */
  get limitPaused(): boolean {
    return this.pausedAtLimit;
  }

  /** The trigger that fired this run. */
  get triggerId(): string {
    return this.firing.triggerId;
  }

  /**
   * Insert the run row as `running` (idempotent — a no-op once started or
   * finished). A non-parking firing never calls this; only a firing that is
   * about to PARK does, so the run becomes observable while it waits. The row
   * is later updated to its terminal status by `finish()`, or to `parked` by
   * `markParked()`.
   */
  async ensureStarted(): Promise<void> {
    if (this.finished) return;
    // Memoize the insert so concurrent callers (parallel asks) await the SAME
    // committed row before writing their FK-bearing park rows — the second
    // branch must not see `started` flipped while the row is still uncommitted.
    this.startPromise ??= this.insertRunningRow();
    await this.startPromise;
  }

  private async insertRunningRow(): Promise<void> {
    this.started = true;
    try {
      await getAutomationsQb(['trigger_run'])
        .insertInto('trigger_run')
        .values({
          id: this.id,
          team_id: this.firing.teamId,
          trigger_id: this.firing.triggerId,
          trigger_type: this.firing.triggerType,
          status: 'running',
          record_id: this.firing.triggerEvent.recordId ?? null,
          movement_version_id: (this.firing.movementVersionId ?? null) as never,
          trigger_payload: jsonb(serializeTriggerEvent(this.firing.triggerEvent)),
          changed_fields: this.firing.triggerEvent.changedFields ?? null,
          ops_run_id: this.opsRunId,
          dry_run: this.firing.dryRun ?? false,
          started_at: this.startedAt,
          last_heartbeat_at: new Date(),
          trigger_event_id: this.firing.triggerEventId ?? null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    } catch (writeErr) {
      logger.error('[trigger_run] failed to record run start', {
        triggerId: this.firing.triggerId,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }

  /**
   * Flip a started run to `parked` — the observable "waiting on a human"
   * state (§5.3). Call after `ensureStarted()` once the park rows are
   * written. Best-effort; never breaks the firing.
   */
  async markParked(): Promise<void> {
    try {
      await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ status: 'parked' })
        .where('id', '=', this.id)
        .execute();
      // Say so in the feed as well, or an answered-in-a-week run reads as
      // working the whole time and the "running now" tile counts it.
      if (this.opsRunId) {
        // AWAITED, unlike the terminal close in `finish()`: parking is a state
        // the feed is then read in, possibly for days, so it should be true by
        // the time the park returns. Errors are still swallowed — the feed must
        // not take the firing down.
        //
        // Same plain-language "what is this waiting on" as the in-app run cards
        // (P22, chunk F) — reads the just-written park rows via the one shared
        // describer rather than inventing a second copy of the wording.
        const awaiting = await describeRunAwaits(this.id).catch(() => []);
        // A run paused at its cost limit is held by the engine, not by any
        // one wait — say that first.
        const pausedRow = await getAutomationsQb(['trigger_run'])
          .selectFrom('trigger_run')
          .select('limit_pause')
          .where('id', '=', this.id)
          .executeTakeFirst()
          .catch(() => undefined);
        const holds = [
          ...(pausedRow?.limit_pause != null ? ['paused: cost limit reached'] : []),
          ...awaiting,
        ];
        const summary =
          holds.length > 0
            ? `${this.firing.triggerName ?? 'Automation'} — ${holds.join('; ')}`
            : `${this.firing.triggerName ?? 'Automation'} — waiting for a person`;
        await parkOpsRun(this.opsRunId, { summary }).catch(() => {});
      }
    } catch (writeErr) {
      logger.error('[trigger_run] failed to mark run parked', {
        triggerId: this.firing.triggerId,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }

  /**
   * Open an ops feed run for this firing. Best-effort — a failure is silently
   * swallowed so it never breaks the pipeline. Dry-run firings emit nothing.
   */
  async startOpsRun(): Promise<void> {
    if (this.firing.dryRun) return;

    // A real firing = this team's automation ran. The dry-run guard above is
    // load-bearing: a simulated run must not activate a team.
    void recordTeamMilestone(this.firing.teamId as unknown as string, {
      milestone: 'first_run',
    }).catch(() => undefined);

    this.opsRunId = await startOpsRun({
      type: OpsEventType.AUTOMATION,
      title: `Automation ${this.firing.triggerName ?? this.firing.triggerId} received an event`,
      teamId: this.firing.teamId as unknown as string,
    }).catch(() => null);
  }

  /**
   * RE-ADOPT the ops feed run this firing already opened, on resume.
   *
   * A parked run's ops event is opened by the FIRST firing and closed by
   * `finish()` — but `finish()` is guarded on `this.opsRunId`, and a resumed
   * firing builds a fresh recorder whose `opsRunId` starts null. So the resume
   * ran, the `trigger_run` reached its terminal status, and the ops event was
   * left `running` forever: in the feed, a run the user had already answered
   * still looked like it was going. It also permanently inflated the
   * "running now" count, which counts exactly that status.
   *
   * Adopting rather than calling `startOpsRun()` is the point — a second open
   * event would close cleanly and still leave the first one stranded, and the
   * feed would show one firing twice. The id is already on the run row; the
   * resume just never read it back.
   */
  async adoptOpsRun(): Promise<void> {
    if (this.firing.dryRun) return;
    if (this.firing.existingRunId === undefined) return;
    try {
      const row = await getAutomationsQb(['trigger_run'])
        .selectFrom('trigger_run')
        .select(['ops_run_id', 'started_at', 'diagnostics', 'limit_pause', 'cost_cap_baseline_microdollars'])
        .where('id', '=', this.id)
        .executeTakeFirst();
      this.opsRunId = row?.ops_run_id ?? null;
      // The run's clock comes back with it: a resumed segment reads the instant
      // the run FIRED at, not the instant the answer arrived, so a movement that
      // asks what day it is gets one answer across the whole run.
      if (row?.started_at !== undefined) this.startedAt = new Date(row.started_at);
      // And so does its spend: the account belongs to the run, not the segment.
      this.priorSpent = runSpentMicrodollars(row?.diagnostics);
      // Usage resets when a run is resumed from a limit pause; the cap counts
      // from what it had spent then.
      this.capBaseline = Number(row?.cost_cap_baseline_microdollars ?? 0);
      this.pausedAtLimit = row?.limit_pause !== null && row?.limit_pause !== undefined;
      // The answer arrived, so it is working again rather than waiting.
      if (this.opsRunId) await unparkOpsRun(this.opsRunId).catch(() => {});
    } catch (readErr) {
      // Best-effort, like every other ops call here: a feed that can't be
      // closed must not take the resumed firing down with it.
      logger.warn('[trigger_run] failed to adopt ops run on resume', {
        runId: this.id,
        error: readErr instanceof Error ? readErr.message : String(readErr),
      });
    }
  }

  /** A step that evaluated (possibly with per-node errors). */
  recordStep(input: {
    tgId: string;
    tgName?: string | null;
    sourceAdapterType?: string | null;
    targetAdapterType?: string | null;
    result: EvaluationResult;
  }): void {
    this.steps.push({
      tgId: input.tgId,
      tgName: input.tgName ?? null,
      sourceAdapterType: input.sourceAdapterType ?? null,
      targetAdapterType: input.targetAdapterType ?? null,
      status: input.result.errors.length > 0 ? 'partial' : 'success',
      appliedActionPlans: input.result.appliedActionPlans ?? [],
      diagnostics: (input.result.diagnostics ?? {}) as unknown as Record<string, unknown>,
      errors: serializeErrors(input.result.errors ?? []),
    });
  }

  /**
   * A step that ran on the MOVEMENT ENGINE (`runMovement`) — the firing
   * record's writes are `MovementWriteRecord`s in program order, each
   * carrying its per-field provenance summaries (E4: the firing record
   * IS the write-provenance graph), with the referenced extraction
   * sites interned once on the step. Shape-compatible with
   * `appliedActionPlans` consumers (adapterType / recordType / created /
   * externalId / writtenValues), so the runs UI renders either engine's
   * step.
   */
  recordMovementStep(input: {
    movementId: string;
    movementName: string;
    sourceAdapterType?: string | null;
    result: MovementRunResult;
  }): void {
    const writes = input.result.writes;
    this.steps.push({
      tgId: `movement:${input.movementId}`,
      tgName: input.movementName,
      sourceAdapterType: input.sourceAdapterType ?? null,
      targetAdapterType: lastDistinctAdapter(
        writes.filter(isWriteEffect).map((w) => w.adapterType),
      ),
      status: 'success',
      appliedActionPlans: movementWritePlans(writes),
      diagnostics: movementStepDiagnostics(input.result),
      errors: [],
      engine: 'interpreter',
      ...(Object.keys(input.result.extractionSites).length > 0
        ? { extractionSites: input.result.extractionSites }
        : {}),
    });
    if (this.opsRunId) {
      const n = input.result.writes.filter(isWriteEffect).length;
      void addOpsRunMessage(this.opsRunId, {
        title: `${input.movementName}: ${n} record${n === 1 ? '' : 's'} written`,
        level: OpsDetailLevel.medium,
        teamId: this.firing.teamId as unknown as string,
      }).catch(() => {});
    }
  }

  /** A step whose evaluation threw (hard failure). */
  recordStepFailure(input: {
    tgId: string;
    tgName?: string | null;
    sourceAdapterType?: string | null;
    targetAdapterType?: string | null;
    message: string;
    /**
     * What a MOVEMENT run had already landed when it threw (`MovementRunFailed`
     * carries it out of the engine). Writes hit external systems inline, so the
     * records exist whether or not the run finished — recording them keeps the
     * firing record, the inspection surface and the provenance graph honest, and
     * stops a re-run colliding with its own invisible writes. The step stays
     * `failed`: this is accounting, not partial success.
     */
    partial?: MovementRunResult;
  }): void {
    const writes = input.partial?.writes ?? [];
    this.steps.push({
      tgId: input.tgId,
      tgName: input.tgName ?? null,
      sourceAdapterType: input.sourceAdapterType ?? null,
      targetAdapterType:
        input.targetAdapterType ??
        lastDistinctAdapter(writes.filter(isWriteEffect).map((w) => w.adapterType)),
      status: 'failed',
      appliedActionPlans: movementWritePlans(writes),
      diagnostics: input.partial ? movementStepDiagnostics(input.partial) : {},
      errors: [{ message: input.message }],
      ...(input.partial ? { engine: 'interpreter' as const } : {}),
      ...(input.partial && Object.keys(input.partial.extractionSites).length > 0
        ? { extractionSites: input.partial.extractionSites }
        : {}),
    });
    if (this.opsRunId) {
      void addOpsRunMessage(this.opsRunId, {
        title: input.message,
        level: OpsDetailLevel.medium,
        severity: OpsSeverity.warn,
        teamId: this.firing.teamId as unknown as string,
      }).catch(() => {});
    }
  }

  /**
   * Persist the steps recorded so far WITHOUT settling the run — the
   * append-only step channel a PARKED run needs.
   *
   * A parking firing early-returns before `finish()` (finishing would overwrite
   * the live `parked` status with a terminal one), so without this the pre-park
   * writes never reached the row at all: mid-park inspection read as "nothing
   * written", and the resuming recorder's `finish()` then REPLACED `steps` with
   * only the post-resume ones — the pre-park half was lost outright, even though
   * those records were already in the external systems.
   *
   * Touches only the accumulating columns; `finish()` stays the sole writer of
   * status / completed_at / failed_at / failure_reason.
   */
  /**
   * Publish the trace of a firing that is STILL RUNNING, so `inspectRun` on it
   * shows what it has done so far instead of an empty list.
   *
   * Until this, the trace reached the row only when the run settled or parked —
   * so the one run anybody actually needs to inspect, the slow one, was the one
   * that showed nothing. "Not doing anything" and "seven minutes into an
   * extraction" looked identical, which is how a 455-second call got read as a
   * hang.
   *
   * The entries land as a PROVISIONAL step (`inProgress`), which every real
   * write drops before appending — so the settle neither loses these entries
   * (it re-records them on the true step) nor duplicates them.
   *
   * @param trace the run's live trace array, held by reference
   */
  beginLiveTrace(trace: MovementTraceEntry[]): void {
    if (this.finished || this.liveTraceTimer) return;
    this.liveTrace = trace;
    // Polled rather than pushed: the run appends to the array from a dozen
    // places, and a fixed cadence is its own debounce — the row is written at
    // most this often however busy the run gets.
    this.liveTraceTimer = setInterval(() => {
      void this.flushLiveTrace();
    }, LIVE_TRACE_INTERVAL);
    this.liveTraceTimer.unref?.();
  }

  /** Stop publishing the live trace. Idempotent; every exit calls it. */
  endLiveTrace(): void {
    if (!this.liveTraceTimer) return;
    clearInterval(this.liveTraceTimer);
    this.liveTraceTimer = undefined;
    this.liveTrace = undefined;
  }

  private async flushLiveTrace(): Promise<void> {
    const trace = this.liveTrace;
    if (this.finished || !trace) return;
    // A run silent inside one long call is still alive; the heartbeat must not
    // depend on the trace having moved.
    if (trace.length === this.flushedLiveTrace) {
      await this.stampHeartbeat();
      return;
    }
    // Snapshot the length now: the run keeps appending while this write is in
    // flight, and the cursor must match what actually went to the row.
    const length = trace.length;
    const provisional: StepRow = {
      tgId: this.firing.triggerId,
      tgName: null,
      sourceAdapterType: null,
      targetAdapterType: null,
      status: 'success',
      appliedActionPlans: [],
      // Where `inspectRun` reads a trace from — the same shape a settled step
      // carries, so the projection needs no special case.
      diagnostics: { trace: trace.slice(0, length), inProgress: true },
      errors: [],
      engine: 'interpreter',
      inProgress: true,
    };
    try {
      await getAutomationsQb(['trigger_run'])
        .transaction()
        .execute(async (trx) => {
          const existing = await trx
            .selectFrom('trigger_run')
            .select(['steps'])
            .where('id', '=', this.id)
            .forUpdate()
            .executeTakeFirst();
          // No row yet ⇒ nothing to publish onto. Leave the cursor so the next
          // tick retries.
          if (!existing) return;
          await trx
            .updateTable('trigger_run')
            .set({
              steps: jsonb([...committedSteps(existing.steps), provisional]),
              last_heartbeat_at: new Date(),
            })
            .where('id', '=', this.id)
            .execute();
          this.flushedLiveTrace = length;
        });
    } catch (writeErr) {
      // A dropped live snapshot costs visibility for one tick, never the run.
      logger.error('[trigger_run] failed to publish the live trace', {
        runId: this.id,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }

  private async stampHeartbeat(): Promise<void> {
    try {
      await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ last_heartbeat_at: new Date() })
        .where('id', '=', this.id)
        .execute();
    } catch (writeErr) {
      logger.error('[trigger_run] failed to stamp the heartbeat', {
        runId: this.id,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }

  async snapshotSteps(): Promise<void> {
    if (this.finished) return;
    // The segment being snapshotted is over (a park, a cancel, a callback
    // body): its real step is about to land, so the provisional has nothing
    // left to say. A resume builds a new recorder and starts a new one.
    this.endLiveTrace();
    if (this.steps.length === this.flushedSteps) return;
    try {
      await this.persistSegment();
    } catch (writeErr) {
      logger.error('[trigger_run] failed to snapshot run steps', {
        triggerId: this.firing.triggerId,
        runId: this.id,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }

  /**
   * Write this segment's not-yet-flushed steps onto the run row, APPENDING to
   * whatever earlier segments left there. `terminal` present ⇒ this is the
   * settle (an upsert: a non-parking firing has no row yet); absent ⇒ a park
   * snapshot, which leaves the terminal columns alone.
   *
   * The read-modify-write runs under a `FOR UPDATE` row lock because branches of
   * a `parallel` settle CONCURRENTLY — one closes the join and finishes while
   * the others snapshot their own parks — and an unlocked merge would let the
   * later writer's stale read of `steps` swallow the earlier one's append.
   */
  private async persistSegment(terminal?: {
    status: StepStatus;
    completedAt: Date | null;
    failedAt: Date | null;
    failureReason: string | null;
  }): Promise<{ nodesWritten: number }> {
    const pending = this.steps.slice(this.flushedSteps);
    const segmentWrites = pending.reduce((sum, s) => sum + diagnosticWrites(s.diagnostics), 0);
    const segmentErrors = pending.flatMap((s) => s.errors.map((e) => ({ ...e, tgId: s.tgId })));
    let nodesWritten = segmentWrites;
    // The cursor only advances over steps that actually LANDED — a snapshot
    // with no row to land on must leave them pending for the next flush rather
    // than silently marking them written.
    let landed = true;
    await getAutomationsQb(['trigger_run'])
      .transaction()
      .execute(async (trx) => {
        const existing = await trx
          .selectFrom('trigger_run')
          .select(['steps', 'errors', 'diagnostics', 'nodes_written'])
          .where('id', '=', this.id)
          .forUpdate()
          .executeTakeFirst();
        const steps = [...committedSteps(existing?.steps), ...pending];
        const errors = [...persistedArray(existing?.errors), ...segmentErrors];
        const diagnostics = sumDiagnostics(
          persistedDiagnostics(existing?.diagnostics),
          mergeDiagnostics(pending),
        );
        nodesWritten = (existing?.nodes_written ?? 0) + segmentWrites;
        if (!terminal) {
          // No row yet ⇒ nothing to snapshot onto (a park / cancel of a live
          // firing always ran `ensureStarted()` first).
          if (!existing) {
            landed = false;
            return;
          }
          await trx
            .updateTable('trigger_run')
            .set({
              steps: jsonb(steps),
              diagnostics: jsonb(diagnostics),
              errors: jsonb(errors),
              nodes_written: nodesWritten,
            })
            .where('id', '=', this.id)
            .execute();
          return;
        }
        // Upsert on the run id: a NON-parking firing never called
        // ensureStarted(), so this is a plain insert (zero behaviour change).
        // A PARKING firing already inserted a `running` row at park time, so a
        // later resume reaching the end UPDATES it to its terminal status +
        // the accumulated step data. The conflict target is the primary key.
        await trx
          .insertInto('trigger_run')
          .values({
            id: this.id,
            team_id: this.firing.teamId,
            trigger_id: this.firing.triggerId,
            trigger_type: this.firing.triggerType,
            status: terminal.status,
            record_id: this.firing.triggerEvent.recordId ?? null,
            movement_version_id: (this.firing.movementVersionId ?? null) as never,
            trigger_payload: jsonb(serializeTriggerEvent(this.firing.triggerEvent)),
            changed_fields: this.firing.triggerEvent.changedFields ?? null,
            steps: jsonb(steps),
            diagnostics: jsonb(diagnostics),
            errors: jsonb(errors),
            nodes_written: nodesWritten,
            ops_run_id: this.opsRunId,
            dry_run: this.firing.dryRun ?? false,
            started_at: this.startedAt,
            completed_at: terminal.completedAt,
            failed_at: terminal.failedAt,
            failure_reason: terminal.failureReason,
            trigger_event_id: this.firing.triggerEventId ?? null,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              status: terminal.status,
              steps: jsonb(steps),
              diagnostics: jsonb(diagnostics),
              errors: jsonb(errors),
              nodes_written: nodesWritten,
              completed_at: terminal.completedAt,
              failed_at: terminal.failedAt,
              failure_reason: terminal.failureReason,
            }),
          )
          .execute();
      });
    if (landed) this.flushedSteps = this.steps.length;
    return { nodesWritten };
  }

  /** Insert the trigger_run row + publish it live. Idempotent (no-op if already
   *  finished). Recording failures are logged + swallowed so they never break
   *  the firing. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    // Before the settle writes, so no tick can land a provisional step after
    // the true one and leave the run looking like it is still going.
    this.endLiveTrace();

    const now = new Date();
    // The terminal status is the SETTLING SEGMENT's outcome, not the whole
    // run's accumulated step list: a resume that fails after a clean park is a
    // FAILED run, and folding the earlier park's success in would demote it to
    // `partial` and drop its failure_reason. Only the accumulating columns
    // (steps / diagnostics / errors / nodes_written) span segments.
    const status = aggregateStatus(this.steps);
    const failed = status === 'failed';
    const completedAt = failed ? null : now;
    const failedAt = failed ? now : null;
    const firstFailureMessage = this.steps.find((s) => s.status === 'failed')?.errors[0]
      ?.message;
    const failureReason = failed
      ? typeof firstFailureMessage === 'string'
        ? firstFailureMessage
        : 'Firing failed'
      : null;
    let nodesWritten = this.steps.reduce(
      (sum, s) => sum + diagnosticWrites(s.diagnostics),
      0,
    );

    try {
      // Settle the run on its id. `finish()` is the interpreter/resume terminal
      // seam (every non-parked outcome — success/partial/failed — settles here).
      // Ask records are NOT settled here: an ask is an adapter record with its
      // own lattice, and a late answer still lands as data (F7); run death only
      // drops await correlations, via `failRunAndCancelRequests` on the
      // cancel/abort terminals.
      ({ nodesWritten } = await this.persistSegment({
        status,
        completedAt,
        failedAt,
        failureReason,
      }));

      // Ruling (b), callback-primitive layer 1: a run that reaches its end with
      // un-fired callbacks REVOKES them. Callbacks are ephemeral by definition —
      // strictly things the current run can still react to; an author who wants
      // buttons to stay live keeps the run alive by awaiting `Called`, and
      // anything genuinely persistent is a standing endpoint (the webhook
      // adapter's concept), not a callback. Unlike an ask this is safe to do at
      // the terminal seam: the capability IS the run's.
      await revokeRunCallbacks(this.id).catch((revokeErr) => {
        logger.warn('[trigger_run] failed to revoke run callbacks', {
          runId: this.id,
          error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
        });
      });

      // Best-effort live signal — a publish failure must never affect the firing.
      mq.triggerRuns.recorded
        .publish({
          id: this.id,
          teamId: this.firing.teamId as unknown as string,
          triggerId: this.firing.triggerId,
          status,
          startedAt: this.startedAt.toISOString(),
          completedAt: completedAt ? completedAt.toISOString() : null,
          failedAt: failedAt ? failedAt.toISOString() : null,
          failureReason,
          nodesWritten,
          dryRun: this.firing.dryRun ?? false,
        })
        .catch((publishErr) => {
          logger.warn('[trigger_run] failed to publish run event', {
            triggerId: this.firing.triggerId,
            error: publishErr instanceof Error ? publishErr.message : String(publishErr),
          });
        });

      // The `finished` edge of the live activity signal (see constructor).
      if (!this.firing.dryRun) {
        mq.triggerRunActivity.activity
          .publish({
            teamId: this.firing.teamId as unknown as string,
            runId: this.id,
            triggerId: this.firing.triggerId,
            phase: 'finished',
          })
          .catch(() => {});
      }

    } catch (writeErr) {
      logger.error('[trigger_run] failed to record run', {
        triggerId: this.firing.triggerId,
        triggerType: this.firing.triggerType,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }

    // Close the ops feed run. Best-effort — a failure here must never
    // affect the firing outcome. Placed outside the DB-write try/catch so
    // a write error doesn't prevent the run from being closed in the feed.
    if (this.opsRunId) {
      if (failed) {
        void failOpsRun(this.opsRunId, {
          error: failureReason ?? 'Firing failed',
        }).catch(() => {});
      } else {
        void completeOpsRun(this.opsRunId, {
          summary: `${this.firing.triggerName ?? 'Automation'} — ${nodesWritten} record${nodesWritten === 1 ? '' : 's'} written`,
        }).catch(() => {});
      }
    }
  }
}

/** The last adapter a movement step wrote to (display currency, mirrors
 *  `lastTargetAdapter` over compiled steps). */
function lastDistinctAdapter(adapterTypes: string[]): string | null {
  return adapterTypes.length > 0 ? adapterTypes[adapterTypes.length - 1] : null;
}

/**
 * A movement run's writes in `appliedActionPlans` currency — the persisted
 * firing record IS the write-provenance graph (E4). Shape-compatible with the
 * TG engine's plans (adapterType / recordType / created / externalId /
 * writtenValues) so the runs UI renders either engine's step. Shared by the
 * success and failure step shapes: a run that died mid-way still landed these.
 */
function movementWritePlans(writes: MovementRunResult['writes']): unknown[] {
  return writes.map((write, index) => ({
    nodeId: write.bindingName ?? `write-${index}`,
    adapterType: write.adapterType,
    recordType: write.recordType,
    created: write.created,
    // Per-write commit truth — false when this target was rehearsed
    // (a `dry_run: true` instance, or a whole-run rehearsal). The
    // run-inspection surface reports this instead of a run-level flag.
    committed: write.committed,
    ...(write.externalId !== undefined ? { externalId: write.externalId } : {}),
    // Standalone link statements, deletes and matches keep their identity
    // on the persisted firing record: `kind` ('link' | 'unlink' | 'delete'
    // | 'match'; absent = a record write) and — for the link pair — the
    // edge itself. A match is a record FOUND, not written: readers count it
    // out through `kind`.
    ...(write.kind !== undefined ? { kind: write.kind } : {}),
    // What the record write actually did — create / update / attach (parent
    // association only) / noop (nothing sent). `created` cannot tell the last
    // three apart, and a reader needs to.
    ...(write.outcome !== undefined ? { outcome: write.outcome } : {}),
    // What the target system did about the parents — confirmed by the system,
    // not inferred from the fact that the engine sent the write.
    ...(write.association !== undefined ? { association: write.association } : {}),
    ...(write.link !== undefined ? { link: write.link } : {}),
    // A write into the run's OWN graph (a node this run built) — no system, no
    // external id. Carried so the inspection surface says so, rather than
    // showing a write that mysteriously committed nothing nowhere.
    ...(write.local !== undefined ? { local: write.local } : {}),
    // Parent → child linkage (the edge a linked/tuple write hangs off) —
    // the inspection surface's "does this record attach to anything".
    ...(write.parents !== undefined ? { parents: write.parents } : {}),
    writtenValues: write.writtenValues,
    provenance: write.provenance,
  }));
}

/** A movement step's diagnostics: the write count `finish()` sums into
 *  `nodes_written` (effects only — a record a `match` found was not
 *  written), what the run spent, plus the run's decision-point trace — what
 *  the firing decided and why ("no records written" gets an explanation in the
 *  UI). */
function movementStepDiagnostics(result: MovementRunResult): Record<string, unknown> {
  return {
    writes: result.writes.filter(isWriteEffect).length,
    // What the run spent, on its own record whether or not a cost cap is set.
    // `costUsd`, `costMicrodollars` and `costBySource` are THIS segment's and
    // add up across segments into the run row's totals; `runCostUsd` is the
    // whole run's as of this segment (a snapshot, never summed).
    ...(result.spentMicrodollars !== undefined
      ? {
          costUsd: costMicrodollarsToUsd(result.spentMicrodollars),
          costMicrodollars: result.spentMicrodollars,
          costBySource: result.spentBySource ?? {},
        }
      : {}),
    ...(result.runSpentMicrodollars !== undefined
      ? { runCostUsd: costMicrodollarsToUsd(result.runSpentMicrodollars) }
      : {}),
    ...(result.trace.length > 0 ? { trace: result.trace } : {}),
  };
}

/** What a run spent before now, off its row's summed diagnostics. A row
 *  written before `costMicrodollars` was recorded has only the dollar sum. */
/**
 * Whether a `running` run has no live segment behind it: its heartbeat (or, if
 * it never beat, its start) is older than `staleAfterMs`. A live segment beats
 * every live-trace tick, so a fresh stamp means some process still owns the run.
 */
/** A segment beats every 5s (the recorder's live-trace tick); a minute of
 *  silence is a dead process, not a slow one. */
export const ORPHAN_AFTER = 60 * SECOND;

export async function isOrphanedRunningRun(
  runId: TriggerRunId,
  opts: { now: Date; staleAfterMs: number },
): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['status', 'started_at', 'last_heartbeat_at'])
    .executeTakeFirst();
  if (row?.status !== 'running') return false;
  const lastSign = new Date(row.last_heartbeat_at ?? row.started_at);
  return lastSign.getTime() < opts.now.getTime() - opts.staleAfterMs;
}

export function runSpentMicrodollars(diagnostics: unknown): number {
  const counters = persistedDiagnostics(diagnostics);
  const exact = counters.costMicrodollars;
  if (typeof exact === 'number') return exact;
  const dollars = counters.costUsd;
  return typeof dollars === 'number' ? Math.round(dollars * 1_000_000) : 0;
}

function aggregateStatus(steps: StepRow[]): StepStatus {
  if (steps.length === 0) return 'success'; // nothing ran, nothing failed
  const failed = steps.filter((s) => s.status === 'failed').length;
  const partial = steps.filter((s) => s.status === 'partial').length;
  if (failed === steps.length) return 'failed';
  if (failed > 0 || partial > 0) return 'partial';
  return 'success';
}

function diagnosticWrites(diagnostics: Record<string, unknown>): number {
  const w = diagnostics.writes;
  return typeof w === 'number' ? w : 0;
}

/** A jsonb array column read back — empty when the row is absent or the column
 *  holds anything else. Contents stay opaque: earlier segments' steps and
 *  errors are only ever concatenated, never re-interpreted. */
function persistedArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A run's aggregate diagnostics: counters, and breakdowns of counters by key
 *  (`costBySource`). Everything else a step reports stays on the step. */
type DiagnosticCounters = Record<string, number | Record<string, number>>;

/** Keys whose value is a breakdown — counters by part, each part summed. */
const BREAKDOWN_KEYS = new Set(['costBySource']);

/** Keys a step reports as the whole RUN's figure rather than its own — summing
 *  them would count earlier segments again, so the run keeps the highest. */
const RUN_SNAPSHOT_KEYS = new Set(['runCostUsd']);

/** The counters of a diagnostics object: its numbers, and its breakdowns. */
function persistedDiagnostics(value: unknown): DiagnosticCounters {
  if (typeof value !== 'object' || value === null) return {};
  const counters: DiagnosticCounters = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number') counters[key] = entry;
    else if (BREAKDOWN_KEYS.has(key) && typeof entry === 'object' && entry !== null) {
      const breakdown: Record<string, number> = {};
      for (const [part, amount] of Object.entries(entry)) {
        if (typeof amount === 'number') breakdown[part] = amount;
      }
      counters[key] = breakdown;
    }
  }
  return counters;
}

/** Diagnostics are per-key additive (a breakdown per part), so earlier
 *  segments' counters carry forward across a park exactly as the step list
 *  does. */
function sumDiagnostics(base: DiagnosticCounters, delta: DiagnosticCounters): DiagnosticCounters {
  const merged = { ...base };
  for (const [key, value] of Object.entries(delta)) {
    const prior = merged[key];
    if (typeof value === 'number') {
      const before = typeof prior === 'number' ? prior : 0;
      merged[key] = RUN_SNAPSHOT_KEYS.has(key) ? Math.max(before, value) : before + value;
    } else {
      const breakdown = typeof prior === 'object' ? { ...prior } : {};
      for (const [part, amount] of Object.entries(value)) {
        breakdown[part] = (breakdown[part] ?? 0) + amount;
      }
      merged[key] = breakdown;
    }
  }
  return merged;
}

function mergeDiagnostics(steps: StepRow[]): DiagnosticCounters {
  return steps.reduce<DiagnosticCounters>(
    (merged, step) => sumDiagnostics(merged, persistedDiagnostics(step.diagnostics)),
    {},
  );
}

function serializeTriggerEvent(event: TriggerEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}

function serializeErrors(
  errors: EvaluationResult['errors'],
): Array<Record<string, unknown>> {
  return errors.map((e) => ({ nodeId: e.nodeId, position: e.position, message: e.message }));
}

/**
 * Wrap a JSON-safe value so it lands in a JSONB column intact (the pg driver
 * otherwise coerces a raw array to a Postgres array text repr). Explicit
 * `::jsonb` cast on the stringified value sidesteps that.
 */
function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}
