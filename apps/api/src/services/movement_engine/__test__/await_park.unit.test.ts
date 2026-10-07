// The engine's await site under protocol v2: the adapter only answers "resolved
// yet, and if not, which key wakes it?"; the engine hands the park sink that key,
// then re-checks the await's whole question itself (WHERE included) and asks
// the host's `park.wake` when it already resolved. Nothing but data crosses.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AwaitResolution } from '../../translation_graph/awaitable';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import { runFailureCause, type ParkSink } from '../run';
import { RunLeaseLost } from '../run_lease';
import type { QueuedWake } from '../host_kit';
import { makeFakeParkSink } from '../test_host';
import { logger } from '../../logger';
import { awaitingSource, makeAwaitingAdapter, runAwaiting } from './awaitable_fixture';

const TEAM_ID = '00000000-0000-0000-0000-000000000042' as TeamId;

type AwaitPark = Parameters<ParkSink['commitAwaitPark']>[0];

/** The in-memory sink, keeping each await park's full input, and the array
 *  the test host's default `park.wake` records into. */
function recording(): {
  sink: ParkSink;
  parks: AwaitPark[];
  wakes: QueuedWake[];
} {
  const parks: AwaitPark[] = [];
  const wakes: QueuedWake[] = [];
  const { sink } = makeFakeParkSink();
  return {
    sink: {
      ...sink,
      async commitAwaitPark(input) {
        parks.push(input);
      },
    },
    parks,
    wakes,
  };
}

const ANSWERED = (answer: boolean): AwaitResolution => ({
  status: 'landed',
  correlationKey: 'req-1',
  landings: [{ recordId: 'req-1', recordType: 'Check Response', fields: { Answer: answer } }],
});

describe('await park — the adapter names the key, the engine keeps the correlation', () => {
  it('pending parks under the adapter type and the key the answer named, and wakes nothing', async () => {
    const awaiting = makeAwaitingAdapter([{ status: 'pending', correlationKey: 'req-1' }]);
    const { sink, parks, wakes } = recording();

    const result = await runAwaiting({ teamId: TEAM_ID, source: awaitingSource(), adapter: awaiting.adapter, parkSink: sink, wakes });

    expect(result.parked).toBe(true);
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({ adapterType: 'ask', correlationKey: 'req-1' });
    expect(awaiting.checks).toBe(2);
    expect(wakes).toEqual([]);
  });

  it('a landing that arrived after the first check is woken by the engine itself', async () => {
    const awaiting = makeAwaitingAdapter([{ status: 'pending', correlationKey: 'req-1' }, ANSWERED(true)]);
    const { sink, wakes } = recording();

    const result = await runAwaiting({ teamId: TEAM_ID, source: awaitingSource(), adapter: awaiting.adapter, parkSink: sink, wakes });

    expect(result.parked).toBe(true);
    expect(awaiting.checks).toBe(2);
    expect(wakes).toEqual([{ adapterType: 'ask', teamId: TEAM_ID, correlationKey: 'req-1' }]);
  });

  it('a re-check that throws (the remote is down) leaves the run parked, wakes nothing, and logs the key', async () => {
    const awaiting = makeAwaitingAdapter([
      { status: 'pending', correlationKey: 'req-1' },
      new Error('remote is down'),
    ]);
    const { sink, parks, wakes } = recording();
    const errors = jest.spyOn(logger, 'error').mockImplementation(() => logger);

    const result = await runAwaiting({ teamId: TEAM_ID, source: awaitingSource(), adapter: awaiting.adapter, parkSink: sink, wakes });

    expect(result.parked).toBe(true);
    expect(parks).toHaveLength(1);
    expect(wakes).toEqual([]);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('re-check after parking failed'),
      expect.objectContaining({ adapterType: 'ask', teamId: TEAM_ID, correlationKey: 'req-1', error: 'remote is down' }),
    );
    errors.mockRestore();
  });

  it('a wake that cannot be queued leaves the run parked', async () => {
    const awaiting = makeAwaitingAdapter([{ status: 'pending', correlationKey: 'req-1' }, ANSWERED(true)]);
    const { sink, parks } = recording();

    const result = await runAwaiting({
      teamId: TEAM_ID,
      source: awaitingSource(),
      adapter: awaiting.adapter,
      parkSink: sink,
      wake: async () => {
        throw new Error('work table unavailable');
      },
    });

    expect(result.parked).toBe(true);
    expect(parks).toHaveLength(1);
  });

  it('landings that all fail the WHERE park on the key the landed answer named, and do not wake', async () => {
    const { adapter } = makeAwaitingAdapter([ANSWERED(false)]);
    const { sink, parks, wakes } = recording();

    const result = await runAwaiting({
      teamId: TEAM_ID,
      source: awaitingSource('r.Answer'),
      adapter,
      parkSink: sink,
      wakes,
    });

    expect(result.parked).toBe(true);
    expect(parks[0]).toMatchObject({ adapterType: 'ask', correlationKey: 'req-1' });
    expect(wakes).toEqual([]);
  });

  it('a landed-but-unmatched answer parks on the key it returned, and a later matching landing wakes it', async () => {
    const unmatched: AwaitResolution = {
      status: 'landed',
      correlationKey: 'thread-9',
      landings: [{ recordType: 'Check Response', fields: { Answer: false } }],
    };
    const matched: AwaitResolution = {
      status: 'landed',
      correlationKey: 'thread-9',
      landings: [
        { recordType: 'Check Response', fields: { Answer: false } },
        { recordType: 'Check Response', fields: { Answer: true } },
      ],
    };
    const { adapter } = makeAwaitingAdapter([unmatched, matched]);
    const { sink, parks, wakes } = recording();

    const result = await runAwaiting({ teamId: TEAM_ID, source: awaitingSource('r.Answer'), adapter, parkSink: sink, wakes });

    expect(result.parked).toBe(true);
    expect(parks[0]).toMatchObject({ adapterType: 'ask', correlationKey: 'thread-9' });
    expect(wakes).toEqual([{ adapterType: 'ask', teamId: TEAM_ID, correlationKey: 'thread-9' }]);
  });
});

describe('a park the host refuses because the run lease was lost', () => {
  it('reaches the run host as that failure, so the segment stops rather than failing the run', async () => {
    const awaiting = makeAwaitingAdapter([{ status: 'pending', correlationKey: 'req-1' }]);
    const { sink } = makeFakeParkSink();
    const refusing: ParkSink = {
      ...sink,
      async commitAwaitPark() {
        throw new RunLeaseLost('run-1' as TriggerRunId);
      },
    };

    const failed = await runAwaiting({ teamId: TEAM_ID, source: awaitingSource(), adapter: awaiting.adapter, parkSink: refusing }).catch(
      (error: unknown) => error,
    );

    expect(runFailureCause(failed)).toBeInstanceOf(RunLeaseLost);
  });
});
