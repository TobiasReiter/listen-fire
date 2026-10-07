import type { WorkKind, WorkRow } from '../kinds';

import { logger } from '../../logger';
import {
  drainPassFailing,
  drainWork,
  notifyWork,
  registerWorkHandler,
  resetWorkHandlersForTests,
  setWorkNotifier,
  inProcessNotifier,
  startDrainLoop,
  type StopDrainLoop,
  WorkDeferred,
} from '../drain';
import { claimDueWork, completeWork, heartbeatWork, releaseWork } from '../store';

jest.mock('../store', () => ({
  claimDueWork: jest.fn(),
  completeWork: jest.fn(),
  heartbeatWork: jest.fn(),
  releaseWork: jest.fn(),
}));

jest.mock('../../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const claim = jest.mocked(claimDueWork);
const complete = jest.mocked(completeWork);
const heartbeat = jest.mocked(heartbeatWork);
const release = jest.mocked(releaseWork);

const UPDATED_AT = new Date('2001-01-01T00:00:00.000Z');

function row(input: { kind?: WorkKind; attempts?: number; key?: string } = {}): WorkRow {
  return {
    id: `id-${input.key ?? 'a'}`,
    teamId: null,
    kind: input.kind ?? 'resume_timer',
    key: input.key ?? 'a',
    payload: { runId: 'r' },
    dueAt: UPDATED_AT,
    intervalMs: null,
    attempts: input.attempts ?? 1,
    leaseOwner: 'me',
    leaseUntil: UPDATED_AT,
    leaseToken: `token-${input.key ?? 'a'}`,
    updatedAt: UPDATED_AT,
  };
}

// The in-memory queue: each claim takes everything pending.
let pending: WorkRow[] = [];

beforeEach(() => {
  resetWorkHandlersForTests();
  setWorkNotifier(inProcessNotifier);
  pending = [];
  claim.mockImplementation(async ({ limit }) => pending.splice(0, limit));
  complete.mockResolvedValue(undefined);
  release.mockResolvedValue(undefined);
  heartbeat.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('drainWork', () => {
  it('a first attempt calls run, not recover, and completes on success', async () => {
    const run = jest.fn(async () => {});
    const recover = jest.fn(async () => {});
    registerWorkHandler('resume_timer', { run, recover });
    pending = [row({ attempts: 1 })];

    const result = await drainWork({ owner: 'me' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith({
      id: 'id-a',
      leaseToken: 'token-a',
      claimedUpdatedAt: UPDATED_AT,
    });
    expect(release).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, ran: 1, recovered: 0, failed: 0, deferred: 0, claimFailed: false });
  });

  it('a second attempt calls recover when defined, else run', async () => {
    const recover = jest.fn(async () => {});
    const run = jest.fn(async () => {});
    registerWorkHandler('resume_timer', { run, recover });
    const fallback = jest.fn(async () => {});
    registerWorkHandler('fire_cron', { run: fallback });
    pending = [row({ attempts: 2, key: 'a' }), row({ attempts: 2, key: 'b', kind: 'fire_cron' })];

    const result = await drainWork({ owner: 'me' });

    expect(recover).toHaveBeenCalledWith({ runId: 'r' }, expect.objectContaining({ attempts: 2 }));
    expect(run).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ claimed: 2, ran: 0, recovered: 2, failed: 0, deferred: 0, claimFailed: false });
  });

  it('a handler that throws releases the row and the drain resolves', async () => {
    registerWorkHandler('resume_timer', {
      run: async () => {
        throw new Error('boom');
      },
    });
    pending = [row()];

    const result = await drainWork({ owner: 'me' });

    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-a', leaseToken: 'token-a' }),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: 'resume_timer', key: 'a', attempts: 1 }),
    );
    expect(result).toEqual({ claimed: 1, ran: 0, recovered: 0, failed: 1, deferred: 0, claimFailed: false });
  });

  it('a handler that defers releases the row with backoff, uncompleted, and is not a failure', async () => {
    registerWorkHandler('wake_await', {
      run: async () => {
        throw new WorkDeferred('run busy');
      },
    });
    pending = [row({ kind: 'wake_await', attempts: 2 })];
    const before = Date.now();

    const result = await drainWork({ owner: 'me' });

    expect(complete).not.toHaveBeenCalled();
    const released = release.mock.calls[0]?.[0];
    expect(released).toMatchObject({ id: 'id-a', leaseToken: 'token-a' });
    // The second attempt waits twice the base backoff.
    expect(released?.dueAt?.getTime()).toBeGreaterThanOrEqual(before + 2_000);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, ran: 0, recovered: 0, failed: 0, deferred: 1, claimFailed: false });
    expect(drainPassFailing(result)).toBe(false);
  });

  it('a known kind with no registered handler is released with a warning', async () => {
    pending = [row({ kind: 'poll_source' })];

    const result = await drainWork({ owner: 'me' });

    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-a', leaseToken: 'token-a' }),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: 'poll_source' }),
    );
    expect(result.failed).toBe(1);
  });

  it('heartbeats while a handler is pending and stops after completion', async () => {
    jest.useFakeTimers();
    const heartbeatMs = 1_000;
    registerWorkHandler('resume_timer', {
      run: () => new Promise((resolve) => setTimeout(resolve, 2 * heartbeatMs + 1)),
    });
    pending = [row()];

    const drained = drainWork({ owner: 'me', leaseMs: 3_000, heartbeatMs });
    await jest.advanceTimersByTimeAsync(2 * heartbeatMs + 1);
    await drained;

    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenCalledWith({ id: 'id-a', leaseToken: 'token-a', leaseMs: 3_000 });
    expect(complete).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10 * heartbeatMs);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it('a throwing handler releases with exponential backoff, capped at five minutes', async () => {
    const clock = new Date('2030-01-01T00:00:00.000Z');
    registerWorkHandler('resume_timer', {
      run: async () => {
        throw new Error('boom');
      },
      recover: async () => {
        throw new Error('boom');
      },
    });
    pending = [row({ attempts: 3, key: 'a' }), row({ attempts: 20, key: 'b' })];

    await drainWork({ owner: 'me', now: () => clock });

    expect(release).toHaveBeenCalledWith({
      id: 'id-a',
      leaseToken: 'token-a',
      claimedUpdatedAt: UPDATED_AT,
      dueAt: new Date(clock.getTime() + 4_000),
    });
    expect(release).toHaveBeenCalledWith({
      id: 'id-b',
      leaseToken: 'token-b',
      claimedUpdatedAt: UPDATED_AT,
      dueAt: new Date(clock.getTime() + 300_000),
    });
  });

  it('a kind with no handler is released with backoff too', async () => {
    const clock = new Date('2030-01-01T00:00:00.000Z');
    pending = [row({ kind: 'poll_source', attempts: 1 })];

    await drainWork({ owner: 'me', now: () => clock });

    expect(release).toHaveBeenCalledWith({
      id: 'id-a',
      leaseToken: 'token-a',
      claimedUpdatedAt: UPDATED_AT,
      dueAt: new Date(clock.getTime() + 1_000),
    });
  });

  it('stops heartbeating on the first heartbeat that reports the lease lost', async () => {
    jest.useFakeTimers();
    const heartbeatMs = 1_000;
    heartbeat.mockResolvedValueOnce(false);
    registerWorkHandler('resume_timer', {
      run: () => new Promise((resolve) => setTimeout(resolve, 5 * heartbeatMs + 1)),
    });
    pending = [row()];

    const drained = drainWork({ owner: 'me', leaseMs: 3_000, heartbeatMs });
    await jest.advanceTimersByTimeAsync(5 * heartbeatMs + 1);
    await drained;

    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a claim failure resolves with nothing done, and says the claim failed', async () => {
    claim.mockRejectedValueOnce(new Error('db down'));

    await expect(drainWork({ owner: 'me' })).resolves.toEqual({
      claimed: 0,
      ran: 0,
      recovered: 0,
      failed: 0,
      deferred: 0,
      claimFailed: true,
    });
  });

  it('claims only the given team when one is named', async () => {
    await drainWork({ owner: 'door', teamId: 'team-1' });

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ owner: 'door', teamId: 'team-1' }));
  });
});

describe('registerWorkHandler', () => {
  it('throws when the kind already has a handler', () => {
    registerWorkHandler('resume_timer', { run: async () => {} });

    expect(() => registerWorkHandler('resume_timer', { run: async () => {} })).toThrow(
      /resume_timer/,
    );
  });
});

describe('notifyWork', () => {
  it('drains nothing in a process with no loop running', async () => {
    notifyWork();
    notifyWork();

    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(claim).not.toHaveBeenCalled();
  });

  it('goes to the injected notifier', () => {
    const notify = jest.fn();
    setWorkNotifier({ notify });

    notifyWork();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('startDrainLoop', () => {
  let stopLoop: StopDrainLoop | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    if (stopLoop) {
      const stopped = stopLoop();
      await jest.advanceTimersByTimeAsync(10_000);
      await stopped;
      stopLoop = undefined;
    }
  });

  /** A handler whose runs finish only when the test says so, in start order. */
  function heldHandler() {
    const finishers: Array<() => void> = [];
    return {
      finishers,
      handler: { run: () => new Promise<void>((resolve) => finishers.push(resolve)) },
    };
  }

  it('a never-finishing row does not stop the next pass claiming and completing another', async () => {
    registerWorkHandler('resume_timer', { run: () => new Promise<void>(() => {}) });
    registerWorkHandler('fire_cron', { run: async () => {} });
    pending = [row({ key: 'stuck' })];
    stopLoop = startDrainLoop({ owner: 'me', everyMs: 1_000 });

    await jest.advanceTimersByTimeAsync(1_000);
    pending = [row({ key: 'next', kind: 'fire_cron' })];
    await jest.advanceTimersByTimeAsync(1_000);

    expect(claim).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-next' }));
  });

  it('never runs more than `limit` rows at once, and claims only the free slots', async () => {
    const held = heldHandler();
    registerWorkHandler('resume_timer', held.handler);
    pending = [row({ key: 'a' }), row({ key: 'b' }), row({ key: 'c' })];
    stopLoop = startDrainLoop({ owner: 'me', everyMs: 1_000, limit: 2 });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(held.finishers).toHaveLength(2);
    expect(claim).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2 }));

    // A full pool claims nothing, however many passes go by.
    await jest.advanceTimersByTimeAsync(3_000);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(held.finishers).toHaveLength(2);

    // A freed slot after a full pass is filled straight away, one row's worth.
    held.finishers[0]();
    await jest.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));
    expect(held.finishers).toHaveLength(3);
  });

  it('a notify during a pass runs one extra pass straight after it', async () => {
    let finishClaim: (rows: WorkRow[]) => void = () => {};
    claim.mockImplementationOnce(
      () =>
        new Promise<WorkRow[]>((resolve) => {
          finishClaim = resolve;
        }),
    );
    stopLoop = startDrainLoop({ owner: 'me', everyMs: 1_000 });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(1);
    notifyWork();
    notifyWork();
    notifyWork();
    finishClaim([]);
    await jest.advanceTimersByTimeAsync(0);

    expect(claim).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(999);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('a notify while the loop waits runs a pass now, not a second drain', async () => {
    stopLoop = startDrainLoop({ owner: 'me', everyMs: 1_000 });

    notifyWork();
    await jest.advanceTimersByTimeAsync(0);

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('reports the claim failure and the outcomes that settled since the last pass', async () => {
    registerWorkHandler('resume_timer', {
      run: async () => {
        throw new Error('boom');
      },
    });
    const onPass = jest.fn();
    pending = [row()];
    stopLoop = startDrainLoop({ owner: 'me', everyMs: 1_000, onPass });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(onPass).toHaveBeenLastCalledWith(expect.objectContaining({ claimed: 1, claimFailed: false }));

    claim.mockRejectedValueOnce(new Error('db down'));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(onPass).toHaveBeenLastCalledWith(expect.objectContaining({ failed: 1, claimFailed: true }));
  });

  it('retries ensuring the periodic rows each pass until it succeeds once', async () => {
    const ensure = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(undefined);
    stopLoop = startDrainLoop({ owner: 'me', everyMs: 1_000, ensure });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(ensure).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(ensure).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(5);
  });

  it('stop releases rows claimed but not started, then waits for the running ones', async () => {
    const held = heldHandler();
    registerWorkHandler('resume_timer', held.handler);
    pending = [row({ key: 'running' })];
    const stop = startDrainLoop({ owner: 'me', everyMs: 1_000 });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(held.finishers).toHaveLength(1);

    let finishClaim: (rows: WorkRow[]) => void = () => {};
    claim.mockImplementationOnce(
      () =>
        new Promise<WorkRow[]>((resolve) => {
          finishClaim = resolve;
        }),
    );
    await jest.advanceTimersByTimeAsync(1_000);

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    finishClaim([row({ key: 'late' })]);
    await jest.advanceTimersByTimeAsync(0);

    expect(release).toHaveBeenCalledWith({
      id: 'id-late',
      leaseToken: 'token-late',
      claimedUpdatedAt: UPDATED_AT,
    });
    expect(held.finishers).toHaveLength(1);
    expect(stopped).toBe(false);

    held.finishers[0]();
    await stopping;
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-running' }));

    const claims = claim.mock.calls.length;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(claims);
  });

  it('stop gives up on a handler that outlives the grace', async () => {
    registerWorkHandler('resume_timer', { run: () => new Promise<void>(() => {}) });
    pending = [row()];
    const stop = startDrainLoop({ owner: 'me', everyMs: 1_000, stopGraceMs: 10_000 });
    await jest.advanceTimersByTimeAsync(1_000);

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(stopped).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
  });
});
