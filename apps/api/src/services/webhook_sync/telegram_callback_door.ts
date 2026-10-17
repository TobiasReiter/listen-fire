// Telegram's door onto the callback router.
//
// Telegram delivers everything to a bot's single webhook, so a button tap is
// not a new route — it is an update whose `callback_query` carries the
// `callback_data` the author wired into the button. When that data is a
// callback id, it goes to the router; when it isn't, the update flows on
// untouched (a bot may have buttons of its own that are none of our business).
//
// Legacy ask answer links stay RECOGNISED for movements authored before
// callbacks — tried after the prefix check, no longer taught — and retire once
// those are re-authored.
//
// Two things Telegram makes MANDATORY, both of them acks:
//   • `answerCallbackQuery` — the tapper's client shows a spinner on the button
//     until this lands. It is sent on EVERY outcome, including the ones that
//     changed nothing, and even when the fire threw.
//   • `editMessageReplyMarkup` — the keyboard is retired only when the tap
//     SERVED the message (`interactionServed`, the shared rule). Closed-request-
//     wins: a late tap on a settled question gets the notice and the keyboard
//     STAYS, because whoever acted first owns the message. A repeatable
//     callback's keyboard stays for the same reason from the other direction —
//     it is still live.
//
// It lives HERE, in the inbound layer, and not in `adapters/telegram` — a
// platform adapter must know nothing about callbacks or questions, and neither
// must know about platforms. Only the layer that already composes both (this
// one: Telegram's webhook door) may see them at once. Slack's equivalent is
// `interfaces/rest/slackInteractivity.ts`, an actual route because Slack POSTs
// interactivity to its own URL; Telegram delivers taps on the SAME webhook as
// every message, so its composition point is the webhook handler.

import { z } from 'zod';

import { logger } from 'movement-engine/public/log';
import { answerAskByToken, type AskDoorOutcome } from '../translation_graph/adapters/ask/answer_door';
import { parseAskLink } from '../translation_graph/adapters/ask/answer_link';
import { isCallbackId } from '../movement_engine/callback_store';
import {
  callbackAckText,
  fireCallback,
  interactionServed,
  type CallbackFireOutcome,
} from '../movement_engine/callback_fire';

/** What the door needs of a bot: the two Bot API calls that close a tap.
 *  `TelegramAdapter` satisfies it structurally — narrow on purpose, so the door
 *  depends on the two calls rather than on the whole adapter, and the adapter
 *  never has to name (and so never has to import) this door. */
export interface TelegramCallbackResponder {
  answerCallbackQuery(input: { callbackQueryId: string; text?: string }): Promise<void>;
  clearReplyMarkup(input: { chatId: string; messageId: number }): Promise<void>;
}

const callbackQuerySchema = z
  .object({
    id: z.string(),
    data: z.string().optional(),
    // Absent for a tap on an inline-mode message (`inline_message_id` instead),
    // which we can still ack but cannot edit.
    message: z
      .object({
        message_id: z.number(),
        chat: z.object({ id: z.union([z.number(), z.string()]) }).passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const callbackUpdateSchema = z
  .object({ callback_query: callbackQuerySchema.optional() })
  .passthrough();

export type TelegramCallbackQuery = z.infer<typeof callbackQuerySchema>;

/** The `callback_query` off a raw update, or null when the update is anything
 *  else (a message, an edit, a poll answer — every other delivery). */
export function callbackQueryOf(raw: unknown): TelegramCallbackQuery | null {
  const parsed = callbackUpdateSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.callback_query ?? null;
}

/** Whether this delivery is a button tap this door owns — a callback id, or
 *  (legacy) an ask answer link. Cheap and side-effect free, so a caller can ask
 *  before resolving a bot token. */
export function ownsCallbackQuery(raw: unknown): boolean {
  const query = callbackQueryOf(raw);
  if (query === null || query.data === undefined) return false;
  return isCallbackId(query.data) || parseAskLink(query.data) !== null;
}

export interface TelegramCallbackResult {
  /** The door consumed this delivery — no movement event to parse from it. */
  handled: boolean;
  outcome?: CallbackFireOutcome['kind'] | AskDoorOutcome['kind'] | 'malformed';
}

/**
 * Resolve a button tap. Returns `{ handled: false }` for every delivery whose
 * `callback_data` this door does not recognise, so the caller's existing path
 * runs unchanged; `{ handled: true }` means the tap was ours and has been acked.
 *
 * Recognition is the callback prefix FIRST, then the legacy ask answer link.
 * Telegram captures nothing at tap time — an inline button's `callback_data` is
 * fixed when the message is sent — so a callback fired from here supplies no
 * values, and a callback that declares parameters is refused loudly by the
 * router (the author wanted a control Telegram does not have).
 */
export async function handleTelegramCallbackQuery(input: {
  raw: unknown;
  responder: TelegramCallbackResponder;
}): Promise<TelegramCallbackResult> {
  const query = callbackQueryOf(input.raw);
  if (!query || query.data === undefined) return { handled: false };

  if (isCallbackId(query.data)) return await fireAndAck(input.responder, query, query.data);

  const link = parseAskLink(query.data);
  if (!link) return { handled: false };

  // LEGACY: a tap whose data carries an ask token but NO `?answer=` is
  // malformed — the author wired a bare link into `callback_data`, where nothing
  // supplies a value. It is ours, so it is acked and logged loudly rather than
  // left spinning or dropped in silence.
  if (link.answer === undefined) {
    logger.warn('[telegram/callback] callback_data carries a question token but no answer', {
      callbackQueryId: query.id,
    });
    await ack(input.responder, query, 'That button could not be read.');
    return { handled: true, outcome: 'malformed' };
  }

  let outcome: AskDoorOutcome;
  try {
    outcome = await answerAskByToken(link.token, link.answer);
  } catch (err) {
    // The ack still has to go out — a spinning client is worse than a failure
    // the person can see — but the failure itself is not swallowed.
    logger.error('[telegram/callback] answering failed', err);
    await ack(input.responder, query, 'Something went wrong recording that answer.');
    return { handled: true, outcome: 'not_found' };
  }

  await ack(input.responder, query, ackText(outcome));
  if (outcome.kind === 'answered') await retireKeyboard(input.responder, query);

  return { handled: true, outcome: outcome.kind };
}

/** The callback path: fire, ack the toast, and retire the keyboard when the tap
 *  served the message. Telegram supplies no tap-time value, so `values` is
 *  empty — the router is the one that decides whether that fits the signature. */
async function fireAndAck(
  responder: TelegramCallbackResponder,
  query: TelegramCallbackQuery,
  id: string,
): Promise<TelegramCallbackResult> {
  let outcome: CallbackFireOutcome;
  try {
    outcome = await fireCallback({ id, values: {} });
  } catch (err) {
    // The ack still has to go out — a spinning client is worse than a failure
    // the person can see — but the failure itself is not swallowed.
    logger.error('[telegram/callback] firing failed', err);
    await ack(responder, query, 'Something went wrong recording that.');
    return { handled: true, outcome: 'not_found' };
  }

  await ack(responder, query, callbackAckText(outcome));
  if (interactionServed(outcome)) await retireKeyboard(responder, query);

  return { handled: true, outcome: outcome.kind };
}

/** Editing the keyboard away is COSMETIC — the fire is already recorded, and a
 *  second tap on a stale keyboard gets the "already closed" notice — so a
 *  failure here is a warning, never the tapper's problem. Nothing to edit on an
 *  inline-mode message, which has no `message` to address. */
async function retireKeyboard(
  responder: TelegramCallbackResponder,
  query: TelegramCallbackQuery,
): Promise<void> {
  if (!query.message) return;
  try {
    await responder.clearReplyMarkup({
      chatId: String(query.message.chat.id),
      messageId: query.message.message_id,
    });
  } catch (err) {
    logger.warn('[telegram/callback] retiring the keyboard failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** LEGACY: a token this store never minted reads to the tapper exactly like a
 *  settled one: nothing moved, and the message says so. */
function ackText(outcome: AskDoorOutcome): string {
  switch (outcome.kind) {
    case 'answered':
      return 'Thanks — your answer was recorded.';
    case 'invalid':
      return `That answer could not be accepted: ${outcome.message}`;
    case 'closed':
    case 'not_found':
    case 'not_ours':
      return 'This request was already closed.';
  }
}

async function ack(
  responder: TelegramCallbackResponder,
  query: TelegramCallbackQuery,
  text: string,
): Promise<void> {
  try {
    await responder.answerCallbackQuery({ callbackQueryId: query.id, text });
  } catch (err) {
    logger.warn('[telegram/callback] answerCallbackQuery failed', {
      callbackQueryId: query.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
