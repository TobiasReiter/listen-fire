import { ensurePeriodicWork } from '../../services/work/store';
import { registerWorkHandler, startDrainLoop } from '../../services/work/drain';
import { WORK_KINDS } from '../../services/work/kinds';
import { registerAutomationsWork } from '../../services/work/register';
import { automationsWorkers } from '../automations';

jest.mock('../../services/work/drain', () => ({
  ...jest.requireActual('../../services/work/drain'),
  registerWorkHandler: jest.fn(),
  startDrainLoop: jest.fn(() => () => {}),
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
] as const;

const originalMode = process.env.AUTOMATIONS_DRAIN_MODE;

afterEach(() => {
  jest.clearAllMocks();
  if (originalMode === undefined) delete process.env.AUTOMATIONS_DRAIN_MODE;
  else process.env.AUTOMATIONS_DRAIN_MODE = originalMode;
});

describe('the automations registry', () => {
  it('runs one drain worker, outside any advisory lock', () => {
    expect(automationsWorkers.workers.map((each) => each.id)).toEqual(['automations.drain']);
    expect(automationsWorkers.lock).toBe(false);
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
    });
  });
});
