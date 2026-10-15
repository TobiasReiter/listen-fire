// Cron adapter — the time intrinsic. Time collapses into adapters
// (3_syntax_sketch.md "Composition, time, queries, failure"): a movement
// that should run on a schedule constructs a cron instance and listens to
// it —
//
//   timer = cron()
//   listen to timer { schedule: "0 9 * * 1" } fire digest
//
// The schedule is ordinary listen routing config (validated like any
// adapter's — five-field cron, see @listen-fire/shared/cron); the fired
// movement's parameter is the Tick position (`t: <timer-[:Tick]->>`). An
// optional `timezone` (IANA id, e.g. `Europe/London`) interprets the
// schedule as local wall-clock time with DST handled automatically —
//
//   listen to timer { schedule: "0 9 * * 1", timezone: "Europe/London" }
//
// Absent ⇒ UTC.
//
// Source-only and credential-free: there is no external system. Events
// are emitted by the platform's own movement scheduler
// (services/movement_scheduler/worker.ts), which scans the cron-derived
// trigger rows and dispatches a tick through the normal trigger path —
// uniform dispatch, uniform trigger_run recording.
//
// `ensureEventSubscription` exists so cron provisioning rides the SAME
// listen-reconciliation seam external webhooks ride (listen_subscriptions
// diff-syncs a subscription row per channel). It is a documented
// platform-internal registration: nothing external is called — the
// subscription row simply records that the platform's scheduler is the
// registered event source for this channel.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  Adapter,
  AdapterManifest,
  EdgesFromResult,
  EnsureEventSubscriptionInput,
  EventSubscriptionRegistration,
} from 'movement-engine/services/translation_graph/adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/services/translation_graph/types';

import { uniformWalk } from '../hop';
import { CRON_HANDBOOK_SECTION } from './handbook_section';
import { META_RECORD_TYPE, positionData } from 'movement-engine/services/translation_graph/types';
import { BaseAdapter } from '../base';

/** Stable adapter identifier — the trigger `kind` of cron-derived rows. */
export const CRON_ADAPTER_TYPE = 'cron';

/** Type id for the tick position a schedule firing seeds. Internal currency —
 *  stays lowercase; the natural name authors see is `CRON_TICK_DISPLAY_NAME`. */
export const CRON_TICK_TYPE_ID = 'tick';

/** Natural type name for a tick — TitleCase, like every other graph's nodes
 *  (adapters/CLAUDE.md). The event seed keys its position by this name (the
 *  address is the natural node name, layer 8), so field reads resolve it
 *  through the resolver; the typeId stays stable. */
export const CRON_TICK_DISPLAY_NAME = 'Tick';

/** The one subscribable event — what the platform scheduler emits. */
export const CRON_TICK_EVENT = 'tick';

/** What a scheduler firing carries as the trigger event's payload. */
export interface CronTickPayload {
  /** The scheduled occurrence this tick fired for (ISO, UTC). */
  firedAt: string;
  /** The listener's schedule, for display/debugging. */
  schedule: string;
}

/**
 * Static manifest. Source-only, credential-free. `listenConfig` declares
 * the `schedule` routing key (required, cron-format-validated at check
 * time); `subscribableEvents` + `ensureEventSubscription` put the channel
 * on the same listen-reconciliation seam as external webhooks.
 */
export const CRON_MANIFEST: AdapterManifest = {
  adapterType: CRON_ADAPTER_TYPE,
  displayName: 'Schedule',
  description:
    'Time as a source. A schedule emits an event when it comes due, and a ' +
    'movement listening to it runs — weekly digests, nightly mirrors. Built ' +
    'in; nothing to connect.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue',
    'ensureEventSubscription', 'removeEventSubscription',
  ],
  subscribableEvents: [CRON_TICK_EVENT],
  listenConfig: [
    { key: 'schedule', required: true, format: 'cron' },
    // Optional IANA timezone the schedule is interpreted in (wall-clock).
    // Absent ⇒ UTC. Handles DST automatically (e.g. Europe/London → 09:00
    // local across BST/GMT).
    { key: 'timezone', required: false, format: 'timezone' },
  ],
  // Self-alias: the subscription row's provider key stays the lowercase
  // slug (there is no legacy uppercase channel for an intrinsic adapter).
  triggerKinds: [CRON_ADAPTER_TYPE],
  triggerExpectation:
    'Fires on the schedule configured on the listener (a cron expression) — ' +
    'nothing external triggers it, and the event carries only the tick time. ' +
    'Present it as periodic work, never as reacting to data changes.',
  handbookSection: CRON_HANDBOOK_SECTION,
  vocabulary: {
    // A built-in owns no brand, but it still owns a MARK — see the manual
    // adapter for why. A clock is the whole of what this source is.
    icon: {
      d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18 M12 7.5 V12 l3.2 1.9',
      fill: false,
    },
  },
};

export class CronAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = CRON_ADAPTER_TYPE;
  readonly supportedTriggers = CRON_MANIFEST.supportedTriggers;
  /** Unstable tick positions resolve to the tick type. */
  readonly webhookEventTypeId = CRON_TICK_TYPE_ID;

  // teamId is accepted for parity with other adapters; cron has no
  // per-team configuration.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly teamId: TeamId) {
    super();
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // The natural name (`Tick`, TitleCase) is the currency authors, the
    // checker, and the hover all use; the internal `tick` typeId lives only in
    // this adapter's private cache. They no longer need to be identical: the
    // event edge keys its seed position by the natural node NAME (the address,
    // layer 8), and describe accepts either spelling — so field reads resolve
    // through the resolver whichever way the seed is stamped.
    return [
      {
        typeId: CRON_TICK_TYPE_ID,
        displayName: CRON_TICK_DISPLAY_NAME,
        writable: false,
        // Nothing enumerates ticks — they are DELIVERED. `readable: true` was
        // the encoding's forced lie (it minted a `timer-[t:tick]->` root
        // collection nothing could serve); the event edge marker is what the
        // honest spelling was blocked on. No change-kind axis, so no `action`
        // field: a tick is just a node a listen delivers.
        readable: false,
        fires: true,
      },
    ];
  }

  /**
   * The smallest graph there is: a schedule, and the tick it delivers. Nothing
   * enumerates ticks, so the single edge leaving the root is one you are fired
   * along — which is the honest shape of a timer, not a gap in it.
   */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Schedule',
    description:
      'A schedule. There is nothing here to list — a schedule holds no data; ' +
      'it fires, and the tick it delivers is the only way in.',
    fields: [],
    references: [
      {
        fieldId: CRON_TICK_TYPE_ID,
        targetTypeId: CRON_TICK_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: CRON_TICK_DISPLAY_NAME,
        fires: true,
        readable: false,
        description: 'The schedule firing — what a listen delivers.',
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: CRON_ADAPTER_TYPE,
      at: position,
      root: CronAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId !== CRON_TICK_TYPE_ID) return null;
    return {
      typeId: CRON_TICK_TYPE_ID,
      displayName: CRON_TICK_DISPLAY_NAME,
      description: 'One scheduled firing — when it was due, and on which schedule.',
      fields: [
        { fieldId: 'firedAt', displayName: 'Fired at', kind: 'date', writable: false, required: true, description: 'The scheduled occurrence this tick fired for (UTC).' },
        { fieldId: 'schedule', displayName: 'Schedule', kind: 'string', writable: false, required: true, description: 'The cron schedule that produced this tick.' },
      ],
      references: [],
    };
  }

  async getFieldValue(input: { position: SourcePosition; fieldId: string }): Promise<unknown> {
    if (input.position.adapterType !== CRON_ADAPTER_TYPE) {
      throw new Error(
        `CronAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    // The program names the field by its NATURAL displayName ('Fired at',
    // 'Schedule'); the payload is keyed by the internal field id (`firedAt`,
    // `schedule`). Resolve natural→internal against the position's natural type
    // on the first line (Decision #3).
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const payload = (positionData(input.position) ?? {}) as Partial<CronTickPayload>;
    return (payload as Record<string, unknown>)[fieldId] ?? null;
  }

  /**
   * Platform-internal registration — there is no external system to call.
   * The platform's own movement scheduler is the event source for every
   * cron channel; this method exists so cron listens ride the same
   * reconciliation seam as external webhook subscriptions, and the
   * returned marker lands on the subscription row to say so honestly.
   */
  async ensureEventSubscription(
    _input: EnsureEventSubscriptionInput,
  ): Promise<EventSubscriptionRegistration> {
    return { externalId: 'platform:movement-scheduler' };
  }

  /** The scheduler stops firing when the trigger rows retire — nothing
   *  external to deregister. */
  async removeEventSubscription(): Promise<void> {
    // Documented no-op (see ensureEventSubscription).
  }
}

/** Factory matching the registry's AdapterFactory signature. */
export function createCronAdapter(input: { teamId: TeamId }): CronAdapter {
  return new CronAdapter(input.teamId);
}
