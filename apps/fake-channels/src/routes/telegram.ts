import { Router } from 'express';
import type { EntityStore } from '../store';

const SVC = 'telegram';
const MEDIA = 'media';
const CALLBACK_ACK = 'callback_ack';
const WEBHOOK = 'webhook';

/**
 * Fake Telegram Bot API. The real adapter's `TelegramClient` builds method
 * URLs as `<base>/bot<token>/<METHOD>` and file URLs as
 * `<base>/file/bot<token>/<path>`; under the dev loop `<base>` is rewritten to
 * `${FAKE_CHANNELS_URL}/telegram` (see `lib/recording.ts:injectFakeBaseUrl`).
 * This router is mounted at `/telegram`, so it sees the `bot<token>/<METHOD>`
 * sub-paths verbatim — the bot token is a path segment, not a header.
 *
 * Every Bot API method answers with the `{ ok, result }` envelope the client's
 * `call()` unwraps. Sent messages land in the `message` outbox so
 * `dev:inspect telegram` can prove an outbound reply was issued.
 */
export function telegramRoutes(store: EntityStore): Router {
  const r = Router();

  // Bot identity — the adapter doesn't strictly need this for send, but a real
  // Bot API exposes it and it's a cheap liveness probe.
  r.post('/bot:token/getMe', (req, res) => {
    res.json({
      ok: true,
      result: {
        id: 424242,
        is_bot: true,
        first_name: 'Listen-Fire Dev Bot',
        username: 'listen_fire_dev_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
    });
  });

  // sendMessage — store to the outbox and echo back the sent Message.
  r.post('/bot:token/sendMessage', (req, res) => {
    const chatId = req.body?.chat_id;
    const text = req.body?.text ?? '';
    if (chatId === undefined || chatId === null || chatId === '') {
      return res
        .status(400)
        .json({ ok: false, error_code: 400, description: 'Bad Request: chat_id is required' });
    }
    const id = store.nextId(SVC, 'message');
    const messageId = Number(id);
    const message = {
      message_id: messageId,
      from: { id: 424242, is_bot: true, first_name: 'Listen-Fire Dev Bot', username: 'listen_fire_dev_bot' },
      chat: { id: Number.isNaN(Number(chatId)) ? chatId : Number(chatId), type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(req.body?.reply_to_message_id !== undefined
        ? { reply_to_message_id: req.body.reply_to_message_id }
        : {}),
      // Real Telegram echoes the keyboard back on the sent Message; recording it
      // is what lets `dev:inspect telegram` prove the buttons went out verbatim.
      ...(req.body?.reply_markup !== undefined
        ? { reply_markup: req.body.reply_markup }
        : {}),
    };
    store.create(SVC, 'message', message, id);
    res.json({ ok: true, result: message });
  });

  // answerCallbackQuery — the mandatory ack for a button tap. Real Telegram
  // answers with `result: true`; the ack is recorded so the dev loop can prove
  // the tapper's client was released (and with what toast).
  r.post('/bot:token/answerCallbackQuery', (req, res) => {
    const callbackQueryId = req.body?.callback_query_id;
    if (!callbackQueryId) {
      return res.status(400).json({
        ok: false,
        error_code: 400,
        description: 'Bad Request: callback_query_id is required',
      });
    }
    const id = store.nextId(SVC, CALLBACK_ACK);
    store.create(
      SVC,
      CALLBACK_ACK,
      {
        id,
        callback_query_id: String(callbackQueryId),
        text: req.body?.text ?? null,
        answered_at: new Date().toISOString(),
      },
      id,
    );
    res.json({ ok: true, result: true });
  });

  // editMessageReplyMarkup — retire (or replace) a sent message's keyboard.
  // Mutates the outbox record so an inspection sees the message as it now
  // stands: an OMITTED `reply_markup` removes the keyboard, per the Bot API.
  r.post('/bot:token/editMessageReplyMarkup', (req, res) => {
    const messageId = String(req.body?.message_id ?? '');
    const existing = messageId ? store.get(SVC, 'message', messageId) : undefined;
    if (!existing) {
      return res.status(400).json({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message to edit not found',
      });
    }
    const data = existing.data as Record<string, unknown>;
    const edited =
      req.body?.reply_markup !== undefined
        ? { ...data, reply_markup: req.body.reply_markup }
        : Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'reply_markup'));
    // `create` is INSERT OR REPLACE — `update` MERGES, which could never drop
    // the keyboard key, and dropping it is the whole point of the no-markup
    // form.
    store.create(SVC, 'message', edited, messageId);
    res.json({ ok: true, result: edited });
  });

  // Inspection surface for the acks a button tap produced.
  r.get('/admin/callback-acks', (_req, res) => {
    res.json({ data: store.list(SVC, CALLBACK_ACK).map((a) => a.data) });
  });

  // sendDocument / sendPhoto — text-with-attachment sends. v1 of the adapter
  // only sends text, but the fake answers these cheaply so a future write path
  // (or a manual curl) has something to land against.
  r.post('/bot:token/sendDocument', (req, res) => {
    const id = store.nextId(SVC, 'message');
    const message = {
      message_id: Number(id),
      chat: { id: Number(req.body?.chat_id) || req.body?.chat_id, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      caption: req.body?.caption ?? '',
      document: { file_id: `doc_${id}`, file_unique_id: `docu_${id}` },
    };
    store.create(SVC, 'message', message, id);
    res.json({ ok: true, result: message });
  });

  r.post('/bot:token/sendPhoto', (req, res) => {
    const id = store.nextId(SVC, 'message');
    const message = {
      message_id: Number(id),
      chat: { id: Number(req.body?.chat_id) || req.body?.chat_id, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      caption: req.body?.caption ?? '',
      photo: [{ file_id: `photo_${id}`, file_unique_id: `photou_${id}`, width: 1, height: 1 }],
    };
    store.create(SVC, 'message', message, id);
    res.json({ ok: true, result: message });
  });

  // Seed media the file routes below will serve — the Telegram analogue of the
  // WhatsApp Graph media seed. `dev:inject telegram --voice` seeds real audio
  // bytes here so the adapter's two-leg download yields decodable audio.
  r.post('/media', (req, res) => {
    const id = String(req.body?.id ?? `media_${store.nextId(SVC, MEDIA)}`);
    if (typeof req.body?.base64 !== 'string' || req.body.base64.length === 0) {
      return res.status(400).json({ ok: false, description: 'base64 bytes are required' });
    }
    const record = {
      id,
      mimeType: typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'application/octet-stream',
      filename: typeof req.body?.filename === 'string' ? req.body.filename : null,
      base64: req.body.base64,
    };
    store.create(SVC, MEDIA, record, id);
    res.json({ ok: true, result: { id } });
  });

  // List seeded media (inspection). Bytes elided.
  r.get('/media', (_req, res) => {
    const media = store.list(SVC, MEDIA).map((m) => {
      const d = m.data as { mimeType?: string; filename?: string | null; base64?: string };
      return {
        id: m.id,
        mimeType: d.mimeType ?? null,
        filename: d.filename ?? null,
        byteLength: typeof d.base64 === 'string' ? Buffer.from(d.base64, 'base64').length : 0,
      };
    });
    res.json({ data: media });
  });

  // getFile — the first leg of the two-step download. A SEEDED file_id gets a
  // `media/<id>` path (real size); an unseeded one keeps the synthetic
  // `documents/<id>.bin` placeholder path.
  r.post('/bot:token/getFile', (req, res) => {
    const fileId = req.body?.file_id;
    if (!fileId) {
      return res
        .status(400)
        .json({ ok: false, error_code: 400, description: 'Bad Request: file_id is required' });
    }
    const seeded = store.get(SVC, MEDIA, String(fileId));
    const size = seeded
      ? Buffer.from(String((seeded.data as { base64?: string }).base64 ?? ''), 'base64').length
      : 12;
    res.json({
      ok: true,
      result: {
        file_id: fileId,
        file_unique_id: `${fileId}_u`,
        file_size: size,
        file_path: seeded ? `media/${fileId}` : `documents/${fileId}.bin`,
      },
    });
  });

  // File bytes — `<base>/file/bot<token>/<file_path>`. The router is mounted at
  // `/telegram`, so the full path here is `/file/bot:token/<...path>`. Seeded
  // `media/<id>` paths serve the seeded bytes with their real content type;
  // everything else keeps the deterministic placeholder so `resolveFileRef`
  // always has a body to stream.
  r.get('/file/bot:token/*', (req, res) => {
    const filePath = (req.params as Record<string, string>)[0] ?? '';
    if (filePath.startsWith('media/')) {
      const seeded = store.get(SVC, MEDIA, filePath.slice('media/'.length));
      if (seeded) {
        const d = seeded.data as { mimeType?: string; base64?: string };
        res.setHeader('content-type', d.mimeType ?? 'application/octet-stream');
        return res.send(Buffer.from(d.base64 ?? '', 'base64'));
      }
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.send(Buffer.from(`fake-telegram-bytes:${filePath}`, 'utf-8'));
  });

  // setWebhook / deleteWebhook / getWebhookInfo — one webhook per bot token,
  // as on the real Bot API. Real Telegram refuses a secret_token outside
  // 1-256 of [A-Za-z0-9_-], so the fake does too: a registration the fake
  // accepts is one Telegram would.
  r.post('/bot:token/setWebhook', (req, res) => {
    const url = req.body?.url;
    const secretToken = req.body?.secret_token;
    if (typeof url !== 'string' || url === '') {
      return res.status(400).json({ ok: false, error_code: 400, description: 'Bad Request: bad webhook: URL is required' });
    }
    if (secretToken !== undefined && (typeof secretToken !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(secretToken))) {
      return res.status(400).json({ ok: false, error_code: 400, description: 'Bad Request: secret token contains unallowed characters' });
    }
    const token = req.params.token;
    const webhook = { url, ...(secretToken !== undefined ? { secret_token: secretToken } : {}), ...(req.body?.allowed_updates !== undefined ? { allowed_updates: req.body.allowed_updates } : {}) };
    // Replaces, as the real one does: a new registration without a secret has none.
    store.delete(SVC, WEBHOOK, token);
    store.create(SVC, WEBHOOK, webhook, token);
    res.json({ ok: true, result: true, description: 'Webhook was set' });
  });

  r.post('/bot:token/deleteWebhook', (req, res) => {
    const existed = store.get(SVC, WEBHOOK, req.params.token) !== null;
    store.delete(SVC, WEBHOOK, req.params.token);
    res.json({ ok: true, result: true, description: existed ? 'Webhook was deleted' : 'Webhook is already deleted' });
  });

  r.post('/bot:token/getWebhookInfo', (req, res) => {
    const webhook = store.get(SVC, WEBHOOK, req.params.token)?.data as { url?: string; allowed_updates?: string[] } | undefined;
    res.json({
      ok: true,
      result: {
        url: webhook?.url ?? '',
        has_custom_certificate: false,
        pending_update_count: 0,
        ...(webhook?.allowed_updates !== undefined ? { allowed_updates: webhook.allowed_updates } : {}),
      },
    });
  });

  // Deliver one Update to the bot's registered webhook as Telegram does: a
  // JSON POST carrying the registered secret in
  // `X-Telegram-Bot-Api-Secret-Token`. Answers the webhook's status.
  r.post('/admin/bot:token/deliver', async (req, res) => {
    const webhook = store.get(SVC, WEBHOOK, req.params.token)?.data as { url?: string; secret_token?: string } | undefined;
    if (webhook?.url === undefined) return res.status(404).json({ ok: false, description: 'no webhook set for this bot' });
    const answer = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(webhook.secret_token !== undefined ? { 'x-telegram-bot-api-secret-token': webhook.secret_token } : {}) },
      body: JSON.stringify(req.body),
    });
    res.json({ ok: true, status: answer.status });
  });

  // Inspection surface — the outbox of everything the bot has sent.
  r.get('/admin/outbox', (_req, res) => {
    const messages = store.list(SVC, 'message');
    res.json({ data: messages.map((m) => m.data) });
  });

  r.delete('/admin/outbox', (_req, res) => {
    store.deleteService(SVC);
    res.json({ ok: true });
  });

  return r;
}
