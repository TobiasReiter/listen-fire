import { ensurePeriodicWork, removeRetiredWork } from '../../services/work/store';
import {
  HttpTickNotifier,
  NoopNotifier,
  inProcessNotifier,
  recordExternalDrainPass,
  registerWorkHandler,
  resetWorkHandlersForTests,
  setExternalDrainPassRecorder,
  setWorkNotifier,
  startDrainLoop,
} from '../../services/work/drain';
import { CORE_WORK_KINDS, claimableWorkKinds } from '../../services/work/kinds';
import { runNamedWorker, workerTick } from '../../lib/worker';
import * as products from '../../products';
import {
  TICK_KEY_VAR,
  TICK_URLS_VAR,
  assertAutomationsDrainConfigured,
  automationsWorkers,
  registerAutomationsWork,
} from '../automations';

jest.mock('../../services/work/drain', () => ({
  ...jest.requireActual('../../services/work/drain'),
  registerWorkHandler: jest.fn(),
  setWorkNotifier: jest.fn(),
  startDrainLoop: jest.fn(() => async () => {}),
}));
jest.mock('../../services/work/store', () => ({
  ...jest.requireActual('../../services/work/store'),
  ensurePeriodicWork: jest.fn(async () => {}),
  removeRetiredWork: jest.fn(async () => {}),
}));

const startLoop = jest.mocked(startDrainLoop);
const register = jest.mocked(registerWorkHandler);
const ensure = jest.mocked(ensurePeriodicWork);
const removeRetired = jest.mocked(removeRetiredWork);

const PERIODIC_KINDS = [
  'cron_reconcile',
  'poll_reconcile',
  'ask_closed_sweep',
  'timer_sweep',
  'exposed_file_sweep',
  'airtable_webhook_refresh',
  'run_orphan_sweep',
] as const;

/** The kinds the units bring: the adapter packages' (asks, Airtable), file
 *  exposure's and inbound sync's. */
const UNIT_KINDS = ['ask_closed_sweep', 'airtable_webhook_refresh', 'exposed_file_sweep', 'linked_object_refresh'];

const PASS = { claimed: 0, ran: 0, recovered: 0, failed: 0, deferred: 0, claimFailed: false };

const installNotifier = jest.mocked(setWorkNotifier);

const DRAIN_ENV_VARS = ['AUTOMATIONS_DRAIN_MODE', TICK_URLS_VAR, TICK_KEY_VAR] as const;
const originalDrainEnv = Object.fromEntries(DRAIN_ENV_VARS.map((name) => [name, process.env[name]]));

function drainEnv(env: Partial<Record<(typeof DRAIN_ENV_VARS)[number], string>>): void {
  for (const name of DRAIN_ENV_VARS) {
    const value = env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  jest.clearAllMocks();
  resetWorkHandlersForTests();
  setExternalDrainPassRecorder(undefined);
  for (const name of DRAIN_ENV_VARS) {
    const value = originalDrainEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the automations registry', () => {
  it('runs one drain worker on every instance: no unit lock, each run under its own lease', () => {
    expect(automationsWorkers.workers.map((each) => each.id)).toEqual(['automations.drain']);
    expect(automationsWorkers.lock).toBe(false);
  });

  it('hands the registry the loop stop, so shutdown can wind the drain down', () => {
    delete process.env.AUTOMATIONS_DRAIN_MODE;
    const stop = automationsWorkers.workers[0].start();
    expect(stop).toBe(startLoop.mock.results[0]?.value);
  });

  it('passes the periodic-row ensure to the loop, which retries it', () => {
    delete process.env.AUTOMATIONS_DRAIN_MODE;
    automationsWorkers.workers[0].start();
    expect(startLoop).toHaveBeenCalledWith(expect.objectContaining({ ensure: expect.any(Function) }));
  });

  it('starts the drain loop once when no drain mode is set', () => {
    delete process.env.AUTOMATIONS_DRAIN_MODE;
    automationsWorkers.workers[0].start();
    expect(startLoop).toHaveBeenCalledTimes(1);
  });

  it('starts the drain loop once in loop mode', () => {
    process.env.AUTOMATIONS_DRAIN_MODE = 'loop';
    automationsWorkers.workers[0].start();
    expect(startLoop).toHaveBeenCalledTimes(1);
  });

  it('publishes a tick through the worker helper after each drain pass', () => {
    delete process.env.AUTOMATIONS_DRAIN_MODE;
    const [drain] = automationsWorkers.workers;
    runNamedWorker(drain.id, drain.start);
    expect(workerTick(drain.id)).toEqual({ lastTickAt: null, failing: false });

    const onPass = startLoop.mock.calls[0]?.[0]?.onPass;
    if (!onPass) throw new Error('the drain loop was started without a pass hook');

    onPass({ ...PASS, claimed: 2, ran: 2 });
    expect(workerTick(drain.id)?.lastTickAt).toBeInstanceOf(Date);
    expect(workerTick(drain.id)?.failing).toBe(false);

    onPass({ ...PASS, claimed: 1, failed: 1 });
    expect(workerTick(drain.id)?.failing).toBe(true);

    onPass(PASS);
    expect(workerTick(drain.id)?.failing).toBe(false);

    onPass({ ...PASS, claimFailed: true });
    expect(workerTick(drain.id)?.failing).toBe(true);
  });

  it('in external mode, each HTTP tick publishes the same pulse a loop pass would', () => {
    process.env.AUTOMATIONS_DRAIN_MODE = 'external';
    const [drain] = automationsWorkers.workers;
    runNamedWorker(drain.id, drain.start);
    expect(workerTick(drain.id)).toEqual({ lastTickAt: null, failing: false });

    recordExternalDrainPass({ ...PASS, claimed: 1, ran: 1 });
    expect(workerTick(drain.id)?.lastTickAt).toBeInstanceOf(Date);
    expect(workerTick(drain.id)?.failing).toBe(false);

    recordExternalDrainPass({ ...PASS, claimFailed: true });
    expect(workerTick(drain.id)?.failing).toBe(true);
  });

  it('starts no loop in external mode — something outside the process ticks it', () => {
    process.env.AUTOMATIONS_DRAIN_MODE = 'external';
    automationsWorkers.workers[0].start();
    expect(startLoop).not.toHaveBeenCalled();
  });

  it('refuses a drain mode it does not know, rather than silently not draining', () => {
    process.env.AUTOMATIONS_DRAIN_MODE = 'sometimes';
    expect(() => automationsWorkers.workers[0].start()).toThrow(/AUTOMATIONS_DRAIN_MODE/);
    expect(startLoop).not.toHaveBeenCalled();
  });
});

describe('where a door\'s notify goes', () => {
  function installed() {
    expect(installNotifier).toHaveBeenCalledTimes(1);
    return installNotifier.mock.calls[0]?.[0];
  }

  it('loop mode: to this process\'s loop', () => {
    drainEnv({ AUTOMATIONS_DRAIN_MODE: 'loop' });
    automationsWorkers.workers[0].start();
    expect(installed()).toBe(inProcessNotifier);
  });

  it('external mode with tick URLs and a key: an HTTP tick to each URL', () => {
    drainEnv({
      AUTOMATIONS_DRAIN_MODE: 'external',
      [TICK_URLS_VAR]: 'http://a.test/api/v1/system/automations/drain, https://b.test/api/v1/system/automations/drain',
      [TICK_KEY_VAR]: 'lf_key',
    });
    automationsWorkers.workers[0].start();
    expect(installed()).toEqual(
      new HttpTickNotifier({
        urls: ['http://a.test/api/v1/system/automations/drain', 'https://b.test/api/v1/system/automations/drain'],
        apiKey: 'lf_key',
      }),
    );
  });

  it('external mode with neither: nowhere, leaving every pass to the schedule', () => {
    drainEnv({ AUTOMATIONS_DRAIN_MODE: 'external' });
    automationsWorkers.workers[0].start();
    expect(installed()).toBeInstanceOf(NoopNotifier);
  });

  it.each([
    ['URLs without a key', { [TICK_URLS_VAR]: 'http://a.test/drain' }],
    ['a key without URLs', { [TICK_KEY_VAR]: 'lf_key' }],
  ])('external mode with %s is refused at boot, naming both', (_label, half) => {
    drainEnv({ AUTOMATIONS_DRAIN_MODE: 'external', ...half });
    const start = () => automationsWorkers.workers[0].start();
    expect(start).toThrow(TICK_URLS_VAR);
    expect(start).toThrow(TICK_KEY_VAR);
    expect(installNotifier).not.toHaveBeenCalled();
  });

  it('refuses a tick URL that is not http(s)', () => {
    drainEnv({ AUTOMATIONS_DRAIN_MODE: 'external', [TICK_URLS_VAR]: 'drain.internal', [TICK_KEY_VAR]: 'lf_key' });
    expect(() => automationsWorkers.workers[0].start()).toThrow(/not an http\(s\) URL/);
  });
});

describe('assertAutomationsDrainConfigured (the boot-time check)', () => {
  it.each([
    ['no drain settings', {}],
    ['loop mode', { AUTOMATIONS_DRAIN_MODE: 'loop' }],
    ['external mode with neither tick setting', { AUTOMATIONS_DRAIN_MODE: 'external' }],
    [
      'external mode with both tick settings',
      { AUTOMATIONS_DRAIN_MODE: 'external', [TICK_URLS_VAR]: 'http://a.test/drain', [TICK_KEY_VAR]: 'lf_key' },
    ],
  ])('accepts %s', (_label, env) => {
    expect(() => assertAutomationsDrainConfigured(env)).not.toThrow();
  });

  it('refuses a drain mode it does not know', () => {
    expect(() => assertAutomationsDrainConfigured({ AUTOMATIONS_DRAIN_MODE: 'sometimes' })).toThrow(/AUTOMATIONS_DRAIN_MODE/);
  });

  it.each([
    ['URLs without a key', { [TICK_URLS_VAR]: 'http://a.test/drain' }],
    ['a key without URLs', { [TICK_KEY_VAR]: 'lf_key' }],
  ])('refuses %s in external mode, naming both', (_label, half) => {
    const check = () => assertAutomationsDrainConfigured({ AUTOMATIONS_DRAIN_MODE: 'external', ...half });
    expect(check).toThrow(TICK_URLS_VAR);
    expect(check).toThrow(TICK_KEY_VAR);
  });

  it('refuses tick settings when the system surface no longer takes API keys, since the notifier sends one', () => {
    const tick = { AUTOMATIONS_DRAIN_MODE: 'external', [TICK_URLS_VAR]: 'http://a.test/drain', [TICK_KEY_VAR]: 'lf_key' };
    const oidc = {
      SYSTEM_AUTH_OIDC_ISSUER: 'https://accounts.google.com',
      SYSTEM_AUTH_OIDC_AUDIENCE: 'http://a.test/drain',
      SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS: 'scheduler@example.iam.gserviceaccount.com',
    };
    expect(() => assertAutomationsDrainConfigured({ ...tick, ...oidc, SYSTEM_AUTH_MODES: 'oidc' })).toThrow(
      /SYSTEM_AUTH_MODES leaves api_key out/,
    );
    expect(() => assertAutomationsDrainConfigured({ ...tick, ...oidc, SYSTEM_AUTH_MODES: 'oidc,api_key' })).not.toThrow();
    expect(() => assertAutomationsDrainConfigured({ AUTOMATIONS_DRAIN_MODE: 'external', ...oidc, SYSTEM_AUTH_MODES: 'oidc' })).not.toThrow();
  });

  describe('over the product set', () => {
    afterEach(() => jest.restoreAllMocks());

    const half = { AUTOMATIONS_DRAIN_MODE: 'external', [TICK_URLS_VAR]: 'http://a.test/drain' };

    it('passes on a process that does not mount automations, whatever its drain settings', () => {
      const mounted = jest.spyOn(products, 'mounts').mockImplementation((unit) => unit !== 'automations');
      expect(() => assertAutomationsDrainConfigured(half)).not.toThrow();
      expect(() => assertAutomationsDrainConfigured({ AUTOMATIONS_DRAIN_MODE: 'sometimes' })).not.toThrow();
      expect(mounted).toHaveBeenCalledWith('automations', half);
    });

    it('throws on a process that mounts automations, naming both tick variables', () => {
      jest.spyOn(products, 'mounts').mockImplementation(() => true);
      const check = () => assertAutomationsDrainConfigured(half);
      expect(check).toThrow(TICK_URLS_VAR);
      expect(check).toThrow(TICK_KEY_VAR);
    });
  });

  it('installs nothing: it only checks', () => {
    assertAutomationsDrainConfigured({ AUTOMATIONS_DRAIN_MODE: 'external' });
    expect(installNotifier).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();
  });
});

describe('registerAutomationsWork', () => {
  it('registers exactly one core handler for every core kind, and every unit kind through its unit', async () => {
    await registerAutomationsWork();
    const kinds = register.mock.calls.map(([kind]) => kind);
    expect([...kinds].sort()).toEqual([...CORE_WORK_KINDS].sort());
    expect(claimableWorkKinds().sort()).toEqual([...CORE_WORK_KINDS, ...UNIT_KINDS].sort());
  });

  it('names no unit kind in the core list: each unit registers its own', async () => {
    for (const kind of UNIT_KINDS) expect(new Set<string>(CORE_WORK_KINDS).has(kind)).toBe(false);
    expect(claimableWorkKinds().sort()).toEqual([...CORE_WORK_KINDS].sort());
    await registerAutomationsWork();
    expect(claimableWorkKinds().sort()).toEqual([...CORE_WORK_KINDS, ...UNIT_KINDS].sort());
  });

  it('ensures every periodic row, the units\' included, keyed by its bare kind', async () => {
    await registerAutomationsWork();
    const ensured = ensure.mock.calls.map(([input]) => input);
    expect(ensured.map((input) => input.kind).sort()).toEqual([...PERIODIC_KINDS].sort());
    for (const input of ensured) {
      expect(input.key).toBe(input.kind);
      expect(input.intervalMs).toBeGreaterThan(0);
    }
    expect(Object.fromEntries(ensured.map((input) => [input.kind, input.intervalMs]))).toMatchObject({
      cron_reconcile: 30_000,
      poll_reconcile: 30_000,
      ask_closed_sweep: 30_000,
      timer_sweep: 30_000,
      exposed_file_sweep: 5 * 60_000,
      airtable_webhook_refresh: 60 * 60_000,
      run_orphan_sweep: 30_000,
    });
  });

  it('deletes the rows of retired kinds where the periodic rows are ensured', async () => {
    await registerAutomationsWork();
    expect(removeRetired).toHaveBeenCalledWith(['await_resume_sweep', 'ask_expiry_sweep']);
    // A retired kind is gone from the live list, not merely unscheduled.
    expect(new Set<string>(claimableWorkKinds()).has('await_resume_sweep')).toBe(false);
    expect(new Set<string>(claimableWorkKinds()).has('ask_expiry_sweep')).toBe(false);
  });
});
