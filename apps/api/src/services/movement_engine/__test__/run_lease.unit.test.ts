// When a held run lease counts as lost, on the holder's own clock. The SQL is
// the integration test's; here each statement's answer is scripted, and time
// is jest's, so the renewal ticks and the deadline are exact.

const answers: Array<() => Promise<unknown>> = [];

function fakeQb(): unknown {
  return new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'executeTakeFirst') {
        return () => {
          const next = answers.shift();
          return next ? next() : Promise.resolve(undefined);
        };
      }
      if (prop === 'execute') return async () => [];
      return () => fakeQb();
    },
  });
}

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => fakeQb(),
}));
jest.mock('../../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const engineWrites = { pending: Promise.resolve() };
jest.mock('../run_engine_record', () => ({
  settleRunEngineRecord: () => engineWrites.pending,
}));

import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { takeRunLease } from '../run_lease';

const RUN = 'run-1' as TriggerRunId;
const TTL = 3_000;
const claimed = () => Promise.resolve({ id: RUN });
const renewed = () => Promise.resolve({ id: RUN });
const taken = () => Promise.resolve(undefined);

/** Let the timer's renewal promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  answers.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a held run lease', () => {
  it('stays held while each renewal lands, past what one life would allow', async () => {
    answers.push(claimed, renewed, renewed, renewed, renewed);
    const lease = await takeRunLease(RUN, { ttlMs: TTL });
    for (let tick = 0; tick < 4; tick++) {
      jest.advanceTimersByTime(TTL / 3);
      await settle();
    }
    expect(lease?.isLost()).toBe(false);
    await lease?.release();
  });

  it('is lost once a renewal finds it taken', async () => {
    answers.push(claimed, taken);
    const lease = await takeRunLease(RUN, { ttlMs: TTL });
    expect(lease?.isLost()).toBe(false);
    jest.advanceTimersByTime(TTL / 3);
    await settle();
    expect(lease?.isLost()).toBe(true);
  });

  it('is not lost to one failed renewal: the next renewal that lands keeps it', async () => {
    answers.push(claimed, () => Promise.reject(new Error('connection reset')), renewed);
    const lease = await takeRunLease(RUN, { ttlMs: TTL });
    jest.advanceTimersByTime(TTL / 3);
    await settle();
    expect(lease?.isLost()).toBe(false);
    jest.advanceTimersByTime(TTL / 3);
    await settle();
    jest.advanceTimersByTime(TTL / 2);
    expect(lease?.isLost()).toBe(false);
    await lease?.release();
  });

  it('past its deadline, a renewal tick marks it lost without touching the row', async () => {
    const failing = () => Promise.reject(new Error('connection reset'));
    const untouched = jest.fn(renewed);
    answers.push(claimed, failing, failing, failing, untouched);
    const lease = await takeRunLease(RUN, { ttlMs: TTL });
    for (let tick = 0; tick < 3; tick++) {
      jest.advanceTimersByTime(TTL / 3);
      await settle();
    }
    // Three failed renewals, the third at the deadline itself: still held.
    expect(lease?.isLost()).toBe(false);
    jest.advanceTimersByTime(TTL / 3);
    await settle();
    expect(lease?.isLost()).toBe(true);
    expect(untouched).not.toHaveBeenCalled();
    expect(answers).toHaveLength(1);
  });

  it('is lost once its last confirmed renewal is a whole life ago, though no renewal has answered', async () => {
    const hanging = () => new Promise<never>(() => {});
    answers.push(claimed, hanging, hanging, hanging, hanging);
    const lease = await takeRunLease(RUN, { ttlMs: TTL });
    jest.advanceTimersByTime(TTL - 1);
    await settle();
    expect(lease?.isLost()).toBe(false);
    jest.advanceTimersByTime(2);
    expect(lease?.isLost()).toBe(true);
  });

  it('a claim that finds the lease held answers null', async () => {
    answers.push(taken);
    expect(await takeRunLease(RUN, { ttlMs: TTL })).toBeNull();
  });

  it('releases only after the run\'s pending engine write has landed, so a queued resume reads it', async () => {
    jest.useRealTimers();
    answers.push(claimed);
    let land!: () => void;
    engineWrites.pending = new Promise<void>((resolve) => {
      land = resolve;
    });
    const lease = await takeRunLease(RUN, { ttlMs: TTL });
    let released = false;
    const releasing = lease?.release().then(() => {
      released = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(released).toBe(false);
    land();
    await releasing;
    expect(released).toBe(true);
    engineWrites.pending = Promise.resolve();
  });
});
