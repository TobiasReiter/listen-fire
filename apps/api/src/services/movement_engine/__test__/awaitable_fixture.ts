// A movement that writes a request and awaits its `Response`, against a fake
// awaitable adapter whose answers the test scripts one call at a time — enough
// to drive the engine's await site (check, park, re-check after parking, wake)
// without a real ask store or Slack.

import type { InstanceSchema } from 'movement-lang';
import type { Adapter, RuntimeCapabilities, WriteInput } from '../../translation_graph/adapter';
import type { AwaitResolution } from '../../translation_graph/awaitable';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AwaitWakeRequest, EngineHost, Scoped } from '../host';
import type { QueuedWake } from '../host_kit';

import { containerAssociation } from '../../translation_graph/adapter';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { snapshotOverManifests, staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { positionData } from '../../translation_graph/types';
import { makeTestHost } from '../test_host';
import { runMovement, type ParkSink } from '../run';

const AWAITING = 'ask';

const awaitingSchema: InstanceSchema = {
  positions: { 'Check Response': { properties: { Answer: 'boolean' }, edges: {} } },
  collections: { Check: { target: 'Check' } },
  writableRoots: {
    Check: {
      fields: { Prompt: 'text' },
      resultShape: { externalId: 'text', Prompt: 'text' },
      requiredFields: ['Prompt'],
      edges: {
        Response: {
          target: 'Check Response',
          writable: false,
          awaitable: true,
          watchable: true,
          resolvesEmpty: true,
        },
      },
    },
  },
};

const base = staticCatalogFromManifests({ credentials: {} });
const catalog = snapshotOverManifests({
  ...base,
  instantiate: (name: string, args?: Record<string, unknown>) =>
    name === AWAITING ? awaitingSchema : base.instantiate(name, args as never),
});

/** Awaits the request's Response; with `where`, only a landing passing it counts. */
export function awaitingSource(where?: string): string {
  const hop = where === undefined ? '[:Response]' : `[r:Response WHERE ${where}]`;
  return `import { manual, ask } from adapters
runs = manual()
qa = ask()

movement m(go: <runs-[:Invocation]->>) {
  a = write qa-[:Check]-> { Prompt: "Ship it?" }
  r = await FIRST(a-${hop}->)
}
listen to runs {} fire m
`;
}

function caps(): RuntimeCapabilities {
  return { traversal: { incoming: false, edgeProperties: false }, resources: false };
}

/** The awaitable adapter: each `resolveAwait` answers the next scripted
 *  resolution, the last one repeating. A scripted `Error` is thrown instead
 *  (the remote is down for that call). */
export function makeAwaitingAdapter(answers: Array<AwaitResolution | Error>): { adapter: Adapter; checks: number } {
  const state = { checks: 0 };
  const adapter: Adapter = {
    adapterType: AWAITING,
    supportedTriggers: [],
    runtimeCapabilities: caps,
    awaitable: {
      async resolveAwait() {
        const answer = answers[Math.min(state.checks, answers.length - 1)];
        state.checks += 1;
        if (answer === undefined) throw new Error('test: no scripted resolution');
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    async getRelated() {
      return [];
    },
    async createRecord(write: WriteInput) {
      return { adapterType: AWAITING, externalId: 'req-1', recordType: write.recordType, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: AWAITING, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return {
    adapter,
    get checks() {
      return state.checks;
    },
  };
}

export function runAwaiting(input: {
  teamId: TeamId;
  source: string;
  adapter: Adapter;
  parkSink: ParkSink;
  /** The host's wake; absent ⇒ the test host's, which records into `wakes`. */
  wake?: (request: Scoped<AwaitWakeRequest>) => Promise<void>;
  wakes?: QueuedWake[];
  /** Wrap the test host before the run is handed it (the seam guard's JSON
   *  round trip). */
  wrapHost?: (host: EngineHost) => EngineHost;
}) {
  const wrap = input.wrapHost ?? ((host: EngineHost) => host);
  const manual = createManualAdapter({ teamId: input.teamId });
  const event: TriggerEvent = {
    pipelineInputId: 'trigger:manual-await',
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { firedAt: '2026-10-07T09:00:00.000Z' },
    occurredAt: '2026-10-07T09:00:00.000Z',
  };
  return runMovement({
    source: input.source,
    event,
    teamId: input.teamId,
    catalog,
    host: wrap(makeTestHost({
      adapters: {
        resolve: ({ adapterType }: { adapterType: string }) => {
          if (adapterType === 'manual') return manual;
          if (adapterType === AWAITING) return input.adapter;
          throw new Error(`test: no fake adapter for '${adapterType}'`);
        },
      },
      park: { sink: input.parkSink, ...(input.wake !== undefined ? { wake: input.wake } : {}) },
      ...(input.wakes !== undefined ? { wakes: input.wakes } : {}),
    })),
    dryRun: false,
  });
}
