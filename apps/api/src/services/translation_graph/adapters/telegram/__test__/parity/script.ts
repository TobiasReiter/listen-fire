// The calls recorded parity makes, in order, against one Telegram
// implementation: the whole adapter surface (schema, inbound, fields, walks,
// actor, file bytes, sends and their refusals) plus the two calls the
// platform's doors make as the bot (ack a button tap, retire a keyboard).
// The transcript is every answer as JSON; two implementations agree when
// their transcripts and the requests they made are identical.

import type { Adapter, FileRef } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { makeMetaPosition, makeStablePosition, makeUnstablePosition } from 'movement-engine/public/catalog';

/** The calls the doors make as the bot, beside the adapter's own. */
export interface TelegramDoorCalls {
  answerCallbackQuery(input: { callbackQueryId: string; text?: string }): Promise<void>;
  clearReplyMarkup(input: { chatId: string; messageId: number }): Promise<void>;
}

export interface TelegramParitySubject {
  adapter: Adapter;
  /** Absent where the host has no doors (a module served as a process). */
  doors?: TelegramDoorCalls;
  /** False where the host keeps no linked identities (a module served as a
   *  process, which lf runs: there is no /start handshake there). */
  identities: boolean;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** The linked identities the script's host knows: user 777 (Ada) only. */
export const LINKED_SENDER = '777';
export const UNLINKED_SENDER = '888';

const TEXT_UPDATE = {
  update_id: 100,
  message: {
    message_id: 42,
    from: { id: 777, is_bot: false, first_name: 'Ada', username: 'adas' },
    chat: { id: 777, type: 'private' },
    date: 1_700_000_000,
    text: 'Closed the round!',
  },
};

const MEDIA_UPDATE = {
  update_id: 101,
  message: {
    message_id: 43,
    from: { id: 888, is_bot: false, first_name: 'Bo' },
    chat: { id: -1001, type: 'supergroup', title: 'Deals' },
    date: 1_700_000_100,
    caption: 'the deck',
    document: { file_id: 'DOC1', file_unique_id: 'DOC1u', file_name: 'deck.pdf', mime_type: 'application/pdf', file_size: 1234 },
    photo: [
      { file_id: 'PH_S', file_unique_id: 'PHs', width: 90, height: 90, file_size: 100 },
      { file_id: 'PH_L', file_unique_id: 'PHl', width: 900, height: 900, file_size: 9000 },
    ],
    voice: { file_id: 'VO1', file_unique_id: 'VO1u', mime_type: 'audio/ogg', file_size: 55 },
    audio: { file_id: 'AU1', file_unique_id: 'AU1u', file_name: 'song.mp3', mime_type: 'audio/mpeg', file_size: 77 },
  },
};

const CALLBACK_UPDATE = {
  update_id: 102,
  callback_query: { id: 'cbq-1', from: { id: 777 }, data: 'cb_x', message: { message_id: 50, chat: { id: 777 } } },
};

export async function runTelegramParityScript(subject: TelegramParitySubject): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  const step = async <T>(name: string, call: () => Promise<T>): Promise<T | undefined> => {
    try {
      const answer = await call();
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };

  // ── Schema ──
  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['Message', 'Linked User', 'Attachment', 'telegram:message', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  const meta = makeMetaPosition('telegram');
  await step('edgesFrom meta', async () => (await adapter.edgesFrom?.(meta)) ?? null);
  await step('listEventTypes', async () => (await adapter.listEventTypes?.()) ?? null);
  await step('runtimeCapabilities', async () => adapter.runtimeCapabilities?.() ?? null);

  // ── Inbound ──
  for (const [name, raw] of [
    ['text', TEXT_UPDATE],
    ['media', MEDIA_UPDATE],
    ['callback_query', CALLBACK_UPDATE],
    ['malformed', { message: { text: 'no ids' } }],
    ['not an object', 'hello'],
  ] as const) {
    await step(`preprocessInbound ${name}`, async () => (await adapter.preprocessInbound?.({ raw })) ?? null);
  }

  // ── Fields and walks on a delivered message ──
  const inbound = await adapter.preprocessInbound?.({ raw: MEDIA_UPDATE });
  const mediaPayload = inbound?.events[0]?.payload as Record<string, unknown> | undefined;
  const message: SourcePosition = makeStablePosition({
    adapterType: 'telegram',
    recordType: 'Message',
    recordId: '43',
    data: mediaPayload ?? {},
  });
  for (const field of ['Text', 'Chat Id', 'Chat Type', 'Sender Id', 'Sender First Name', 'Date', 'Message Id', 'Reply Markup', 'Nope']) {
    await step(`Message.${field}`, () => adapter.getFieldValue({ position: message, fieldId: field }));
  }
  const attachments = await step('Message Attachments', () =>
    adapter.getRelated({ position: message, fieldId: 'Attachments', direction: 'outgoing' }),
  );
  await step('Message Attachments incoming', () => adapter.getRelated({ position: message, fieldId: 'Attachments', direction: 'incoming' }));
  let file: FileRef | undefined;
  for (const [index, attachment] of (attachments ?? []).entries()) {
    for (const field of ['Name', 'Content Type', 'Size', 'File Id', 'File']) {
      const value = await step(`Attachment ${index}.${field}`, () => adapter.getFieldValue({ position: attachment.position, fieldId: field }));
      if (field === 'File' && index === 0 && value !== null && typeof value === 'object') file = value as FileRef;
    }
  }
  const noFile = makeUnstablePosition({ adapterType: 'telegram', recordType: 'Attachment', data: { name: 'x' } });
  await step('Attachment without file_id .File', () => adapter.getFieldValue({ position: noFile, fieldId: 'File' }));
  await step('foreign position', () =>
    adapter.getFieldValue({ position: makeMetaPosition('slack'), fieldId: 'Text' }),
  );

  // ── File bytes ──
  if (file !== undefined) {
    const bytes = file;
    await step('resolveFileRef document', async () => {
      const resolved = await adapter.resolveFileRef?.({ ref: bytes });
      if (resolved === undefined) return null;
      if (!('stream' in resolved)) return resolved;
      return { contentType: resolved.contentType ?? null, text: await text(resolved.stream as NodeJS.ReadableStream) };
    });
  }
  await step('resolveFileRef without a handle', async () => (await adapter.resolveFileRef?.({ ref: { __brand: 'FileRef', name: 'x' } })) ?? null);

  // ── Linked identities ──
  const linkedSender = makeStablePosition({
    adapterType: 'telegram',
    recordType: 'Message',
    recordId: '42',
    data: { message_id: '42', chat_id: '777', sender_id: LINKED_SENDER, sender_username: 'adas', sender_first_name: 'Ada', text: 'hi' },
  });
  let linkedUser: SourcePosition | undefined;
  if (subject.identities) {
    const users = await step('Linked Users', () => adapter.getRelated({ position: meta, fieldId: 'Linked Users', direction: 'outgoing' }));
    linkedUser = users?.[0]?.position;
    await step('Message Sender linked', () => adapter.getRelated({ position: linkedSender, fieldId: 'Sender', direction: 'outgoing' }));
    await step('Message Sender unlinked', () => adapter.getRelated({ position: message, fieldId: 'Sender', direction: 'outgoing' }));
    const event = (payload: unknown) => ({ payload }) as never;
    await step('extractActor linked', async () => (await adapter.extractActor?.({ event: event(linkedSender.identity.data) })) ?? null);
    await step('extractActor unlinked', async () => (await adapter.extractActor?.({ event: event(mediaPayload) })) ?? null);
    await step('getActorCandidates linked', async () => (await adapter.getActorCandidates?.({ event: event(linkedSender.identity.data) })) ?? null);
    await step('getActorCandidates no sender', async () => (await adapter.getActorCandidates?.({ event: event({}) })) ?? null);
  }
  await step('meta other edge', () => adapter.getRelated({ position: meta, fieldId: 'Message', direction: 'outgoing' }));

  // ── Sends ──
  const dmParent = linkedUser ?? makeStablePosition({ adapterType: 'telegram', recordType: 'Linked User', recordId: LINKED_SENDER, data: { chat_id: LINKED_SENDER } });
  const parentOf = (position: SourcePosition, edgeName: string) => ({
    adapterType: 'telegram',
    recordType: position.recordType ?? '',
    externalId: position.identity.kind === 'stable' ? position.identity.recordId : '',
    edgeName,
    data: (position.identity.data ?? {}) as Record<string, unknown>,
  });
  await step('createRecord DM', () =>
    adapter.createRecord({ recordType: 'Message', fields: { Text: 'Hello Ada' }, parentLinks: [parentOf(dmParent, 'Messages')] } as never),
  );
  await step('createRecord reply with keyboard', () =>
    adapter.createRecord({
      recordType: 'Message',
      fields: { Text: 'Approve?', 'Reply Markup': { inline_keyboard: [[{ text: 'Yes', callback_data: 'cb_1' }]] } },
      parentLinks: [parentOf(linkedSender, 'Replies')],
    } as never),
  );
  await step('createRecord reply, empty markup', () =>
    adapter.createRecord({ recordType: 'Message', fields: { Text: 'plain', 'Reply Markup': {} }, parentLinks: [parentOf(linkedSender, 'Replies')] } as never),
  );
  await step('createRecord no parent', () => adapter.createRecord({ recordType: 'Message', fields: { Text: 'x' } } as never));
  await step('createRecord empty text', () =>
    adapter.createRecord({ recordType: 'Message', fields: { Text: '' }, parentLinks: [parentOf(dmParent, 'Messages')] } as never),
  );
  await step('createRecord markup list', () =>
    adapter.createRecord({ recordType: 'Message', fields: { Text: 'x', 'Reply Markup': [[1]] }, parentLinks: [parentOf(linkedSender, 'Replies')] } as never),
  );
  await step('createRecord reply without chat', () =>
    adapter.createRecord({
      recordType: 'Message',
      fields: { Text: 'x' },
      parentLinks: [{ adapterType: 'telegram', recordType: 'Message', externalId: '42', edgeName: 'Replies', data: {} }],
    } as never),
  );
  await step('createRecord wrong edge', () =>
    adapter.createRecord({ recordType: 'Message', fields: { Text: 'x' }, parentLinks: [parentOf(dmParent, 'Replies')] } as never),
  );
  await step('updateRecord', () => adapter.updateRecord({ recordType: 'Message', externalId: '1', fields: {} } as never));
  await step('deleteRecord', () => adapter.deleteRecord({ recordType: 'Message', externalId: '1' } as never));

  // ── As the bot, for the doors ──
  if (subject.doors !== undefined) {
    const doors = subject.doors;
    await step('answerCallbackQuery', () => doors.answerCallbackQuery({ callbackQueryId: 'cbq-1', text: 'x'.repeat(250) }));
    await step('answerCallbackQuery bare', () => doors.answerCallbackQuery({ callbackQueryId: 'cbq-2' }));
    await step('clearReplyMarkup', () => doors.clearReplyMarkup({ chatId: '777', messageId: 50 }));
  }
  return transcript;
}
