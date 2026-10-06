// Automations' background work: everything that makes a movement run without
// a request — the clock, the pollers, the subscription upkeep, and the two
// ways a parked run wakes up — is a row in one work table, run by one drain.
//
// The drain takes no advisory lock: rows are claimed with SKIP LOCKED leases,
// so every instance may drain at once, and a lease that lapses with a dead
// process is how its work is recovered (which is why no boot-time orphan sweep
// exists any more).

import { neverAsAny } from '../lib/utils/types';
import { claimLoopTick } from '../lib/worker';
import { startDrainLoop } from '../services/work/drain';
import { registerAutomationsWork } from '../services/work/register';
import type { WorkerRegistry } from './registry';

type Env = Record<string, string | undefined>;

const DRAIN_MODE_VAR = 'AUTOMATIONS_DRAIN_MODE';

/** `loop`: this process drains on a timer. `external`: something outside the
 *  process (a scheduled HTTP tick) drives each pass. */
type DrainMode = 'loop' | 'external';

function drainMode(env: Env): DrainMode {
  const raw = env[DRAIN_MODE_VAR]?.trim();
  if (raw === undefined || raw === '' || raw === 'loop') return 'loop';
  if (raw === 'external') return 'external';
  throw new Error(`${DRAIN_MODE_VAR} must be "loop" or "external", not "${raw}".`);
}

function startDrain(env: Env): void {
  const mode = drainMode(env);
  switch (mode) {
    case 'loop': {
      const recordPass = claimLoopTick();
      // A pass never throws; a row whose handler failed is what "failing" means here.
      startDrainLoop({ onPass: (result) => recordPass?.({ failing: result.failed > 0 }) });
      return;
    }
    case 'external':
      return;
    default:
      neverAsAny(mode);
  }
}

const automationsWorkers: WorkerRegistry = {
  unit: 'automations',
  workers: [{ id: 'automations.drain', start: () => startDrain(process.env) }],
  wire: registerAutomationsWork,
  lock: false,
};

export { DRAIN_MODE_VAR, automationsWorkers };
