// A parked state names its contract version, and every entry that reads one
// back (a resume, a race settlement, a callback body) checks it before it
// rehydrates anything: a version this release does not read is refused,
// loudly, on either engine.

import { tenantIdOf } from 'engine-contracts';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { ParkedScopeState } from 'movement-engine/services/movement_engine/serialize';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame } from 'movement-engine/services/movement_engine/run';
import { makeFakeParkSink, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000078');
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

const SOURCE = `import { manual } from adapters
runs = manual()
movement nap(go: <runs-[:Invocation]->>) {
  await sleep(1h)
  x = 1
}
listen to runs {} fire nap
`;

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-park-state-version',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-05T09:00:00.000Z' },
    occurredAt: '2026-10-05T09:00:00.000Z',
  };
}

function runInput() {
  const resolved: string[] = [];
  const park = makeFakeParkSink();
  const input = {
    source: SOURCE,
    event: manualEvent(),
    teamId: TEAM_ID,
    catalog: staticCatalogSnapshot({}),
    movementName: 'nap',
    firedAt: '2026-10-05T09:00:00.000Z',
    host: makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          resolved.push(adapterType);
          if (adapterType === 'manual') return manualAdapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
      park: { sink: park.sink },
    }),
  };
  return { input, park, resolved };
}

async function parkedState(): Promise<ParkedScopeState> {
  const { input, park } = runInput();
  const result = await runMovement(input);
  expect(result.parked).toBe(true);
  const [timer] = park.timerParks;
  if (timer === undefined) throw new Error('test: the run did not park on its timer');
  // Round-tripped through JSON as a host's store hands it back, which is also
  // how a state from some other release would arrive: untyped.
  return JSON.parse(JSON.stringify(timer.state));
}

async function statesOfEachVersion(): Promise<{ current: ParkedScopeState; future: ParkedScopeState }> {
  const current = await parkedState();
  return { current, future: JSON.parse(JSON.stringify({ ...current, version: 2 })) };
}

const REFUSAL = 'the parked state carries park state version 2, which this release does not read (supported: 1)';

describe.each(['ts', 'rust'] as const)('a parked state of a version this release does not read (%s engine)', (engine) => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.MOVEMENT_ENGINE;
    process.env.MOVEMENT_ENGINE = engine;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  });

  it('is refused by a resume before anything is rehydrated, while version 1 resumes', async () => {
    const { current, future } = await statesOfEachVersion();
    const refused = runInput();
    await expect(resumeMovement({ ...refused.input, state: future })).rejects.toThrow(REFUSAL);
    expect(refused.resolved).toEqual([]);

    const resumed = await resumeMovement({ ...runInput().input, state: current });
    expect(resumed.parked).toBeUndefined();
  });

  it('is refused by a race settlement before anything is rehydrated', async () => {
    const { future } = await statesOfEachVersion();
    const refused = runInput();
    await expect(settleRaceFrame({ ...refused.input, state: future, frameAddress: 's0' })).rejects.toThrow(REFUSAL);
    expect(refused.resolved).toEqual([]);
  });

  it('is refused by a callback body before anything is rehydrated', async () => {
    const { future } = await statesOfEachVersion();
    const refused = runInput();
    await expect(fireCallbackBody({ ...refused.input, state: future, values: {}, callIndex: 0 })).rejects.toThrow(
      REFUSAL,
    );
    expect(refused.resolved).toEqual([]);
  });
});
