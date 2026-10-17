// Telegram adapter — type ids + inbound Bot API shapes. Kept in a leaf module
// (no imports from `./index` or `./write`) so value-importers on either side
// stay acyclic — the same idiom slack/whatsapp follow with their `types.ts`.
//
// The shapes below mirror the verified Telegram Bot API
// (core.telegram.org/bots/api). They are defined here, NOT imported from any
// pre-existing Telegram code, so the TG-side contract evolves independently
// (the "mirror; don't import" rule the WhatsApp adapter follows).

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const TELEGRAM_ADAPTER_TYPE = 'telegram';

/** Top-level type id for an inbound Telegram message record. */
export const TELEGRAM_MESSAGE_TYPE_ID = 'telegram:message';

/** Type id for the per-attachment record (one position per document/photo). */
export const TELEGRAM_ATTACHMENT_TYPE_ID = 'telegram:attachment';

/** A handshake-linked person (adapters.telegram_identity) — the one listable
 *  noun Telegram has; their user id IS the private chat id a send targets. */
export const TELEGRAM_LINKED_USER_TYPE_ID = 'telegram:linked_user';

/** Natural type name for an attachment — the pretty name positions carry.
 *  No system prefix (rule 5, adapters/CLAUDE.md): the instance already says
 *  which system you're in. */
export const TELEGRAM_ATTACHMENT_DISPLAY_NAME = 'Attachment';

/** Edge id on `telegram:message` that fans out one position per attachment. */
export const TELEGRAM_ATTACHMENTS_FIELD = 'attachments';

/** Edge id on `telegram:message` up-hop to the sender's Linked User — the
 *  reverse of `Linked User -[Messages]->`. Resolves via the message's
 *  `sender_id`; a group chat / unlinked sender honestly yields nothing. */
export const TELEGRAM_MESSAGE_SENDER_EDGE = 'sender';

/**
 * The NATURAL names Telegram's edges publish — Title Case, the one convention
 * across every adapter surface. The ids above stay internal (`getRelated`
 * dispatch); THESE are what a movement writes (`u-[:Messages]->`) and what
 * `edgeWriteName` resolves to, so `resolveWriteAnchor` keys on them.
 */
export const TELEGRAM_EDGE_NAMES = {
  attachments: 'Attachments',
  replies: 'Replies',
  sender: 'Sender',
  messages: 'Messages',
} as const;

// ── Inbound Bot API shapes (verified vs core.telegram.org/bots/api) ─────────

/** A Telegram user (the `from` on a message). Telegram carries no email — the
 *  user is identified by its numeric `id` and optional `username`. */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

/** A Telegram chat (the conversation a message belongs to). */
export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** A Telegram document attachment (file with name + MIME). */
export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** A Telegram voice note — always OGG/OPUS (`audio/ogg`), no filename. */
export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

/** A Telegram audio file (music / an audio attachment with a filename). */
export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  title?: string;
}

/** One size of a Telegram photo. Telegram delivers an array of progressively
 *  larger sizes; the adapter picks the largest. */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** A Telegram message — the payload carried on an inbound `Update`. */
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  audio?: TelegramAudio;
}

/** The inbound webhook envelope — Telegram POSTs one Update per delivery. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ── Normalised adapter-side shapes ──────────────────────────────────────────

/**
 * The TG-side message payload carried on a source position's `data`. Narrower
 * and flatter than the raw `TelegramMessage` (sender/chat flattened to the
 * scalar fields `describe()` advertises), so field reads are a plain lookup.
 */
export interface TelegramMessagePayload {
  message_id: string;
  text: string;
  chat_id: string;
  chat_type: string;
  sender_id: string;
  sender_username?: string;
  sender_first_name?: string;
  date?: string;
  attachments: TelegramAttachment[];
}

/**
 * A normalised Telegram attachment (a document, the largest photo size, a
 * voice note, or an audio file). `file_id` is the opaque Bot API handle the
 * adapter resolves to bytes via `getFile` → file path (`resolveFileRef`).
 */
export interface TelegramAttachment {
  file_id: string;
  name: string;
  contentType: string | null;
  size: number | null;
}
