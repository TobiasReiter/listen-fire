// The registry's lock lifecycle: a unit's lock is held only between acquiring
// it and shutdown, and shutdown winds the unit's workers down before the lock
// frees, so no worker of the unit is still running when another process takes it.

import { acquireAdvisoryLock } from '../../lib/pg';
import { runRegistry, shutdownBackground } from '../registry';

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

    runRegistry({
      unit: 'valuations',
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
    expect(acquire).toHaveBeenCalledTimes(1);

    const shutdown = shutdownBackground();
    await settle();
    expect(order).toEqual(['stop:begin']);

    finishStop();
    await shutdown;
    expect(order).toEqual(['stop:begin', 'stop:end', 'release']);
  });

  it('a unit that takes no lock starts its workers without one', async () => {
    acquire.mockClear();
    const started = jest.fn();
    runRegistry({ unit: 'asks', workers: [{ id: 'asks.test', start: started }], lock: false });
    await settle();

    expect(acquire).not.toHaveBeenCalled();
    expect(started).toHaveBeenCalledTimes(1);
  });
});
