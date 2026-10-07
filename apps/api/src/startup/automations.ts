// Automations' background work: everything that makes a movement run without
// a request — the clock, the pollers, the subscription upkeep, and the two
// ways a parked run wakes up — is a row in one work table, run by one drain.
//
// Rows are claimed with SKIP LOCKED leases, and a lease that lapses with a dead
// process is how its work is recovered. Every entry into a run holds that
// run's own lease (movement_engine/run_lease.ts), so two processes never step
// one run at once: the unit takes no advisory lock, and any number of
// instances may drain side by side, in either mode.

import { neverAsAny } from '../lib/utils/types';
import { claimLoopTick } from '../lib/worker';
import {
  drainPassFailing,
  setExternalDrainPassRecorder,
  startDrainLoop,
  type DrainResult,
  type StopDrainLoop,
} from '../services/work/drain';
import { ensureAutomationsPeriodicWork, registerAutomationsWork } from '../services/work/register';
import type { WorkerRegistry } from './registry';

type Env = Record<string, string | undefined>;

const DRAIN_MODE_VAR = 'AUTOMATIONS_DRAIN_MODE';
const DRAIN_WORKER_ID = 'automations.drain';
const DRAIN_EVERY_MS = 1_000;

/** `loop`: this process drains on a timer. `external`: something outside the
 *  process (a scheduled HTTP tick) drives each pass. */
type DrainMode = 'loop' | 'external';

function drainMode(env: Env): DrainMode {
  const raw = env[DRAIN_MODE_VAR]?.trim();
  if (raw === undefined || raw === '' || raw === 'loop') return 'loop';
  if (raw === 'external') return 'external';
  throw new Error(`${DRAIN_MODE_VAR} must be "loop" or "external", not "${raw}".`);
}

/** The worker pulse one drain pass records, in either mode. */
function passRecorder(): ((result: DrainResult) => void) | undefined {
  const recordPass = claimLoopTick();
  if (!recordPass) return undefined;
  return (result) => recordPass({ failing: drainPassFailing(result) });
}

function startDrain(env: Env): StopDrainLoop | undefined {
  const mode = drainMode(env);
  switch (mode) {
    case 'loop': {
      console.warn(`[startup] ${DRAIN_WORKER_ID}: drain mode "loop" (in-process, every ${DRAIN_EVERY_MS} ms)`);
      const onPass = passRecorder();
      return startDrainLoop({
        everyMs: DRAIN_EVERY_MS,
        ensure: ensureAutomationsPeriodicWork,
        ...(onPass ? { onPass } : {}),
      });
    }
    case 'external':
      console.warn(
        `[startup] ${DRAIN_WORKER_ID}: drain mode "external" (no loop; each POST /api/v1/system/automations/drain is a pass)`,
      );
      setExternalDrainPassRecorder(passRecorder());
      return undefined;
    default:
      return neverAsAny(mode);
  }
}

const automationsWorkers: WorkerRegistry = {
  unit: 'automations',
  workers: [{ id: DRAIN_WORKER_ID, start: () => startDrain(process.env) }],
  wire: registerAutomationsWork,
  lock: false,
};

export { DRAIN_MODE_VAR, automationsWorkers };
