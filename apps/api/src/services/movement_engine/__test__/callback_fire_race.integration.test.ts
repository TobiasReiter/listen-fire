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
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { ParkedScopeState } from '../serialize';

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
import { getCallback, mintCallback } from '../callback_store';

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
async function seedFiredRun(): Promise<{ runId: TriggerRunId; callbackId: string }> {
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
    singleUse: true,
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
