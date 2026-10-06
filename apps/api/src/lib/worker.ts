import { SECOND } from '../constants';
import { handleError } from './errors';
import { getTimeout } from './utils/timeout';

/**
 * What a loop has told us about itself, in THIS process. `lastTickAt` is the
 * end of an iteration rather than its start, so a `fn` that never returns
 * leaves a stale tick — which is the whole point of publishing one.
 */
interface WorkerTick {
  lastTickAt: Date | null;
  /** Whether the last completed iteration threw. */
  failing: boolean;
}

const ticks = new Map<string, WorkerTick>();

/**
 * The name the next loop created in this call stack publishes under. The
 * worker registries bind it around a unit's start function (`runNamedWorker`)
 * so a worker is named in exactly one place — its registry — instead of being
 * spelled again at every `worker()` call.
 */
let claiming: { id: string; claimed: boolean } | undefined;

/**
 * Run `start` with `id` bound to the loop it creates.
 *
 * Starting NO loop is legitimate — a worker with nothing to do in this
 * deployment (asks' drainer under `local` delivery) says so by not starting,
 * and the health surface reports it as not running rather than as wedged.
 * Starting TWO under one name is a naming bug: it would publish one loop's
 * pulse as both, so it throws out of the unit's startup instead — loudly, and
 * where the fix is (the registry), rather than as a health row that lies.
 */
function runNamedWorker<T>(id: string, start: () => T): T {
  const outer = claiming;
  claiming = { id, claimed: false };
  try {
    return start();
  } finally {
    claiming = outer;
  }
}

function claimTick(): WorkerTick | undefined {
  if (!claiming) return undefined;
  if (claiming.claimed) {
    throw new Error(
      `Worker "${claiming.id}" starts more than one loop. A registered worker is one loop; ` +
        'split it into two registry entries so each publishes its own pulse.',
    );
  }
  claiming.claimed = true;
  const tick: WorkerTick = { lastTickAt: null, failing: false };
  ticks.set(claiming.id, tick);
  return tick;
}

/**
 * For a loop not built on `worker()`: claim the tick of the worker being
 * started, the same way `worker()` does, and hand back what records a pass.
 * Undefined outside `runNamedWorker`, exactly like `worker()`'s own tick.
 */
function claimLoopTick(): ((pass: { failing: boolean }) => void) | undefined {
  const tick = claimTick();
  if (!tick) return undefined;
  return ({ failing }) => {
    tick.lastTickAt = new Date();
    tick.failing = failing;
  };
}

/** This process's pulse for `id`, or undefined when it never started the loop. */
function workerTick(id: string): Readonly<WorkerTick> | undefined {
  return ticks.get(id);
}

// One shutdown flag and one handler pair for every loop in the process. A pair
// per worker put thirteen listeners on two signals, which is past Node's
// default cap of ten — the boot log carried a MaxListenersExceededWarning and
// the next worker added would have been the one nobody noticed.
let shuttingDown = false;
let signalsWired = false;

function stopWorkersOnShutdown() {
  if (signalsWired) return;
  signalsWired = true;

  const stop = () => (shuttingDown = true);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * Run a function in a loop with a fixed interval.
 *
 * @param fn - The function to run.
 * @param pollInterval - The interval in milliseconds.
 * @returns A function that skips to the next iteration.
 */
function worker(fn: () => Promise<unknown> | unknown, pollInterval: number = 30 * SECOND) {
  const timeout = getTimeout();
  const logFatal = () => console.error('Potentially Fatal Worker Error:');
  const tick = claimTick();

  stopWorkersOnShutdown();

  (async () => {
    while (!shuttingDown) {
      await Promise.all([
        (async () => {
          try {
            await fn();
            if (tick) {
              tick.lastTickAt = new Date();
              tick.failing = false;
            }
          } catch (e) {
            if (tick) {
              tick.lastTickAt = new Date();
              tick.failing = true;
            }
            logFatal();
            handleError(e);
          }
        })(),
        timeout.next(pollInterval),
      ]);
    }
  })().catch(handleError);

  return () => timeout.interrupt();
}

export { worker, runNamedWorker, claimLoopTick, workerTick, type WorkerTick };
