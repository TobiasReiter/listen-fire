// Settling the runs parked on retired triggers: which leaves count, and what
// happens to a run another instance is stepping. The database is a recording
// stub; the SQL itself is abandoned_ask_close.integration's.

const queries: Array<{ table: string; op: string; wheres: unknown[][]; set?: unknown }> = [];
let parkedRunIds: string[] = [];
let runsOnTriggers: string[] = [];

function stub(table: string, op: string) {
  const query = { table, op, wheres: [] as unknown[][], set: undefined as unknown };
  queries.push(query);
  const chain: Record<string, unknown> = {
    select: () => chain,
    returning: () => chain,
    set: (value: unknown) => {
      query.set = value;
      return chain;
    },
    where: (...args: unknown[]) => {
      query.wheres.push(args);
      return chain;
    },
    execute: async () => {
      if (table === 'parked_run') return parkedRunIds.map((run_id) => ({ run_id }));
      if (table === 'trigger_run' && op === 'select') return runsOnTriggers.map((id) => ({ id }));
      return [];
    },
    executeTakeFirst: async () => ({ id: 'stamped' }),
  };
  return chain;
}

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: (table: string) => stub(table, 'select'),
    updateTable: (table: string) => stub(table, 'update'),
    deleteFrom: (table: string) => stub(table, 'delete'),
  }),
  getQb: () => ({}),
}));

const busyRuns = new Set<string>();
const settledUnderLease: string[] = [];
jest.mock('../../movement_engine/run_lease', () => ({
  withRunLease: async (runId: string) => {
    if (busyRuns.has(runId)) return { kind: 'busy' };
    settledUnderLease.push(runId);
    return { kind: 'held', value: undefined };
  },
}));

import { settleRunsParkedOnTriggers } from '../run_failure';

beforeEach(() => {
  queries.length = 0;
  settledUnderLease.length = 0;
  busyRuns.clear();
  parkedRunIds = ['run-free', 'run-busy'];
  runsOnTriggers = ['run-free', 'run-busy'];
});

describe('settleRunsParkedOnTriggers', () => {
  it('counts a leaf mid-resume as well as a parked one', async () => {
    await settleRunsParkedOnTriggers({ triggerIds: ['t-1'], reason: 'listener removed' });
    const leaves = queries.find((q) => q.table === 'parked_run' && q.op === 'select');
    expect(leaves?.wheres).toEqual([['status', 'in', ['parked', 'resuming']]]);
  });

  it('settles a free run under its lease, and stamps one another instance holds', async () => {
    busyRuns.add('run-busy');
    await settleRunsParkedOnTriggers({ triggerIds: ['t-1'], reason: 'listener removed' });

    expect(settledUnderLease).toEqual(['run-free']);
    const stamp = queries.find((q) => q.table === 'trigger_run' && q.op === 'update');
    expect(stamp?.set).toMatchObject({ cancel_reason: 'listener removed' });
    expect(stamp?.wheres).toEqual([
      ['id', '=', 'run-busy'],
      ['status', 'in', ['running', 'parked']],
      ['cancel_requested_at', 'is', null],
    ]);
  });
});
