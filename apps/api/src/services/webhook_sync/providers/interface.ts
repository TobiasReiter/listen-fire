// provider interface
// auto vs manual registration
// actor capture

import type { Actor } from 'movement-engine/public/adapter';

export interface WebhookEvent {
  eventType: string;
  recordId: string;
  objectId: string;
  /**
   * The source's own per-DELIVERY id (Slack envelope `event_id`, …) — STABLE
   * across at-least-once redeliveries of the same event, so the receipt store
   * dedupes on it and a retry is a no-op instead of a duplicate run. Distinct
   * from `recordId`, which identifies the RECORD (and legitimately repeats
   * across distinct deliveries — e.g. two updates of the same Attio record).
   * Sources without a stable per-delivery handle leave it undefined (not
   * deduped).
   */
  idempotencyKey?: string;
  /**
   * Server-asserted actor that produced the change at the source system, when
   * surfaced. Substrate for Layer 14.4 actor-based echo recognition: the
   * inbound trigger router uses `(adapterType, actor)` to recognize echoes of
   * Listen-Fire-driven writes and drop them at entry. When absent, correctness
   * falls back to no-op detection (P14.1) and the circuit breaker (P14.2).
   *
   * Adapters that observe the source surfacing actor info normalize it into
   * this uniform shape; adapters that don't leave the field undefined.
   */
  actor?: Actor;
  /**
   * The original event payload, if the source delivers richer data than the
   * normalized fields above (e.g. before/after snapshots, actor metadata,
   * nested references). The webhook handler uses this verbatim as the source
   * position's `data` when set, so trigger filters and field mappings can
   * read the full payload via the adapter's `getFieldValue`. Adapters that
   * don't surface a richer payload leave it undefined; the handler then
   * synthesises a minimal `data` object from the normalized fields.
   */
  rawPayload?: unknown;
  /**
   * Adapter-specific identifiers for the fields that changed on the source
   * record, when the source surfaces field-level change info. Used by
   * event-mode TG execution to prune edge traversals (via
   * `SchemaReferenceDescriptor.backingFields`) — if the change can't have
   * touched the FK backing an edge, the edge is skipped.
   *
   * Adapters that don't surface change granularity leave this undefined;
   * the runtime then falls through to "possibly affected" for every edge
   * (safe default, no pruning).
   *
   * Format: whatever shape the adapter's `backingFields` use. Attio surfaces
   * attribute UUIDs in its webhook payload; the runtime checker compares
   * Set-membership against the same shape declared on the descriptor, so
   * adapters should be consistent.
   */
  changedFields?: string[];
}

/** What we need to persist on a webhook_subscription row after registration.
 *  `externalId` is set when the source system was registered via API; absent
 *  when the operator must paste the URL + secret into the source manually. */
export interface WebhookRegistration {
  externalId?: string;
  /** HMAC secret used to verify inbound signatures. For auto-registered
   *  providers this comes back from the source system; for manual
   *  registration we generate it ourselves and the operator pastes it. */
  secret: string;
}

export interface WebhookProvider {
  /**
   * Whether this provider can auto-register subscriptions via the source
   * system's API. When false, the operator pastes the URL + secret into
   * the source UI and clicks Confirm; when true, `registerSubscription`
   * makes the API call and returns the source-issued externalId/secret.
   *
   * The abstraction collapses both modes to a single `registerSubscription`
   * call — manual providers just generate a fresh local secret instead of
   * calling the source API. The UI uses `canRegisterViaApi` to swap labels
   * ("Create subscription" vs "Mark registered") and to surface
   * `setupInstructions` when manual.
   */
  readonly canRegisterViaApi: boolean;

  /** Human-readable setup steps shown alongside the webhook URL when
   *  `canRegisterViaApi` is false. Markdown-ish plain text. */
  readonly setupInstructions?: string;

  /**
   * Provider-shaped event types the UI subscribes to by default when the
   * operator clicks "Create subscription" without picking specific events.
   * Lets the front-end stay provider-agnostic — it omits `eventTypes` on
   * create and the backend fills them in from here. Each provider's list
   * is whatever maps to "all the typical row-change events for this
   * source" (Attio: record.{created,updated,deleted}; Valuations:
   * valuations:legal_entity:{create,update,delete}; etc.).
   */
  readonly defaultEventTypes: readonly string[];

  /**
   * Register a subscription with the source system. Auto providers call
   * the source's "create webhook" API and return the issued externalId +
   * secret. Manual providers generate a fresh local secret and return
   * `{ externalId: undefined, secret }`; the UI surfaces both for the
   * operator to paste into the source system.
   */
  registerSubscription(input: {
    credentialsId: string;
    targetUrl: string;
    eventTypes: string[];
  }): Promise<WebhookRegistration>;

  /** Deregister a subscription. No-op for manual providers. */
  deregisterSubscription?(input: {
    credentialsId: string;
    externalId: string;
  }): Promise<void>;
}
