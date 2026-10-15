// The forced race behind a NON-reproducing live incident: one tap on a
// parameterised Slack datepicker, ONE call on the callback's ledger, and the
// body's write applied TWICE (run b7e95f89 — steps 2 and 4 byte-identical, same
// source span, with the main continuation's step wedged between them).
//
// The cause is not the claim (that UPDATE is atomic — `callback_store`) and not
// the backstop wake (it only ever RESUMES awaits). It is the per-run slot the
// fire shares with the await drain: its coalescing entry REPLAYS the in-flight
// task whenever another arrival lands mid-flight, because a drain is supposed to
// re-gather. A callback body is not re-gatherable — it belongs to ONE recorded
// call — so a nudge landing mid-body (in the incident, the body's own Slack
// write echoing back through the inbound seam) re-ran it.
//
// This drives the REAL router against the REAL store, with the firing stubbed so
// body executions are countable, and lands the concurrent arrival exactly where
// the incident did: inside the body.

import { randomUUID } from 'node:crypto';

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';

const fireCallbackFiringMock = jest.fn();

jest.mock('../../translation_graph/movement/execute', () => ({
  fireCallbackFiring: (input: unknown) => fireCallbackFiringMock(input),
  resumeMovementFiring: jest.fn(),
}));

import { getAutomationsQb, getCoreQb, getQb } from '../../../lib/kysely';
import { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { fireCallback } from '../callback_fire';
import { runResumeSlot } from '../await_resume';
import * as callbackStore from '../callback_store';
import { getCallback, mintCallback, revokeRunCallbacks } from '../callback_store';
import { registerCallbackFireWork } from '../callback_fire';
import { drainWork, resetWorkHandlersForTests } from '../../work/drain';
import * as workStore from '../../work/store';
import { enqueueWork } from '../../work/store';
import { postgresRunHostStore } from '../run_host_store';

const SOURCE = 'go = manual()';

const STATE: ParkedScopeState = {
  version: 1,
  address: 's0',
  bindingName: null,
  scopeChain: [{ bindings: {} }],
};

function makeEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:callback-fire-race',
    adapterType: 'slack',
    triggerType: 'webhook',
    payload: { hello: 'world' },
  } as TriggerEvent;
}

let teamId: TeamId;
let triggerId: TriggerId;
let movementVersionId: string;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `cb-fire-race-${teamId.slice(0, 8)}` } as any)
    .execute();

  const pipelineConfigurationId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    .values({
      id: pipelineConfigurationId,
      team_id: teamId,
      name: `cfg-${pipelineConfigurationId.slice(0, 8)}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();

  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: teamId, name: 'book_it', source: SOURCE } as any)
    .execute();

  movementVersionId = randomUUID();
  await getAutomationsQb(['movement_version'])
    .insertInto('movement_version')
    .values({
      id: movementVersionId,
      movement_id: movementId,
      team_id: teamId,
      version_number: 1,
      source: SOURCE,
      content_hash: 'race-fixture',
      language_version: CURRENT_LANGUAGE_VERSION,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();

  triggerId = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({
      id: triggerId,
      team_id: teamId,
      pipeline_configuration_id: pipelineConfigurationId,
      name: 'Book it',
      kind: 'webhook',
      movement_id: movementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();
});

afterAll(async () => {
  await cleanupTeam(teamId);
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

/** A live run with a live single-use callback taking one `day` — the incident's
 *  shape exactly. */
async function seedFiredRun(
  options: { singleUse?: boolean } = {},
): Promise<{ runId: TriggerRunId; callbackId: string }> {
  const recorder = new TriggerRunRecorder({
    teamId,
    triggerId,
    triggerType: 'webhook',
    triggerEvent: makeEvent(),
    movementVersionId,
  });
  await recorder.ensureStarted();
  const callback = await mintCallback({
    teamId,
    runId: recorder.triggerRunId,
    address: 's0',
    params: [{ name: 'day', type: 'date' }],
    state: STATE,
    singleUse: options.singleUse ?? true,
  });
  return { runId: recorder.triggerRunId, callbackId: callback.id };
}

describe('a fired callback body runs once per recorded call, even under a mid-body nudge', () => {
  beforeEach(() => {
    fireCallbackFiringMock.mockReset();
  });

  it('a resume nudge landing mid-body does not re-run the body', async () => {
    const { runId, callbackId } = await seedFiredRun();

    const bodyCalls: number[] = [];
    let drains = 0;
    let nudge: Promise<void> = Promise.resolve();

    fireCallbackFiringMock.mockImplementation(async (input: { callIndex: number }) => {
      bodyCalls.push(input.callIndex);
      if (bodyCalls.length === 1) {
        // A wake (inbound seam, backstop) entering the SAME run's slot while the
        // body is in flight — in the incident, the Slack message the body had
        // just posted arriving back through `resumeAwaitsForCorrelation`.
        nudge = runResumeSlot.coalesce(runId, async () => {
          drains += 1;
        });
        await Promise.resolve();
      }
      return { result: { movementName: 'book_it' } };
    });

    const outcome = await fireCallback({
      id: callbackId,
      values: {},
      suppliedValue: '2026-08-20',
      awaitExecution: true,
    });
    await nudge;

    expect(outcome.kind).toBe('recorded');
    // The ledger is the authority on how many calls happened: ONE tap, one call.
    const after = await getCallback(callbackId);
    expect(after?.calls).toHaveLength(1);
    expect(after?.calls[0].values).toEqual({ day: '2026-08-20' });
    // …and therefore exactly one body execution, at that call's own frame.
    expect(bodyCalls).toEqual([0]);
    // The arrival is not swallowed either: it still gets its own drain pass,
    // serialized after the body rather than replacing it.
    expect(drains).toBe(1);
  });

  it('a second tap of a single-use callback is refused, and runs no body', async () => {
    const { callbackId } = await seedFiredRun();
    fireCallbackFiringMock.mockResolvedValue({
      result: { movementName: 'book_it' },
    });

    const first = await fireCallback({
      id: callbackId,
      values: {},
      suppliedValue: '2026-08-20',
      awaitExecution: true,
    });
    const second = await fireCallback({
      id: callbackId,
      values: {},
      suppliedValue: '2026-08-21',
      awaitExecution: true,
    });

    expect(first.kind).toBe('recorded');
    expect(second.kind).toBe('closed');
    expect(fireCallbackFiringMock).toHaveBeenCalledTimes(1);
    expect((await getCallback(callbackId))?.calls).toHaveLength(1);
  });

  it('a call whose body row cannot be written is not recorded: the claim rolls back, and a retry records it', async () => {
    const { callbackId } = await seedFiredRun();
    fireCallbackFiringMock.mockResolvedValue({ result: { movementName: 'book_it' } });
    const enqueue = jest.spyOn(workStore, 'enqueueWork').mockRejectedValueOnce(new Error('test: the insert failed'));

    await expect(
      fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-20', awaitExecution: true }),
    ).rejects.toThrow('test: the insert failed');
    const untouched = await getCallback(callbackId);
    expect(untouched?.status).toBe('live');
    expect(untouched?.calls).toEqual([]);
    expect(fireCallbackFiringMock).not.toHaveBeenCalled();

    // The single-use callback was not consumed, so the tapper's retry lands.
    const retried = await fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-20', awaitExecution: true });
    expect(retried.kind).toBe('recorded');
    expect((await getCallback(callbackId))?.calls).toHaveLength(1);
    expect(fireCallbackFiringMock).toHaveBeenCalledTimes(1);
    enqueue.mockRestore();
  });

  it('a recorded call queues a delayed wake for its awaiters, which outlives this process', async () => {
    const { callbackId } = await seedFiredRun();
    fireCallbackFiringMock.mockResolvedValue({ result: { movementName: 'book_it' } });
    const before = Date.now();

    await fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-20', awaitExecution: true });

    const rows = await getAutomationsQb(['work'])
      .selectFrom('work')
      .where('key', '=', `wake_await:callback_backstop:${callbackId}`)
      .select(['kind', 'payload', 'due_at'])
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('wake_await');
    expect(rows[0].payload).toEqual({ adapterType: 'callback', teamId, correlationKey: callbackId });
    // Deferred well past the in-process wake, so it only matters if that was lost.
    expect(rows[0].due_at.getTime()).toBeGreaterThan(before + 10_000);
  });
});

type CallbackFireModule = typeof import('../callback_fire');

/** The router loaded afresh: its own slot, its own lease owner and its own
 *  database pool, the way a second API instance holds them. */
function secondProcess(): CallbackFireModule {
  let loaded: CallbackFireModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<CallbackFireModule>('../callback_fire');
  });
  if (loaded === undefined) throw new Error('test: the second process did not load');
  return loaded;
}

describe('two processes fire one run at once', () => {
  beforeEach(async () => {
    fireCallbackFiringMock.mockReset();
    resetWorkHandlersForTests();
    registerCallbackFireWork();
    // Only this describe's rows: the earlier tests' wake backstops are not ours to drain.
    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
  });

  it('exactly one runs its body now; the other queues it, and the queued row runs it once the run is free', async () => {
    const { runId, callbackId } = await seedFiredRun({ singleUse: false });
    const other = secondProcess();

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bodies: number[] = [];
    fireCallbackFiringMock.mockImplementation(async (input: { callIndex: number }) => {
      bodies.push(input.callIndex);
      started();
      if (bodies.length === 1) await held;
      return { result: { movementName: 'book_it' } };
    });

    const here = fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-20', awaitExecution: true });
    const there = other.fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-21', awaitExecution: true });
    await bodyStarted;
    // Whichever took the run's lease is mid-body; the other has answered.
    const answered = await Promise.race([here, there]);
    expect(answered).toMatchObject({ kind: 'recorded', queued: true });
    expect(bodies).toHaveLength(1);
    // Each call's body row was written with its claim: the running body's is
    // due only as a backstop, the waiting one's at once.
    const queuedRows = await getAutomationsQb(['work'])
      .selectFrom('work')
      .where('kind', '=', 'fire_callback')
      .where('team_id', '=', teamId)
      .where('due_at', '<=', new Date())
      .select(['key', 'payload'])
      .execute();
    expect(queuedRows).toHaveLength(1);

    // While the body runs, the queued row finds the run held and defers.
    const whileHeld = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(whileHeld).toMatchObject({ claimed: 1, deferred: 1 });
    expect(bodies).toHaveLength(1);

    release();
    const outcomes = await Promise.all([here, there]);
    expect(outcomes.filter((outcome) => outcome.kind === 'recorded' && outcome.queued)).toHaveLength(1);
    const lease = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select('lease_token')
      .executeTakeFirstOrThrow();
    expect(lease.lease_token).toBeNull();

    // The deferral backed the waiting row off; make it due now, as the clock
    // would. The two rows are drained one pass each, the waiting one first: in
    // one pass they run concurrently and contend for the run's lease, so
    // whether the second finds it free or held would be down to scheduling
    // (and a held one defers), not to anything this test is about.
    const ranIndex = bodies[0];
    const waitingIndex = 1 - ranIndex;
    const makeDue = (callIndex: number) =>
      getAutomationsQb(['work'])
        .updateTable('work')
        .set({ due_at: new Date(Date.now() - 1_000) })
        .where('key', '=', `fire_callback:${callbackId}:${callIndex}`)
        .execute();
    await makeDue(waitingIndex);
    const waiting = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(waiting).toMatchObject({ claimed: 1, failed: 0, deferred: 0 });
    expect(waiting.ran + waiting.recovered).toBe(1);
    // The waiting body ran, at its own call's frame.
    expect(bodies).toEqual([ranIndex, waitingIndex]);
    // The row of the call that already ran finds its body started and does nothing.
    await makeDue(ranIndex);
    const spent = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(spent).toMatchObject({ claimed: 1, failed: 0, deferred: 0 });
    expect(spent.ran + spent.recovered).toBe(1);
    // Two calls on the ledger, two bodies, each at its own call's frame.
    expect((await getCallback(callbackId))?.calls).toHaveLength(2);
    expect([...bodies].sort()).toEqual([0, 1]);

    // The row is spent: a later pass finds nothing to do.
    const after = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(after.claimed).toBe(0);
    expect(bodies).toHaveLength(2);
  });

  it('a queued body follows the door: none once its run has ended and its callback is revoked', async () => {
    const { runId, callbackId } = await seedFiredRun({ singleUse: false });
    const elsewhere = await postgresRunHostStore.leases.claim({ runId, ttlMs: 60_000 });
    const outcome = await fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-20' });
    expect(outcome).toMatchObject({ kind: 'recorded', queued: true });
    // The run ends while the body waits: its callbacks are revoked with it.
    await getAutomationsQb(['trigger_run']).updateTable('trigger_run').set({ status: 'success' }).where('id', '=', runId).execute();
    await revokeRunCallbacks(runId);
    await postgresRunHostStore.leases.release({ runId, token: elsewhere!.token });

    const result = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(result).toMatchObject({ claimed: 1, ran: 1 });
    expect(fireCallbackFiringMock).not.toHaveBeenCalled();
  });

  it('a queued body the ledger says already started never runs again (its row outlived the body)', async () => {
    const { callbackId } = await seedFiredRun({ singleUse: false });
    // The mark is on the ledger before the body begins.
    let markedBeforeBody: string | undefined;
    fireCallbackFiringMock.mockImplementation(async () => {
      markedBeforeBody = (await getCallback(callbackId))?.calls[0]?.bodyStartedAt;
      return { result: { movementName: 'book_it' } };
    });
    await fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-20', awaitExecution: true });
    expect(fireCallbackFiringMock).toHaveBeenCalledTimes(1);
    expect(markedBeforeBody).toEqual(expect.any(String));
    expect((await getCallback(callbackId))?.calls[0]?.bodyStartedAt).toEqual(expect.any(String));

    // The crash window: the body started (and maybe committed), the row did not complete.
    await enqueueWork({
      kind: 'fire_callback',
      key: `fire_callback:${callbackId}:0`,
      teamId,
      payload: { callbackId, teamId, callIndex: 0 },
    });
    const result = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(result).toMatchObject({ claimed: 1, ran: 1 });
    expect(fireCallbackFiringMock).toHaveBeenCalledTimes(1);
    expect((await getCallback(callbackId))?.status).toBe('live');
  });

  it('a queued body whose lease is lost before it starts re-queues, unmarked, and the next holder runs it once', async () => {
    const { runId, callbackId } = await seedFiredRun({ singleUse: false });
    const elsewhere = await postgresRunHostStore.leases.claim({ runId, ttlMs: 60_000 });
    expect(await fireCallback({ id: callbackId, values: {}, suppliedValue: '2026-08-20' })).toMatchObject({
      queued: true,
    });
    await postgresRunHostStore.leases.release({ runId, token: elsewhere!.token });
    fireCallbackFiringMock.mockResolvedValue({ result: { movementName: 'book_it' } });

    // Between the row taking the lease and the body starting, another
    // instance takes the run over.
    const realMark = callbackStore.markCallbackBodyStarted;
    const mark = jest.spyOn(callbackStore, 'markCallbackBodyStarted').mockImplementationOnce(async (input) => {
      await getAutomationsQb(['trigger_run'])
        .updateTable('trigger_run')
        .set({ lease_token: randomUUID(), lease_owner: 'the-new-holder' })
        .where('id', '=', runId)
        .execute();
      return realMark(input);
    });
    const lost = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    mark.mockRestore();

    expect(lost).toMatchObject({ claimed: 1, deferred: 1 });
    expect(fireCallbackFiringMock).not.toHaveBeenCalled();
    expect((await getCallback(callbackId))?.calls[0]?.bodyStartedAt).toBeUndefined();
    const rows = await getAutomationsQb(['work'])
      .selectFrom('work')
      .where('key', '=', `fire_callback:${callbackId}:0`)
      .select('lease_until')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lease_until).toBeNull();

    // The new holder lets go; the row, due again, runs the body once.
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ lease_token: null, lease_owner: null, lease_until: null })
      .where('id', '=', runId)
      .execute();
    await getAutomationsQb(['work'])
      .updateTable('work')
      .set({ due_at: new Date(Date.now() - 1_000) })
      .where('key', '=', `fire_callback:${callbackId}:0`)
      .execute();
    const ran = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(ran).toMatchObject({ claimed: 1, deferred: 0, failed: 0 });
    expect(fireCallbackFiringMock).toHaveBeenCalledTimes(1);
    expect((await getCallback(callbackId))?.calls[0]?.bodyStartedAt).toEqual(expect.any(String));
  });

  it('a queued body whose callback is gone finds nothing to do', async () => {
    await enqueueWork({
      kind: 'fire_callback',
      key: `fire_callback:cb_gone:0`,
      teamId,
      payload: { callbackId: 'cb_gone', teamId, callIndex: 0 },
    });
    const result = await drainWork({ owner: 'drain-1', teamId, heartbeatMs: false });
    expect(result).toMatchObject({ claimed: 1, ran: 1 });
    expect(fireCallbackFiringMock).not.toHaveBeenCalled();
  });
});
