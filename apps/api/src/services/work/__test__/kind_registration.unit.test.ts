import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';

import { registerWorkHandler, registerWorkKinds, resetWorkHandlersForTests } from '../drain';
import { claimDueWork, enqueueWork, ensurePeriodicWork } from '../store';

// A database that runs nothing and answers no rows, but records every query
// it was sent, parameters included.
const sent: CompiledQuery[] = [];
const recordingDb = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
  log: (event) => {
    if (event.level === 'query') sent.push(event.query);
  },
});

jest.mock('../../../lib/kysely', () => ({ getAutomationsQb: () => recordingDb }));

// A unit kind, declared as a unit declares it (kinds.ts), for this suite only.
declare module '../kinds' {
  interface UnitWorkKinds {
    test_unit_sweep: true;
  }
}
const UNIT_KIND = 'test_unit_sweep';

beforeEach(() => {
  resetWorkHandlersForTests();
  sent.length = 0;
});

describe('a unit kind no process registered', () => {
  it('cannot be enqueued: the row would never be claimed', async () => {
    await expect(enqueueWork({ kind: UNIT_KIND, key: 'k' })).rejects.toThrow(
      /'test_unit_sweep' is not claimable in this process/,
    );
    expect(sent).toEqual([]);
  });

  it('cannot be ensured as a periodic row either', async () => {
    await expect(ensurePeriodicWork({ kind: UNIT_KIND, key: UNIT_KIND, intervalMs: 1_000 })).rejects.toThrow(
      /not claimable in this process/,
    );
    expect(sent).toEqual([]);
  });

  it('cannot be registered as a core handler: a unit goes through registerWorkKinds', () => {
    // A caller outside the type system (a cast, plain JS) is refused at run time too.
    const kind: string = UNIT_KIND;
    expect(() => registerWorkHandler(kind as 'timer_sweep', { run: async () => {} })).toThrow(
      /not a core kind/,
    );
  });
});

describe('a unit kind registered through registerWorkKinds', () => {
  it('is enqueued, ensured and claimed by this process', async () => {
    registerWorkKinds([{ kind: UNIT_KIND, handler: { run: async () => {} }, intervalMs: 1_000 }]);

    await enqueueWork({ kind: UNIT_KIND, key: 'k' });
    await ensurePeriodicWork({ kind: UNIT_KIND, key: UNIT_KIND, intervalMs: 1_000 });
    await claimDueWork({ owner: 'me', limit: 10, leaseMs: 1_000 });

    expect(sent).toHaveLength(3);
    const claim = sent[2];
    expect(claim?.sql).toMatch(/kind = ANY/);
    expect(claim?.parameters).toContainEqual(expect.arrayContaining([UNIT_KIND, 'resume_timer']));
  });

  it('is claimed only once registered', async () => {
    await claimDueWork({ owner: 'me', limit: 10, leaseMs: 1_000 });
    expect(sent[0]?.parameters).not.toContainEqual(expect.arrayContaining([UNIT_KIND]));
  });
});
