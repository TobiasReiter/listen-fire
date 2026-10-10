import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

const executeTakeFirst = jest.fn();
jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst }),
      }),
    }),
  }),
}));

import { makeDbCancelGate } from '../cancel_gate';

const RUN = 'run-1' as TriggerRunId;

beforeEach(() => {
  executeTakeFirst.mockReset();
  jest.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => jest.useRealTimers());

it('reports not-cancelled and caches between polls', async () => {
  executeTakeFirst.mockResolvedValue({ cancel_requested_at: null, cancel_reason: null });
  const gate = makeDbCancelGate(RUN);
  expect(await gate.cancelled()).toBe(false);
  expect(await gate.cancelled()).toBe(false); // within POLL_MS — cached
  expect(executeTakeFirst).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(3_500);
  await gate.cancelled(); // past POLL_MS — re-reads
  expect(executeTakeFirst).toHaveBeenCalledTimes(2);
});

it('latches once cancelled and exposes the reason', async () => {
  executeTakeFirst.mockResolvedValue({
    cancel_requested_at: new Date(),
    cancel_reason: 'Cancelled by Ada',
  });
  const gate = makeDbCancelGate(RUN);
  expect(await gate.cancelled()).toBe(true);
  expect(gate.reason()).toBe('Cancelled by Ada');
  jest.advanceTimersByTime(10_000);
  await gate.cancelled();
  expect(executeTakeFirst).toHaveBeenCalledTimes(1); // latched — never re-reads
});

it('fails open on a read error', async () => {
  executeTakeFirst.mockRejectedValue(new Error('db down'));
  const gate = makeDbCancelGate(RUN);
  expect(await gate.cancelled()).toBe(false);
});

// The run's final check cannot afford the debounce: a cached "no" there is not
// a few seconds' latency, it is a cancel dropped for good, because no later
// boundary will look again.
it('cancelledNow re-reads inside the debounce window', async () => {
  executeTakeFirst.mockResolvedValue({ cancel_requested_at: null, cancel_reason: null });
  const gate = makeDbCancelGate(RUN);
  expect(await gate.cancelled()).toBe(false);

  executeTakeFirst.mockResolvedValue({
    cancel_requested_at: new Date(),
    cancel_reason: 'Cancelled by Ada',
  });
  // Still within POLL_MS — the debounced reading is stale by design...
  expect(await gate.cancelled()).toBe(false);
  // ...and this one is the reason the final check uses a different door.
  expect(await gate.cancelledNow()).toBe(true);
  expect(gate.reason()).toBe('Cancelled by Ada');
});

// A cancel stamped WHILE a statement is running is the whole point of the gate:
// nothing latched it beforehand, so the check made inside that statement is the
// one that has to discover it. A gate that only replayed a cached value would
// answer "not cancelled" here for as long as the statement lasted.
it('discovers a cancel stamped after the run started', async () => {
  executeTakeFirst.mockResolvedValue({ cancel_requested_at: null, cancel_reason: null });
  const gate = makeDbCancelGate(RUN);
  expect(await gate.cancelled()).toBe(false);

  executeTakeFirst.mockResolvedValue({
    cancel_requested_at: new Date(),
    cancel_reason: 'Cancelled by Ada',
  });
  jest.advanceTimersByTime(3_500);
  expect(await gate.cancelled()).toBe(true);
  expect(gate.reason()).toBe('Cancelled by Ada');
});
