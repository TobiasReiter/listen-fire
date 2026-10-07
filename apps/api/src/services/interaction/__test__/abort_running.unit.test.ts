// abortRun's dual behavior (runs-cancel task 3, §abortRun): a `parked` run is
// still cancelled immediately (the pre-existing path, §5.7 P9), but a
// `running` run can't be safely torn down from outside — a write could be
// mid-flight. Instead abortRun STAMPS `cancel_requested_at`/`cancel_reason`
// via a guarded update and leaves the engine's cooperative cancel gate
// (movement_engine/cancel_gate.ts) to settle it at its next check. If the
// guarded update races (the run parked or finished between the status read
// and the stamp), abortRun re-reads status and falls back: now-parked →
// immediate path; terminal → no-op (already settled).

const TEAM_ID = 'team-1' as never;

// A scriptable qb double (chain/script shape borrowed from
// scan tests), extended with the update-side
// methods (`updateTable`/`set`/`returning`) abortRun's stamp needs.
type Op = 'select' | 'update';
const scripted: Record<string, unknown[]> = {};
const recorded: { table: string; op: Op; set?: Record<string, unknown> }[] = [];
const script = (table: string, op: Op, result: unknown) =>
  ((scripted[`${table}:${op}`] ??= []).push(result));
const next = (table: string, op: Op) => (scripted[`${table}:${op}`] ?? []).shift();

function chain(table: string) {
  const state: { op: Op; set?: Record<string, unknown> } = { op: 'select' };
  const terminal = () => {
    recorded.push({ table, op: state.op, set: state.set });
    return next(table, state.op);
  };
  const proxy: any = {};
  for (const m of ['selectFrom', 'select', 'where', 'returning']) {
    proxy[m] = () => proxy;
  }
  proxy.updateTable = () => {
    state.op = 'update';
    return proxy;
  };
  proxy.set = (s: Record<string, unknown>) => {
    state.op = 'update';
    state.set = s;
    return proxy;
  };
  proxy.execute = async () => (await terminal()) ?? [];
  proxy.executeTakeFirst = async () => (await terminal()) ?? undefined;
  return proxy;
}

// A schema-qualified read (`getQb(['core.team', 'team_wallet'])`, the D35(b)
// idiom for a query that crosses the boundary) still names the same TABLE, so
// the double strips the qualifier rather than growing a second key space.
const table = (t: string) => t.replace(/^\w+\./, '');
jest.mock('../../../lib/kysely', () => ({
  getQb: (tables: string[]) => chain(table(tables[0])),
  getCoreQb: (tables: string[]) => chain(table(tables[0])),
  getAutomationsQb: (tables: string[]) => chain(table(tables[0])),
}));

const failRunAndCancelRequests = jest.fn();
// The run's lease: always free here, so a parked run is failed under it.
jest.mock('../../movement_engine/run_lease', () => ({
  withRunLease: async (_runId: string, fn: () => Promise<unknown>) => ({ kind: 'held', value: await fn() }),
}));
jest.mock('../run_failure', () => ({
  failRunAndCancelRequests: (...args: unknown[]) => failRunAndCancelRequests(...args),
}));

import { abortRun } from '../operator';

beforeEach(() => {
  for (const k of Object.keys(scripted)) delete scripted[k];
  recorded.length = 0;
  failRunAndCancelRequests.mockReset().mockResolvedValue(undefined);
});

// abortRun's DB shape: assertOwnedRun (select) → status read (select) →
// [running only] guarded stamp (update) → [raced only] status re-read (select).
function scriptOwned(status: string) {
  script('trigger_run', 'select', { id: 'run-1' }); // assertOwnedRun
  script('trigger_run', 'select', { status }); // initial status read
}

describe('abortRun', () => {
  it('running run: stamps cancel_requested_at/cancel_reason, does not fail immediately', async () => {
    scriptOwned('running');
    script('trigger_run', 'update', { id: 'run-1' }); // guarded stamp wins

    const result = await abortRun({ runId: 'run-1', teamId: TEAM_ID, abortedBy: 'Ada' });

    expect(result.runId).toBe('run-1');
    expect(failRunAndCancelRequests).not.toHaveBeenCalled();
    const stamp = recorded.find((r) => r.table === 'trigger_run' && r.op === 'update');
    expect(stamp?.set).toEqual(
      expect.objectContaining({
        cancel_reason: 'Cancelled by Ada',
      }),
    );
    expect(stamp?.set).toHaveProperty('cancel_requested_at');
  });

  it('parked run: calls failRunAndCancelRequests immediately, no stamp attempted', async () => {
    scriptOwned('parked');

    const result = await abortRun({ runId: 'run-1', teamId: TEAM_ID, abortedBy: 'Ada' });

    expect(result.runId).toBe('run-1');
    expect(failRunAndCancelRequests).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', message: 'Cancelled by Ada' }),
    );
    expect(recorded.some((r) => r.table === 'trigger_run' && r.op === 'update')).toBe(false);
  });

  it('running-but-raced: guarded update loses, re-read finds parked → falls back to immediate fail', async () => {
    scriptOwned('running');
    script('trigger_run', 'update', undefined); // guarded stamp lost the race
    script('trigger_run', 'select', { status: 'parked' }); // re-read after the race

    const result = await abortRun({ runId: 'run-1', teamId: TEAM_ID, abortedBy: 'Ada' });

    expect(result.runId).toBe('run-1');
    expect(failRunAndCancelRequests).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', message: 'Cancelled by Ada' }),
    );
  });

  it('running-but-raced: guarded update loses, re-read finds terminal → no-op', async () => {
    scriptOwned('running');
    script('trigger_run', 'update', undefined); // guarded stamp lost the race
    script('trigger_run', 'select', { status: 'failed' }); // already settled

    const result = await abortRun({ runId: 'run-1', teamId: TEAM_ID, abortedBy: 'Ada' });

    expect(result.runId).toBe('run-1');
    expect(failRunAndCancelRequests).not.toHaveBeenCalled();
  });
});
