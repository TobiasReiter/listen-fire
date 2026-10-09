// Worker liveness, in one shape, for every worker of every product this
// process mounts.
//
// The signals were all already there and all differently shaped: knowledge and
// asks each published a drainer pulse on their own product route, valuations'
// reader was written and never mounted, and the six automations loops had
// nothing but the rows they claim. This aligns them — it does not add a
// subsystem. Persisted pulses stay where they are and are read through each
// unit's registry; the in-process tick comes from the loop primitive, which is
// what gives the six unpulsed workers a last-tick for the first time.
//
// Two absences are deliberately distinguishable, because reading either as
// "wedged" is how a monitoring surface teaches people to ignore it:
//   - an UNMOUNTED product contributes no rows at all (`products` says which
//     are mounted, so a missing product is a composition fact, not a fault);
//   - a MOUNTED product's worker that this process does not run reports
//     `startedHere: false` — either another instance holds the unit's lock, or
//     the worker has nothing to do here and `idleReason` says what.

import type { RegisteredWorker, WorkerRegistry } from './registry';

import { LISTEN_FIRE_VERSION } from '../constants';
import { logger } from '../services/logger';
import { workerTick } from '../lib/worker';
import { mounts, mountedProducts, type Product, type Unit } from '../products';
import { asksWorkers } from './asks';
import { automationsWorkers } from './automations';
import { coreStartup } from './core';
import { knowledgeWorkers } from './knowledge';
import { residualWorkers } from './residual';
import { valuationsWorkers } from './valuations';

// Every registry, not every registry that has workers today: core's is a
// first-boot step with no loops, and listing it is what makes "core mounted,
// no rows" a fact the surface states rather than a module somebody forgot.
const REGISTRIES: WorkerRegistry[] = [
  coreStartup,
  valuationsWorkers,
  automationsWorkers,
  knowledgeWorkers,
  asksWorkers,
  residualWorkers,
];

interface WorkerHealth {
  unit: Unit;
  worker: string;
  /** Whether this process started the loop — it holds the unit's lock. */
  startedHere: boolean;
  /** The freshest evidence the loop is turning, from either source. */
  lastTickAt: string | null;
  /** Last tick that did its work without an error, where the worker records one. */
  lastSuccessAt: string | null;
  failing: boolean;
  queue: { pending: number; oldestPendingAt: string | null; stuck: number } | null;
  idleReason: string | null;
}

interface WorkersHealth {
  /** The release this process is running — `dev` for a build from an untagged tree. */
  version: string;
  products: Product[];
  workers: WorkerHealth[];
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

async function readWorker(unit: Unit, registered: RegisteredWorker): Promise<WorkerHealth> {
  const tick = workerTick(registered.id);
  const base: WorkerHealth = {
    unit,
    worker: registered.id,
    startedHere: tick !== undefined,
    lastTickAt: tick?.lastTickAt?.toISOString() ?? null,
    lastSuccessAt: null,
    failing: tick?.failing ?? false,
    queue: null,
    idleReason: null,
  };

  if (!registered.pulse) return base;

  try {
    const pulse = await registered.pulse();
    return {
      ...base,
      lastTickAt: later(base.lastTickAt, pulse.lastBeatAt),
      lastSuccessAt: pulse.lastSuccessAt,
      failing: base.failing || pulse.failing,
      queue: pulse.queue,
      idleReason: pulse.idleReason,
    };
  } catch (err) {
    // A pulse we cannot read is a fault of its own, and reporting it as a
    // clean row would be worse than reporting it as this worker's failure.
    logger.error('[healthz] a worker pulse could not be read', {
      worker: registered.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...base, failing: true };
  }
}

/** Every worker of every mounted unit, read concurrently. */
async function readWorkersHealth(): Promise<WorkersHealth> {
  const rows = REGISTRIES.filter((registry) => mounts(registry.unit)).flatMap((registry) =>
    registry.workers.map((registered) => readWorker(registry.unit, registered)),
  );

  return {
    version: LISTEN_FIRE_VERSION,
    products: mountedProducts(),
    workers: await Promise.all(rows),
  };
}

/** The ids this process would report on — the composition, without touching the database. */
function mountedWorkerIds(): string[] {
  return REGISTRIES.filter((registry) => mounts(registry.unit)).flatMap((registry) =>
    registry.workers.map((registered) => registered.id),
  );
}

export { type WorkerHealth, type WorkersHealth, readWorkersHealth, mountedWorkerIds };
