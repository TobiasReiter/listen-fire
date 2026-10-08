// The event a run fired on: which source and trigger delivered it, its
// payload, and the record it anchors to. A resume is handed the run's
// original event.

import { z } from 'zod';

/** Who or what produced a change, as the producing system asserts it. */
export const actorTypeSchema = z.enum(['user', 'api-token', 'system']);

export type ActorType = z.infer<typeof actorTypeSchema>;

export const actorSchema = z.object({
  type: actorTypeSchema,
  id: z.string().nullable(),
});

export type Actor = z.infer<typeof actorSchema>;

/** What fired the change. */
export const triggerTypeSchema = z.enum([
  'snapshot',
  'poll',
  'changes-feed',
  'webhook',
  'mutation',
  'extraction',
]);

export type TriggerType = z.infer<typeof triggerTypeSchema>;

/** The source system's identifier for the record an inbound event is about. */
export const inboundRecordRefSchema = z.object({
  adapterType: z.string(),
  externalId: z.string(),
  recordType: z.string().optional(),
});

export type InboundRecordRef = z.infer<typeof inboundRecordRefSchema>;

export const triggerEventSchema = z.object({
  pipelineInputId: z.string(),
  adapterType: z.string(),
  objectType: z.string().optional(),
  triggerEntryId: z.string().optional(),
  triggerType: triggerTypeSchema,
  payload: z.unknown(),
  changeType: z.enum(['create', 'update', 'delete']).optional(),
  actor: actorSchema.optional(),
  snapshotRunId: z.string().optional(),
  snapshotComplete: z.boolean().optional(),
  /** The host's own id (a UUID) of the record this event anchors to — a
   *  node it materialised for the event. External identifiers ride
   *  `externalRecordRef`. */
  recordId: z.string().uuid().optional(),
  /** The source system's identifier for the record, for webhook and
   *  snapshot triggers. */
  externalRecordRef: inboundRecordRefSchema.optional(),
  /**
   * The concrete source type the inbound dispatch discriminated this event to
   * (an `EventType.positionType`, e.g. `attio:companies`), set by the dispatch
   * layer after matching the event against the adapter's `listEventTypes`. When
   * present (with `externalRecordRef.externalId`), the run seeds a typed stable
   * record position rather than the raw unstable payload.
   */
  rootRecordType: z.string().optional(),
  changedFields: z.array(z.string()).optional(),
  /**
   * The source's own per-DELIVERY id (Slack envelope `event_id`, …): a host
   * dedupes an at-least-once redelivery on it. Absent ⇒ not deduped.
   */
  idempotencyKey: z.string().optional(),
  occurredAt: z.string().datetime().optional(),
});

export type TriggerEvent = z.infer<typeof triggerEventSchema>;
