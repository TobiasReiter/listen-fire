// The engine's await site under protocol v2: the adapter only answers "resolved
// yet, and if not, which key wakes it?"; the engine hands the park sink that key
// and a re-check that asks the await's whole question again, WHERE included.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AwaitResolution } from '../../translation_graph/awaitable';
import type { ParkSink } from '../run';
import { makeFakeParkSink } from '../host';
import { awaitingSource, makeAwaitingAdapter, runAwaiting } from './awaitable_fixture';

const TEAM_ID = '00000000-0000-0000-0000-000000000042' as TeamId;

type AwaitPark = Parameters<ParkSink['commitAwaitPark']>[0];

/** The in-memory sink, keeping each await park's full input. */
function recordingSink(): { sink: ParkSink; parks: AwaitPark[] } {
  const parks: AwaitPark[] = [];
  const { sink } = makeFakeParkSink();
  return {
    sink: {
      ...sink,
      async commitAwaitPark(input) {
        parks.push(input);
      },
    },
    parks,
  };
}

const ANSWERED = (answer: boolean): AwaitResolution => ({
  status: 'landed',
  correlationKey: 'req-1',
  landings: [{ recordId: 'req-1', recordType: 'Check Response', fields: { Answer: answer } }],
});

describe('await park — the adapter names the key, the engine keeps the correlation', () => {
  it('pending parks under the adapter type and the key the answer named', async () => {
    const { adapter } = makeAwaitingAdapter([{ status: 'pending', correlationKey: 'req-1' }]);
    const { sink, parks } = recordingSink();

    const result = await runAwaiting({ teamId: TEAM_ID, source: awaitingSource(), adapter, parkSink: sink });

    expect(result.parked).toBe(true);
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({ adapterType: 'ask', correlationKey: 'req-1' });
    expect(await parks[0]!.resolvesNow()).toBe(false);
  });

  it('the re-check reports a landing that arrived after the first check', async () => {
    const awaiting = makeAwaitingAdapter([{ status: 'pending', correlationKey: 'req-1' }, ANSWERED(true)]);
    const { sink, parks } = recordingSink();

    await runAwaiting({ teamId: TEAM_ID, source: awaitingSource(), adapter: awaiting.adapter, parkSink: sink });

    expect(await parks[0]!.resolvesNow()).toBe(true);
    expect(awaiting.checks).toBe(2);
  });

  it('landings that all fail the WHERE park on the key the landed answer named, and do not count as resolved', async () => {
    const { adapter } = makeAwaitingAdapter([ANSWERED(false)]);
    const { sink, parks } = recordingSink();

    const result = await runAwaiting({
      teamId: TEAM_ID,
      source: awaitingSource('r.Answer'),
      adapter,
      parkSink: sink,
    });

    expect(result.parked).toBe(true);
    expect(parks[0]).toMatchObject({ adapterType: 'ask', correlationKey: 'req-1' });
    expect(await parks[0]!.resolvesNow()).toBe(false);
  });

  it('refuses to park on unmatched landings that name no key', async () => {
    const { adapter } = makeAwaitingAdapter([
      { status: 'landed', landings: [{ recordType: 'Check Response', fields: { Answer: false } }] },
    ]);
    const { sink, parks } = recordingSink();

    await expect(
      runAwaiting({ teamId: TEAM_ID, source: awaitingSource('r.Answer'), adapter, parkSink: sink }),
    ).rejects.toThrow(/no landing passed the WHERE, and the adapter named no key/);
    expect(parks).toHaveLength(0);
  });
});
