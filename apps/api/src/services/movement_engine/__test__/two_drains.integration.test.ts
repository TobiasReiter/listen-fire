// Two automations instances on one database, with no lock between them. Each
// "process" is the drain and the resume driver loaded afresh — its own work
// handlers, its own in-process slot, its own lease owner, its own pool — so the
// only thing they share is Postgres, exactly as two API instances do.
//
//   · Two wakes of one parked run, drained by both at once, resume it once:
//     whichever takes the run's lease steps it, the other's wake row defers,
//     and the deferred row later finds nothing left to resume.
//   · Two external ticks at once never run one periodic kind twice: the work
//     table's SKIP LOCKED claim hands each row to one of them.
//
// Only the engine step is stubbed, so the test can count resumes and hold one
// open while the other process arrives.

import { randomUUID } from 'node:crypto';

const resumeMovementFiringMock = jest.fn();
jest.mock('../../translation_graph/movement/execute', () => ({
  ...jest.requireActual('../../translation_graph/movement/execute'),
  resumeMovementFiring: (input: unknown) => resumeMovementFiringMock(input),
}));

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import { getAutomationsQb, getCoreQb, getQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../generated/kysely/public/PipelineConfiguration';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';
import { enqueueAwaitWake } from '../await_wake';
import { ensurePeriodicWork } from '../../work/store';
import { postgresRunHostStore } from '../run_host_store';

type Drain = typeof import('../../work/drain');
type AwaitResume = typeof import('../await_resume');

interface Process {
  drain: Drain;
}

/** One instance: the drain with the await driver registered on it, or with
 *  `periodic` as the handler of the timer sweep. */
function startProcess(options: { periodic?: () => Promise<void> } = {}): Process {
  let drain: Drain | undefined;
  jest.isolateModules(() => {
    drain = jest.requireActual<Drain>('../../work/drain');
    const awaits = jest.requireActual<AwaitResume>('../await_resume');
    drain.setWorkNotifier({ notify() {} });
    awaits.registerAwaitWork();
    if (options.periodic) drain.registerWorkHandler('timer_sweep', { run: options.periodic });
  });
  if (drain === undefined) throw new Error('test: the process did not load');
  return { drain };
}

const SOURCE = 'go = manual()';
const ADDRESS = 's0.await';
const ADAPTER = 'slack';

let teamId: TeamId;
let triggerId: TriggerId;
let movementVersionId: string;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `two-drains-${teamId.slice(0, 8)}` } as any)
    .execute();
  const pipelineConfigurationId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: pipelineConfigurationId, team_id: teamId, name: `cfg-${pipelineConfigurationId.slice(0, 8)}` } as any)
    .execute();
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: teamId, name: 'wait_for_reply', source: SOURCE } as any)
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
      content_hash: 'two-drains-fixture',
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
      name: 'Wait for reply',
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

beforeEach(async () => {
  resumeMovementFiringMock.mockReset();
  await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
});

/** A run parked on a reply in a thread, as `commitAwaitPark` leaves it. */
async function runParkedOnReply(): Promise<{ runId: TriggerRunId; correlationKey: string }> {
  const recorder = new TriggerRunRecorder({
    teamId,
    triggerId,
    triggerType: 'webhook',
    triggerEvent: {
      pipelineInputId: 'trigger:two-drains',
      adapterType: 'webhook',
      triggerType: 'webhook',
      payload: {},
    } as TriggerEvent,
    movementVersionId,
  });
  await recorder.ensureStarted();
  const runId = recorder.triggerRunId;
  await getAutomationsQb(['trigger_run']).updateTable('trigger_run').set({ status: 'parked' }).where('id', '=', runId).execute();
  await getAutomationsQb(['parked_run'])
    .insertInto('parked_run')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      run_id: runId,
      address: ADDRESS,
      status: 'parked',
      park_reason: 'await',
      state: JSON.stringify({ version: 1, address: ADDRESS, bindingName: null, scopeChain: [{ bindings: {} }] }),
    } as any)
    .execute();
  const correlationKey = `C1:${randomUUID()}`;
  await postgresRunHostStore.correlations.correlate({ adapterType: ADAPTER, correlationKey, runId, teamId, address: ADDRESS });
  return { runId, correlationKey };
}

async function wakeTwice(correlationKey: string): Promise<void> {
  await enqueueAwaitWake({ adapterType: ADAPTER, teamId, correlationKey });
  await enqueueAwaitWake({ adapterType: ADAPTER, teamId, correlationKey });
}

async function parkedLeaves(runId: TriggerRunId): Promise<unknown[]> {
  return getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId).select(['address', 'status']).execute();
}

async function wakeRows() {
  return getAutomationsQb(['work'])
    .selectFrom('work')
    .where('team_id', '=', teamId)
    .where('kind', '=', 'wake_await')
    .select(['key', 'due_at', 'lease_until', 'attempts'])
    .execute();
}

async function makeWakesDue(): Promise<void> {
  await getAutomationsQb(['work'])
    .updateTable('work')
    .set({ due_at: new Date(Date.now() - 1_000) })
    .where('team_id', '=', teamId)
    .execute();
}

describe('two instances wake one parked run at once', () => {
  it('one resumes it while it holds the lease; the other defers, and its retry finds nothing left', async () => {
    const { runId, correlationKey } = await runParkedOnReply();
    await wakeTwice(correlationKey);
    const a = startProcess();
    const b = startProcess();

    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered: () => void = () => {};
    const stepping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    resumeMovementFiringMock.mockImplementation(async () => {
      entered();
      await held;
      return { result: { parked: false } };
    });

    // A claims one wake and is mid-step, holding the run; B claims the other.
    const first = a.drain.drainWork({ owner: 'instance-a', teamId, limit: 1, heartbeatMs: false });
    await stepping;
    expect(await parkedLeaves(runId)).toEqual([{ address: ADDRESS, status: 'resuming' }]);
    const second = await b.drain.drainWork({ owner: 'instance-b', teamId, limit: 1, heartbeatMs: false });
    expect(second).toMatchObject({ claimed: 1, deferred: 1, ran: 0, failed: 0 });

    finish();
    expect(await first).toMatchObject({ claimed: 1, ran: 1, deferred: 0 });
    expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
    expect(await parkedLeaves(runId)).toEqual([]);
    const lease = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId)
      .select('lease_token')
      .executeTakeFirstOrThrow();
    expect(lease.lease_token).toBeNull();

    // B's row backed off and is still there; once due it resumes nothing.
    const [deferred] = await wakeRows();
    expect(deferred?.lease_until).toBeNull();
    await makeWakesDue();
    const retry = await b.drain.drainWork({ owner: 'instance-b', teamId, heartbeatMs: false });
    expect(retry.claimed).toBe(1);
    expect(retry.failed + retry.deferred).toBe(0);
    expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
    expect(await wakeRows()).toEqual([]);
  });

  it('drained truly at once, round after round, every run is resumed exactly once', async () => {
    const a = startProcess();
    const b = startProcess();
    resumeMovementFiringMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { result: { parked: false } };
    });
    for (let round = 0; round < 5; round++) {
      resumeMovementFiringMock.mockClear();
      const { runId, correlationKey } = await runParkedOnReply();
      await wakeTwice(correlationKey);

      await Promise.all([
        a.drain.drainWork({ owner: 'instance-a', teamId, limit: 1, heartbeatMs: false }),
        b.drain.drainWork({ owner: 'instance-b', teamId, limit: 1, heartbeatMs: false }),
      ]);
      // Whatever deferred, retried until the queue is empty.
      for (let pass = 0; pass < 5 && (await wakeRows()).length > 0; pass++) {
        await makeWakesDue();
        await Promise.all([
          a.drain.drainWork({ owner: 'instance-a', teamId, heartbeatMs: false }),
          b.drain.drainWork({ owner: 'instance-b', teamId, heartbeatMs: false }),
        ]);
      }

      expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
      expect(resumeMovementFiringMock).toHaveBeenCalledWith(expect.objectContaining({ runId }));
      expect(await parkedLeaves(runId)).toEqual([]);
      expect(await wakeRows()).toEqual([]);
    }
  });
});

describe('two external ticks at once', () => {
  it('never run one periodic kind twice', async () => {
    let runs = 0;
    let concurrent = 0;
    let overlapped = false;
    const periodic = async (): Promise<void> => {
      runs += 1;
      concurrent += 1;
      if (concurrent > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrent -= 1;
    };
    const a = startProcess({ periodic });
    const b = startProcess({ periodic });
    await ensurePeriodicWork({ kind: 'timer_sweep', key: 'timer_sweep', intervalMs: 30_000 });
    await getAutomationsQb(['work'])
      .updateTable('work')
      .set({ due_at: new Date(Date.now() - 1_000), lease_until: null, lease_token: null, lease_owner: null })
      .where('key', '=', 'timer_sweep')
      .execute();

    const ticks = await Promise.all([
      a.drain.drainUntilIdle({ owner: `http:${randomUUID()}`, heartbeatMs: false }),
      b.drain.drainUntilIdle({ owner: `http:${randomUUID()}`, heartbeatMs: false }),
    ]);

    expect(runs).toBe(1);
    expect(overlapped).toBe(false);
    expect(ticks.map((tick) => tick.claimFailed)).toEqual([false, false]);
    const row = await getAutomationsQb(['work'])
      .selectFrom('work')
      .where('key', '=', 'timer_sweep')
      .select(['due_at', 'lease_until'])
      .executeTakeFirstOrThrow();
    // Ran once, and rescheduled an interval on.
    expect(row.lease_until).toBeNull();
    expect(row.due_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });
});
