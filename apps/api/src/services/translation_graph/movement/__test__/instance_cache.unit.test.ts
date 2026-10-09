// TTL-cache semantics around adapter-instance introspection: keyed
// (teamId, adapter, credentialsId), single-flight, successes-only, TTL
// expiry, forceRefresh. The adapter seam (`resolveAdapter`) is mocked;
// the real projection (`instanceSchemaFromDescriptors`) runs.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  clearIntrospectionCache,
  introspectAdapterInstanceCached,
} from '../instance_cache';
import { resolveAdapter } from '../../adapters/resolve';

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: jest.fn(),
}));

const resolveAdapterMock = resolveAdapter as jest.Mock;

const TEAM = 'team-1' as TeamId;
const OTHER_TEAM = 'team-2' as TeamId;

function fakeAdapter(adapterType: string) {
  return {
    listEntryPoints: async () => [
      {
        typeId: `${adapterType}:thing`,
        displayName: 'Thing',
        writable: false,
        readable: true,
      },
    ],
    describe: async (typeId: string) => ({
      typeId,
      displayName: 'Thing',
      fields: [
        { fieldId: 'name', displayName: 'name', kind: 'string', writable: false, required: false },
      ],
      references: [],
    }),
  };
}

beforeEach(() => {
  clearIntrospectionCache();
  resolveAdapterMock.mockReset();
  resolveAdapterMock.mockImplementation(async ({ adapterType }) => fakeAdapter(adapterType));
  jest.useFakeTimers({ now: new Date('2026-06-10T12:00:00Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('introspectAdapterInstanceCached', () => {
  it('introspects once per key within the TTL', async () => {
    const first = await introspectAdapterInstanceCached({
      adapterType: 'attio',
      teamId: TEAM,
      credentialsId: 'cred-1',
    });
    const second = await introspectAdapterInstanceCached({
      adapterType: 'attio',
      teamId: TEAM,
      credentialsId: 'cred-1',
    });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1);
    // Since the per-type accumulator (2026-07-05) the cache holds the raw
    // introspection (entries + descriptor promises) and PROJECTS per call —
    // cache hits are pinned by the call count above, equal content here.
    expect(second).toStrictEqual(first);
    // The projection keys positions by the entry's NATURAL name (its
    // `displayName`, here `Thing`), not the internal typeId.
    expect(first.schema.positions.Thing).toBeDefined();
  });

  it('keys on (teamId, adapter, credentialsId) — each axis isolates', async () => {
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' });
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c2' });
    await introspectAdapterInstanceCached({ adapterType: 'slack', teamId: TEAM, credentialsId: 'c1' });
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: OTHER_TEAM, credentialsId: 'c1' });
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM }); // credential-free slot
    expect(resolveAdapterMock).toHaveBeenCalledTimes(5);
  });

  it('shares one in-flight introspection across concurrent callers (single-flight)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    resolveAdapterMock.mockImplementation(async ({ adapterType }) => {
      await gate;
      return fakeAdapter(adapterType);
    });
    const a = introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' });
    const b = introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' });
    release();
    expect(await a).toStrictEqual(await b);
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1);
  });

  // The TTL carries one authoring loop (validate, then save moments later)
  // through its hops without re-introspecting on every step; staleness past
  // that is bounded by `describeConnection`, which always forces a fresh
  // read (see the `forceRefresh` test below), not by keeping the TTL short.
  it('expires entries after the TTL', async () => {
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' });
    jest.advanceTimersByTime(2.5 * 60 * 1000);
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1); // still fresh at 2.5min
    jest.advanceTimersByTime(1 * 60 * 1000);
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(2); // stale past 3min
  });

  it('forceRefresh drops the entry and re-introspects', async () => {
    await introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' });
    await introspectAdapterInstanceCached({
      adapterType: 'attio',
      teamId: TEAM,
      credentialsId: 'c1',
      forceRefresh: true,
    });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures — the next caller retries', async () => {
    resolveAdapterMock.mockRejectedValueOnce(new Error('workspace unreachable'));
    await expect(
      introspectAdapterInstanceCached({ adapterType: 'attio', teamId: TEAM, credentialsId: 'c1' }),
    ).rejects.toThrow('workspace unreachable');
    const retried = await introspectAdapterInstanceCached({
      adapterType: 'attio',
      teamId: TEAM,
      credentialsId: 'c1',
    });
    expect(retried.schema.positions.Thing).toBeDefined();
    expect(resolveAdapterMock).toHaveBeenCalledTimes(2);
  });
});
