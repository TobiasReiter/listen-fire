// WhatsApp's door onto the callback router.
//
// A button tap arrives as an ordinary MESSAGE-typed update — `interactive.
// button_reply` (or `list_reply`) carrying the id the author wired into the
// send — never a dedicated update kind the way Telegram's `callback_query` is.
// So this door does not own a delivery the way Telegram's does; it owns
// INDIVIDUAL MESSAGES within one, and a single Meta delivery can batch several
// messages. When a message's reply id is a callback id, it goes to the
// router; every other message — a callback-less button of the author's own,
// or a plain message — is left for the caller's normal handling, unaffected.
//
// PLATFORM-FORCED RULING (plans/callback-primitive-2026-07-31/
// 4_doors_and_migration.md): WhatsApp cannot edit a message it already sent,
// and there is no toast — the ONLY feedback channel is a message. So the ack
// IS a reply, threaded to the tapped message via Meta's `context.message_id`,
// on EVERY outcome. `interactionServed` (the shared after-effect predicate)
// adds nothing here: there is no keyboard or control to retire the way
// Slack's `replace_original` or Telegram's `editMessageReplyMarkup` do — a
// single-use callback's buttons simply stay exactly as they were sent, and a
// second tap gets its own "already closed" reply.
//
// It lives HERE, in the inbound layer, and not in `adapters/whatsapp` — a
// platform adapter must know nothing about callbacks, and neither must know
// about platforms. The send client this door acks through
// (`services/whatsapp/metaApi.ts`) is the SAME generic, credential-free send
// capability the adapter itself uses (keyed by the receiving NUMBER, not a
// per-team credential) — see `defaultWhatsappCallbackResponder` below — so
// shared and BYO deliveries ack identically with no separate wiring.

import { z } from 'zod';

import { logger } from 'movement-engine/services/logger';
import { getMetaWhatsappApi } from '../whatsapp/metaApi';
import { isCallbackId } from '../movement_engine/callback_store';
import {
  callbackAckText,
  fireCallback,
  type CallbackFireOutcome,
} from '../movement_engine/callback_fire';

/** What the door needs to ack a tap: send ONE reply, from the number that
 *  received it, threaded to the tapped message. Narrow on purpose — the door
 *  depends on this one call, not on the whole send client. */
export interface WhatsappCallbackResponder {
  sendReply(input: {
    to: string;
    text: string;
    businessPhoneNumberId?: string;
    replyToMessageId: string;
  }): Promise<void>;
}

/** The default responder — the generic Meta send client, keyed by the
 *  RECEIVING number. WhatsApp's send identity is the number, never a
 *  per-team credential (there is no per-team WhatsApp credential to resolve —
 *  every send, shared or BYO-routed, goes out through this same registry;
 *  mirrors `WhatsappAdapter.apiFor`), so both doors below share one
 *  implementation. */
export function defaultWhatsappCallbackResponder(): WhatsappCallbackResponder {
  return {
    async sendReply({ to, text, businessPhoneNumberId, replyToMessageId }) {
      await getMetaWhatsappApi(businessPhoneNumberId).sendTextMessage(to, text, {
        replyToMessageId,
      });
    },
  };
}

// ── Recognition (self-contained — mirrors, never imports, the provider's own
//    envelope parsing, so this door's currency can evolve independently) ────

const interactiveReplySchema = z
  .object({
    button_reply: z.object({ id: z.string() }).passthrough().optional(),
    list_reply: z.object({ id: z.string() }).passthrough().optional(),
  })
  .passthrough();

const metaMessageSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    interactive: interactiveReplySchema.optional(),
  })
  .passthrough();

const metaChangeSchema = z
  .object({
    field: z.string().optional(),
    value: z
      .object({
        metadata: z
          .object({ phone_number_id: z.string().optional() })
          .passthrough()
          .optional(),
        messages: z.array(metaMessageSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const metaWebhookSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(z.object({ changes: z.array(metaChangeSchema).optional() }).passthrough()).optional(),
  })
  .passthrough();

/** One interactive button/list reply, whatever id it carries — not yet
 *  filtered to callback ids, so `ownsWhatsappInteractiveReply` and the
 *  handler below can share the same extraction. */
export interface WhatsappInteractiveReply {
  messageId: string;
  from: string;
  replyId: string;
  businessPhoneNumberId?: string;
}

/**
 * Every interactive button/list reply carried by a raw Meta delivery. A
 * delivery can batch more than one message — unlike Telegram's one-update-
 * per-tap `callback_query`, so this returns a list rather than a single query.
 */
export function interactiveRepliesOf(raw: unknown): WhatsappInteractiveReply[] {
  const parsed = metaWebhookSchema.safeParse(raw);
  if (!parsed.success) return [];
  const replies: WhatsappInteractiveReply[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const businessPhoneNumberId = change.value.metadata?.phone_number_id;
      for (const message of change.value.messages ?? []) {
        const replyId =
          message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
        if (replyId === undefined) continue;
        replies.push({
          messageId: message.id,
          from: message.from,
          replyId,
          ...(businessPhoneNumberId !== undefined ? { businessPhoneNumberId } : {}),
        });
      }
    }
  }
  return replies;
}

/** Whether this delivery carries at least one button/list reply this door
 *  owns — a callback id. Cheap and side-effect free, mirroring Telegram's
 *  `ownsCallbackQuery`. */
export function ownsWhatsappInteractiveReply(raw: unknown): boolean {
  return interactiveRepliesOf(raw).some((r) => isCallbackId(r.replyId));
}

export interface WhatsappCallbackResult {
  replyId: string;
  outcome: CallbackFireOutcome['kind'];
}

/**
 * Resolve every callback-id button/list reply in this delivery — fire, then
 * ack. Non-callback ids never appear in the result: someone's own button
 * vocabulary is left for the caller's normal message handling, untouched.
 *
 * WhatsApp supplies no tap-time value (unlike Slack's date/time pickers), so
 * every fire carries `values: {}`; a parameterized callback's tap is refused
 * loudly by the router (`fireCallback`'s own `mismatch`), never a silent drop.
 */
export async function handleWhatsappInteractiveReplies(input: {
  raw: unknown;
  responder: WhatsappCallbackResponder;
}): Promise<WhatsappCallbackResult[]> {
  const replies = interactiveRepliesOf(input.raw).filter((r) => isCallbackId(r.replyId));
  const results: WhatsappCallbackResult[] = [];
  for (const reply of replies) {
    results.push(await fireAndAck(input.responder, reply));
  }
  return results;
}

async function fireAndAck(
  responder: WhatsappCallbackResponder,
  reply: WhatsappInteractiveReply,
): Promise<WhatsappCallbackResult> {
  let outcome: CallbackFireOutcome;
  try {
    outcome = await fireCallback({ id: reply.replyId, values: {} });
  } catch (err) {
    // The ack still has to go out — a tapper left with no reply at all is
    // worse than a failure they can see — but the failure itself is not
    // swallowed.
    logger.error('[whatsapp/callback] firing failed', {
      replyId: reply.replyId,
      error: err instanceof Error ? err.message : String(err),
    });
    await ack(responder, reply, 'Something went wrong recording that.');
    return { replyId: reply.replyId, outcome: 'not_found' };
  }

  await ack(responder, reply, callbackAckText(outcome));
  return { replyId: reply.replyId, outcome: outcome.kind };
}

async function ack(
  responder: WhatsappCallbackResponder,
  reply: WhatsappInteractiveReply,
  text: string,
): Promise<void> {
  try {
    await responder.sendReply({
      to: reply.from,
      text,
      ...(reply.businessPhoneNumberId !== undefined
        ? { businessPhoneNumberId: reply.businessPhoneNumberId }
        : {}),
      replyToMessageId: reply.messageId,
    });
  } catch (err) {
    logger.warn('[whatsapp/callback] ack reply send failed', {
      replyId: reply.replyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
