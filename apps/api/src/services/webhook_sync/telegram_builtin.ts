// Shared built-in Telegram bot — the SINGLE global inbound entry.
//
// Unlike BYO Telegram (one webhook subscription per team, the team implied by
// the subscription row in the URL), the shared bot is ONE bot serving every
// team. There is no per-team subscription URL; routing is by SENDER IDENTITY:
//
//   1. `/start <token>` — the deep-link handshake. The ONLY action an UNLINKED
//      user may drive. Bind the real Telegram account to the minting user's
//      Listen-Fire identity (`bindTelegramFromStart`), then reply through the
//      built-in bot ("✅ Linked, <name>." / a friendly reject). Done.
//
//   2. A message from a LINKED sender. Resolve `telegram_user_id` → EVERY
//      `adapters.telegram_identity` row with that id → the set of `(team_id)`
//      bindings (a user may be linked in several teams). For each such team,
//      dispatch the message into that team via the existing per-team trigger
//      fan-out (`captureProviderTriggerEvents` + `enqueueCapturedEvents`),
//      run AS that user (the per-team `extractActor` resolves the binding within
//      its own team → the team-clamped `lookupTeamUserByEmail` → ActingUser).
//      Route-all across teams.
//
// CAPTURE-THEN-ACK. Telegram redelivers anything it doesn't get a prompt 2xx
// for, so the movement dispatch must not sit inside the request. The message
// branch splits around the ack: routing + durable receipts pre-ack (phase 1,
// here), then a work row per receipt (phase 2, the returned `enqueueDeferred`,
// which the route awaits before its 200); the movement runs when the row drains.
// `/start` stays wholly pre-ack — see `handleStart`.
//
//   3. An UNLINKED sender (no identity row) that isn't `/start` → ignore
//      silently (the spam gate). A reply-to-bot → classified but no-op in v1.
//
// SECURITY INVARIANTS (Pillar B0 + C):
//   • A team only ever sees a message from a user IT has a binding for — the
//     `telegram_identity` rows ARE the gate. We fan out to exactly the teams
//     whose rows match the sender; a team with no row never receives the event.
//   • The adapter never picks the team — the binding rows do. The adapter only
//     asserts "this is person E"; the framework owns team-routing.
//   • The downstream `lookupTeamUserByEmail` clamp (`u.team_id = teamId`) stays
//     in force: the per-team `extractActor` resolves the binding scoped to that
//     team, so a resolved email can only ever match a user in the SAME team.

import type { TeamId } from '../../generated/kysely/core/Team';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from '../logger';
import {
  parseTelegramEvents,
  telegramEventToDiscriminable,
} from '../translation_graph/adapters/telegram';
import type { WebhookEvent } from './providers';
import { captureProviderTriggerEvents } from './handler';
import {
  enqueueCapturedEvents,
  loadFailedReceipts,
  type CapturedTriggerEvent,
} from '../translation_graph/triggers/dispatch_event';
import { isTestHarnessTeam } from '../../lib/recording';
import {
  TELEGRAM_ADAPTER_TYPE,
  TelegramAdapter,
} from '../translation_graph/adapters/telegram';
import { bindTelegramFromStart } from '../translation_graph/adapters/telegram/handshake';
import { handleTelegramCallbackQuery, ownsCallbackQuery } from './telegram_callback_door';

/** The provider key webhook dispatch routes Telegram triggers by. */
const TELEGRAM_PROVIDER_KEY = 'TELEGRAM';

/** A parsed shared-bot inbound `Update`, classified for routing. */
type SharedBotInbound =
  | { kind: 'start'; token: string; telegramUserId: string; chatId: string; senderName?: string }
  | { kind: 'message'; telegramUserId: string; event: WebhookEvent }
  | { kind: 'callback_query' }
  | { kind: 'reply_to_bot' }
  | { kind: 'ignore' };

export interface SharedBotResult {
  ok: boolean;
  /** Coarse classification of what the inbound was — surfaced for the dev loop.
   *  `unauthorized` is produced by the route's secret-token gate (the request
   *  could not be proven to come from Telegram) BEFORE this service runs. */
  classification:
    | 'start'
    | 'message'
    | 'callback_query'
    | 'reply_to_bot'
    | 'unlinked_ignore'
    | 'no_message'
    | 'unauthorized';
  /** For `/start`: whether the bind succeeded + the reject reason if not. */
  bind?: { ok: boolean; reason?: string; email?: string };
  /** For a button tap: how the answer door settled it. */
  callback?: { handled: boolean; outcome?: string };
  /** For a linked message: the teams the message fanned out to. Pre-ack this is
   *  the teams whose receipts were stored (routing is settled by then); the
   *  deferred half narrows it to the teams that dispatched cleanly. */
  routedTeamIds?: string[];
  error?: string;
}

/**
 * One shared-bot delivery, split around the ack.
 *
 * `result` is everything settled before any movement runs — the body the door
 * answers Telegram with. `enqueueDeferred` queues the movement runs, which the
 * door awaits before its 200.
 */
export interface SharedBotDelivery {
  result: SharedBotResult;
  /**
   * Phase 2: a work row for every receipt captured in phase 1. Absent when the
   * delivery carried nothing to run (`/start`, an ignore, an unlinked sender).
   * Never rejects for a per-team failure — those are logged and shown as a
   * narrowed `routedTeamIds` — but the caller still guards an unexpected throw.
   */
  enqueueDeferred?: () => Promise<EnqueuedSharedBotDelivery>;
  /**
   * Test-harness deliveries drain the rows before acking, so `pnpm dev:inject
   * telegram-builtin` keeps seeing the run happen synchronously (and dispatch
   * errors surfaced) the way it always has.
   */
  awaitDeferred?: boolean;
}

/** What `enqueueDeferred` queued; `readOutcome` once the rows have drained. */
export interface EnqueuedSharedBotDelivery {
  /** The teams whose rows were queued — what a waiting door waits on. */
  teamIds: string[];
  readOutcome(): Promise<SharedBotResult>;
}

/**
 * Resolve the team used purely to construct the built-in client for the
 * `/start` confirmation reply. The built-in bot token is env-global, so the
 * team only governs the fake-base-url swap under the dev loop. We use the
 * test-harness team when set (so the reply lands in the fake outbox), else a
 * synthetic id (the real Telegram host applies in production).
 */
function replyClientTeamId(): TeamId {
  const harness = process.env.TEST_HARNESS_TEAM_ID;
  return ((harness && harness.length > 0 ? harness : 'shared-telegram-bot') as unknown) as TeamId;
}

/**
 * Parse + classify a raw shared-bot `Update`. The classification picks the
 * route; the heavy lifting (binding, fan-out) happens in the entry below.
 *
 * `/start <token>` is detected on the raw message text BEFORE the provider's
 * `parseEvents` (which is the per-message normaliser) — a `/start` is a control
 * command, not a movement-bearing message.
 */
export function classifySharedBotInbound(raw: unknown): SharedBotInbound {
  // A button tap is a `callback_query`, never a `message` — classify it first
  // so it can never be mistaken for one, and so nothing downstream of the
  // message path has to know it exists.
  if (ownsCallbackQuery(raw)) return { kind: 'callback_query' };

  const update = (raw ?? {}) as {
    message?: {
      text?: string;
      from?: { id?: number | string; first_name?: string; username?: string; is_bot?: boolean };
      chat?: { id?: number | string };
      reply_to_message?: { from?: { is_bot?: boolean } };
    };
  };
  const message = update.message;
  if (!message || !message.from) return { kind: 'ignore' };

  const telegramUserId = String(message.from.id ?? '');
  if (telegramUserId.length === 0) return { kind: 'ignore' };

  // A reply to one of OUR bot's messages — classified, but no-op in v1.
  if (message.reply_to_message?.from?.is_bot === true) {
    return { kind: 'reply_to_bot' };
  }

  // `/start <token>` — the handshake. `/start` with no token is a plain greet
  // (no binding to do) → fall through to the message path (which ignores it if
  // the sender is unlinked).
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const startMatch = /^\/start(?:@\w+)?\s+(\S+)/.exec(text);
  if (startMatch) {
    return {
      kind: 'start',
      token: startMatch[1],
      telegramUserId,
      chatId: String(message.chat?.id ?? ''),
      senderName: message.from.first_name ?? message.from.username,
    };
  }

  // A normal message. Re-use the adapter's pure parse so the event payload is
  // byte-identical to the BYO door (whose `preprocessInbound` runs the same
  // function — the adapter reads `chat_id`/`text`/`sender_*` off `data`).
  const events = parseTelegramEvents(raw);
  if (events.length === 0) return { kind: 'ignore' };
  return { kind: 'message', telegramUserId, event: events[0] };
}

/**
 * Every team that has a binding for this Telegram user. The identity rows are
 * the routing gate: each `(team_id, telegram_user_id, email)` row means that
 * team consented (via the authenticated handshake) to receive this sender's
 * messages. A team with no row is never returned — structural isolation.
 */
async function teamsForTelegramUser(telegramUserId: string): Promise<string[]> {
  const rows = await getAutomationsQb(['telegram_identity'])
    .selectFrom('telegram_identity')
    .where('telegram_user_id', '=', telegramUserId)
    .select(['team_id'])
    .execute();
  // De-dupe defensively (UNIQUE(team_id, telegram_user_id) already guarantees
  // one row per team, but distinct teams are what we fan out over).
  return Array.from(new Set(rows.map((r) => r.team_id as string)));
}

/**
 * The shared-bot inbound entry. ONE global call per delivered `Update`;
 * performs the identity-based fan-out (or the `/start` handshake) instead of
 * the per-subscription single-team dispatch. BYO inbound is untouched — it
 * still flows through `handleInboundWebhook` keyed by its subscription row.
 *
 */
export async function handleSharedBotInbound(raw: unknown): Promise<SharedBotDelivery> {
  const inbound = classifySharedBotInbound(raw);

  if (inbound.kind === 'ignore') {
    return { result: { ok: true, classification: 'no_message' } };
  }

  if (inbound.kind === 'callback_query') {
    // Wholly pre-ack, like `/start`: settling the question is one DB write and
    // two Bot API calls, and the tapper's client spins until the first of them
    // lands. The run parked on the question resumes on its own.
    const result = await handleTelegramCallbackQuery({
      raw,
      responder: new TelegramAdapter(replyClientTeamId()),
    });
    return {
      result: {
        ok: true,
        classification: 'callback_query',
        callback: { handled: result.handled, ...(result.outcome ? { outcome: result.outcome } : {}) },
      },
    };
  }

  if (inbound.kind === 'reply_to_bot') {
    // v1: classify but no-op. Reply-threading / run-resume is phase 2.
    logger.info('[TelegramSharedBot] reply-to-bot — no-op in v1');
    return { result: { ok: true, classification: 'reply_to_bot' } };
  }

  if (inbound.kind === 'start') {
    // Wholly pre-ack: the bind is a single locked DB write and the confirmation
    // reply is one Bot API call. Neither is a movement run, and the bind result
    // IS the response body — deferring would ack an outcome we don't have yet.
    return { result: await handleStart(inbound) };
  }

  // A normal message from a (maybe) linked sender.
  const teamIds = await teamsForTelegramUser(inbound.telegramUserId);
  if (teamIds.length === 0) {
    // Unlinked sender + not `/start` → ignore silently (the spam gate).
    logger.info('[TelegramSharedBot] unlinked sender — ignoring', {
      telegramUserId: inbound.telegramUserId,
    });
    return { result: { ok: true, classification: 'unlinked_ignore' } };
  }

  // Phase 1 — route-all capture. Fan the SAME event into every team that has a
  // binding for this sender and store that team's durable receipts. Each team
  // is independent; one team's failure doesn't abort the others.
  const event = telegramEventToDiscriminable(inbound.event);
  const captures: { teamId: string; receipts: CapturedTriggerEvent[] }[] = [];
  for (const teamId of teamIds) {
    try {
      const receipts = await captureProviderTriggerEvents({
        event,
        // No per-subscription credential — the shared built-in bot received
        // this globally. Each matched trigger dispatches with its OWN
        // credential (the send identity), falling back to the env built-in
        // token when it has none.
        subscription: { team_id: teamId, credentials_id: null, provider: TELEGRAM_PROVIDER_KEY },
        adapterType: TELEGRAM_ADAPTER_TYPE,
        // The shared bot receives globally — a trigger's credential is its send
        // identity, not an inbound gate. Don't narrow candidates by credential.
        //
        // STILL LOAD-BEARING after Chunk 7. A connected team's `listen to
        // telegram` trigger now pins a real (empty) TELEGRAM credential id, but
        // the shared bot has no per-subscription credential — this dispatch
        // passes `credentials_id: null`. Without this opt-out the candidate
        // filter (`trigger.credentialsId !== null`) would drop every connected
        // team's telegram trigger and nothing would fire. The empty credential
        // is the team's CONNECT signal + the construction handle, not an inbound
        // routing key; identity-based fan-out (the telegram_identity rows) is
        // the real gate, so matching any credential here is correct.
        matchAnyCredential: true,
      });
      captures.push({ teamId, receipts });
    } catch (err) {
      logger.error('[TelegramSharedBot] capture failed for team', {
        teamId,
        telegramUserId: inbound.telegramUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 2 — queue the movement runs, in the same per-team isolation.
  const enqueueDeferred = async (): Promise<EnqueuedSharedBotDelivery> => {
    const enqueued: typeof captures = [];
    for (const capture of captures) {
      try {
        await enqueueCapturedEvents(capture.receipts);
        enqueued.push(capture);
      } catch (err) {
        logger.error('[TelegramSharedBot] enqueue failed for team', {
          teamId: capture.teamId,
          telegramUserId: inbound.telegramUserId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      teamIds: enqueued.map(({ teamId }) => teamId),
      readOutcome: () => readSharedBotOutcome(enqueued),
    };
  };

  return {
    result: {
      ok: true,
      classification: 'message',
      routedTeamIds: captures.map((c) => c.teamId),
    },
    enqueueDeferred,
    ...(teamIds.some(isTestHarnessTeam) ? { awaitDeferred: true } : {}),
  };
}

/** A team dispatched cleanly unless one of its receipts settled `failed`. */
async function readSharedBotOutcome(
  enqueued: { teamId: string; receipts: CapturedTriggerEvent[] }[],
): Promise<SharedBotResult> {
  const receiptIds = enqueued.flatMap(({ receipts }) =>
    receipts.flatMap((r) => (r.storedEventId !== undefined ? [r.storedEventId] : [])),
  );
  const failed = await loadFailedReceipts(receiptIds);
  const dispatched = enqueued
    .filter(({ receipts }) =>
      receipts.every((r) => r.storedEventId === undefined || !failed.has(r.storedEventId)),
    )
    .map(({ teamId }) => teamId);
  return { ok: true, classification: 'message', routedTeamIds: dispatched };
}

/**
 * The `/start <token>` handshake half. Validates + consumes the token, writes
 * the identity binding, and replies through the built-in bot. The reply is
 * best-effort: a send failure (e.g. no `TELEGRAM_BOT_TOKEN`) doesn't undo a
 * successful bind — the bind is the durable, security-relevant act.
 */
async function handleStart(
  inbound: Extract<SharedBotInbound, { kind: 'start' }>,
): Promise<SharedBotResult> {
  const result = await bindTelegramFromStart({
    token: inbound.token,
    telegramUserId: inbound.telegramUserId,
  });

  const reply = result.ok
    ? `✅ Linked, ${inbound.senderName ?? 'there'}. Your Telegram is now connected to Listen-Fire.`
    : rejectMessage(result.reason);

  if (inbound.chatId.length > 0) {
    try {
      const adapter = new TelegramAdapter(replyClientTeamId());
      await adapter.sendBuiltInReply({ chatId: inbound.chatId, text: reply });
    } catch (err) {
      logger.warn('[TelegramSharedBot] handshake reply send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    classification: 'start',
    bind: result.ok
      ? { ok: true, email: result.email }
      : { ok: false, reason: result.reason },
  };
}

/** A friendly, non-leaky reject for a failed `/start`. */
function rejectMessage(reason: string): string {
  switch (reason) {
    case 'token_expired':
      return '⚠️ That link has expired. Open Listen-Fire and click "Connect Telegram" again for a fresh link.';
    case 'token_used':
      return '⚠️ That link was already used. Generate a new one from Listen-Fire if you need to re-link.';
    case 'token_not_found':
      return '⚠️ That link is not valid. Start from the "Connect Telegram" button in Listen-Fire.';
    case 'no_primary_email':
      return '⚠️ We could not find an email on your Listen-Fire account to link. Contact support.';
    default:
      return '⚠️ We could not complete linking. Please try again from Listen-Fire.';
  }
}
