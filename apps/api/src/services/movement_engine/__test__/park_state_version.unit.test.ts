// A parked state names its contract version, and every entry that reads one
// back (a resume, a race settlement, a callback body) checks it before it
// rehydrates anything. Each engine reads its own version: the TypeScript
// engine (language versions 1–4) writes and reads 1, the Rust engine (5 on)
// writes and reads 2. A version neither reads, or the other engine's, is
// refused loudly.

import { tenantIdOf, type AnyParkedScopeState } from 'engine-contracts';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { teamOfTenant } from '../../translation_graph/movement/tenant';
import { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame } from 'movement-engine/services/movement_engine/run';
import { makeFakeParkSink, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000078');
const manualAdapter = createManualAdapter({ teamId: teamOfTenant(TEAM_ID) });

/** The same flow as each engine's language version spells it. */
const SOURCES = {
  4: `import { manual } from adapters
runs = manual()
movement nap(go: <runs-[:Invocation]->>) {
  await sleep(1h)
  x = 1
}
listen to runs {} fire nap
`,
  5: `import { manual } from adapters
runs = connect manual
function nap(go: <runs-[:Invocation]->>) {
  await sleep(1h)
  x = 1
}
listen to runs {} fire nap
`,
} as const;

type Pin = keyof typeof SOURCES;

function manualEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:manual-park-state-version',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-05T09:00:00.000Z' },
    occurredAt: '2026-10-05T09:00:00.000Z',
  };
}

function runInput(languageVersion: Pin) {
  const resolved: string[] = [];
  const park = makeFakeParkSink();
  const input = {
    source: SOURCES[languageVersion],
    languageVersion,
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

async function parkedState(languageVersion: Pin): Promise<AnyParkedScopeState> {
  const { input, park } = runInput(languageVersion);
  const result = await runMovement(input);
  expect(result.parked).toBe(true);
  const [timer] = park.timerParks;
  if (timer === undefined) throw new Error('test: the run did not park on its timer');
  // Round-tripped through JSON as a host's store hands it back, which is also
  // how a state from some other release would arrive: untyped.
  return JSON.parse(JSON.stringify(timer.state));
}

/** `state` restamped as another version, as a state from elsewhere arrives. */
const restamped = (state: AnyParkedScopeState, version: number): AnyParkedScopeState =>
  JSON.parse(JSON.stringify({ ...state, version }));

const UNREAD = 'the parked state carries park state version 3, which this release does not read (supported: 1, 2)';

/** Each pin, the version its engine writes, and how it refuses the other's. */
const ENGINES = [
  {
    pin: 4,
    engine: 'TypeScript',
    writes: 1,
    other: 2,
    refusal: 'the parked state carries park state version 2, which only the Rust engine reads (the TypeScript engine reads version 1)',
  },
  {
    pin: 5,
    engine: 'Rust',
    writes: 2,
    other: 1,
    refusal: "this run's parked state does not read (resume_state_version)",
  },
] as const;

describe.each(ENGINES)('a parked state on the $engine engine (language version $pin)', ({ pin, writes, other, refusal }) => {
  it(`is written as version ${writes}, and resumes`, async () => {
    const current = await parkedState(pin);
    expect(current.version).toBe(writes);
    const resumed = await resumeMovement({ ...runInput(pin).input, state: current });
    expect(resumed.parked).toBeUndefined();
  });

  it("refuses the other engine's version on a resume, before anything is rehydrated", async () => {
    const state = restamped(await parkedState(pin), other);
    const refused = runInput(pin);
    await expect(resumeMovement({ ...refused.input, state })).rejects.toThrow(refusal);
    expect(refused.resolved).toEqual([]);
  });

  it('refuses a version this release does not read on a resume, before anything is rehydrated', async () => {
    const state = restamped(await parkedState(pin), 3);
    const refused = runInput(pin);
    await expect(resumeMovement({ ...refused.input, state })).rejects.toThrow(UNREAD);
    expect(refused.resolved).toEqual([]);
  });

  it('refuses a version this release does not read on a race settlement, before anything is rehydrated', async () => {
    const state = restamped(await parkedState(pin), 3);
    const refused = runInput(pin);
    await expect(settleRaceFrame({ ...refused.input, state, frameAddress: 's0' })).rejects.toThrow(UNREAD);
    expect(refused.resolved).toEqual([]);
  });

  it('refuses a version this release does not read on a callback body, before anything is rehydrated', async () => {
    const state = restamped(await parkedState(pin), 3);
    const refused = runInput(pin);
    await expect(fireCallbackBody({ ...refused.input, state, values: {}, callIndex: 0 })).rejects.toThrow(UNREAD);
    expect(refused.resolved).toEqual([]);
  });
});
