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
}

export interface DrainResult {
  claimed: number;
  ran: number;
  recovered: number;
  failed: number;
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
  return { claimed: 0, ran: 0, recovered: 0, failed: 0 };
}

function addResults(a: DrainResult, b: DrainResult): DrainResult {
  return {
    claimed: a.claimed + b.claimed,
    ran: a.ran + b.ran,
    recovered: a.recovered + b.recovered,
    failed: a.failed + b.failed,
  };
}

type RowOutcome = 'ran' | 'recovered' | 'failed';

async function releaseQuietly(row: WorkRow, leaseToken: string): Promise<void> {
  try {
    await releaseWork({ id: row.id, leaseToken });
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
  now: Date;
}): Promise<RowOutcome> {
  const { row, owner, leaseMs, heartbeatMs, now } = input;
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
    await releaseQuietly(row, leaseToken);
    return 'failed';
  }

  const heartbeat = async (): Promise<void> => {
    try {
      const held = await heartbeatWork({ id: row.id, leaseToken, leaseMs });
      if (!held) logger.warn('[work] lease lost during run', { kind: row.kind, key: row.key });
    } catch (error) {
      logger.warn('[work] heartbeat failed', { kind: row.kind, key: row.key, error });
    }
  };
  const timer =
    heartbeatMs === false ? undefined : setInterval(() => void heartbeat(), heartbeatMs);

  const ctx: WorkContext = { now, owner, attempts: row.attempts, heartbeat };
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
    await releaseQuietly(row, leaseToken);
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

/** Claim due rows and run each concurrently. Never throws. */
export async function drainWork(opts: DrainOptions = {}): Promise<DrainResult> {
  const owner = opts.owner ?? DEFAULT_OWNER;
  const limit = opts.limit ?? 10;
  const leaseMs = opts.leaseMs ?? 60_000;
  const heartbeatMs = opts.heartbeatMs ?? leaseMs / 3;
  const now = opts.now?.() ?? new Date();

  let rows: WorkRow[];
  try {
    rows = await claimDueWork({ owner, limit, leaseMs, now });
  } catch (error) {
    logger.warn('[work] claim failed', { owner, error });
    return emptyResult();
  }

  const outcomes = await Promise.all(
    rows.map((row) => runRow({ row, owner, leaseMs, heartbeatMs, now })),
  );
  const result = emptyResult();
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
    if (result.claimed < limit) break;
  }
  return total;
}

export interface WorkNotifier {
  notify(): void;
}

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

/** Default: coalesces notifies within a tick and runs drainUntilIdle in-process, fire-and-forget. */
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

/** The always-on driver: calls drainUntilIdle every `everyMs` (default 1000). Returns a stop(). */
export function startDrainLoop(opts: DrainOptions & { everyMs?: number } = {}): () => void {
  const { everyMs = 1_000, ...drainOpts } = opts;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  // Chained timeouts, not setInterval: a slow pass must not overlap the next.
  const tick = async (): Promise<void> => {
    await drainUntilIdle(drainOpts);
    if (!stopped) timer = setTimeout(() => void tick(), everyMs);
  };
  timer = setTimeout(() => void tick(), everyMs);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
