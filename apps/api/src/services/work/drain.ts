import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { WorkContext, WorkHandler, WorkKind, WorkRow } from './kinds';

import { logger } from '../logger';
import { claimDueWork, completeWork, heartbeatWork, releaseWork } from './store';

// One process is one owner: owner is only informational (the lease token fences),
// so a stable name makes the lease column readable across passes.
const DEFAULT_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface DrainOptions {
  owner?: string;
  limit?: number;
  leaseMs?: number;
  /** Default leaseMs / 3. `false` disables the timer (tests simulating a hung holder). */
  heartbeatMs?: number | false;
  now?: () => Date;
  /** Claim only this team's rows (a harness door draining its own delivery). */
  teamId?: string;
}

export interface DrainResult {
  claimed: number;
  ran: number;
  recovered: number;
  failed: number;
  /** The claim itself threw (the database is unreachable): nothing ran, and nothing could. */
  claimFailed: boolean;
}

const handlers = new Map<WorkKind, WorkHandler>();

/** Register the handler for a kind. Throws if the kind already has one (no silent override). */
export function registerWorkHandler(kind: WorkKind, handler: WorkHandler): void {
  if (handlers.has(kind)) throw new Error(`work kind '${kind}' already has a handler`);
  handlers.set(kind, handler);
}

/** Test-only: forget every registered handler. */
export function resetWorkHandlersForTests(): void {
  handlers.clear();
}

function emptyResult(): DrainResult {
  return { claimed: 0, ran: 0, recovered: 0, failed: 0, claimFailed: false };
}

function addResults(a: DrainResult, b: DrainResult): DrainResult {
  return {
    claimed: a.claimed + b.claimed,
    ran: a.ran + b.ran,
    recovered: a.recovered + b.recovered,
    failed: a.failed + b.failed,
    claimFailed: a.claimFailed || b.claimFailed,
  };
}

/** Whether a pass marks its worker failing. A pass never throws, so a claim
 *  that could not reach the store, or a row whose handler failed, is what
 *  "failing" means for a drain. */
export function drainPassFailing(result: DrainResult): boolean {
  return result.claimFailed || result.failed > 0;
}

type RowOutcome = 'ran' | 'recovered' | 'failed';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 300_000;

// A failing row must not retry every drain pass forever.
function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

async function releaseWithBackoff(input: {
  row: WorkRow;
  leaseToken: string;
  clock: () => Date;
}): Promise<void> {
  const { row, leaseToken, clock } = input;
  const claimedUpdatedAt = row.updatedAt;
  const dueAt = new Date(clock().getTime() + backoffMs(row.attempts));
  try {
    await releaseWork({ id: row.id, leaseToken, claimedUpdatedAt, dueAt });
  } catch (error) {
    logger.warn('[work] release failed; the lease will lapse instead', {
      kind: row.kind,
      key: row.key,
      error,
    });
  }
}

async function runRow(input: {
  row: WorkRow;
  owner: string;
  leaseMs: number;
  heartbeatMs: number | false;
  clock: () => Date;
}): Promise<RowOutcome> {
  const { row, owner, leaseMs, heartbeatMs, clock } = input;
  // Captured at claim: every later call on this row is fenced on this claim alone.
  const { leaseToken, updatedAt: claimedUpdatedAt } = row;
  if (!leaseToken) {
    logger.warn('[work] claimed row has no lease token', { kind: row.kind, key: row.key });
    return 'failed';
  }

  const handler = handlers.get(row.kind);
  if (!handler) {
    logger.warn('[work] no handler registered for kind; releasing', {
      kind: row.kind,
      key: row.key,
      attempts: row.attempts,
    });
    await releaseWithBackoff({ row, leaseToken, clock });
    return 'failed';
  }

  let leaseLost = false;
  let timer: NodeJS.Timeout | undefined;
  const heartbeat = async (): Promise<void> => {
    if (leaseLost) return;
    try {
      const held = await heartbeatWork({ id: row.id, leaseToken, leaseMs });
      if (!held) {
        // Another claim owns the row now; extending is pointless, so stop rather than warn per tick.
        leaseLost = true;
        clearInterval(timer);
        logger.warn('[work] lease lost during run', { kind: row.kind, key: row.key });
      }
    } catch (error) {
      logger.warn('[work] heartbeat failed', { kind: row.kind, key: row.key, error });
    }
  };
  if (heartbeatMs !== false) timer = setInterval(() => void heartbeat(), heartbeatMs);

  const ctx: WorkContext = { now: clock(), owner, attempts: row.attempts, heartbeat };
  const isFirstAttempt = row.attempts === 1;
  try {
    const execute = isFirstAttempt ? handler.run : handler.recover ?? handler.run;
    await execute.call(handler, row.payload, ctx);
  } catch (error) {
    // Handlers own failure recording; the drain only makes the row retry at its due_at.
    logger.warn('[work] handler threw; releasing for retry', {
      kind: row.kind,
      key: row.key,
      attempts: row.attempts,
      error,
    });
    clearInterval(timer);
    await releaseWithBackoff({ row, leaseToken, clock });
    return 'failed';
  }
  clearInterval(timer);

  try {
    await completeWork({ id: row.id, leaseToken, claimedUpdatedAt });
  } catch (error) {
    // The handler already ran; a lapsed lease will re-run it via recover.
    logger.warn('[work] complete failed after a successful run', {
      kind: row.kind,
      key: row.key,
      attempts: row.attempts,
      error,
    });
    return 'failed';
  }
  return isFirstAttempt ? 'ran' : 'recovered';
}

interface DrainSettings {
  owner: string;
  limit: number;
  leaseMs: number;
  heartbeatMs: number | false;
  clock: () => Date;
  teamId: string | undefined;
}

function drainSettings(opts: DrainOptions): DrainSettings {
  const leaseMs = opts.leaseMs ?? 60_000;
  return {
    owner: opts.owner ?? DEFAULT_OWNER,
    limit: opts.limit ?? 10,
    leaseMs,
    heartbeatMs: opts.heartbeatMs ?? leaseMs / 3,
    clock: opts.now ?? (() => new Date()),
    teamId: opts.teamId,
  };
}

/** Undefined when the claim threw: the caller reports it rather than reading it as idle. */
async function claimRows(settings: DrainSettings, limit: number): Promise<WorkRow[] | undefined> {
  const { owner, leaseMs, clock, teamId } = settings;
  try {
    return await claimDueWork({
      owner,
      limit,
      leaseMs,
      now: clock(),
      ...(teamId !== undefined ? { teamId } : {}),
    });
  } catch (error) {
    logger.warn('[work] claim failed', { owner, error });
    return undefined;
  }
}

function executeRow(row: WorkRow, settings: DrainSettings): Promise<RowOutcome> {
  const { owner, leaseMs, heartbeatMs, clock } = settings;
  return runRow({ row, owner, leaseMs, heartbeatMs, clock });
}

/** Claim due rows and run each concurrently, resolving once all of them finish. Never throws. */
export async function drainWork(opts: DrainOptions = {}): Promise<DrainResult> {
  const settings = drainSettings(opts);
  const result = emptyResult();
  const rows = await claimRows(settings, settings.limit);
  if (rows === undefined) {
    result.claimFailed = true;
    return result;
  }
  const outcomes = await Promise.all(rows.map((row) => executeRow(row, settings)));
  result.claimed = rows.length;
  for (const outcome of outcomes) result[outcome] += 1;
  return result;
}

/** Keep draining until a pass claims fewer than `limit` rows (bounded by maxPasses, default 20). */
export async function drainUntilIdle(
  opts: DrainOptions & { maxPasses?: number } = {},
): Promise<DrainResult> {
  const { maxPasses = 20, ...drainOpts } = opts;
  const limit = drainOpts.limit ?? 10;
  let total = emptyResult();
  for (let pass = 0; pass < maxPasses; pass++) {
    const result = await drainWork({ ...drainOpts, limit });
    total = addResults(total, result);
    if (result.claimFailed || result.claimed < limit) break;
  }
  return total;
}

export interface WorkNotifier {
  notify(): void;
}

// The always-on loop of this process, when one runs: a notify asks it for an
// extra pass instead of starting a second, awaiting drain beside it.
let activeLoop: { kick(): void } | undefined;

function createInProcessNotifier(): WorkNotifier {
  let scheduled = false;
  let running = false;
  // A notify during a drain may enqueue rows that pass already missed.
  let notifiedWhileRunning = false;

  const drain = async (): Promise<void> => {
    running = true;
    try {
      do {
        notifiedWhileRunning = false;
        await drainUntilIdle();
      } while (notifiedWhileRunning);
    } finally {
      running = false;
    }
  };

  return {
    notify() {
      if (activeLoop) {
        activeLoop.kick();
        return;
      }
      if (running) {
        notifiedWhileRunning = true;
        return;
      }
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (running) {
          notifiedWhileRunning = true;
          return;
        }
        void drain();
      });
    },
  };
}

/** Default: kicks this process's drain loop when one runs; otherwise coalesces
 *  notifies within a tick and runs drainUntilIdle in-process, fire-and-forget. */
export const inProcessNotifier: WorkNotifier = createInProcessNotifier();

let notifier: WorkNotifier = inProcessNotifier;

/** Injection point: external shapes set a no-op or an HTTP poke. */
export function setWorkNotifier(n: WorkNotifier): void {
  notifier = n;
}

/** What doors call after enqueue. */
export function notifyWork(): void {
  notifier.notify();
}

export interface DrainLoopOptions extends DrainOptions {
  /** Pause between passes (default 1000). */
  everyMs?: number;
  /** Each pass's claim, plus the outcomes of rows that finished since the previous pass. */
  onPass?: (result: DrainResult) => void;
  /** Run before each pass until it succeeds once — the periodic rows, which a
   *  transient failure at boot would otherwise leave missing until a restart. */
  ensure?: () => Promise<void>;
  /** How long stop() waits for running handlers (default 10 s). */
  stopGraceMs?: number;
}

/** Stops ticking, releases rows claimed but not started, and resolves once the
 *  running handlers finish or the grace elapses (their leases then lapse). */
export type StopDrainLoop = () => Promise<void>;

/**
 * The always-on driver. Rows run in a pool of at most `limit`: each pass claims
 * only the free slots and starts those rows without waiting for them, so one
 * hours-long segment holds one slot, not the whole loop.
 */
export function startDrainLoop(opts: DrainLoopOptions = {}): StopDrainLoop {
  const { everyMs = 1_000, onPass, ensure, stopGraceMs = 10_000, ...drainOpts } = opts;
  const settings = drainSettings(drainOpts);
  const inFlight = new Set<Promise<void>>();
  let settled = emptyResult();
  let ensured = ensure === undefined;
  let stopping = false;
  let stopped: Promise<void> | undefined;
  let passing: Promise<void> | undefined;
  let passAgain = false;
  // The last pass filled every free slot, so more rows may be due than it took.
  let backlog = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void runPass(), ms);
  };

  const kick = (): void => {
    if (stopping) return;
    if (passing) {
      passAgain = true;
      return;
    }
    schedule(0);
  };

  const start = (row: WorkRow): void => {
    const execution: Promise<void> = executeRow(row, settings)
      .then(
        (outcome) => {
          settled[outcome] += 1;
        },
        () => {
          settled.failed += 1;
        },
      )
      .finally(() => {
        inFlight.delete(execution);
        if (backlog) kick();
      });
    inFlight.add(execution);
  };

  const releaseUnstarted = async (rows: WorkRow[]): Promise<void> => {
    for (const row of rows) {
      if (!row.leaseToken) continue;
      try {
        await releaseWork({ id: row.id, leaseToken: row.leaseToken, claimedUpdatedAt: row.updatedAt });
      } catch (error) {
        logger.warn('[work] release at stop failed; the lease will lapse instead', {
          kind: row.kind,
          key: row.key,
          error,
        });
      }
    }
  };

  const pass = async (): Promise<void> => {
    if (!ensured && ensure) {
      try {
        await ensure();
        ensured = true;
      } catch (error) {
        logger.warn('[work] ensuring the periodic rows failed; retrying next pass', { error });
      }
    }
    const result = settled;
    settled = emptyResult();
    const room = settings.limit - inFlight.size;
    backlog = room <= 0;
    if (room > 0) {
      const rows = await claimRows(settings, room);
      if (rows === undefined) {
        result.claimFailed = true;
      } else {
        result.claimed = rows.length;
        backlog = rows.length === room;
        if (stopping) await releaseUnstarted(rows);
        else for (const row of rows) start(row);
      }
    }
    onPass?.(result);
  };

  const runPass = async (): Promise<void> => {
    timer = undefined;
    passing = pass().catch((error: unknown) => {
      logger.warn('[work] drain pass failed', { error });
    });
    await passing;
    passing = undefined;
    if (stopping) return;
    const again = passAgain;
    passAgain = false;
    schedule(again ? 0 : everyMs);
  };

  const handle = { kick };
  activeLoop = handle;
  schedule(everyMs);

  const stop = async (): Promise<void> => {
    stopping = true;
    clearTimeout(timer);
    if (activeLoop === handle) activeLoop = undefined;
    // A pass mid-claim releases what it claims instead of starting it.
    await passing;
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, stopGraceMs);
    });
    await Promise.race([Promise.allSettled([...inFlight]), grace]);
    clearTimeout(graceTimer);
    if (inFlight.size > 0) {
      logger.warn('[work] drain stopped with handlers still running; their leases will lapse', {
        running: inFlight.size,
      });
    }
  };

  return () => {
    stopped ??= stop();
    return stopped;
  };
}

// External mode's worker pulse: the drain worker claims it at boot and each
// HTTP tick feeds it, so a scheduler that stops calling shows as a stale tick.
let externalPassRecorder: ((result: DrainResult) => void) | undefined;

export function setExternalDrainPassRecorder(record: ((result: DrainResult) => void) | undefined): void {
  externalPassRecorder = record;
}

/** What the HTTP tick calls after each drain, exactly as the loop's onPass. */
export function recordExternalDrainPass(result: DrainResult): void {
  externalPassRecorder?.(result);
}
