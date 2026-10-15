// The await park's write order. The parked row is the truth and the correlation
// only an index onto it, so the parked row goes in first: a wake that runs
// between the two writes then finds either no correlation (a no-op the engine's
// re-check covers) or both rows (a resume), never a correlation without its
// park, which the wake handler would drop as "already drained" and so leave
// the run deaf to every later signal (await_resume.unit covers that handler).

const writes: string[] = [];

function makeQb(): unknown {
  const chain: unknown = new Proxy(() => undefined, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'execute') return async () => undefined;
      // A written row comes back from each upsert.
      if (prop === 'executeTakeFirst') return async () => ({ id: 'row-1' });
      return (...args: unknown[]) => {
        if (prop === 'insertInto') writes.push(`insert ${String(args[0])}`);
        return chain;
      };
    },
  });
  return chain;
}

jest.mock('../../../lib/kysely', () => ({
  getQb: () => makeQb(),
  getAutomationsQb: () => makeQb(),
}));
// The backend, recording what each write lands in.
jest.mock('../run_host_store', () => ({
  postgresRunHostStore: {
    parks: {
      putLeaf: jest.fn(async () => {
        writes.push('insert parked_run');
      }),
    },
    correlations: {
      correlate: jest.fn(async () => {
        writes.push('insert adapter_await');
      }),
      drop: jest.fn(),
    },
    work: { enqueue: jest.fn() },
  },
  triggerRunIdOf: (id: string) => id,
}));
jest.mock('../../translation_graph/adapters/packages', () => ({ awaitKeepers: () => [] }));
jest.mock('../callback_sink', () => ({ callbackAwaitKeeper: { adapterType: 'callback', loadResolvable: jest.fn(), abandon: jest.fn() } }));
jest.mock('../callback_store', () => ({ revokeRunCallbacks: jest.fn() }));
jest.mock('../run_engine_record', () => ({ settleRunEngineRecord: jest.fn() }));
jest.mock('../limit_pause', () => ({ markRunLimitPaused: jest.fn() }));

import { makeRecorderParkSink } from '../park_sink';
import type { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';

function recorder(): TriggerRunRecorder {
  const stub: Pick<TriggerRunRecorder, 'triggerRunId' | 'teamId' | 'triggerId' | 'ensureStarted' | 'markParked'> = {
    triggerRunId: 'run-1' as TriggerRunRecorder['triggerRunId'],
    teamId: 'team-1' as TriggerRunRecorder['teamId'],
    triggerId: 'trigger-1' as TriggerRunRecorder['triggerId'],
    ensureStarted: async () => {
      writes.push('ensure trigger_run');
    },
    markParked: async () => {
      writes.push('mark parked');
    },
  };
  return stub as TriggerRunRecorder;
}

beforeEach(() => {
  writes.length = 0;
});

describe('commitAwaitPark — write order', () => {
  it('writes the parked row before the correlation that indexes it', async () => {
    await makeRecorderParkSink(recorder()).commitAwaitPark({
      address: 's1',
      state: {},
      adapterType: 'slack',
      correlationKey: 'C1:1.0',
    });

    expect(writes).toEqual(['ensure trigger_run', 'insert parked_run', 'insert adapter_await', 'mark parked']);
  });
});
