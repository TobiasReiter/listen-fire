// The admin ops views read runs and notices: the admission dry run's roll-up
// rows (services/movement_engine/admission_rollup.ts) share their table, and
// each view leaves them out. The SQL each view sends is compiled for real and
// captured; nothing reaches a database.

const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];

jest.mock('../../../../lib/kysely', () => {
  const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = jest.requireActual('kysely');
  const connection = {
    executeQuery: async (query: { sql: string; parameters: readonly unknown[] }) => {
      queries.push(query);
      return { rows: [{}] };
    },
    async *streamQuery() {},
  };
  const qb = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
      createIntrospector: (db: unknown) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { getQb: () => qb, getAutomationsQb: () => qb.withSchema('automations') };
});

const principal = { userId: 'admin-1', teamId: 'team-1', access: 'write' as const, scopes: ['*'], pinnedTeamId: null };
jest.mock('../../../../services/context', () => ({
  currentContext: () => ({ user: { id: 'admin-1', teamId: 'team-1' }, principal }),
}));
jest.mock('../../../../services/user', () => ({
  UserService: { getById: async () => ({ id: 'admin-1', isPlatformAdmin: true }) },
}));
jest.mock('../../../../lib/anthropic', () => ({ anthropicChatStructured: jest.fn() }));

import { ADMISSION_ROLLUP_KIND } from '../../../../services/movement_engine/admission_rollup';
import { trpc } from '../../trpc';
import { opsRouter } from '../ops';

function caller() {
  return opsRouter(trpc.procedure).createCaller({ authorise: async () => {} });
}

/** The one query a view sent leaves the roll-up rows out. */
function expectRollupsLeftOut(): void {
  expect(queries).toHaveLength(1);
  const [query] = queries;
  expect(query?.sql).toContain(`(ops_event.detail->>'kind') is distinct from $`);
  expect(query?.parameters).toContain(ADMISSION_ROLLUP_KIND);
}

beforeEach(() => {
  queries.length = 0;
});

describe('the ops views leave the admission roll-up rows out', () => {
  it('the summary tiles (runs today among them)', async () => {
    await caller().summary();
    expectRollupsLeftOut();
  });

  it('the feed', async () => {
    await caller().listFeed({});
    expectRollupsLeftOut();
  });

  it("an event's detail", async () => {
    await caller().getEvent({ id: '00000000-0000-0000-0000-000000000001' });
    expectRollupsLeftOut();
  });
});
