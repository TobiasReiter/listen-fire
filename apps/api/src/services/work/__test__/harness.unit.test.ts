// The harness sequence's drain is scoped to the delivering teams: a test
// harness door must never fire another tenant's due rows on its request.

import { drainUntilIdle } from '../drain';
import { awaitTeamWorkSettled } from '../store';
import { runHarnessDelivery } from '../harness';

jest.mock('../drain', () => ({ drainUntilIdle: jest.fn() }));
jest.mock('../store', () => ({ awaitTeamWorkSettled: jest.fn() }));
jest.mock('movement-engine/services/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const drain = jest.mocked(drainUntilIdle);
const settled = jest.mocked(awaitTeamWorkSettled);

beforeEach(() => {
  jest.clearAllMocks();
  drain.mockResolvedValue({ claimed: 0, ran: 0, recovered: 0, failed: 0, deferred: 0, claimFailed: false, stopped: 'idle' as const });
  settled.mockResolvedValue(true);
});

describe('runHarnessDelivery', () => {
  it('drains each delivering team once, and only that team, before reading the outcome', async () => {
    const order: string[] = [];
    drain.mockImplementation(async (opts) => {
      order.push(`drain:${opts?.teamId}`);
      return { claimed: 0, ran: 0, recovered: 0, failed: 0, deferred: 0, claimFailed: false, stopped: 'idle' as const };
    });

    const outcome = await runHarnessDelivery(async () => ({
      teamIds: ['team-A', 'team-B', 'team-A'],
      readOutcome: async () => {
        order.push('read');
        return 'done';
      },
    }));

    expect(outcome).toBe('done');
    expect(drain.mock.calls.map(([opts]) => opts)).toEqual([
      { owner: 'door', teamId: 'team-A' },
      { owner: 'door', teamId: 'team-B' },
    ]);
    expect(order).toEqual(['drain:team-A', 'drain:team-B', 'read']);
  });

  it('drains nothing when the delivery queued no team', async () => {
    await runHarnessDelivery(async () => ({ teamIds: [], readOutcome: async () => 'none' }));

    expect(drain).not.toHaveBeenCalled();
  });
});
