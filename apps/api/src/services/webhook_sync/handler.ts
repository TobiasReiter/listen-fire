// The platform's store under the webhook door. The door itself — verify,
// preprocess, capture, queue, ack — is the shared inbound core
// (movement-engine/public/inbound, `receiveDelivery` / `answerDelivery`); this
// file is what it stands on here: subscription rows in Postgres, the built-in
// providers' frozen signature table, remote installs, the trigger table, the
// receipt store and the work table.
import { sql } from 'kysely';

import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { DiscriminableEvent, EventType } from 'movement-engine/public/adapter';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { HarnessDelivery, SettleReport } from '../work/harness';
import type {
  EventError,
  InboundHeaders,
  InboundSource,
  InboundStore,
  InboundSubscription,
  OpenedSource,
  QueuedDelivery,
} from 'movement-engine/public/inbound';

import { getAutomationsQb } from '../../lib/kysely';
import { getWebhookProvider } from './providers';
import { logger } from 'movement-engine/public/log';
import { findTriggersByKind } from '../translation_graph/storage/tg_table';
import {
  captureDiscriminableEvent,
  enqueueCapturedEvents,
  readReceiptGroupOutcomes,
  type CapturedTriggerEvent,
} from '../translation_graph/triggers/dispatch_event';
import { channelScopeMatches, eventConfigList, eventMatchesTriggerScope } from 'movement-engine/public/inbound';
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
import { receiveDelivery } from 'movement-engine/public/inbound';
import { webhookProviderKey } from './urls';
import { listRemoteAdapters } from '../translation_graph/adapters/remote/store';
import { mayBeRemoteSlug } from '../translation_graph/adapters/remote/slugs';
import { LEGACY_INTERCEPTS, LEGACY_SIGNATURE_HEADERS } from '../inbound/legacy_signature_headers';
import { builtinModuleInboundVerifier } from '../translation_graph/adapters/builtin_modules';

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

/** The receipts phase 1 stored for one event (one per trigger that matched). */
export type CapturedReceipts = CapturedTriggerEvent[];

/**
 * Outcome of a delivery once its work rows have drained: events that cleared
 * BOTH capture and dispatch. Only a test-harness caller ever sees it (it drains
 * before acking); a production sender is acked before its rows run.
 */
export interface DeferredOutcome {
  eventsProcessed: number;
  /** Per-event errors the door continued past, for the dev loop to read. */
  perEventErrors: EventError[];
}

/** Queue a delivery's rows and say how to read them once drained — the shape
 *  the work harness (`runHarnessDelivery`) drains. */
export async function queueForHarness(
  queue: () => Promise<QueuedDelivery<CapturedReceipts>>,
): Promise<HarnessDelivery<DeferredOutcome>> {
  const queued = await queue();
  return { teamIds: [queued.teamId], readOutcome: (settle) => readDeliveryOutcome({ queued, settle }) };
}

async function readDeliveryOutcome(input: {
  queued: QueuedDelivery<CapturedReceipts>;
  settle: SettleReport;
}): Promise<DeferredOutcome> {
  const { cleared, failed } = await readReceiptGroupOutcomes({
    groups: input.queued.enqueued.map((entry) => ({ group: entry.event, receipts: entry.captured })),
    settle: input.settle,
  });
  return {
    eventsProcessed: cleared.length,
    perEventErrors: [...input.queued.captureErrors, ...failed.map(({ group, error }) => ({ event: group, error }))],
  };
}

/** Meta signs every WhatsApp delivery with the Meta app's secret, not with a
 *  secret minted per subscription — and the platform's one WhatsApp app is the
 *  only one there is (WhatsApp takes no credential). Empty means "no secret to
 *  verify against", which the `hmac_sha256_hex` scheme refuses: an HMAC keyed
 *  with '' is one anybody can compute. */
function signingSecretFor(subscription: InboundSubscription): string {
  return subscription.providerKey === 'INBOUND_WHATSAPP'
    ? (process.env.WHATSAPP_WEBHOOK_SECRET ?? '')
    : subscription.secret;
}

/** A built-in provider's subscription: verified by the frozen table, read by
 *  the adapter its provider key aliases. */
function builtInSource(subscription: InboundSubscription): InboundSource | null {
  // A built-in on a module line that declares its inbound is held to the
  // host's one rule for a declared signed inbound; the rest keep their door's.
  const verifier = builtinModuleInboundVerifier(subscription.providerKey) ?? LEGACY_SIGNATURE_HEADERS[subscription.providerKey];
  if (!verifier) return null;
  return {
    verifier,
    secret: signingSecretFor(subscription),
    async open() {
      const credentialsId = requireSubscriptionCredentials(subscription);
      // Provider keys are trigger-kind aliases (every provider key appears in its
      // adapter's manifest `triggerKinds`), so the registry's own alias map is the
      // resolver — NOT a naming convention (INBOUND_WHATSAPP is no slug).
      const adapterType = resolveAdapterSlug(subscription.providerKey);
      if (!hasAdapter(adapterType)) return null;
      const adapter = await resolveAdapter({
        adapterType,
        teamId: subscription.teamId as TeamId,
        credentialsId,
      });
      return { adapterType, credentialsId, adapter, ...builtInIntercept({ adapterType, subscription, credentialsId }) };
    },
  };
}

/** The button taps a built-in channel answers before its events. */
function builtInIntercept(input: {
  adapterType: string;
  subscription: InboundSubscription;
  credentialsId: string;
}): Pick<OpenedSource, 'intercept'> {
  // A Telegram button tap arrives on the same webhook as every message, as a
  // `callback_query`. It fires the callback it was wired to and acks Telegram;
  // there is no movement event in it, so the delivery ends there.
  if (input.adapterType === TELEGRAM_ADAPTER_TYPE) {
    return {
      async intercept(body) {
        if (!ownsCallbackQuery(body)) return 'continue';
        const { handled } = await handleTelegramCallbackQuery({
          raw: body,
          responder: new TelegramAdapter(input.subscription.teamId as TeamId, input.credentialsId),
        });
        return handled ? 'handled' : 'continue';
      },
    };
  }
  // A WhatsApp interactive reply is an ordinary message, and a delivery can
  // batch several, so a tap is fired here and the delivery carries on: the
  // adapter already drops an interactive message as unclassified, so it is
  // never dispatched twice.
  if (input.adapterType === WHATSAPP_ADAPTER_TYPE) {
    return {
      async intercept(body) {
        if (ownsWhatsappInteractiveReply(body)) {
          await handleWhatsappInteractiveReplies({ raw: body, responder: defaultWhatsappCallbackResponder() });
        }
        return 'continue';
      },
    };
  }
  return {};
}

/**
 * A subscription a team's remote install provisioned, recognised by its
 * provider key being the one that install mints (`webhookProviderKey`). An
 * install whose slug a built-in answers to is never recognised (the shared
 * rule in `remote/slugs`): the built-in wins, as it does at resolution. It
 * signs in the protocol's own header, and only that header. The row carries no
 * credential of its own; the install's credential is the channel's.
 */
async function remoteSource(subscription: InboundSubscription): Promise<InboundSource | null> {
  const installs = await listRemoteAdapters({ teamId: subscription.teamId as TeamId });
  const install = installs.find(
    (row) =>
      mayBeRemoteSlug(row.adapter_type) &&
      webhookProviderKey({ adapterType: row.adapter_type }) === subscription.providerKey,
  );
  if (!install) return null;
  return {
    verifier: { scheme: 'remote', signatureHeaders: ['x-listen-fire-signature'] },
    secret: subscription.secret,
    async open() {
      const credentialsId = install.credentials_id;
      if (credentialsId === null) {
        logger.error(`[webhook] remote adapter ${install.adapter_type} has no credential — delivery dropped`);
        return null;
      }
      const adapter = await resolveAdapter({
        adapterType: install.adapter_type,
        teamId: subscription.teamId as TeamId,
      });
      return { adapterType: install.adapter_type, credentialsId, adapter };
    },
  };
}

/** Inbound deliveries only exist for credentialed channels — a
 *  credential-free subscription row (the cron adapter's platform-internal
 *  registration) has no inbound URL traffic; reject loudly if one shows up. */
function requireSubscriptionCredentials(subscription: InboundSubscription): string {
  if (subscription.credentialsId === null) {
    throw new Error(
      `webhook subscription for provider '${subscription.providerKey}' carries no credential — inbound deliveries are not expected on credential-free channels`,
    );
  }
  return subscription.credentialsId;
}

/** The trigger matcher's view of a subscription, with the channel's credential. */
function subscriptionRow(subscription: InboundSubscription, source: OpenedSource) {
  return { team_id: subscription.teamId, credentials_id: source.credentialsId, provider: subscription.providerKey };
}

export const platformInboundStore: InboundStore<CapturedReceipts> = {
  async findSubscription(id) {
    const row = await getAutomationsQb(['webhook_subscription'])
      .selectFrom('webhook_subscription')
      .where('webhook_subscription.id', '=', id as WebhookSubscriptionId)
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
    if (!row) return null;
    return {
      id: row.id,
      teamId: row.team_id,
      providerKey: row.provider,
      credentialsId: row.credentials_id,
      secret: row.webhook_secret,
      checkpoint: row.inbound_checkpoint,
    };
  },

  knowsProvider: (providerKey) => getWebhookProvider(providerKey) !== null,

  intercepts: (providerKey) => LEGACY_INTERCEPTS[providerKey] ?? [],

  sourceFor: async (subscription) =>
    getWebhookProvider(subscription.providerKey) ? builtInSource(subscription) : remoteSource(subscription),

  // The dev-loop CLI fires synthetic webhooks at the pinned test team without a
  // real source signing them.
  verifiesSignature: (subscription) => !isTestHarnessTeam(subscription.teamId),

  capture: ({ event, subscription, source, eventTypes }) =>
    captureProviderTriggerEvents({
      event,
      subscription: subscriptionRow(subscription, source),
      adapterType: source.adapterType,
      eventTypes,
    }),

  async saveCheckpoint({ subscriptionId, checkpoint }) {
    await getAutomationsQb(['webhook_subscription'])
      .updateTable('webhook_subscription')
      .set({ inbound_checkpoint: jsonb(checkpoint) as never })
      .where('id', '=', subscriptionId as WebhookSubscriptionId)
      .execute();
  },

  enqueue: ({ captured, event, subscription, source }) =>
    enqueueCapturedInboundEvent({ event, receipts: captured, subscription: subscriptionRow(subscription, source) }),

  enqueueWakes: ({ adapterType, teamId, keys }) =>
    enqueueAwaitWakes({ adapterType, teamId: teamId as TeamId, correlationKeys: keys }),
};

interface HandleResult {
  ok: boolean;
  /** Events CAPTURED — durably receipted and ready to dispatch. */
  eventsProcessed: number;
  error?: string;
  /** Queue the delivery's work rows; awaited BEFORE the ack. Rejects when any
   *  receipt or wake could not be queued, so the door answers 500. */
  enqueueDeferred?: () => Promise<HarnessDelivery<DeferredOutcome>>;
  /** Test-harness subscriptions drain the rows before acking. */
  awaitDeferred?: boolean;
}

/** One delivery through the core over the platform store, without the HTTP
 *  answer (the door's route sends that; tests and scripts read this). */
async function handleInboundWebhook(options: {
  provider: string;
  subscriptionId: string;
  rawBody: Buffer;
  headers: InboundHeaders;
}): Promise<HandleResult> {
  const result = await receiveDelivery(platformInboundStore, {
    providerKey: options.provider,
    subscriptionId: options.subscriptionId,
    rawBody: options.rawBody,
    headers: options.headers,
  });
  if (!result.ok) return { ok: false, eventsProcessed: 0, error: result.error };
  const { queue } = result;
  return {
    ok: true,
    eventsProcessed: result.eventsProcessed,
    ...(queue ? { enqueueDeferred: () => queueForHarness(queue) } : {}),
    ...(result.drainFirst ? { awaitDeferred: true } : {}),
  };
}

/**
 * Phase 2 for ONE event: queue a linked_object refresh when a KG node is
 * bridged to the record it names, and a run per stored receipt. The rows are
 * independent; none makes a live provider read inside the request.
 */
async function enqueueCapturedInboundEvent(input: {
  event: DiscriminableEvent;
  receipts: CapturedReceipts;
  subscription: { team_id: string; credentials_id: string; provider: string };
}): Promise<void> {
  const { event, receipts, subscription } = input;

  // The cache refresh is its own row, owed whether or not any trigger matched.
  const { externalId, recordType, idempotencyKey } = event;
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

  await enqueueCapturedEvents(receipts);
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
