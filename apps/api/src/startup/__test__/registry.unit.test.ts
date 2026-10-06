// The registry's lock lifecycle: a unit's lock is held only between acquiring
// it and shutdown, and shutdown winds the unit's workers down before the lock
// frees, so no worker of the unit is still running when another process takes it.

import { acquireAdvisoryLock } from '../../lib/pg';
import { holdsUnitLock, runRegistry, shutdownBackground } from '../registry';

jest.mock('../../lib/pg', () => ({ acquireAdvisoryLock: jest.fn() }));

const acquire = jest.mocked(acquireAdvisoryLock);

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('runRegistry', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('holds the lock once acquired, and on shutdown stops the workers before releasing it', async () => {
    const order: string[] = [];
    let finishStop: () => void = () => {};
    acquire.mockResolvedValue({
      release: async () => {
        order.push('release');
      },
    });

    expect(holdsUnitLock('automations')).toBe(false);
    runRegistry({
      unit: 'automations',
      workers: [
        {
          id: 'automations.test',
          start: () => () =>
            new Promise<void>((resolve) => {
              order.push('stop:begin');
              finishStop = () => {
                order.push('stop:end');
                resolve();
              };
            }),
        },
      ],
    });
    await settle();
    expect(holdsUnitLock('automations')).toBe(true);

    const shutdown = shutdownBackground();
    await settle();
    expect(order).toEqual(['stop:begin']);
    expect(holdsUnitLock('automations')).toBe(true);

    finishStop();
    await shutdown;
    expect(order).toEqual(['stop:begin', 'stop:end', 'release']);
    expect(holdsUnitLock('automations')).toBe(false);
  });

  it('a unit that takes no lock never reports holding one', async () => {
    runRegistry({ unit: 'asks', workers: [], lock: false });
    await settle();

    expect(acquire).not.toHaveBeenCalled();
    expect(holdsUnitLock('asks')).toBe(false);
  });
});
