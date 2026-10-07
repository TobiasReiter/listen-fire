// The cancel door: a cancel wakes the run parked on the ask through the
// in-process notifier — and only where one is registered, which is what says an
// engine and its drain live in this deployment. Unregistered (asks-only), a
// cancel queues nothing and says nothing. Either way the creator's settle
// webhook is never told: a cancel is not an answer.

const cancelAskMock = jest.fn();
const enqueueAwaitWakeMock = jest.fn();
const notifyWorkMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();

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
jest.mock('../../../../logger', () => ({
  logger: {
    error: (...a: unknown[]) => loggerErrorMock(...a),
    warn: (...a: unknown[]) => loggerWarnMock(...a),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { cancelAskAndWake } from '../answer_door';
import { resetAskSettledNotifierForTests } from '../notifier';
import { notifyEngineOfSettledAsks } from '../../../../asks/in_process_notifier';
import type { AskId } from '../../../../../generated/kysely/asks/Ask';

const ASK_ID = '00000000-0000-4000-8000-000000000001' as AskId;
const CANCELLED = { ok: true, ask: { id: ASK_ID, teamId: 'team-1', state: 'expired', callbackUrl: 'https://creator.test/hook' } };

beforeEach(() => {
  jest.clearAllMocks();
  resetAskSettledNotifierForTests();
});

afterAll(() => {
  resetAskSettledNotifierForTests();
});

describe('cancelAskAndWake', () => {
  it('with the engine notifier registered, a cancel queues one wake for the ask and kicks the drain', async () => {
    notifyEngineOfSettledAsks();
    cancelAskMock.mockResolvedValue(CANCELLED);

    const outcome = await cancelAskAndWake({ id: ASK_ID });

    expect(outcome.ok).toBe(true);
    expect(enqueueAwaitWakeMock).toHaveBeenCalledTimes(1);
    expect(enqueueAwaitWakeMock).toHaveBeenCalledWith({ adapterType: 'ask', teamId: 'team-1', correlationKey: ASK_ID });
    expect(notifyWorkMock).toHaveBeenCalledTimes(1);
  });

  it('with nothing registered (asks-only), a cancel queues no wake and logs nothing', async () => {
    cancelAskMock.mockResolvedValue(CANCELLED);

    const outcome = await cancelAskAndWake({ id: ASK_ID });

    expect(outcome.ok).toBe(true);
    expect(enqueueAwaitWakeMock).not.toHaveBeenCalled();
    expect(notifyWorkMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('a refused cancel (already settled) wakes nothing', async () => {
    notifyEngineOfSettledAsks();
    cancelAskMock.mockResolvedValue({ ok: false, reason: 'settled' });

    const outcome = await cancelAskAndWake({ id: ASK_ID });

    expect(outcome).toEqual({ ok: false, reason: 'settled' });
    expect(enqueueAwaitWakeMock).not.toHaveBeenCalled();
    expect(notifyWorkMock).not.toHaveBeenCalled();
  });
});
