// Ruling (b), driven through the REAL terminal seams rather than the store's
// own helper: a run that ENDS revokes its outstanding callbacks.
//
// There are two choke points and this pins both, because a callback that
// outlives its run is the whole failure mode ruling (b) exists to prevent:
//   · `TriggerRunRecorder.finish()` — the success / partial / failed terminal;
//   · `failRunAndCancelRequests` — the cancel / abort / unresumable terminal.
//
// ruling (b)

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';

import { getCoreQb } from '../../../lib/kysely';
import { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';
import { failRunAndCancelRequests } from '../../interaction/run_failure';
import { claimCallbackFire, getCallback, mintCallback } from '../callback_store';
import { cleanupTeam } from '../../../test/harness/cleanup';

let teamId: TeamId;

const STATE: ParkedScopeState = {
  version: 1,
  address: 's0',
  bindingName: null,
  scopeChain: [{ bindings: {} }],
};

function makeEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:callback-revocation',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: { hello: 'world' },
  } as TriggerEvent;
}

async function mintFor(runId: TriggerRunId) {
  return mintCallback({
    teamId,
    runId,
    address: 's0',
    params: [],
    state: STATE,
    singleUse: true,
  });
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `callback-revoke-${teamId.slice(0, 8)}` } as any)
    .execute();
});

afterAll(async () => {
  await cleanupTeam(teamId);
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

describe('a run reaching its end revokes its outstanding callbacks', () => {
  it('finish() — the success terminal — revokes them', async () => {
    const recorder = new TriggerRunRecorder({
      teamId,
      triggerId: 'callback-revocation-trigger',
      triggerType: 'webhook',
      triggerEvent: makeEvent(),
    });
    await recorder.ensureStarted();
    const record = await mintFor(recorder.triggerRunId);
    expect((await getCallback(record.id))?.status).toBe('live');

    await recorder.finish();

    expect((await getCallback(record.id))?.status).toBe('revoked');
    // And a late tap gets the closed-request-wins ack, not an error.
    expect((await claimCallbackFire({ id: record.id, values: {} })).kind).toBe('closed');
  });

  it('failRunAndCancelRequests — the cancel / unresumable terminal — revokes them', async () => {
    const recorder = new TriggerRunRecorder({
      teamId,
      triggerId: 'callback-revocation-trigger',
      triggerType: 'webhook',
      triggerEvent: makeEvent(),
    });
    await recorder.ensureStarted();
    const record = await mintFor(recorder.triggerRunId);

    await failRunAndCancelRequests({
      runId: recorder.triggerRunId,
      message: 'Cancelled by an operator',
    });

    expect((await getCallback(record.id))?.status).toBe('revoked');
  });

  it('a callback FIRED before the run ended keeps its `fired` ending', async () => {
    const recorder = new TriggerRunRecorder({
      teamId,
      triggerId: 'callback-revocation-trigger',
      triggerType: 'webhook',
      triggerEvent: makeEvent(),
    });
    await recorder.ensureStarted();
    const record = await mintFor(recorder.triggerRunId);
    await claimCallbackFire({ id: record.id, values: {} });

    await recorder.finish();

    const after = await getCallback(record.id);
    expect(after?.status).toBe('fired');
    expect(after?.revokedAt).toBeNull();
  });
});
