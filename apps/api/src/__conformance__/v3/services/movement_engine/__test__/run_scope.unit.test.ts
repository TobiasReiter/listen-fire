// The per-run ceiling on third-party network calls.
//
// The properties that matter: it is INERT outside a run (CLI scripts, the
// connection describer, the catalog — none of those are a run and none of them
// should be able to fail on a run's budget), it is PER RUN (two runs in flight
// in the same process do not spend each other's budget), and the error it
// throws is the whole failure surface an author sees, so its wording is under
// test too.

import {
  AdapterCallCeilingExceeded,
  bindAdapterCallCounter,
  countAdapterCall,
  currentRunCallCount,
  isAdapterCallCeilingExceeded,
  withRunCallLedger,
} from '../run_scope';

const ENV_VAR = 'AFFINITY_MAX_CALLS_PER_RUN';

describe('the per-run Affinity call ceiling', () => {
  const original = process.env[ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  it('does nothing at all outside a run', () => {
    process.env[ENV_VAR] = '1';
    for (let i = 0; i < 10; i++) countAdapterCall('affinity');
    expect(currentRunCallCount('affinity')).toBe(0);
  });

  it('counts every call made inside a run', async () => {
    await withRunCallLedger(async () => {
      countAdapterCall('affinity');
      countAdapterCall('affinity');
      expect(currentRunCallCount('affinity')).toBe(2);
    });
  });

  it('throws on the call past the ceiling, naming the count and the knob', async () => {
    process.env[ENV_VAR] = '3';
    await withRunCallLedger(async () => {
      countAdapterCall('affinity');
      countAdapterCall('affinity');
      countAdapterCall('affinity');
      expect(() => countAdapterCall('affinity')).toThrow(
        'Affinity call ceiling reached: this run made 3 Affinity API calls, ' +
          'the limit set by AFFINITY_MAX_CALLS_PER_RUN. ' +
          'The run was stopped in case something was looping.',
      );
    });
  });

  it('defaults to 2000, and a zero or unparseable override means the default', async () => {
    for (const value of [undefined, '0', 'lots', '-5']) {
      if (value === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = value;
      await withRunCallLedger(async () => {
        for (let i = 0; i < 2000; i++) countAdapterCall('affinity');
        expect(() => countAdapterCall('affinity')).toThrow(/made 2000 Affinity API calls/);
      });
    }
  });

  it('keeps two runs in flight apart', async () => {
    process.env[ENV_VAR] = '2';
    // Both bodies interleave on the same event loop; if they shared a count,
    // the fourth call across the pair would throw.
    const run = (tick: () => Promise<void>) =>
      withRunCallLedger(async () => {
        countAdapterCall('affinity');
        await tick();
        countAdapterCall('affinity');
        return currentRunCallCount('affinity');
      });

    const [a, b] = await Promise.all([
      run(() => new Promise((r) => setTimeout(r, 1))),
      run(() => new Promise((r) => setTimeout(r, 1))),
    ]);

    expect([a, b]).toEqual([2, 2]);
  });

  it('charges a queued call to the run that issued it, not the one that runs it', async () => {
    process.env[ENV_VAR] = '10';
    // The shape the API clients have: a job is enqueued inside run A but
    // dequeued and executed inside run B, so the counter has to be bound where
    // the call was ISSUED.
    let deferred: (() => void) | undefined;
    const a = withRunCallLedger(async () => {
      const count = bindAdapterCallCounter('affinity');
      await new Promise<void>((resolve) => {
        deferred = () => {
          count();
          resolve();
        };
      });
      return currentRunCallCount('affinity');
    });

    const b = await withRunCallLedger(async () => {
      deferred?.();
      return currentRunCallCount('affinity');
    });

    expect(await a).toBe(1);
    expect(b).toBe(0);
  });

  it('recognises its own error through the guard the adapters use', async () => {
    process.env[ENV_VAR] = '1';
    await withRunCallLedger(async () => {
      countAdapterCall('affinity');
      try {
        countAdapterCall('affinity');
        throw new Error('should have thrown');
      } catch (err) {
        expect(isAdapterCallCeilingExceeded(err)).toBe(true);
        expect(err).toBeInstanceOf(AdapterCallCeilingExceeded);
      }
    });
  });
});
