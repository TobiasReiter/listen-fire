// A closed ask wakes the run parked on it, against a real DB.
//
// An answer and a cancel each queue their own wake at their door. The ask
// service's periodic closed sweep is the safety net behind both: it finds a
// closed ask a run is still parked on (its wake was lost) and queues the same
// `wake_await` row. Sweep → row → drain → the run re-enters its await, which
// reads the ask through the real adapter. Only the engine step itself is
// stubbed, so the test can see what the re-entered await got back. Store-level
// transitions stand in for a door whose wake was lost.

import { randomUUID } from 'node:crypto';

const resumeMovementFiringMock = jest.fn();
jest.mock('../../../movement/execute', () => ({
  ...jest.requireActual('../../../movement/execute'),
  resumeMovementFiring: (input: unknown) => resumeMovementFiringMock(input),
}));

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../../../generated/kysely/automations/TriggerRun';
import type { MovementId } from '../../../../../generated/kysely/automations/Movement';
import type { PipelineConfigurationId } from '../../../../../generated/kysely/public/PipelineConfiguration';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { AwaitResolution } from 'movement-engine/services/translation_graph/awaitable';

import { testWorkContext } from '../../../../../test/harness/work';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { getAutomationsQb, getCoreQb, getQb } from '../../../../../lib/kysely';
import { TriggerRunRecorder } from '../../../runs/trigger_run';
import { registerAwaitWork } from '../../../../movement_engine/await_resume';
import { enqueueAwaitWake } from '../../../../movement_engine/await_wake';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../../work/drain';
import { loadCorrelatedParks, registerAwaitCorrelation } from '../../await_correlation';
import { askClosedSweepHandler, registerAskClosedSweepWork } from '../closed_sweep';
import { cancelAskAndWake } from '../answer_door';
import { notifyEngineOfSettledAsks } from '../../../../asks/in_process_notifier';
import { resetAskSettledNotifierForTests } from '../notifier';
import { AskAdapter } from '../index';
import { ASK_ADAPTER_TYPE } from '../type';
import { answerAsk, cancelAsk, createAsk, type AskRecord } from '../store';

const SOURCE = 'go = manual()';
const ADDRESS = 'await-ask';

let teamId: TeamId;
let triggerId: TriggerId;
let movementVersionId: string;

beforeAll(async () => {
  resetWorkHandlersForTests();
  registerAwaitWork();
  registerAskClosedSweepWork();
  // The test drains explicitly.
  setWorkNotifier({ notify() {} });

  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `ask-expiry-${teamId.slice(0, 8)}` } as any)
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
    .values({ id: movementId, team_id: teamId, name: 'ask_then_wait', source: SOURCE } as any)
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
      content_hash: 'ask-expiry-fixture',
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
      name: 'Ask then wait',
      kind: 'webhook',
      movement_id: movementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();
});

afterAll(async () => {
  resetAskSettledNotifierForTests();
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await cleanupTeam(teamId);
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

beforeEach(async () => {
  resumeMovementFiringMock.mockReset();
  // The team is shared across cases; each starts with an empty queue.
  await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
});

/** A live run parked on an open ask, exactly as `commitAwaitPark` leaves it. */
async function runParkedOnAsk(): Promise<{ runId: TriggerRunId; ask: AskRecord }> {
  const recorder = new TriggerRunRecorder({
    teamId,
    triggerId,
    triggerType: 'webhook',
    triggerEvent: {
      pipelineInputId: 'trigger:ask-expiry',
      adapterType: 'webhook',
      triggerType: 'webhook',
      payload: {},
    } as TriggerEvent,
    movementVersionId,
  });
  await recorder.ensureStarted();
  const runId = recorder.triggerRunId;
  const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?', provenance: { runId } });
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
  await registerAwaitCorrelation({ adapterType: ASK_ADAPTER_TYPE, correlationKey: ask.id, runId, teamId, address: ADDRESS });
  return { runId, ask };
}

async function wakeRows(): Promise<unknown[]> {
  const rows = await getAutomationsQb(['work'])
    .selectFrom('work')
    .where('team_id', '=', teamId)
    .where('kind', '=', 'wake_await')
    .select('payload')
    .execute();
  return rows.map((row) => row.payload);
}

async function sweep(): Promise<void> {
  await askClosedSweepHandler.run({}, testWorkContext());
}

/** The re-entered await: read the ask through the real adapter, as the engine's
 *  await does, and complete the branch. */
function awaitReadsTheAsk(askId: string, seen: AwaitResolution[]): void {
  resumeMovementFiringMock.mockImplementation(async () => {
    seen.push(await new AskAdapter(teamId).awaitable.resolveAwait({ recordId: askId, edge: 'Response' }));
    return { result: { parked: false } };
  });
}

describe('a closed ask wakes the run parked on it', () => {
  it('an expired ask: sweep → a wake row → draining resumes the run, and the await resolves empty', async () => {
    const { runId, ask } = await runParkedOnAsk();
    const seen: AwaitResolution[] = [];
    awaitReadsTheAsk(ask.id, seen);

    // Still open: nothing to wake.
    await sweep();
    expect(await wakeRows()).toEqual([]);

    await cancelAsk({ id: ask.id });
    // Two overlapping sweeps before the drain gets there fold onto one row.
    await sweep();
    await sweep();
    expect(await wakeRows()).toEqual([{ adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: ask.id }]);
    expect(resumeMovementFiringMock).not.toHaveBeenCalled();

    await drainUntilIdle({ owner: 'test', teamId });

    expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
    expect(resumeMovementFiringMock).toHaveBeenCalledWith(expect.objectContaining({ runId, reenter: true }));
    expect(seen).toEqual([{ status: 'empty' }]);
    expect(await loadCorrelatedParks({ adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: ask.id })).toEqual([]);
    const park = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .where('address', '=', ADDRESS)
      .select('id')
      .executeTakeFirst();
    expect(park).toBeUndefined();
    expect(await wakeRows()).toEqual([]);

    // Once woken the ask drops out of the sweep, and a stray wake for the
    // already-resumed key drives nothing.
    await sweep();
    expect(await wakeRows()).toEqual([]);
    await enqueueAwaitWake({ adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: ask.id });
    await drainUntilIdle({ owner: 'test', teamId });
    expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
  });

  it('an answered ask whose wake was lost (no notifier) gets exactly one wake row', async () => {
    const { ask } = await runParkedOnAsk();
    // The bare lattice transition, without the door's notifier: the wake an
    // answer would have queued never was.
    expect((await answerAsk({ id: ask.id, raw: 'true' })).ok).toBe(true);
    expect(await wakeRows()).toEqual([]);

    await sweep();
    await sweep();
    expect(await wakeRows()).toEqual([{ adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: ask.id }]);
  });

  it('the cancel door queues the wake itself, before any sweep', async () => {
    // The composed deployment's wiring: the engine is here to be woken.
    notifyEngineOfSettledAsks();
    const { ask } = await runParkedOnAsk();
    const seen: AwaitResolution[] = [];
    awaitReadsTheAsk(ask.id, seen);

    expect((await cancelAskAndWake({ id: ask.id })).ok).toBe(true);
    expect(await wakeRows()).toEqual([{ adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: ask.id }]);

    await drainUntilIdle({ owner: 'test', teamId });
    expect(seen).toEqual([{ status: 'empty' }]);
    expect(await loadCorrelatedParks({ adapterType: ASK_ADAPTER_TYPE, teamId, correlationKey: ask.id })).toEqual([]);
  });
});
