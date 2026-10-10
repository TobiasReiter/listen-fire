// The per-segment ceiling on third-party network calls — the host's half of a
// run segment (`translation_graph/segment_scope.ts`), opened by the engine
// through `host.segment.open` and named on every adapter it resolves.
//
// The properties that matter: it is INERT outside a segment (CLI scripts, the
// connection describer, the catalog — none of those are a run and none of them
// should be able to fail on a run's budget), it is PER SEGMENT (two runs in
// flight in the same process do not spend each other's budget), and the error
// it throws is the whole failure surface an author sees, so its wording is
// under test too.

import { tenantIdOf } from 'engine-contracts';
import type { Adapter } from '../../translation_graph/adapter';
import { adapterTable } from '../../translation_graph/engine/adapter_table';
import {
  AdapterCallCeilingExceeded,
  bindAdapterCallCounter,
  closeSegment,
  countAdapterCall,
  currentSegmentCallCount,
  inSegment,
  isAdapterCallCeilingExceeded,
  openSegment,
  segmentScopedCalls,
  withSegment,
} from '../../translation_graph/segment_scope';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const ENV_VAR = 'AFFINITY_MAX_CALLS_PER_RUN';
const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000071');

const inASegment = <T>(fn: () => Promise<T>) => withSegment({ teamId: teamOfTenant(TEAM_ID) }, fn);

describe('the per-segment Affinity call ceiling', () => {
  const original = process.env[ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  it('does nothing at all outside a segment', () => {
    process.env[ENV_VAR] = '1';
    for (let i = 0; i < 10; i++) countAdapterCall('affinity');
    expect(currentSegmentCallCount('affinity')).toBe(0);
  });

  it('counts every call made inside a segment', async () => {
    await inASegment(async () => {
      countAdapterCall('affinity');
      countAdapterCall('affinity');
      expect(currentSegmentCallCount('affinity')).toBe(2);
    });
  });

  it('throws on the call past the ceiling, naming the count and the knob', async () => {
    process.env[ENV_VAR] = '3';
    await inASegment(async () => {
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
      await inASegment(async () => {
        for (let i = 0; i < 2000; i++) countAdapterCall('affinity');
        expect(() => countAdapterCall('affinity')).toThrow(/made 2000 Affinity API calls/);
      });
    }
  });

  it('keeps two segments in flight apart', async () => {
    process.env[ENV_VAR] = '2';
    // Both bodies interleave on the same event loop; if they shared a count,
    // the fourth call across the pair would throw.
    const run = (tick: () => Promise<void>) =>
      inASegment(async () => {
        countAdapterCall('affinity');
        await tick();
        countAdapterCall('affinity');
        return currentSegmentCallCount('affinity');
      });

    const [a, b] = await Promise.all([
      run(() => new Promise((r) => setTimeout(r, 1))),
      run(() => new Promise((r) => setTimeout(r, 1))),
    ]);

    expect([a, b]).toEqual([2, 2]);
  });

  it('charges a queued call to the segment that issued it, not the one that runs it', async () => {
    process.env[ENV_VAR] = '10';
    // The shape the API clients have: a job is enqueued inside segment A but
    // dequeued and executed inside segment B, so the counter has to be bound
    // where the call was ISSUED.
    let deferred: (() => void) | undefined;
    const a = inASegment(async () => {
      const count = bindAdapterCallCounter('affinity');
      await new Promise<void>((resolve) => {
        deferred = () => {
          count();
          resolve();
        };
      });
      return currentSegmentCallCount('affinity');
    });

    const b = await inASegment(async () => {
      deferred?.();
      return currentSegmentCallCount('affinity');
    });

    expect(await a).toBe(1);
    expect(b).toBe(0);
  });

  it('comes back as the typed error the engine contract names', async () => {
    process.env[ENV_VAR] = '1';
    await inASegment(async () => {
      countAdapterCall('affinity');
      try {
        countAdapterCall('affinity');
        throw new Error('should have thrown');
      } catch (err) {
        expect(isAdapterCallCeilingExceeded(err)).toBe(true);
        expect(err).toBeInstanceOf(AdapterCallCeilingExceeded);
        expect(err).toMatchObject({ kind: 'call_ceiling', system: 'affinity', calls: 1 });
      }
    });
  });

  it('a segment is entered by its id, and a closed one cannot be', async () => {
    const { segmentId } = await openSegment({ teamId: TEAM_ID, languageVersion: 2 });
    inSegment(segmentId, () => countAdapterCall('affinity'));
    expect(inSegment(segmentId, () => currentSegmentCallCount('affinity'))).toBe(1);
    await closeSegment({ segmentId });
    expect(() => inSegment(segmentId, () => undefined)).toThrow(/no open segment/);
  });

  it('the host answers the engine with the ceiling as data, and refuses a call into a closed segment', async () => {
    process.env[ENV_VAR] = '1';
    const counting: Adapter = {
      adapterType: 'affinity',
      supportedTriggers: [],
      runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
      listEntryPoints: async () => [],
      describe: async () => {
        countAdapterCall('affinity');
        return null;
      },
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      createRecord: async () => ({ adapterType: 'affinity', externalId: 'x', data: {} }),
      updateRecord: async (input) => ({ adapterType: 'affinity', externalId: input.externalId, data: {}, association: 'none' }),
      deleteRecord: async () => ({}),
    };
    const table = adapterTable({
      resolveLive: () => counting,
      segments: { facts: () => ({ teamId: TEAM_ID }) },
      ...segmentScopedCalls,
    });
    const { segmentId } = await openSegment({ teamId: TEAM_ID, languageVersion: 2 });
    const { instance } = await table.resolve({ adapterType: 'affinity', role: 'source', segmentId });
    const describe = () => table.call({ segmentId, instance, method: 'describe', args: { typeId: 't' } });

    expect(await describe()).toEqual({ result: null });
    expect(await describe()).toEqual({
      error: { kind: 'call_ceiling', message: expect.stringContaining('Affinity call ceiling reached') },
    });
    await closeSegment({ segmentId });
    expect(await describe()).toEqual({
      error: { kind: 'adapter_error', message: expect.stringMatching(/no open segment/) },
    });
  });
});
