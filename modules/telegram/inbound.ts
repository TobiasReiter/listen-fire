// Telegram's inbound: one `Update` per webhook delivery, normalised into the
// flat message payload the schema advertises (so `getFieldValue` reads it off
// `data`), and turned into the one event kind, `message`. Pure: both of the
// platform's doors (a team's own bot, the shared bot) and every other host
// parse a delivery here.

import { z } from 'zod';

import type { DiscriminableEvent } from 'movement-engine/public/adapter';

import {
  TELEGRAM_MESSAGE_TYPE_ID,
  type TelegramAttachment,
  type TelegramMessage,
  type TelegramMessagePayload,
} from './types';

/** Telegram `User` (the message `from`). `.passthrough()` so extra Bot API
 *  fields don't reject an otherwise-valid update. */
const telegramUserSchema = z
  .object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const telegramChatSchema = z
  .object({
    id: z.number(),
    type: z.string().optional(),
    title: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const telegramFileSchema = z
  .object({
    file_id: z.string(),
    file_unique_id: z.string().optional(),
    file_name: z.string().optional(),
    mime_type: z.string().optional(),
    file_size: z.number().optional(),
  })
  .passthrough();

const telegramPhotoSizeSchema = z
  .object({
    file_id: z.string(),
    file_unique_id: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    file_size: z.number().optional(),
  })
  .passthrough();

const telegramMessageSchema = z
  .object({
    message_id: z.number(),
    from: telegramUserSchema.optional(),
    chat: telegramChatSchema,
    date: z.number().optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    document: telegramFileSchema.optional(),
    photo: z.array(telegramPhotoSizeSchema).optional(),
    voice: telegramFileSchema.optional(),
    audio: telegramFileSchema.optional(),
  })
  .passthrough();

/** A Telegram `Update`. v1 fires on plain messages only — `edited_message`,
 *  `channel_post`, `callback_query`, … are accepted (so parsing doesn't throw)
 *  but yield no events. */
const telegramUpdateSchema = z
  .object({
    update_id: z.number().optional(),
    message: telegramMessageSchema.optional(),
  })
  .passthrough();

/** The delivered message, normalised; null for an update that carries none
 *  (edited messages, channel posts, button taps: v1 fires on plain messages
 *  only) or that is not an update at all. */
export function parseTelegramMessage(body: unknown): TelegramMessagePayload | null {
  const parsed = telegramUpdateSchema.safeParse(body);
  if (!parsed.success || !parsed.data.message) return null;
  return normalizeMessage(parsed.data.message as TelegramMessage);
}

/**
 * The events one delivery fires: none, or one `message` keyed by its
 * message_id. Tagged rather than discriminated by a literal (the payload
 * carries none), and a `create`, so the engine seeds a STABLE message
 * position a reply can anchor on.
 */
export function telegramInboundEvents(body: unknown): DiscriminableEvent[] {
  const payload = parseTelegramMessage(body);
  if (payload === null) return [];
  return [
    {
      payload,
      externalId: payload.message_id,
      recordType: TELEGRAM_MESSAGE_TYPE_ID,
      eventType: 'message',
      tag: 'message',
      changeType: 'create',
    },
  ];
}

export function normalizeMessage(message: TelegramMessage): TelegramMessagePayload {
  const attachments: TelegramAttachment[] = [];
  if (message.document) {
    attachments.push({
      file_id: message.document.file_id,
      name: message.document.file_name ?? message.document.file_id,
      contentType: message.document.mime_type ?? null,
      size: message.document.file_size ?? null,
    });
  }
  if (message.photo && message.photo.length > 0) {
    // Telegram delivers photo sizes smallest→largest; take the largest.
    const largest = message.photo[message.photo.length - 1];
    attachments.push({
      file_id: largest.file_id,
      name: `photo_${largest.file_unique_id}.jpg`,
      contentType: 'image/jpeg',
      size: largest.file_size ?? null,
    });
  }
  if (message.voice) {
    // A voice note is always OGG/OPUS and carries no filename — synthesise one
    // so the extension classifies it downstream.
    attachments.push({
      file_id: message.voice.file_id,
      name: `voice_${message.voice.file_unique_id ?? message.voice.file_id}.ogg`,
      contentType: message.voice.mime_type ?? 'audio/ogg',
      size: message.voice.file_size ?? null,
    });
  }
  if (message.audio) {
    attachments.push({
      file_id: message.audio.file_id,
      name: message.audio.file_name ?? `audio_${message.audio.file_unique_id ?? message.audio.file_id}`,
      contentType: message.audio.mime_type ?? null,
      size: message.audio.file_size ?? null,
    });
  }
  return {
    message_id: String(message.message_id),
    text: message.text ?? message.caption ?? '',
    chat_id: String(message.chat.id),
    chat_type: message.chat.type,
    sender_id: message.from ? String(message.from.id) : '',
    sender_username: message.from?.username,
    sender_first_name: message.from?.first_name,
    date: typeof message.date === 'number'
      ? new Date(message.date * 1000).toISOString()
      : undefined,
    attachments,
  };
}
