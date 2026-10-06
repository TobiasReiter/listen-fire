import type { WorkKind, WorkRow } from '../kinds';

import { logger } from '../../logger';
import {
  drainWork,
  notifyWork,
  registerWorkHandler,
  resetWorkHandlersForTests,
  setWorkNotifier,
  inProcessNotifier,
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
  claim.mockImplementation(async () => pending.splice(0));
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
    expect(result).toEqual({ claimed: 1, ran: 1, recovered: 0, failed: 0 });
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
    expect(result).toEqual({ claimed: 2, ran: 0, recovered: 2, failed: 0 });
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
    expect(result).toEqual({ claimed: 1, ran: 0, recovered: 0, failed: 1 });
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
      dueAt: new Date(clock.getTime() + 4_000),
    });
    expect(release).toHaveBeenCalledWith({
      id: 'id-b',
      leaseToken: 'token-b',
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

  it('a claim failure resolves with nothing done', async () => {
    claim.mockRejectedValueOnce(new Error('db down'));

    await expect(drainWork({ owner: 'me' })).resolves.toEqual({
      claimed: 0,
      ran: 0,
      recovered: 0,
      failed: 0,
    });
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
  it('coalesces synchronous notifies into one drain', async () => {
    notifyWork();
    notifyWork();
    notifyWork();

    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('goes to the injected notifier', () => {
    const notify = jest.fn();
    setWorkNotifier({ notify });

    notifyWork();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });
});
