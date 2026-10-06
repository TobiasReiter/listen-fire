import { ensurePeriodicWork } from '../../services/work/store';
import {
  recordExternalDrainPass,
  registerWorkHandler,
  setExternalDrainPassRecorder,
  startDrainLoop,
} from '../../services/work/drain';
import { WORK_KINDS } from '../../services/work/kinds';
import { runNamedWorker, workerTick } from '../../lib/worker';
import { registerAutomationsWork } from '../../services/work/register';
import { automationsWorkers } from '../automations';

jest.mock('../../services/work/drain', () => ({
  ...jest.requireActual('../../services/work/drain'),
  registerWorkHandler: jest.fn(),
  startDrainLoop: jest.fn(() => async () => {}),
}));
jest.mock('../../services/work/store', () => ({
  ...jest.requireActual('../../services/work/store'),
  ensurePeriodicWork: jest.fn(async () => {}),
}));

const startLoop = jest.mocked(startDrainLoop);
const register = jest.mocked(registerWorkHandler);
const ensure = jest.mocked(ensurePeriodicWork);

const PERIODIC_KINDS = [
  'cron_reconcile',
  'poll_reconcile',
  'await_resume_sweep',
  'timer_sweep',
  'exposed_file_sweep',
  'airtable_webhook_refresh',
  'run_orphan_sweep',
] as const;

const PASS = { claimed: 0, ran: 0, recovered: 0, failed: 0, claimFailed: false };

const originalMode = process.env.AUTOMATIONS_DRAIN_MODE;

afterEach(() => {
  jest.clearAllMocks();
  setExternalDrainPassRecorder(undefined);
  if (originalMode === undefined) delete process.env.AUTOMATIONS_DRAIN_MODE;
  else process.env.AUTOMATIONS_DRAIN_MODE = originalMode;
});

describe('the automations registry', () => {
  it('runs one drain worker, under the unit lock until cross-process write locks land', () => {
    expect(automationsWorkers.workers.map((each) => each.id)).toEqual(['automations.drain']);
    expect(automationsWorkers.lock).toBe(true);
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

describe('registerAutomationsWork', () => {
  it('registers exactly one handler for every work kind', async () => {
    await registerAutomationsWork();
    const kinds = register.mock.calls.map(([kind]) => kind);
    expect([...kinds].sort()).toEqual([...WORK_KINDS].sort());
  });

  it('ensures every periodic row, keyed by its bare kind', async () => {
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
      await_resume_sweep: 5_000,
      timer_sweep: 30_000,
      exposed_file_sweep: 5 * 60_000,
      airtable_webhook_refresh: 60 * 60_000,
      run_orphan_sweep: 30_000,
    });
  });
});
