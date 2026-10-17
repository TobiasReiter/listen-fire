// Telegram adapter — target/write side (message-write-unification chunk 3).
// ONE message type (`telegram:message`), readable and writable, created only
// along edges:
//
//   Linked User -[:Messages]-> Telegram Message  — a proactive DM
//                                                   (chat id = the linked
//                                                   user's own id)
//   msg         -[:Replies]->  Telegram Message  — a threaded reply
//
// `chat_id` is never a field and `reply_to_message_id` is never exposed:
// parentage supplies both (the parent link's externalId + data — design
// §5.2). Un-threaded sends into an arbitrary chat id / @channelusername
// died with the `telegram:send-message` sentinel — regression accepted
// (design §6.4 resolution 3); a group send anchors on the inbound message
// that addressed the bot.

import type { WriteResult } from 'movement-engine/public/adapter';
import type { ModuleLog } from 'module-kit';

import { TELEGRAM_ADAPTER_TYPE } from './types';

// ── Base-URL-aware Bot API client ───────────────────────────────────────────
// The real base is `https://api.telegram.org/bot<token>`; under the dev loop
// the adapter swaps in the fake-channels base (`injectFakeBaseUrl(creds,
// 'TELEGRAM')` sets `creds.baseUrl` to `${FAKE_CHANNELS_URL}/telegram`). The
// client takes the resolved base + bot token and issues `<base>/bot<token>/
// <METHOD>` calls — so implementer 2 can point it at the fake by setting the
// baseUrl, exactly like Slack's `slackApiUrl`.

export const TELEGRAM_REAL_BASE_URL = 'https://api.telegram.org';

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export interface TelegramSentMessage {
  message_id: number;
  chat?: { id: number };
  date?: number;
  text?: string;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface SendMessageArgs {
  chat_id: string;
  text: string;
  reply_to_message_id?: number;
  /** Telegram's own `reply_markup`, verbatim — an inline keyboard, a reply
   *  keyboard, whatever the author assembled. Never inspected here. */
  reply_markup?: unknown;
}

export interface AnswerCallbackQueryArgs {
  callback_query_id: string;
  /** Shown to the tapper as a transient toast. Telegram caps it at 200
   *  characters. */
  text?: string;
}

export interface EditReplyMarkupArgs {
  chat_id: string;
  message_id: number;
  /** Omitted entirely to REMOVE the keyboard (Telegram's documented way). */
  reply_markup?: unknown;
}

/**
 * Minimal Telegram Bot API client. Base-URL-aware: `baseUrl` defaults to the
 * real Telegram host but the adapter passes the fake-channels base under the
 * dev loop. Bytes-free — text send + the `getFile` lookup `resolveFileRef`
 * needs. Built fresh per write (no cross-team token caching) to keep the bot
 * token scoped to the call.
 */
export class TelegramClient {
  private readonly base: string;

  constructor(
    private readonly botToken: string,
    baseUrl: string | undefined,
    /** The host's fetch: every Bot API call and file download goes through it. */
    readonly fetch: typeof globalThis.fetch,
  ) {
    this.base = (baseUrl ?? TELEGRAM_REAL_BASE_URL).replace(/\/+$/, '');
  }

  /** The fully-qualified method URL: `<base>/bot<token>/<method>`. */
  methodUrl(method: string): string {
    return `${this.base}/bot${this.botToken}/${method}`;
  }

  /** The bytes URL for a resolved `file_path`: `<base>/file/bot<token>/<path>`.
   *  (Telegram serves file bytes from a `/file/bot<token>/` prefix, distinct
   *  from the method prefix.) */
  fileUrl(filePath: string): string {
    return `${this.base}/file/bot${this.botToken}/${filePath}`;
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await this.fetch(this.methodUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const envelope = (await res.json()) as TelegramApiEnvelope<T>;
    if (!res.ok || !envelope.ok || envelope.result === undefined) {
      throw new Error(
        `Telegram ${method} failed (status ${res.status}, code ` +
          `${envelope.error_code ?? 'n/a'}): ${envelope.description ?? 'unknown error'}`,
      );
    }
    return envelope.result;
  }

  /** Post a message to a chat. */
  async sendMessage(args: SendMessageArgs): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>('sendMessage', args);
  }

  /** Resolve a `file_id` to a `File` (carrying the `file_path` the bytes live
   *  at). The first half of the two-step download (`getFile` → fetch path). */
  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId });
  }

  /** MANDATORY answer to a button tap — Telegram spins a progress indicator on
   *  the tapper's client until this lands. Returns `true` on success (the Bot
   *  API's result for this method is the boolean itself). */
  async answerCallbackQuery(args: AnswerCallbackQueryArgs): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', args);
  }

  /** Replace (or, with `reply_markup` omitted, remove) the inline keyboard on
   *  an already-sent message. The Bot API answers with the edited message for a
   *  bot-sent message, so the result is deliberately untyped here. */
  async editMessageReplyMarkup(args: EditReplyMarkupArgs): Promise<unknown> {
    return this.call<unknown>('editMessageReplyMarkup', args);
  }
}

// ── The one create path ─────────────────────────────────────────────────

/** Where a Telegram send lands — derived from the parent link, never fields. */
export type TelegramWriteAnchor =
  | { kind: 'dm'; chatId: string }
  | { kind: 'reply'; chatId: string; replyToMessageId: number };

/**
 * Send the unified `Telegram Message`: a DM or a threaded reply, decided by
 * the anchor. Text-only in this pass (v1 send parity — media send is future
 * work and lands as a `File` field when it comes). The result's externalId
 * is the new message_id and its data carries `chat_id`, so a further reply
 * chained off the handle re-anchors without any field.
 *
 * `replyMarkup` rides through VERBATIM — Telegram's own `reply_markup`, no
 * wrapping and no typed shape, so a malformed keyboard surfaces as Telegram's
 * own loud 400 rather than as something we invented. Telegram accepts it on
 * every send endpoint, so there is nothing it excludes: unlike Slack, a
 * keyboard and an attachment compose on one message.
 */
export async function sendUnifiedTelegramMessage(input: {
  client: TelegramClient;
  log: ModuleLog;
  anchor: TelegramWriteAnchor;
  text: string;
  replyMarkup?: unknown;
}): Promise<WriteResult> {
  const { client, anchor, text } = input;
  const replyMarkup = asReplyMarkupValue(input.replyMarkup);
  const sent = await client.sendMessage({
    chat_id: anchor.chatId,
    text,
    ...(anchor.kind === 'reply' ? { reply_to_message_id: anchor.replyToMessageId } : {}),
    ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
  });
  input.log.info(
    `[TelegramAdapter.write] sent message ${sent.message_id} to chat ${anchor.chatId}` +
      (anchor.kind === 'reply' ? ` (reply to ${anchor.replyToMessageId})` : ''),
  );
  return {
    adapterType: TELEGRAM_ADAPTER_TYPE,
    externalId: String(sent.message_id),
    data: {
      message_id: String(sent.message_id),
      chat_id: anchor.chatId,
      text,
      name: text,
    },
  };
}

/**
 * The only validation `Reply Markup` gets: it must be a single OBJECT — no
 * per-key typing of Telegram's keyboard shapes (that is the deliberate cost of
 * verbatim passthrough; a wrong key comes back as Telegram's own 400 with its
 * own description). `undefined`/`null` and `{}` all mean "no keyboard", so
 * `Reply Markup: {}` behaves like the field was never set rather than sending
 * an empty markup object.
 */
function asReplyMarkupValue(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `TelegramAdapter.createRecord: Reply Markup must be a single Telegram reply_markup object, got ${describeMarkupValue(raw)}.`,
    );
  }
  const markup = raw as Record<string, unknown>;
  return Object.keys(markup).length > 0 ? markup : undefined;
}

function describeMarkupValue(raw: unknown): string {
  if (typeof raw === 'string') return `the string "${raw}"`;
  if (Array.isArray(raw)) return 'a list (the keyboard rows go inside `inline_keyboard`)';
  return `a ${typeof raw}`;
}
