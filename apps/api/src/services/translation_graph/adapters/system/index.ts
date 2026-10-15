// System adapter — the platform itself as a system an automation can listen to.
//
//   sys = system()
//   listen to sys { events: ["Run Failed"] } fire `Report Failure`
//
// Read-only and credential-free: nothing is written here and nothing is
// enumerated — the platform's events are DELIVERED, one fires edge per kind,
// each landing on a record with the same fields (types.ts). Event production
// lives on the poll source (poll.ts), which reads what the platform already
// records: it only emits what the engine and the deploy check already know.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter, AdapterManifest, EdgesFromResult, EventType } from 'movement-engine/services/translation_graph/adapter';
import type {
  SchemaEntryPoint,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/services/translation_graph/types';

import { uniformWalk } from '../hop';
import { META_RECORD_TYPE, positionData } from 'movement-engine/services/translation_graph/types';
import { BaseAdapter } from '../base';
import { SYSTEM_HANDBOOK_SECTION } from './handbook_section';
import {
  RUN_FAILED,
  SYSTEM_ADAPTER_TYPE,
  SYSTEM_EVENT_KINDS,
  SYSTEM_SUBSCRIBABLE_EVENTS,
  type SystemEventKind,
} from './types';

export { SYSTEM_ADAPTER_TYPE } from './types';

export const SYSTEM_MANIFEST: AdapterManifest = {
  adapterType: SYSTEM_ADAPTER_TYPE,
  displayName: 'Listen-Fire',
  description:
    'The platform itself, as a source. An automation listening to it runs when ' +
    'another automation fails — post the failure to Slack, open a ticket. Built ' +
    'in; nothing to connect.',
  authoringHints:
    'Every event carries `Automation`, `Automation Id`, `Run Id`, `Version`, ' +
    '`Reason`, `Url` and `At`. `Run Failed` is delivered as runs fail; ' +
    '`Validation Issue`, `Deprecated Version` and `Release Applied` as a new ' +
    'release is deployed. An automation is never told about its own failures.',
  handbookSection: SYSTEM_HANDBOOK_SECTION,
  triggerExpectation:
    'Fires on the platform’s own events, selected with `events`. `Run Failed` ' +
    '(the default) fires once per run of ANOTHER automation in this workspace ' +
    'that ends failed, within a couple of minutes — never for the listening ' +
    'automation’s own runs, and never for a rehearsal. `Validation Issue` and ' +
    '`Deprecated Version` fire once per affected automation, and `Release Applied` ' +
    'once per workspace, each time a new release is deployed. The first poll sets ' +
    'the mark and emits nothing, so going live never replays past events.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'listEventTypes'],
  subscribableEvents: [...SYSTEM_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [RUN_FAILED.displayName],
  listenConfig: [{ key: 'pollIntervalSeconds', required: false }],
  vocabulary: {
    // A built-in owns no brand, but it still owns a mark (see the manual
    // adapter). A pulse line: the platform's own heartbeat.
    icon: {
      d: 'M3 12 H8 L10 7 L14 17 L16 12 H21',
      fill: false,
    },
    eventPhrase: {
      default: [{ template: 'When another automation’s run fails' }],
    },
  },
};

/** The one record shape every kind lands on. */
function systemEventDescriptor(kind: SystemEventKind): SchemaTypeDescriptor {
  return {
    typeId: kind.typeId,
    displayName: kind.displayName,
    description: kind.description,
    fields: [
      { fieldId: 'automation', displayName: 'Automation', kind: 'string', writable: false, required: true, description: 'The name of the automation the event is about.' },
      { fieldId: 'automationId', displayName: 'Automation Id', kind: 'string', writable: false, required: true, description: 'That automation’s id.' },
      { fieldId: 'runId', displayName: 'Run Id', kind: 'string', writable: false, required: true, description: 'The run the event is about; empty when it concerns no run.' },
      { fieldId: 'version', displayName: 'Version', kind: 'string', writable: false, required: true, description: 'The name of the language version involved; empty when none is.' },
      { fieldId: 'reason', displayName: 'Reason', kind: 'string', writable: false, required: true, description: 'What happened, in words — for a failed run, why it failed.' },
      { fieldId: 'url', displayName: 'Url', kind: 'string', writable: false, required: true, description: 'A link into the app: the automation’s failed runs, or the automation itself.' },
      { fieldId: 'at', displayName: 'At', kind: 'date', writable: false, required: true, description: 'When it happened (UTC).' },
    ],
    references: [],
  };
}

/** The root's edge for one kind: fired along, never read or written. */
function firesEdge(kind: SystemEventKind): SchemaReferenceDescriptor {
  return {
    fieldId: kind.typeId,
    targetTypeId: kind.typeId,
    cardinality: 'one',
    direction: 'outgoing',
    name: kind.displayName,
    fires: true,
    firesOn: [kind.displayName],
    readable: false,
    writable: false,
    description: kind.description,
  };
}

export class SystemAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = SYSTEM_ADAPTER_TYPE;
  readonly supportedTriggers = SYSTEM_MANIFEST.supportedTriggers;

  // teamId is accepted for parity with other adapters; the read side is
  // static — the team scoping lives on the poll source.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly teamId: TeamId) {
    super();
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // Nothing enumerates the platform's events — each is DELIVERED — so every
    // entry is a fires edge and none is readable or writable.
    return SYSTEM_EVENT_KINDS.map((kind) => ({
      typeId: kind.typeId,
      displayName: kind.displayName,
      writable: false,
      readable: false,
      fires: true,
      firesOn: [kind.displayName],
    }));
  }

  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Listen-Fire',
    description:
      'The platform itself. Nothing here can be listed or written — its events ' +
      'are delivered, and each edge leaving here is one a listen subscribes to.',
    fields: [],
    references: SYSTEM_EVENT_KINDS.map(firesEdge),
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: SYSTEM_ADAPTER_TYPE,
      at: position,
      root: SystemAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    const kind = SYSTEM_EVENT_KINDS.find((k) => k.typeId === typeId);
    return kind ? systemEventDescriptor(kind) : null;
  }

  async getFieldValue(input: { position: SourcePosition; fieldId: string }): Promise<unknown> {
    if (input.position.adapterType !== SYSTEM_ADAPTER_TYPE) {
      throw new Error(
        `SystemAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    return data[fieldId] ?? null;
  }

  /** The poll source tags every event it produces, so discrimination is by tag
   *  alone — which edge a listen is on, never a sniff of the payload. */
  async listEventTypes(): Promise<EventType[]> {
    return SYSTEM_EVENT_KINDS.map((kind) => ({ tag: kind.tag, positionType: kind.typeId }));
  }
}

/** Factory matching the registry's AdapterFactory signature. */
export function createSystemAdapter(input: { teamId: TeamId }): SystemAdapter {
  return new SystemAdapter(input.teamId);
}
