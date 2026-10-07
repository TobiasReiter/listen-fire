// The cancel door: a cancel wakes the run parked on the ask through the local
// engine's queued wake — and only that. A cancel is not an answer, so the
// creator's settle notifier (the standalone webhook) is never told.

const cancelAskMock = jest.fn();
const enqueueAwaitWakeMock = jest.fn();
const notifyWorkMock = jest.fn();
const notifyAskSettledMock = jest.fn();

jest.mock('../store', () => ({
  ...jest.requireActual('../store'),
  cancelAsk: (...a: unknown[]) => cancelAskMock(...a),
}));
jest.mock('../../../../movement_engine/await_wake', () => ({
  enqueueAwaitWake: (...a: unknown[]) => enqueueAwaitWakeMock(...a),
}));
jest.mock('../../../../work/drain', () => ({
  notifyWork: () => notifyWorkMock(),
}));
jest.mock('../notifier', () => ({
  notifyAskSettled: (...a: unknown[]) => notifyAskSettledMock(...a),
}));

import { cancelAskAndWake } from '../answer_door';
import type { AskId } from '../../../../../generated/kysely/asks/Ask';

const ASK_ID = '00000000-0000-4000-8000-000000000001' as AskId;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('cancelAskAndWake', () => {
  it('a cancel queues one wake for the ask and kicks the drain, and tells no creator', async () => {
    cancelAskMock.mockResolvedValue({ ok: true, ask: { id: ASK_ID, teamId: 'team-1', state: 'expired' } });

    const outcome = await cancelAskAndWake({ id: ASK_ID });

    expect(outcome.ok).toBe(true);
    expect(enqueueAwaitWakeMock).toHaveBeenCalledTimes(1);
    expect(enqueueAwaitWakeMock).toHaveBeenCalledWith({ adapterType: 'ask', teamId: 'team-1', correlationKey: ASK_ID });
    expect(notifyWorkMock).toHaveBeenCalledTimes(1);
    expect(notifyAskSettledMock).not.toHaveBeenCalled();
  });

  it('a refused cancel (already settled) wakes nothing', async () => {
    cancelAskMock.mockResolvedValue({ ok: false, reason: 'settled' });

    const outcome = await cancelAskAndWake({ id: ASK_ID });

    expect(outcome).toEqual({ ok: false, reason: 'settled' });
    expect(enqueueAwaitWakeMock).not.toHaveBeenCalled();
    expect(notifyWorkMock).not.toHaveBeenCalled();
  });
});
