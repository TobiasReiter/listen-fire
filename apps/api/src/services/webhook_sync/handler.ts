// webhook handler
// TG dispatch from webhook
import { sql } from 'kysely';

import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { Adapter, DiscriminableEvent, EventType } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { HarnessDelivery, SettleReport } from '../work/harness';
import type { WebhookProvider } from './providers';

import { getAutomationsQb } from '../../lib/kysely';
import { getWebhookProvider } from './providers';
import { logger } from 'movement-engine/services/logger';
import { findTriggersByKind } from '../translation_graph/storage/tg_table';
import {
  captureDiscriminableEvent,
  enqueueCapturedEvents,
  readReceiptGroupOutcomes,
  type CapturedTriggerEvent,
} from '../translation_graph/triggers/dispatch_event';
import { channelScopeMatches, eventConfigList, eventMatchesTriggerScope } from 'movement-engine/services/translation_graph/triggers/listen_config';
import { ATTIO_ADAPTER_TYPE } from '../translation_graph/adapters/attio';
import { TELEGRAM_ADAPTER_TYPE, TelegramAdapter } from '../translation_graph/adapters/telegram';
import { handleTelegramCallbackQuery, ownsCallbackQuery } from './telegram_callback_door';
import { WHATSAPP_ADAPTER_TYPE } from '../translation_graph/adapters/whatsapp';
import {
  defaultWhatsappCallbackResponder,
  handleWhatsappInteractiveReplies,
  ownsWhatsappInteractiveReply,
} from './whatsapp_callback_door';
import { enqueueAwaitWakes } from '../movement_engine/await_wake';
import { notifyWork } from '../work/drain';
import {
  enqueueLinkedObjectRefresh,
  hasBridgedLinkedObjects,
  type LinkedObjectRefresh,
} from './linked_object_refresh';
import { hasAdapter, resolveAdapterSlug } from '../translation_graph/adapters/registry';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { isTestHarnessTeam } from '../../lib/recording';
import { verifyRemoteSignature } from 'movement-engine/services/webhook_sync/remote_inbound';
import { webhookProviderKey } from './urls';
import { listRemoteAdapters } from '../translation_graph/adapters/remote/store';
import { mayBeRemoteSlug } from '../translation_graph/adapters/remote/slugs';

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

/**
 * Outcome of a delivery once its work rows have drained.
 *
 * `eventsProcessed` counts events that cleared BOTH halves — capture and
 * dispatch — which is what the pre-split handler reported. Only a
 * test-harness caller ever sees it (it drains before acking); a production
 * sender is acked before its rows run.
 */
interface DeferredOutcome {
  eventsProcessed: number;
  /**
   * Per-event errors the handler caught and continued past. Surfaced in the
   * response only for test-harness-team subscriptions so the dev loop can see
   * why a dispatch silently failed. Production teams receive the same 200 they
   * always have.
   */
  perEventErrors: { event: DiscriminableEvent; error: string }[];
}

/** What `enqueueDeferred` queued, readable once the rows have drained. */
type EnqueuedDelivery = HarnessDelivery<DeferredOutcome>;

interface HandleResult {
  ok: boolean;
  /** Events CAPTURED — durably receipted and ready to dispatch. The sender is
   *  acked on this count; dispatch outcomes land on the receipts. */
  eventsProcessed: number;
  error?: string;
  /**
   * Phase 2: a work row per linked_object refresh, per receipt and per await
   * wake — nothing else, so nothing live sits between a receipt and its row.
   * The door awaits it BEFORE acking, since a receipt or a wake without a row
   * would never run; the rows themselves (the linked-object refresh included)
   * run off the request. Absent when the delivery carried nothing to run.
   * Never rejects for a per-event failure (those come back in the outcome).
   * Rejects when the delivery's wakes could not be read or queued, after its
   * events are queued: the door answers 500 so the sender retries.
   */
  enqueueDeferred?: () => Promise<EnqueuedDelivery>;
  /**
   * Test-harness subscriptions drain the rows before acking, so the dev-loop
   * inject CLI keeps seeing runs settled and dispatch errors in the response.
   */
  awaitDeferred?: boolean;
}

async function handleInboundWebhook(options: {
  provider: string;
  subscriptionId: string;
  rawBody: Buffer;
  signatureHeader: string;
}): Promise<HandleResult> {
  const { provider: providerKey, subscriptionId, rawBody, signatureHeader } = options;

  const webhookProvider = getWebhookProvider(providerKey);

  const subscription = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('webhook_subscription.id', '=', subscriptionId as WebhookSubscriptionId)
    .where('webhook_subscription.deleted_at', 'is', null)
    .where('webhook_subscription.status', '!=', 'disabled')
    .select([
      'webhook_subscription.id',
      'webhook_subscription.team_id',
      'webhook_subscription.provider',
      'webhook_subscription.credentials_id',
      'webhook_subscription.webhook_secret',
      'webhook_subscription.external_webhook_id',
      'webhook_subscription.inbound_checkpoint',
    ])
    .executeTakeFirst();

  if (!subscription) {
    return {
      ok: false,
      eventsProcessed: 0,
      error: webhookProvider ? 'subscription_not_found' : 'unknown_provider',
    };
  }

  if (subscription.provider !== providerKey) {
    return { ok: false, eventsProcessed: 0, error: 'provider_mismatch' };
  }

  const door = webhookProvider
    ? localDoor(webhookProvider, subscription)
    : await remoteDoor(subscription);
  if (!door) {
    return { ok: false, eventsProcessed: 0, error: 'unknown_provider' };
  }

  // Test-harness bypass: the dev-loop CLI fires synthetic webhooks at the
  // pinned test team to exercise the handler without a real source signing
  // the payload. Production teams always go through verifySignature.
  const isHarnessTeam = isTestHarnessTeam(subscription.team_id);
  if (
    !isHarnessTeam &&
    !door.verifySignature(rawBody, signatureHeader, signingSecretFor(providerKey, subscription))
  ) {
    logger.warn(`Webhook signature verification failed for subscription ${subscriptionId}`);
    return { ok: false, eventsProcessed: 0, error: 'signature_invalid' };
  }
  if (isHarnessTeam) {
    logger.info(`[webhook] test-harness team — skipping signature verification`);
  }

  const body = JSON.parse(rawBody.toString('utf-8'));
  const opened = await door.open();

  // `Adapter.preprocessInbound` is THE raw→events seam — every provider's
  // adapter implements it (the legacy provider-side sync `parseEvents` is
  // retired). A delivery whose adapter can't preprocess is a wiring bug, and
  // the lockstep test (provider-adapter-lockstep.unit.test.ts) plus the
  // registry guarantee it can't ship — fail loudly rather than drop silently.
  if (!opened?.adapter.preprocessInbound) {
    logger.error(
      `[webhook] adapter for provider ${subscription.provider} has no preprocessInbound — delivery dropped`,
    );
    return { ok: false, eventsProcessed: 0, error: 'adapter cannot preprocess inbound' };
  }
  const { sub, adapterType, adapter } = opened;

  // A Telegram button tap arrives on the same webhook as every message, as a
  // `callback_query` rather than a `message`. It fires the callback it was wired
  // to and acks Telegram; there is no movement event in it, so the delivery ends
  // here. Every other Telegram update — and every other provider — falls
  // straight through to the raw→events seam below.
  if (adapterType === TELEGRAM_ADAPTER_TYPE && ownsCallbackQuery(body)) {
    const { handled } = await handleTelegramCallbackQuery({
      raw: body,
      responder: new TelegramAdapter(sub.team_id as TeamId, sub.credentials_id),
    });
    if (handled) return { ok: true, eventsProcessed: 0 };
  }

  // A WhatsApp interactive reply arrives as an ordinary MESSAGE-typed update
  // (`interactive.button_reply`/`list_reply`), not a dedicated update kind the
  // way Telegram's `callback_query` is — and a delivery can batch several
  // messages. So this does NOT early-return the way the Telegram branch does:
  // a callback-id tap in this batch is fired + acked here, and the delivery
  // still falls through to `preprocessInbound` for whatever else it carries.
  // Safe either way — `classifyMetaMessage` already drops an interactive-typed
  // message as unclassified, so reprocessing it below is a no-op, never a
  // double dispatch.
  if (adapterType === WHATSAPP_ADAPTER_TYPE && ownsWhatsappInteractiveReply(body)) {
    await handleWhatsappInteractiveReplies({
      raw: body,
      responder: defaultWhatsappCallbackResponder(),
    });
  }

  const extraction = await opened.adapter.preprocessInbound({
    raw: body,
    checkpoint: sub.inbound_checkpoint ?? undefined,
  });
  const events = extraction.events;

  // Phase 1 — capture. Match each event to its triggers and store the durable
  // receipts. Nothing here runs a movement, so the sender gets its 200 back
  // fast; the receipt is what makes the deferred half safe to lose and replay.
  // The adapter's event-type union for discrimination, fetched once per delivery.
  const eventTypes = events.length > 0 && adapter.listEventTypes ? await adapter.listEventTypes() : [];
  const captured: CapturedInboundEvent[] = [];
  const captureErrors: { event: DiscriminableEvent; error: string }[] = [];
  for (const event of events) {
    try {
      captured.push(await captureInboundEvent({ event, subscription: sub, adapterType, eventTypes }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Webhook event capture failed:`, { event, err });
      captureErrors.push({ event, error: message });
    }
  }

  // The wake door, independent of the events: a delivery may resolve a parked
  // await whether or not it carries anything a trigger listens for. Read after
  // the capture, so a wake door that fails never costs the delivery its events:
  // they are receipted, and the sender's retry replays them idempotently.
  const wakes = await readWakeKeys(adapter, body);
  if (!events.length && wakes.ok && !wakes.keys.length) {
    return { ok: true, eventsProcessed: 0 };
  }

  // Advance the pull cursor once every event in the batch is durably stored —
  // the invariant the cursor rides on is "receipted", not "dispatched", so a
  // crash before the deferred half re-plays receipts rather than re-pulling.
  // Push providers return `checkpoint` unset and never write here.
  if (extraction.checkpoint !== undefined) {
    await getAutomationsQb(['webhook_subscription'])
      .updateTable('webhook_subscription')
      .set({ inbound_checkpoint: jsonb(extraction.checkpoint) as never })
      .where('id', '=', subscriptionId as WebhookSubscriptionId)
      .execute();
  }

  // Phase 2 — queue the work, all before the ack. Events keep their delivery
  // order, and one event's failure never stops the next — the pre-split
  // per-event isolation. The wakes go last: a wake door that failed, or a wake
  // row that cannot be queued, throws, so the sender is answered 500 and
  // retries. Its events are already receipted and queued, so the retry costs
  // them nothing and re-attempts only what was lost.
  const enqueueDeferred = async (): Promise<EnqueuedDelivery> => {
    const enqueueErrors = [...captureErrors];
    const enqueued: CapturedInboundEvent[] = [];
    for (const entry of captured) {
      try {
        await enqueueCapturedInboundEvent({ captured: entry, subscription: sub });
        enqueued.push(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Webhook event processing failed:`, { event: entry.event, err });
        enqueueErrors.push({ event: entry.event, error: message });
      }
    }
    if (!wakes.ok) throw wakes.error;
    await enqueueAwaitWakes({ adapterType: adapter.adapterType, teamId: sub.team_id as TeamId, correlationKeys: wakes.keys });
    return {
      teamIds: [sub.team_id],
      readOutcome: (settle) => readDeliveryOutcome({ enqueued, enqueueErrors, settle }),
    };
  };

  return {
    ok: true,
    eventsProcessed: captured.length,
    enqueueDeferred,
    ...(isHarnessTeam ? { awaitDeferred: true } : {}),
  };
}

async function readDeliveryOutcome(input: {
  enqueued: CapturedInboundEvent[];
  enqueueErrors: { event: DiscriminableEvent; error: string }[];
  settle: SettleReport;
}): Promise<DeferredOutcome> {
  const { cleared, failed } = await readReceiptGroupOutcomes({
    groups: input.enqueued.map((entry) => ({ group: entry.event, receipts: entry.receipts })),
    settle: input.settle,
  });
  return {
    eventsProcessed: cleared.length,
    perEventErrors: [
      ...input.enqueueErrors,
      ...failed.map(({ group, error }) => ({ event: group, error })),
    ],
  };
}

type SubscriptionRow = {
  id: string;
  team_id: string;
  provider: string;
  credentials_id: string | null;
  webhook_secret: string;
  inbound_checkpoint: unknown;
};

/** Meta signs every WhatsApp delivery with the Meta app's secret, not with a
 *  secret minted per subscription — and the platform's one WhatsApp app is the
 *  only one there is (WhatsApp takes no credential). Empty means "no secret to
 *  verify against", which `whatsappProvider.verifySignature` refuses: an HMAC
 *  keyed with '' is one anybody can compute. */
function signingSecretFor(providerKey: string, subscription: SubscriptionRow): string {
  return providerKey === 'INBOUND_WHATSAPP'
    ? (process.env.WHATSAPP_WEBHOOK_SECRET ?? '')
    : subscription.webhook_secret;
}

/** What a delivery is read with, once its subscription has named it: how its
 *  signature is checked, and (after the check) whom it is for and the adapter
 *  that turns it into events. */
interface InboundDoor<S extends SubscriptionRow> {
  verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean;
  /** Null when no adapter can read the delivery. */
  open(): Promise<{
    sub: S & { credentials_id: string };
    adapterType: string;
    adapter: Adapter;
  } | null>;
}

function localDoor<S extends SubscriptionRow>(provider: WebhookProvider, subscription: S): InboundDoor<S> {
  return {
    verifySignature: (rawBody, header, secret) => provider.verifySignature(rawBody, header, secret),
    async open() {
      const sub = requireSubscriptionCredentials(subscription);
      // Provider keys are trigger-kind aliases (every provider key appears in its
      // adapter's manifest `triggerKinds`), so the registry's own alias map is the
      // resolver — NOT a naming convention. The old lowercase-hyphen convention
      // silently broke INBOUND_WHATSAPP ('inbound-whatsapp' is not a registered slug),
      // making that BYO door skip dispatch forever.
      const adapterType = resolveAdapterSlug(sub.provider);
      if (!hasAdapter(adapterType)) return null;
      const adapter = await resolveAdapter({
        adapterType,
        teamId: sub.team_id as TeamId,
        credentialsId: sub.credentials_id,
      });
      return { sub, adapterType, adapter };
    },
  };
}

/**
 * A subscription a team's remote install provisioned, recognised by its
 * provider key being the one that install mints (`webhookProviderKey`). An
 * install whose slug a built-in answers to is never recognised (the shared
 * rule in `remote/slugs`): the built-in wins, as it does at resolution.
 * Everything after
 * is the ordinary path over the wire — preprocessInbound, listEventTypes and
 * wakeKeys are RemoteAdapter forwarders. The row carries no credential of its
 * own; the install's credential is the channel's.
 */
async function remoteDoor<S extends SubscriptionRow>(subscription: S): Promise<InboundDoor<S> | null> {
  const installs = await listRemoteAdapters({ teamId: subscription.team_id as TeamId });
  const install = installs.find(
    (row) =>
      mayBeRemoteSlug(row.adapter_type) &&
      webhookProviderKey({ adapterType: row.adapter_type }) === subscription.provider,
  );
  if (!install) return null;
  return {
    verifySignature: verifyRemoteSignature,
    async open() {
      const credentialsId = install.credentials_id;
      if (credentialsId === null) {
        logger.error(`[webhook] remote adapter ${install.adapter_type} has no credential — delivery dropped`);
        return null;
      }
      const adapter = await resolveAdapter({
        adapterType: install.adapter_type,
        teamId: subscription.team_id as TeamId,
      });
      return { sub: { ...subscription, credentials_id: credentialsId }, adapterType: install.adapter_type, adapter };
    },
  };
}

/** Inbound deliveries only exist for credentialed channels — a
 *  credential-free subscription row (the cron adapter's platform-internal
 *  registration) has no inbound URL traffic; reject loudly if one shows up. */
function requireSubscriptionCredentials<T extends { credentials_id: string | null; provider: string }>(
  subscription: T,
): T & { credentials_id: string } {
  if (subscription.credentials_id === null) {
    throw new Error(
      `webhook subscription for provider '${subscription.provider}' carries no credential — inbound deliveries are not expected on credential-free channels`,
    );
  }
  return subscription as T & { credentials_id: string };
}

/** One inbound event carried across the ack: what arrived, and the receipts
 *  phase 1 stored for it (one per trigger that matched). */
interface CapturedInboundEvent {
  event: DiscriminableEvent;
  adapterType: string;
  receipts: CapturedTriggerEvent[];
}

/**
 * Phase 1 for ONE event: resolve the adapter, match the event against this
 * team's triggers, and store a durable receipt per match. Cheap and local —
 * this is the work that has to finish before the sender is acked.
 */
async function captureInboundEvent(input: {
  event: DiscriminableEvent;
  subscription: { team_id: string; credentials_id: string; provider: string };
  adapterType: string;
  eventTypes: readonly EventType[];
}): Promise<CapturedInboundEvent> {
  const { event, subscription, adapterType, eventTypes } = input;
  const receipts = await captureProviderTriggerEvents({
    event,
    subscription,
    adapterType,
    eventTypes,
  });
  return { event, adapterType, receipts };
}

/**
 * Phase 2 for ONE event: queue a linked_object refresh when a KG node is bridged to the record it names, and
 * a run per stored receipt. The rows are independent; none makes a live
 * provider read inside the request.
 */
async function enqueueCapturedInboundEvent(input: {
  captured: CapturedInboundEvent;
  subscription: { team_id: string; credentials_id: string; provider: string };
}): Promise<void> {
  const { captured, subscription } = input;

  // The cache refresh is its own row, owed whether or not any trigger matched.
  const { externalId, recordType, idempotencyKey } = captured.event;
  if (externalId !== undefined) {
    const refresh: LinkedObjectRefresh = {
      teamId: subscription.team_id as TeamId,
      provider: subscription.provider,
      credentialsId: subscription.credentials_id,
      externalId,
      ...(recordType !== undefined ? { recordType } : {}),
    };
    if (await hasBridgedLinkedObjects(refresh)) {
      await enqueueLinkedObjectRefresh({ refresh, eventKey: idempotencyKey ?? externalId });
    }
  }

  await enqueueCapturedEvents(captured.receipts);
}

/**
 * The correlation keys an adapter's `wakeKeys` names for one inbound delivery.
 * INDEPENDENT of trigger dispatch — a thread reply must resolve an
 * `await m-[:Replies]->` even when no movement listens for its messages
 * (consent-by-silence, S18) — and unordered against it: the resumed await
 * re-checks live. A throw comes back as the error, for the caller to refuse the
 * delivery with once its events are safe.
 */
async function readWakeKeys(
  adapter: Adapter,
  raw: unknown,
): Promise<{ ok: true; keys: string[] } | { ok: false; error: unknown }> {
  if (!adapter.wakeKeys) return { ok: true, keys: [] };
  try {
    return { ok: true, keys: await adapter.wakeKeys({ raw }) };
  } catch (error) {
    logger.error(`[webhook] wakeKeys failed for adapter ${adapter.adapterType}; the delivery will be refused for a retry`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error };
  }
}

/**
 * Channel-scope filter for `listen … { channels: [...] }` (Slack's channel
 * names). Async because matching an inbound event's channel needs the event's
 * channel id → name resolved off the adapter (cached). Skips the resolution
 * entirely when no candidate declares `channels`, so unscoped listens (every
 * other adapter, and Slack listens without a channel filter) pay nothing. A
 * trigger with no `channels` always passes; a scoped trigger passes only when
 * the resolved channel name is in its list.
 */
async function filterByChannelScope<T extends { config: unknown }>(input: {
  candidates: T[];
  event: DiscriminableEvent;
  adapterType: string;
  subscription: { team_id: string; credentials_id: string | null };
}): Promise<T[]> {
  const { candidates, event, adapterType, subscription } = input;
  const hasChannels = (config: unknown): boolean =>
    eventConfigList((config as { channels?: unknown } | null)?.channels).length > 0;
  if (!candidates.some((t) => hasChannels(t.config))) return candidates;

  const channelName = await resolveEventChannelName({ event, adapterType, subscription });
  return candidates.filter((t) => channelScopeMatches(t.config, channelName));
}

/**
 * Resolve an inbound event's channel id → name via the adapter, when the
 * adapter supports it (Slack does; nothing else declares a channel filter).
 * Message events carry the channel at `payload.channel`; reactions at
 * `payload.item.channel`.
 */
async function resolveEventChannelName(input: {
  event: DiscriminableEvent;
  adapterType: string;
  subscription: { team_id: string; credentials_id: string | null };
}): Promise<string | null> {
  const payload = input.event.payload as
    | { channel?: unknown; item?: { channel?: unknown } }
    | undefined;
  const channelId =
    (typeof payload?.channel === 'string' && payload.channel) ||
    (typeof payload?.item?.channel === 'string' && payload.item.channel) ||
    undefined;
  if (!channelId || !hasAdapter(input.adapterType)) return null;

  const adapter = await resolveAdapter({
    adapterType: input.adapterType,
    teamId: input.subscription.team_id as TeamId,
    credentialsId: input.subscription.credentials_id ?? undefined,
  });
  const maybe = adapter as { resolveChannelName?: (id: string) => Promise<string | null> };
  return typeof maybe.resolveChannelName === 'function'
    ? maybe.resolveChannelName(channelId)
    : null;
}

/** Resolve the adapter's event-type union for discrimination. Used when the
 *  caller (the shared-bot fan-out) hasn't already fetched it for the delivery. */
async function loadEventTypes(
  adapterType: string,
  subscription: { team_id: string; credentials_id: string | null },
): Promise<readonly EventType[]> {
  if (!hasAdapter(adapterType)) return [];
  const adapter = await resolveAdapter({
    adapterType,
    teamId: subscription.team_id as TeamId,
    credentialsId: subscription.credentials_id ?? undefined,
  });
  return adapter.listEventTypes ? await adapter.listEventTypes() : [];
}

/**
 * R (2026-05-28) — trigger-first dispatch path. For each `automations.trigger`
 * row on this team whose kind matches the provider, fan out to bound
 * TGs through the trigger-id engine entry. Trigger filtering layered on
 * top: kind must match the provider, and (when the subscription scopes
 * by credentials) the trigger's credentials_id must agree.
 *
 * Bridge materialisation + trigger-entry filtering live inside each
 * binding's TG body (filter expression). Mirroring the legacy path's
 * external→KG bridge here would cross the chunk seam; we let the engine
 * handle source-position bridging via the TG body itself (W3-B1's anchor
 * bridge runs at engine entry, not in dispatch).
 *
 */
export async function dispatchToProviderTriggers(input: ProviderTriggerDispatch): Promise<void> {
  await enqueueCapturedEvents(await captureProviderTriggerEvents(input));
  notifyWork();
}

interface ProviderTriggerDispatch {
  event: DiscriminableEvent;
  // `credentials_id` is the per-subscription credential for BYO inbound. The
  // SHARED built-in bot has no per-team credential (it sends from the env
  // `TELEGRAM_BOT_TOKEN`), so the shared-bot fan-out passes `null` here — the
  // adapter then resolves the built-in client. BYO always passes a real id.
  subscription: { team_id: string; credentials_id: string | null; provider: string };
  adapterType: string;
  /**
   * Shared-bot path opt-out of credential narrowing. The shared built-in bot
   * receives GLOBALLY (one bot, every team), so a trigger's own credential is
   * the SEND identity, not a gate on which inbound it matches. When set, the
   * per-trigger credential filter below is skipped — every TELEGRAM trigger on
   * the resolved team is a candidate, each dispatching with its own credential
   * (or the built-in env token when it has none).
   */
  matchAnyCredential?: boolean;
  /** The adapter's event-type union, when the caller already fetched it for the
   *  delivery (the BYO handler). Omitted by the shared-bot caller — fetched here. */
  eventTypes?: readonly EventType[];
}

/**
 * Capture half of the trigger-first path: which of this team's triggers does
 * the event match, and a durable receipt for each. No movement runs here, so an
 * acking front door can finish this inside the request and dispatch after.
 */
export async function captureProviderTriggerEvents(
  input: ProviderTriggerDispatch,
): Promise<CapturedTriggerEvent[]> {
  const { event, subscription, adapterType, matchAnyCredential } = input;

  // Provider key matches `automations.trigger.kind` directly (Setup writes
  // the PipelineInputType enum value as the kind); webhook subscriptions are
  // 1:1 with a provider. The adapter's own slug joins it because a remote
  // install's listens carry its slug as their kind, and its provider key is no
  // registry alias of that slug.
  const triggers = await findTriggersByKind({
    teamId: subscription.team_id,
    kinds: [...new Set([subscription.provider, adapterType])],
  });
  if (triggers.length === 0) return [];

  // Scope by credentials when set on the trigger, then by the listen's authored
  // scope (`events` change types + Airtable `table`). A null credentials_id
  // means the trigger is provider-wide (rare for webhook adapters, common for
  // inbound email); a matching credentials_id is the integration narrowing.
  const candidates = triggers.filter((t) => {
    if (
      !matchAnyCredential &&
      t.credentialsId != null &&
      t.credentialsId !== subscription.credentials_id
    ) {
      return false;
    }
    return eventMatchesTriggerScope(event, t.config);
  });
  if (candidates.length === 0) return [];

  // Channel-scope filter (`listen … { channels: [...] }`) — async because it
  // resolves the event's channel id → name off the adapter. Only runs when a
  // candidate actually declares `channels`, so the common case pays nothing.
  const scoped = await filterByChannelScope({ candidates, event, adapterType, subscription });
  if (scoped.length === 0) return [];

  const eventTypes =
    input.eventTypes ?? (await loadEventTypes(adapterType, subscription));

  const captured: CapturedTriggerEvent[] = [];
  for (const trigger of scoped) {
    // The shared inbound tail: discriminate → build TriggerEvent → durable
    // receipt → dispatch to the movement engine. Identical to the poll path
    // (`poll_source/worker.ts`); only the front door (a webhook delivery vs a
    // timer) differs — and where the ack sits relative to the dispatch.
    const receipt = await captureDiscriminableEvent({
      triggerId: trigger.id as TriggerId,
      movementId: trigger.movementId,
      event,
      adapterType,
      triggerType: 'webhook',
      eventTypes,
      teamId: subscription.team_id as TeamId,
    });
    if (receipt !== null) captured.push(receipt);
  }
  return captured;
}

export { handleInboundWebhook };
