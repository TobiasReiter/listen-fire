// The shape a unit's worker registry has, and the one thing most of them
// share: exactly one process runs a unit's background loops.
//
// The single application-wide lock is gone (D14). It was correct while every
// worker booted from one file, but it makes a valuations-only process and an
// automations-only process exclude each other for no reason — they share a
// database and nothing else. A lock per unit keeps the guarantee that
// mattered (no worker of a unit runs twice; none of the loops claim rows with
// SKIP LOCKED, so they are not safe to double-run) and drops the one that
// never did. A unit whose work is safe to run on every instance at once may
// opt out (automations' leased drain will, once cross-process write locks land).

import { ADVISORY_LOCK_SCOPES } from '../constants';
import { acquireAdvisoryLock } from '../lib/pg';
import { runInBackground } from '../lib/utils/background';
import { runNamedWorker } from '../lib/worker';
import type { Unit } from '../products';

/**
 * One background-processing lock id per unit, inside the existing application
 * scope. Ids start at 10 so they can never be confused with the retired global
 * id (1) if an old process is still holding it mid-deploy.
 */
const BACKGROUND_LOCK_IDS = {
  core: 10,
  valuations: 11,
  automations: 12,
  knowledge: 13,
  asks: 14,
  residual: 15,
} as const satisfies Record<Unit, number>;

/**
 * How much a worker can say about itself beyond "the loop ticked". Every
 * worker that keeps a persisted pulse keeps the same one — a beat, a last
 * success, a queue behind it — so aligning them is a matter of naming, not of
 * a new subsystem. `null` where the worker has no such thing to report.
 */
interface WorkerPulse {
  /** The persisted beat, which — unlike the in-process tick — survives a
   *  restart and is readable from an instance that is not running the loop. */
  lastBeatAt: string | null;
  lastSuccessAt: string | null;
  /** Whether the last beat recorded a failure. Kept as a flag: the surface
   *  serving it is unauthenticated, and the text names customer URLs. */
  failing: boolean;
  queue: { pending: number; oldestPendingAt: string | null; stuck: number } | null;
  /** Why this worker is deliberately doing nothing — the difference between a
   *  queue that is growing because nobody configured a key and one that is
   *  growing because the loop is wedged. */
  idleReason: string | null;
}

/** Stops a worker's loop and resolves once its in-flight work has wound down. */
type WorkerStop = () => Promise<void>;

interface RegisteredWorker {
  /** `<unit>.<name>`, stable, and the ONE place this loop is named. */
  id: string;
  /** Starts the loop. May start none when this deployment has no work for it.
   *  Returns a stop when the loop must wind down before the unit's lock is released. */
  start(): WorkerStop | void;
  /** This worker's persisted pulse, where it keeps one. */
  pulse?(): Promise<WorkerPulse>;
}

interface WorkerRegistry {
  unit: Unit;
  /** Started once, in order, under the unit's lock when it takes one. Never awaited. */
  workers: RegisteredWorker[];
  /** Background wiring this unit owns that is not a loop (event sinks). */
  wire?(): void | Promise<void>;
  /** Take the unit's advisory lock before starting. Default true; false only
   *  for a unit whose workers are safe to run on every instance at once. */
  lock?: boolean;
}

// One signal handler for every unit's shutdown rather than a pair each: the
// composed deployment holds five locks, and Node warns about a leak at ten.
const shutdowns: Array<() => Promise<void>> = [];
let signalsWired = false;

function onShutdown(shutdown: () => Promise<void>) {
  shutdowns.push(shutdown);
  if (signalsWired) return;
  signalsWired = true;

  const shutdownAll = () => {
    for (const each of shutdowns) void each();
  };
  process.on('SIGINT', shutdownAll);
  process.on('SIGTERM', shutdownAll);
}

/** The unit's workers stop first, so none is still running when the lock frees. */
function shutdownUnit(input: { unit: Unit; stops: WorkerStop[]; release?: () => Promise<void> }) {
  return async () => {
    await Promise.all(
      input.stops.map((stop) =>
        stop().catch((error: unknown) => console.error(`[shutdown] ${input.unit}: a worker failed to stop`, error)),
      ),
    );
    await input.release?.();
  };
}

/**
 * Take the unit's lock (unless it opts out), then start its workers. Blocks
 * (in the background) until a previous deployment's process releases — the
 * same overlap guard the global lock gave, now scoped to the unit that needs it.
 */
function runRegistry(registry: WorkerRegistry): void {
  const { unit, workers, wire, lock = true } = registry;

  runInBackground(async () => {
    let release: (() => Promise<void>) | undefined;
    if (lock) {
      console.warn(`[startup] ${unit}: waiting for the background lock...`);

      ({ release } = await acquireAdvisoryLock(
        ADVISORY_LOCK_SCOPES.LISTEN_FIRE_API_APPLICATION,
        BACKGROUND_LOCK_IDS[unit],
      ));
    }

    const stops: WorkerStop[] = [];
    for (const registered of workers) {
      const stop = runNamedWorker(registered.id, registered.start);
      if (stop) stops.push(stop);
    }
    if (release || stops.length > 0) onShutdown(shutdownUnit({ unit, stops, ...(release ? { release } : {}) }));
    await wire?.();

    console.warn(`[startup] ${unit}: background processing started`);
  });
}

export {
  BACKGROUND_LOCK_IDS,
  type WorkerPulse,
  type RegisteredWorker,
  type WorkerStop,
  type WorkerRegistry,
  runRegistry,
};
