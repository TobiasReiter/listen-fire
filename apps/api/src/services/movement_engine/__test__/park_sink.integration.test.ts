// Real-DB proof that `commitTimerPark` writes the durable timer-park row
// correctly. Standing gate for §3 of plans/2026-07-01-movement-sleep/3_model.md:
// a `parked_run` row with `park_reason='timer'` and `wake_at` set, and idempotent
// UPSERT on `(run_id, address)`. And that `commitAwaitPark` writes the park and
// its correlation row, after which the engine re-checks once and, through the
// host's `park.wake`, queues the wake for an answer that landed while it parked.

import { randomUUID } from 'node:crypto';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';
import { makeRecorderParkSink } from '../park_sink';
import { enqueueAwaitWake } from '../await_wake';
import { loadCorrelatedParks } from '../../translation_graph/adapters/await_correlation';
import { awaitingSource, makeAwaitingAdapter, runAwaiting } from './awaitable_fixture';
import { claimParkedLeaf, claimRunLease, finishResumedLeaf, RunLeaseLost } from '../run_lease';
import { dropRunLeaves } from '../lease_fence';
import { tenantOfTeam } from '../../translation_graph/movement/tenant';

let teamId: TeamId;
let runId: TriggerRunId;

/** Minimal recorder stub: the run row is pre-inserted so ensureStarted is a
 *  no-op; markParked updates the row. Only the four properties/methods used by
 *  makeRecorderParkSink are needed. */
function makeStubRecorder(opts: {
  teamId: TeamId;
  runId: TriggerRunId;
}): TriggerRunRecorder {
  return {
    get triggerRunId() {
      return opts.runId;
    },
    get teamId() {
      return opts.teamId;
    },
    async ensureStarted() {
      // Pre-inserted in beforeAll — no-op.
    },
    async markParked() {
      await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ status: 'parked' })
        .where('id', '=', opts.runId)
        .execute();
    },
  } as unknown as TriggerRunRecorder;
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  runId = randomUUID() as TriggerRunId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `park-sink-${teamId.slice(0, 8)}` } as any)
    .execute();
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: runId,
      team_id: teamId,
      trigger_id: 'park-sink-trigger',
      trigger_type: 'webhook',
      status: 'running',
      started_at: new Date(),
    } as any)
    .execute();
});

afterAll(async () => {
  await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
  await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('id', '=', runId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

afterEach(async () => {
  // Reset after each test so tests are independent.
  await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
  await getAutomationsQb(['join_pending']).deleteFrom('join_pending').where('run_id', '=', runId).execute();
  await getAutomationsQb(['adapter_await']).deleteFrom('adapter_await').where('run_id', '=', runId).execute();
  await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
  // Reset run status to running so ensureStarted / markParked can flip it again.
  await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ status: 'running' })
    .where('id', '=', runId)
    .execute();
});

describe('commitTimerPark', () => {
  it('writes a parked_run row with park_reason=timer, the given wake_at, and status=parked', async () => {
    const sink = makeRecorderParkSink(makeStubRecorder({ teamId, runId }));
    const wakeAt = new Date(Date.now() + 60_000);

    await sink.commitTimerPark({ address: 's1', state: { x: 1 }, wakeAt: wakeAt.toISOString() });

    const row = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .selectAll()
      .where('run_id', '=', runId)
      .where('address', '=', 's1')
      .executeTakeFirstOrThrow();

    expect(row.park_reason).toBe('timer');
    expect(row.status).toBe('parked');
    // wake_at round-trips within 1s (DB truncates to microseconds).
    expect(Math.abs(new Date(row.wake_at!).getTime() - wakeAt.getTime())).toBeLessThan(1000);

    // The run row itself is flipped to parked by markParked().
    const run = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('parked');
  });

  it('is idempotent: a second call for the same (run_id, address) upserts — one row, updated state and wake_at', async () => {
    const sink = makeRecorderParkSink(makeStubRecorder({ teamId, runId }));
    const wakeAt1 = new Date(Date.now() + 60_000);
    const wakeAt2 = new Date(Date.now() + 120_000);

    await sink.commitTimerPark({ address: 's2', state: { original: true }, wakeAt: wakeAt1.toISOString() });
    await sink.commitTimerPark({ address: 's2', state: { updated: true }, wakeAt: wakeAt2.toISOString() });

    const rows = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .selectAll()
      .where('run_id', '=', runId)
      .where('address', '=', 's2')
      .execute();

    // Exactly one row (the UPSERT never duplicates).
    expect(rows).toHaveLength(1);
    expect(rows[0].park_reason).toBe('timer');
    // The second call's wake_at is the durable value.
    expect(Math.abs(new Date(rows[0].wake_at!).getTime() - wakeAt2.getTime())).toBeLessThan(1000);
  });
});

async function awaitWakes() {
  return getAutomationsQb(['work'])
    .selectFrom('work')
    .where('team_id', '=', teamId)
    .where('kind', '=', 'wake_await')
    .select('payload')
    .execute();
}

describe('commitAwaitPark', () => {
  it('writes the await park and the correlation row from the key to it; no wake of its own', async () => {
    const sink = makeRecorderParkSink(makeStubRecorder({ teamId, runId }));

    await sink.commitAwaitPark({
      address: 's1',
      state: { scope: true },
      adapterType: 'slack',
      correlationKey: 'C123:1700000000.000100',
    });

    expect(
      await loadCorrelatedParks({ adapterType: 'slack', teamId, correlationKey: 'C123:1700000000.000100' }),
    ).toEqual([{ runId, teamId, address: 's1' }]);
    const park = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .select(['park_reason', 'status'])
      .where('run_id', '=', runId)
      .where('address', '=', 's1')
      .executeTakeFirstOrThrow();
    expect(park).toEqual({ park_reason: 'await', status: 'parked' });
    expect(await awaitWakes()).toEqual([]);
  });

  // Review focus: the reply that lands between the first check and the
  // correlation row would otherwise wake nothing, and nothing else looks again.
  it('an answer that landed while the run parked queues the wake itself, with no inbound event', async () => {
    const awaiting = makeAwaitingAdapter([
      { status: 'pending', correlationKey: 'req-1' },
      {
        status: 'landed',
        correlationKey: 'req-1',
        landings: [{ recordId: 'req-1', recordType: 'Check Response', fields: { Answer: true } }],
      },
    ]);

    const result = await runAwaiting({
      teamId: tenantOfTeam(teamId),
      source: awaitingSource(),
      adapter: awaiting.adapter,
      parkSink: makeRecorderParkSink(makeStubRecorder({ teamId, runId })),
      // The production host's wake: a `wake_await` work row.
      wake: ({ adapterType, correlationKey }) => enqueueAwaitWake({ adapterType, teamId, correlationKey }),
    });

    expect(result.parked).toBe(true);
    expect(awaiting.checks).toBe(2);
    expect(await loadCorrelatedParks({ adapterType: 'ask', teamId, correlationKey: 'req-1' })).toHaveLength(1);
    expect(await awaitWakes()).toEqual([{ payload: { adapterType: 'ask', teamId, correlationKey: 'req-1' } }]);
  });
});

describe('a park under a lease that lapsed', () => {
  const STATE = { version: 1, address: 's0', bindingName: null, scopeChain: [] };

  afterEach(async () => {
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ lease_owner: null, lease_until: null, lease_token: null })
      .where('id', '=', runId)
      .execute();
  });

  it("is refused: a stale token's park commit writes nothing, and the new holder's row stands", async () => {
    const current = await claimRunLease(runId, { owner: 'the-new-holder', ttlMs: 60_000 });
    expect(current).not.toBeNull();
    const fresh = makeRecorderParkSink(makeStubRecorder({ teamId, runId }), { lease: { token: current!.token } });
    const stale = makeRecorderParkSink(makeStubRecorder({ teamId, runId }), { lease: { token: randomUUID() } });
    const wakeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await fresh.commitTimerPark({ address: 's0', state: { ...STATE, by: 'new' }, wakeAt });

    await expect(
      stale.commitTimerPark({ address: 's0', state: { ...STATE, by: 'stale' }, wakeAt }),
    ).rejects.toBeInstanceOf(RunLeaseLost);
    await expect(
      stale.commitAwaitPark({ address: 's1', state: STATE, adapterType: 'ask', correlationKey: 'req-9' }),
    ).rejects.toBeInstanceOf(RunLeaseLost);
    await expect(stale.commitSuspension!({ address: 's2', state: STATE })).rejects.toBeInstanceOf(RunLeaseLost);
    await expect(stale.recordJoin({ frameAddress: 's3', parkedChildren: 2 })).rejects.toBeInstanceOf(RunLeaseLost);

    const rows = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .select(['address', 'state'])
      .execute();
    expect(rows).toEqual([{ address: 's0', state: { ...STATE, by: 'new' } }]);
    expect(await loadCorrelatedParks({ adapterType: 'ask', teamId, correlationKey: 'req-9' })).toEqual([]);
    const joins = await getAutomationsQb(['join_pending']).selectFrom('join_pending').where('run_id', '=', runId).select('frame_address').execute();
    expect(joins).toEqual([]);
  });

  it("a stale holder's finish of a claimed leaf, and its sweep of the run, leave the new holder's rows alone", async () => {
    const current = await claimRunLease(runId, { owner: 'the-new-holder', ttlMs: 60_000 });
    const sink = makeRecorderParkSink(makeStubRecorder({ teamId, runId }), { lease: { token: current!.token } });
    await sink.commitTimerPark({ address: 's0', state: STATE, wakeAt: new Date().toISOString() });
    await sink.recordJoin({ frameAddress: 's', parkedChildren: 1 });
    expect(await claimParkedLeaf({ runId, address: 's0' })).not.toBeNull();
    const stale = { token: randomUUID() };

    await finishResumedLeaf(runId, 's0', stale);
    await dropRunLeaves(runId, stale);
    const left = await getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId).select('status').execute();
    expect(left).toEqual([{ status: 'resuming' }]);
    expect(await getAutomationsQb(['join_pending']).selectFrom('join_pending').where('run_id', '=', runId).select('pending').execute()).toEqual([{ pending: 1 }]);

    // The holder itself finishes the leaf and sweeps the run.
    await finishResumedLeaf(runId, 's0', current!);
    await dropRunLeaves(runId, current!);
    expect(await getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId).select('id').execute()).toEqual([]);
    expect(await getAutomationsQb(['join_pending']).selectFrom('join_pending').where('run_id', '=', runId).select('pending').execute()).toEqual([]);
  });
});
