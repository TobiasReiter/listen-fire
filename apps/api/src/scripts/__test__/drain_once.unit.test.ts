// The drain-once entry: register what the server's drain registers, drain
// until idle, and answer with an exit code — against stubbed store functions.

jest.mock('../../services', () => ({}));
jest.mock('../../prisma', () => ({ ...jest.requireActual('../../prisma'), prismaClient: { $disconnect: jest.fn() } }));
jest.mock('../../lib/kysely', () => ({
  ...jest.requireActual('../../lib/kysely'),
  globalQb: { destroy: jest.fn() },
}));
jest.mock('../../products', () => ({ ...jest.requireActual('../../products'), mounts: jest.fn(() => true) }));
jest.mock('../../services/work/store', () => ({
  ...jest.requireActual('../../services/work/store'),
  claimDueWork: jest.fn(),
  completeWork: jest.fn(async () => true),
  heartbeatWork: jest.fn(async () => true),
  releaseWork: jest.fn(),
  deferWork: jest.fn(),
  ensurePeriodicWork: jest.fn(async () => {}),
  removeRetiredWork: jest.fn(async () => {}),
}));
// File exposure's sweep reaches the database; its registration is kept, its handler stubbed.
const sweep = jest.fn(async () => {});
jest.mock('../../services/exposed_file/worker', () => ({
  registerExposedFileWork: () =>
    jest
      .requireActual('../../services/work/drain')
      .registerWorkKinds([{ kind: 'exposed_file_sweep', handler: { run: sweep }, intervalMs: 300_000 }]),
}));
jest.mock('../../services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { mounts } from '../../products';
import { claimableWorkKinds, CORE_WORK_KINDS, type WorkRow } from '../../services/work/kinds';
import { resetWorkHandlersForTests } from '../../services/work/drain';
import { claimDueWork, completeWork, ensurePeriodicWork } from '../../services/work/store';
import { drainOnceMain } from '../drain_once';

const claim = jest.mocked(claimDueWork);
const complete = jest.mocked(completeWork);
const ensure = jest.mocked(ensurePeriodicWork);
const mounted = jest.mocked(mounts);

function row(key: string): WorkRow {
  const at = new Date('2001-01-01T00:00:00.000Z');
  return {
    id: `id-${key}`,
    teamId: null,
    kind: 'exposed_file_sweep',
    key,
    payload: {},
    dueAt: at,
    intervalMs: 300_000,
    attempts: 1,
    deferrals: 0,
    leaseOwner: 'once',
    leaseUntil: at,
    leaseToken: `token-${key}`,
    updatedAt: at,
  };
}

let log: jest.SpyInstance;

beforeEach(() => {
  resetWorkHandlersForTests();
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => log.mockRestore());

describe('drainOnceMain', () => {
  it('registers every kind the server drains, ensures the periodic rows, then drains until a pass comes up short', async () => {
    // Two full passes of two, then a short one: idle.
    claim
      .mockResolvedValueOnce([row('a'), row('b')])
      .mockResolvedValueOnce([row('c'), row('d')])
      .mockResolvedValueOnce([row('e')]);

    const code = await drainOnceMain(['--limit', '2']);

    expect(code).toBe(0);
    expect(claimableWorkKinds()).toEqual(expect.arrayContaining([...CORE_WORK_KINDS, 'exposed_file_sweep', 'linked_object_refresh']));
    expect(ensure).toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(3);
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0] ?? 0);
    for (const [input] of claim.mock.calls) {
      expect(input.owner).toMatch(/^once:/);
      expect(input.limit).toBe(2);
    }
    expect(sweep).toHaveBeenCalledTimes(5);
    expect(complete).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      claimed: 5,
      ran: 5,
      recovered: 0,
      failed: 0,
      deferred: 0,
      claimFailed: false,
    });
  });

  it('exits 1 when the work table cannot be reached', async () => {
    claim.mockRejectedValueOnce(new Error('connection refused'));
    expect(await drainOnceMain([])).toBe(1);
  });

  it('refuses a process that does not mount automations, before registering or claiming anything', async () => {
    mounted.mockReturnValueOnce(false);
    await expect(drainOnceMain([])).rejects.toThrow(/LISTEN_FIRE_PRODUCTS/);
    expect(claimableWorkKinds().sort()).toEqual([...CORE_WORK_KINDS].sort());
    expect(claim).not.toHaveBeenCalled();
  });

  it('refuses a limit outside the tick endpoint\'s bounds', async () => {
    await expect(drainOnceMain(['--limit', '500'])).rejects.toThrow(/--limit/);
    expect(claim).not.toHaveBeenCalled();
  });
});
