// Automations' background work: everything that makes a movement run without
// a request — the clock, the pollers, the subscription upkeep, and the two
// ways a parked run wakes up — is a row in one work table, run by one drain.
//
// Rows are claimed with SKIP LOCKED leases, and a lease that lapses with a dead
// process is how its work is recovered. Every entry into a run holds that
// run's own lease (movement_engine/run_lease.ts), so two processes never step
// one run at once: the unit takes no advisory lock, and any number of
// instances may drain side by side, in either mode.

import { performance } from 'node:perf_hooks';

import type { WorkerRegistry } from './registry';

import { neverAsAny } from 'movement-engine/lib/utils/types';
import { mounts } from '../products';
import { claimLoopTick } from '../lib/worker';
import {
  HttpTickNotifier,
  NoopNotifier,
  drainPassFailing,
  inProcessNotifier,
  registerWorkKinds,
  setExternalDrainPassRecorder,
  setWorkNotifier,
  startDrainLoop,
  type DrainResult,
  type StopDrainLoop,
  type WorkNotifier,
} from '../services/work/drain';
import { MODES_VAR as SYSTEM_AUTH_MODES_VAR, systemAuthConfig } from '../services/system_auth';
import { assertEngineConfigured } from 'movement-engine/services/movement_engine/rust_engine';
import { recordRunEnginesOnRows } from '../services/movement_engine/run_engine_record';
import { registerExposedFileWork } from '../services/exposed_file/worker';
import { adapterWorkKinds } from '../services/translation_graph/adapters/packages';
import { logRefusedModuleInbounds } from '../services/translation_graph/adapters/module_inbound_audit';
import { registerLinkedObjectWork } from '../services/webhook_sync/linked_object_refresh';
import { ensureAutomationsPeriodicWork, registerCoreWork } from '../services/work/register';

type Env = Record<string, string | undefined>;

const DRAIN_MODE_VAR = 'AUTOMATIONS_DRAIN_MODE';
const TICK_URLS_VAR = 'AUTOMATIONS_TICK_URLS';
const TICK_KEY_VAR = 'AUTOMATIONS_TICK_KEY';
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

function tickUrls(env: Env): string[] {
  const urls = (env[TICK_URLS_VAR] ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');
  for (const url of urls) {
    if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
      throw new Error(`${TICK_URLS_VAR} names "${url}", which is not an http(s) URL.`);
    }
  }
  return urls;
}

/** Where a door's notify goes. In loop mode, to this process's loop. In
 *  external mode, to the drain tick endpoints when both tick settings are
 *  given, or nowhere when neither is (every pass then comes from the
 *  schedule). One without the other is refused: a key with nowhere to send it,
 *  or URLs that would answer every tick 403, is a deployment that believes its
 *  doors wake the drain when they do not. */
function workNotifierFor(mode: DrainMode, env: Env): WorkNotifier {
  switch (mode) {
    case 'loop':
      return inProcessNotifier;
    case 'external': {
      const urls = tickUrls(env);
      const apiKey = env[TICK_KEY_VAR]?.trim() ?? '';
      if (urls.length === 0 && apiKey === '') return new NoopNotifier();
      if (urls.length === 0 || apiKey === '') {
        throw new Error(
          `${TICK_URLS_VAR} and ${TICK_KEY_VAR} go together: set both for a door's notify to tick the drain, ` +
            `or neither to leave every pass to the scheduled tick.`,
        );
      }
      // The notifier authenticates with the key alone, so a deployment whose
      // system surface no longer accepts keys would have every notify refused.
      if (!systemAuthConfig(env).modes.some(({ mode }) => mode === 'api_key')) {
        throw new Error(
          `${TICK_URLS_VAR} ticks with ${TICK_KEY_VAR}, an API key, but ${SYSTEM_AUTH_MODES_VAR} leaves api_key out, ` +
            `so every notify would be refused: add api_key to it, or unset both tick settings.`,
        );
      }
      return new HttpTickNotifier({ urls, apiKey });
    }
    default:
      return neverAsAny(mode);
  }
}

/** The drain's settings, checked where the server checks its other boot-time
 *  configuration: a bad mode or half a tick pair fails the boot, rather than
 *  leaving an API that serves requests while nothing drains. Only where the
 *  unit is mounted — the same gate the drain worker has — so a process
 *  running other products is not failed by settings it never reads.
 *  `startDrain` checks again, for an entry that boots without the server. */
function assertAutomationsDrainConfigured(env: Env = process.env): void {
  if (!mounts('automations', env)) return;
  workNotifierFor(drainMode(env), env);
}

/** What one drain pass records, in either mode: the worker pulse. */
function passRecorder(): (result: DrainResult) => void {
  const recordPass = claimLoopTick();
  return (result) => {
    recordPass?.({ failing: drainPassFailing(result) });
  };
}

function startDrain(env: Env): StopDrainLoop | undefined {
  const mode = drainMode(env);
  const notifier = workNotifierFor(mode, env);
  setWorkNotifier(notifier);
  switch (mode) {
    case 'loop': {
      console.warn(`[startup] ${DRAIN_WORKER_ID}: drain mode "loop" (in-process, every ${DRAIN_EVERY_MS} ms)`);
      return startDrainLoop({
        everyMs: DRAIN_EVERY_MS,
        ensure: ensureAutomationsPeriodicWork,
        onPass: passRecorder(),
      });
    }
    case 'external':
      console.warn(
        `[startup] ${DRAIN_WORKER_ID}: drain mode "external" (no loop; each POST /api/v1/system/automations/drain is a pass; ` +
          `${notifier instanceof HttpTickNotifier ? `a door's notify ticks ${TICK_URLS_VAR}` : 'a door waits for the scheduled tick'})`,
      );
      setExternalDrainPassRecorder(passRecorder());
      return undefined;
    default:
      return neverAsAny(mode);
  }
}

/** Everything the drain runs: the core's kinds, then each unit's own — the
 *  adapter packages' (through the adapter registry), file exposure's and
 *  inbound sync's. Handlers go first, before any await, so this process's
 *  first drain pass finds them; then every periodic row is ensured. */
async function registerAutomationsWork(): Promise<void> {
  // Every entry that runs movements comes through here (the server's wire,
  // drain:once), so the engine settings are checked here for all of them.
  assertEngineConfigured();
  recordRunEnginesOnRows();
  registerCoreWork();
  registerWorkKinds(adapterWorkKinds());
  registerExposedFileWork();
  registerLinkedObjectWork();
  await ensureAutomationsPeriodicWork();
  // A report, never a reason not to start.
  logRefusedModuleInbounds().catch((error: unknown) =>
    console.warn(`[startup] could not count the webhook subscriptions signed inbound refuses: ${error instanceof Error ? error.message : String(error)}`),
  );
}

const automationsWorkers: WorkerRegistry = {
  unit: 'automations',
  workers: [{ id: DRAIN_WORKER_ID, start: () => startDrain(process.env) }],
  wire: registerAutomationsWork,
  lock: false,
};

export {
  DRAIN_MODE_VAR,
  TICK_KEY_VAR,
  TICK_URLS_VAR,
  assertAutomationsDrainConfigured,
  automationsWorkers,
  registerAutomationsWork,
};
