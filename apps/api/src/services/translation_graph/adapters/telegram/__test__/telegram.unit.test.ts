// Telegram TG adapter — pure introspection + inbound parse + send + file
// resolution. No network, no DB: the credential read is mocked at the
// `lib/kysely` / `lib/credentials` leaves, and the Bot API is exercised via a
// stubbed `global.fetch`. Covers:
//   1. listEntryPoints / describe (message, attachment, linked_user).
//   2. preprocessInbound — a real-shaped Update → a tagged telegram:message
//      event; a non-message update is skipped.
//   3. getFieldValue — message scalars.
//   4. getActorCandidates / extractActor — from message.from (no email).
//   5. createRecord — edge-anchored DM / reply → the right sendMessage call.
//   6. resolveFileRef — getFile → fetch path.
//   7. listEventTypes — parse→discriminate pin (both doors use the tagged mapper).

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type { TelegramUpdate } from '@listen-fire/telegram/types';
import type { FileRef } from 'movement-engine/services/translation_graph/adapter';

import { makeStablePosition, makeUnstablePosition } from 'movement-engine/services/translation_graph/types';

// ── Module-scope mocks ──────────────────────────────────────────────────────
// The credential read (getQb → external_service_credentials) and decryption are
// mocked so the adapter constructs a real `TelegramClient` from a fixed bot
// token without a DB.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

// The decrypted credential payload is configurable per-test via this holder so
// the same mock serves the BYO case (a real botToken) and Chunk 7's empty /
// connected-but-secret-less credential (`{}`, `{ botToken: '' }`, `{ baseUrl }`).
const decryptedPayload = { value: JSON.stringify({ botToken: 'BOT123' }) };
jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => decryptedPayload.value,
  encryptToken: async () => '',
}));

// `automations.telegram_identity` store, keyed by `${team_id}::${telegram_user_id}`
// → email. The mock below resolves a SELECT … WHERE
// telegram_user_id = ? AND team_id = ? against this map by capturing both
// `.where(...)` clauses — so a row owned by team A is invisible to a team-B
// query (the cross-team isolation the helper relies on).
const identityStore = new Map<string, string>();
const identityKey = (teamId: string, tgUserId: string) => `${teamId}::${tgUserId}`;

// One double, keyed by TABLE rather than by which accessor asked — both the
// credential row and the identity map now live in `automations`, and a double
// that branched on the accessor would answer the wrong table the moment one
// more table moved.
jest.mock('../../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: (table: string) => {
      const filters: Record<string, string> = {};
      const builder = {
        where: (column: string, _op: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        select: () => builder,
        executeTakeFirst: async () => {
          if (table === 'external_service_credentials') {
            return { id: 'cred-1', credentials: Buffer.from('x') };
          }
          const tgUserId = filters['telegram_user_id'];
          const teamId = filters['team_id'];
          if (tgUserId === undefined || teamId === undefined) return undefined;
          const email = identityStore.get(identityKey(teamId, tgUserId));
          return email ? { email } : undefined;
        },
      };
      return builder;
    },
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});

import {
  TelegramAdapter,
  TELEGRAM_ADAPTER_TYPE,
  TELEGRAM_MESSAGE_TYPE_ID,
  TELEGRAM_ATTACHMENT_TYPE_ID,
  parseTelegramEvents,
  telegramEventToDiscriminable,
  type TelegramMessagePayload,
} from '../index';
import { TELEGRAM_LINKED_USER_TYPE_ID } from '@listen-fire/telegram/types';
import { discriminateEvent } from 'movement-engine/services/translation_graph/engine/inbound/discriminate';
import { webhookEventToDiscriminable } from '../../../../webhook_sync/event_conversion';

const TEAM_ID = 'team-1' as TeamId;
const CRED_ID = 'cred-1';

function adapter() {
  return new TelegramAdapter(TEAM_ID, CRED_ID);
}

// A real-shaped inbound Update (one text message in a private chat).
const SAMPLE_UPDATE: TelegramUpdate = {
  update_id: 100,
  message: {
    message_id: 42,
    from: { id: 777, is_bot: false, first_name: 'Ada', username: 'adas' },
    chat: { id: -1001, type: 'supergroup', title: 'Deals' },
    date: 1_700_000_000,
    text: 'Closed the round!',
  },
};

describe('TelegramAdapter schema', () => {
  it('lists message + attachment + linked_user, none writable — the fires edge lands ON the message', async () => {
    const entries = await adapter().listEntryPoints();
    expect(entries.map((e) => e.typeId).sort()).toEqual(
      [
        TELEGRAM_ATTACHMENT_TYPE_ID,
        TELEGRAM_LINKED_USER_TYPE_ID,
        TELEGRAM_MESSAGE_TYPE_ID,
      ].sort(),
    );
    expect(entries.every((e) => !e.writable)).toBe(true);
    // Root-READABLE is only what the root can genuinely enumerate: the
    // Linked Users identity table. A message ARRIVES (the fires edge); an
    // attachment is reached via the message's `attachments` edge. A fires
    // edge is reachability, never a root read.
    // plans/2026-07-10-adapter-entry-positions/8_event_edges.md
    const readable = entries.filter((e) => e.readable);
    expect(readable.map((e) => e.typeId)).toEqual([TELEGRAM_LINKED_USER_TYPE_ID]);
  });

  it('the fires edge lands straight on Message — no field-less event node (rule 1)', async () => {
    const entries = await adapter().listEntryPoints();
    const message = entries.find((e) => e.typeId === TELEGRAM_MESSAGE_TYPE_ID);
    expect(message).toBeDefined();
    expect(message?.displayName).toBe('Message');
    expect(message?.readable).toBe(false);
    expect(message?.writable).toBe(false);
    expect(message?.fires).toBe(true);
    // The retired indirection stays retired: nothing describes it.
    expect(await adapter().describe('Message Received')).toBeNull();
  });

  it('no longer describes the deleted send-message sentinel', async () => {
    expect(await adapter().describe('telegram:send-message')).toBeNull();
  });

  it('describes the unified message: Text writable+required, read scalars read-only, writable `replies` edge', async () => {
    const desc = await adapter().describe(TELEGRAM_MESSAGE_TYPE_ID);
    expect(desc?.fields.map((f) => f.fieldId)).toEqual(
      expect.arrayContaining(['message_id', 'text', 'chat_id', 'chat_type', 'sender_id', 'sender_username', 'sender_first_name', 'date']),
    );
    expect(desc?.fields.find((f) => f.fieldId === 'text')).toMatchObject({ writable: true, required: true });
    // read scalars stay read-only — chat_id / reply targets are NEVER a write field.
    expect(desc?.fields.find((f) => f.fieldId === 'chat_id')?.writable).toBe(false);
    expect(desc?.fields.map((f) => f.fieldId)).not.toContain('reply_to_message_id');
    expect(desc?.references.map((r) => r.fieldId)).toContain('attachments');
    expect(desc?.references.find((r) => r.fieldId === 'replies')).toMatchObject({
      targetTypeId: TELEGRAM_MESSAGE_TYPE_ID,
      writable: true,
    });
  });

  it('describes the linked user with a writable `messages` edge', async () => {
    const desc = await adapter().describe(TELEGRAM_LINKED_USER_TYPE_ID);
    expect(desc?.references.find((r) => r.fieldId === 'messages')).toMatchObject({
      targetTypeId: TELEGRAM_MESSAGE_TYPE_ID,
      writable: true,
    });
  });

  it('describes the attachment with a File-typed `data` field', async () => {
    const desc = await adapter().describe(TELEGRAM_ATTACHMENT_TYPE_ID);
    expect(desc?.fields.find((f) => f.fieldId === 'data')?.kind).toBe('file');
    expect(desc?.fields.find((f) => f.fieldId === 'file_id')).toBeDefined();
  });

  it('returns null for an unknown type', async () => {
    expect(await adapter().describe('telegram:nope')).toBeNull();
  });
});

describe('TelegramAdapter.preprocessInbound', () => {
  it('parses a real-shaped Update into a telegram:message event', async () => {
    const { events } = await adapter().preprocessInbound({ raw: SAMPLE_UPDATE });
    expect(events).toHaveLength(1);
    // Tagged at parse time — the tag-only event type is selectable only by tag.
    expect(events[0].tag).toBe('message');
    // The event rides the legacy-conversion shape (recordType/eventType) —
    // the same shape the retired provider `parseEvents` path emitted, so
    // BYO-door dispatch semantics are unchanged by the seam migration.
    expect(events[0].recordType).toBe(TELEGRAM_MESSAGE_TYPE_ID);
    expect(events[0].eventType).toBe('message');
    expect(events[0].externalId).toBe('42');
    // The changeType is a stored-receipt fact (nothing routes on it since
    // the variant retirement) — the seed routes on discrimination, and the
    // message entry now carries the fires edge itself.
    // plans/2026-07-10-adapter-entry-positions/8_event_edges.md
    expect(events[0].changeType).toBe('create');
    const payload = events[0].payload as TelegramMessagePayload;
    expect(payload).toMatchObject({
      message_id: '42',
      text: 'Closed the round!',
      chat_id: '-1001',
      chat_type: 'supergroup',
      sender_id: '777',
      sender_username: 'adas',
      sender_first_name: 'Ada',
    });
  });

  it('uses the caption as text + builds an attachment for a document message', async () => {
    const { events } = await adapter().preprocessInbound({
      raw: {
        update_id: 101,
        message: {
          message_id: 43,
          from: { id: 777, is_bot: false, first_name: 'Ada' },
          chat: { id: 5, type: 'private' },
          date: 1_700_000_001,
          caption: 'the deck',
          document: { file_id: 'FILE9', file_unique_id: 'u9', file_name: 'deck.pdf', mime_type: 'application/pdf', file_size: 1234 },
        },
      } satisfies TelegramUpdate,
    });
    expect(events[0].tag).toBe('message');
    const payload = events[0].payload as TelegramMessagePayload;
    expect(payload.text).toBe('the deck');
    expect(payload.attachments).toEqual([
      { file_id: 'FILE9', name: 'deck.pdf', contentType: 'application/pdf', size: 1234 },
    ]);
  });

  it('builds an attachment for a voice note (audio/ogg opus)', async () => {
    const { events } = await adapter().preprocessInbound({
      raw: {
        update_id: 103,
        message: {
          message_id: 44,
          from: { id: 777, is_bot: false, first_name: 'Ada' },
          chat: { id: 5, type: 'private' },
          date: 1_700_000_002,
          voice: { file_id: 'VOICE1', file_unique_id: 'uv1', duration: 3, mime_type: 'audio/ogg', file_size: 4321 },
        },
      } satisfies TelegramUpdate,
    });
    expect(events[0].tag).toBe('message');
    const payload = events[0].payload as TelegramMessagePayload;
    expect(payload.attachments).toEqual([
      { file_id: 'VOICE1', name: 'voice_uv1.ogg', contentType: 'audio/ogg', size: 4321 },
    ]);
  });

  it('builds an attachment for an audio message (music / audio file)', async () => {
    const { events } = await adapter().preprocessInbound({
      raw: {
        update_id: 104,
        message: {
          message_id: 45,
          from: { id: 777, is_bot: false, first_name: 'Ada' },
          chat: { id: 5, type: 'private' },
          date: 1_700_000_003,
          caption: 'listen to this',
          audio: { file_id: 'AUDIO1', file_unique_id: 'ua1', duration: 30, file_name: 'memo.m4a', mime_type: 'audio/mp4', file_size: 9999 },
        },
      } satisfies TelegramUpdate,
    });
    expect(events[0].tag).toBe('message');
    const payload = events[0].payload as TelegramMessagePayload;
    expect(payload.text).toBe('listen to this');
    expect(payload.attachments).toEqual([
      { file_id: 'AUDIO1', name: 'memo.m4a', contentType: 'audio/mp4', size: 9999 },
    ]);
  });

  it('skips a non-message update (no message present)', async () => {
    const { events } = await adapter().preprocessInbound({ raw: { update_id: 102 } });
    expect(events).toEqual([]);
  });
});

// Rule 1's collapse: the fires edge lands STRAIGHT on the message — a listen
// delivers the message itself (the engine seeds it stable on its message_id),
// so there is no event node and no `record` hop.
// plans/2026-07-10-adapter-entry-positions/8_event_edges.md + adapters/CLAUDE.md
describe('TelegramAdapter — the record-edge indirection is GONE', () => {
  const payload = {
    message_id: '42',
    text: 'Closed the round!',
    chat_id: '-1001',
    sender_id: '777',
    attachments: [],
  };

  it('the SEED reads directly — Text/Chat Id off the delivered position', async () => {
    // What the engine seeds after the collapse: the message itself, stable on
    // its message_id (so a reply write anchors identically — chat_id rides
    // data).
    const seed = makeStablePosition({
      adapterType: TELEGRAM_ADAPTER_TYPE,
      recordType: 'Message',
      recordId: payload.message_id,
      data: payload,
    });
    expect(await adapter().getFieldValue({ position: seed, fieldId: 'Text' })).toBe(
      'Closed the round!',
    );
    expect(await adapter().getFieldValue({ position: seed, fieldId: 'Chat Id' })).toBe('-1001');
  });

  it('a `record` hop off a message is DRIFT — the edge died with the event node', async () => {
    const seed = makeStablePosition({
      adapterType: TELEGRAM_ADAPTER_TYPE,
      recordType: 'Message',
      recordId: payload.message_id,
      data: payload,
    });
    await expect(
      adapter().getRelated({ position: seed, fieldId: 'record', direction: 'outgoing' }),
    ).rejects.toThrow(/not a known edge/);
  });
});

describe('TelegramAdapter.getFieldValue', () => {
  // Positions carry the NATURAL type name (the displayName the read wrapper
  // stamps); the adapter resolves it + the natural field names to its internal
  // ids on the method's first line.
  const MESSAGE_TYPE = 'Message';

  function messagePosition(payload: Partial<TelegramMessagePayload>) {
    return makeUnstablePosition({
      adapterType: TELEGRAM_ADAPTER_TYPE,
      recordType: MESSAGE_TYPE,
      data: payload,
    });
  }

  it('reads message scalar fields', async () => {
    const a = adapter();
    const { events } = await a.preprocessInbound({ raw: SAMPLE_UPDATE });
    const position = messagePosition(events[0].payload as TelegramMessagePayload);
    expect(await a.getFieldValue({ position, fieldId: 'Text' })).toBe('Closed the round!');
    expect(await a.getFieldValue({ position, fieldId: 'Chat Id' })).toBe('-1001');
    expect(await a.getFieldValue({ position, fieldId: 'Sender Username' })).toBe('adas');
  });

  it('throws for a position from another adapter', async () => {
    const foreign = makeUnstablePosition({
      adapterType: 'slack',
      recordType: TELEGRAM_MESSAGE_TYPE_ID,
      data: {},
    });
    await expect(adapter().getFieldValue({ position: foreign, fieldId: 'text' })).rejects.toThrow();
  });
});

describe('TelegramAdapter actor resolution (telegram_user_id → email via the store)', () => {
  const TEAM_A = 'team-A' as TeamId;
  const TEAM_B = 'team-B' as TeamId;
  const TG_USER = '123';
  const EMAIL_A = 'x@a.com';

  beforeEach(() => {
    identityStore.clear();
  });

  function event(payload: Partial<TelegramMessagePayload>): TriggerEvent {
    return {
      pipelineInputId: 'trigger:t-1',
      adapterType: TELEGRAM_ADAPTER_TYPE,
      triggerType: 'webhook',
      payload,
    };
  }

  // A message from `from.id === 123` with a username/first name (for @actor_*).
  function messageFromBoundUser(): Partial<TelegramMessagePayload> {
    return {
      message_id: '42',
      sender_id: TG_USER,
      sender_username: 'adas',
      sender_first_name: 'Ada',
    };
  }

  it('bound id → email-bearing identity carrying the team-scoped email', async () => {
    // teamA has a binding for tg user 123 → x@a.com.
    identityStore.set(identityKey(TEAM_A, TG_USER), EMAIL_A);
    const a = new TelegramAdapter(TEAM_A, CRED_ID);

    const actor = await a.extractActor({ event: event(messageFromBoundUser()) });
    expect(actor).toEqual({
      identifier: TG_USER,
      scheme: 'email',
      adapterType: TELEGRAM_ADAPTER_TYPE,
      email: EMAIL_A,
      name: 'Ada',
      label: '@adas',
    });

    const candidates = await a.getActorCandidates({ event: event(messageFromBoundUser()) });
    expect(candidates).toEqual([
      {
        identity: {
          identifier: TG_USER,
          scheme: 'email',
          adapterType: TELEGRAM_ADAPTER_TYPE,
          email: EMAIL_A,
          name: 'Ada',
          label: '@adas',
        },
        source: 'originator',
      },
    ]);
  });

  it('unbound id → null actor / no candidates (no row for this sender)', async () => {
    // Store empty — no binding for tg user 123 in this team.
    const a = new TelegramAdapter(TEAM_A, CRED_ID);
    expect(await a.extractActor({ event: event(messageFromBoundUser()) })).toBeNull();
    expect(await a.getActorCandidates({ event: event(messageFromBoundUser()) })).toEqual([]);
  });

  // ── CROSS-TEAM ISOLATION (load-bearing security test) ──────────────────
  // A binding exists ONLY for teamA. A teamB-constructed adapter resolving the
  // SAME telegram_user_id must get null — it must never see teamA's email.
  it('cross-team: teamB adapter never resolves teamA-owned binding for the same id', async () => {
    identityStore.set(identityKey(TEAM_A, TG_USER), EMAIL_A);
    const teamB = new TelegramAdapter(TEAM_B, CRED_ID);

    const actor = await teamB.extractActor({ event: event(messageFromBoundUser()) });
    expect(actor).toBeNull();

    const candidates = await teamB.getActorCandidates({ event: event(messageFromBoundUser()) });
    expect(candidates).toEqual([]);

    // teamA, by contrast, DOES resolve its own binding for the identical id.
    const teamA = new TelegramAdapter(TEAM_A, CRED_ID);
    const teamAActor = await teamA.extractActor({ event: event(messageFromBoundUser()) });
    expect(teamAActor?.email).toBe(EMAIL_A);
  });

  it('null actor when there is no sender id at all', async () => {
    identityStore.set(identityKey(TEAM_A, TG_USER), EMAIL_A);
    const a = new TelegramAdapter(TEAM_A, CRED_ID);
    const e = event({ message_id: '1', sender_id: '' });
    expect(await a.getActorCandidates({ event: e })).toEqual([]);
    expect(await a.extractActor({ event: e })).toBeNull();
  });
});

describe('TelegramAdapter.createRecord (edge-anchored DM / reply)', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 555, chat: { id: 424242 }, text: 'hi' } }),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  // The engine speaks the program's NATURAL names — the unified type's
  // displayName ('Message') and the field displayName ('Text'). The
  // chat + reply target come from the parent link, never from fields.
  const MESSAGE_TYPE = 'Message';

  it('DM (Linked User -[:messages]->): the linked user id IS the chat id, no reply_to', async () => {
    const result = await adapter().createRecord({
      recordType: MESSAGE_TYPE,
      fields: { Text: 'hello' },
      parentLinks: [{ recordType: 'Linked User', externalId: '424242', edgeName: 'Messages' }],
      mutationContext: {} as never,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botBOT123/sendMessage');
    expect(JSON.parse(init.body)).toEqual({ chat_id: '424242', text: 'hello' });
    expect(JSON.parse(init.body).reply_to_message_id).toBeUndefined();
    expect(result.externalId).toBe('555');
    expect(result.adapterType).toBe(TELEGRAM_ADAPTER_TYPE);
    expect((result.data as Record<string, unknown>).chat_id).toBe('424242');
  });

  it('reply (msg -[:replies]->): chat from parent data, reply target from parent externalId', async () => {
    await adapter().createRecord({
      recordType: MESSAGE_TYPE,
      fields: { Text: 'noted' },
      parentLinks: [
        { recordType: 'Message', externalId: '77', edgeName: 'Replies', data: { chat_id: '424242' } },
      ],
      mutationContext: {} as never,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat_id: '424242',
      text: 'noted',
      reply_to_message_id: 77,
    });
  });

  it('reply chained off a write handle (WriteResult data shape) re-anchors the same way', async () => {
    await adapter().createRecord({
      recordType: MESSAGE_TYPE,
      fields: { Text: 'again' },
      parentLinks: [
        {
          recordType: 'Message',
          externalId: '99',
          edgeName: 'Replies',
          data: { message_id: '99', chat_id: '424242', text: 'prev' },
        },
      ],
      mutationContext: {} as never,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat_id: '424242',
      text: 'again',
      reply_to_message_id: 99,
    });
  });

  it('reply with no chat_id anywhere → rejects (parentage must carry the chat)', async () => {
    await expect(
      adapter().createRecord({
        recordType: MESSAGE_TYPE,
        fields: { Text: 'orphan' },
        parentLinks: [{ recordType: 'Message', externalId: '77', edgeName: 'Replies' }],
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/chat_id/);
  });

  it('no parent → rejects (there is no top-level send)', async () => {
    await expect(
      adapter().createRecord({
        recordType: MESSAGE_TYPE,
        fields: { Text: 'hi' },
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/along an edge/);
  });

  it('a Linked User parent along a non-`messages` edge → rejects', async () => {
    await expect(
      adapter().createRecord({
        recordType: MESSAGE_TYPE,
        fields: { Text: 'hi' },
        parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Replies' }],
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/cannot be created along/);
  });

  it('empty Text → rejects', async () => {
    await expect(
      adapter().createRecord({
        recordType: MESSAGE_TYPE,
        fields: { Text: '' },
        parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Messages' }],
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/Text/);
  });

  // ── Reply Markup — verbatim passthrough ────────────────────────────────
  // The whole doctrine in one assertion: whatever the author assembled reaches
  // Telegram byte-for-byte. A wrapper, a rename, or a stringify here is the
  // defect this pins.
  const KEYBOARD = {
    inline_keyboard: [
      [
        { text: 'Send', url: 'http://localhost:3500/api/asks/ask_abc?answer=true' },
        { text: 'Hold', callback_data: 'ask_abc?answer=false' },
      ],
    ],
  };

  it('Reply Markup rides sendMessage verbatim — nested rows, both button kinds', async () => {
    await adapter().createRecord({
      recordType: MESSAGE_TYPE,
      fields: { Text: 'Send the update?', 'Reply Markup': KEYBOARD },
      parentLinks: [{ recordType: 'Linked User', externalId: '424242', edgeName: 'Messages' }],
      mutationContext: {} as never,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat_id: '424242',
      text: 'Send the update?',
      reply_markup: KEYBOARD,
    });
  });

  it('composes with a threaded reply — Telegram excludes nothing (no write union)', async () => {
    await adapter().createRecord({
      recordType: MESSAGE_TYPE,
      fields: { Text: 'Send the update?', 'Reply Markup': KEYBOARD },
      parentLinks: [
        { recordType: 'Message', externalId: '77', edgeName: 'Replies', data: { chat_id: '424242' } },
      ],
      mutationContext: {} as never,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat_id: '424242',
      text: 'Send the update?',
      reply_to_message_id: 77,
      reply_markup: KEYBOARD,
    });
  });

  it('an absent or empty Reply Markup sends no `reply_markup` key at all', async () => {
    for (const value of [undefined, null, {}]) {
      fetchMock.mockClear();
      await adapter().createRecord({
        recordType: MESSAGE_TYPE,
        fields: { Text: 'plain', 'Reply Markup': value },
        parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Messages' }],
        mutationContext: {} as never,
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('reply_markup');
    }
  });

  it('a Reply Markup that is not a single object → rejects loudly (never a silent drop)', async () => {
    for (const bad of [[{ text: 'Send' }], 'inline_keyboard', 7]) {
      await expect(
        adapter().createRecord({
          recordType: MESSAGE_TYPE,
          fields: { Text: 'hi', 'Reply Markup': bad },
          parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Messages' }],
          mutationContext: {} as never,
        }),
      ).rejects.toThrow(/Reply Markup must be a single Telegram reply_markup object/);
    }
  });

  it('is declared send-side only — a received message never reads a keyboard back', async () => {
    const desc = await adapter().describe(TELEGRAM_MESSAGE_TYPE_ID);
    const field = desc?.fields.find((f) => f.displayName === 'Reply Markup');
    expect(field).toMatchObject({ kind: 'json', writable: true, readable: false, required: false });
    expect(field?.cardinality).toBeUndefined(); // ONE — a single reply_markup object
  });
});

describe('TelegramAdapter attachment `data` — a FileRef descriptor', () => {
  const ATTACHMENT_TYPE = 'Attachment';

  function attachmentPosition(att: Record<string, unknown>) {
    return makeUnstablePosition({
      adapterType: TELEGRAM_ADAPTER_TYPE,
      recordType: ATTACHMENT_TYPE,
      data: att,
    });
  }

  it('mints a FileRef carrying name/contentType/size + the file_id handle', async () => {
    const position = attachmentPosition({
      file_id: 'VOICE1', name: 'voice_uv1.ogg', contentType: 'audio/ogg', size: 4321,
    });
    const ref = (await adapter().getFieldValue({ position, fieldId: 'File' })) as FileRef;
    expect(ref).toMatchObject({
      __brand: 'FileRef',
      name: 'voice_uv1.ogg',
      contentType: 'audio/ogg',
      size: 4321,
      source: { adapterType: TELEGRAM_ADAPTER_TYPE, credentialId: CRED_ID, handle: 'VOICE1' },
    });
  });

  it('the owner redeems the FileRef for its bytes (getFile → file-path fetch)', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/getFile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { file_id: 'VOICE1', file_unique_id: 'uv1', file_path: 'voice/file_1.oga' } }),
        };
      }
      const { Readable } = await import('node:stream');
      const webStream = Readable.toWeb(Readable.from(Buffer.from('OGGBYTES')));
      return { ok: true, status: 200, body: webStream, headers: { get: () => 'audio/ogg' } };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const position = attachmentPosition({
      file_id: 'VOICE1', name: 'voice_uv1.ogg', contentType: 'audio/ogg', size: 4321,
    });
    const owner = adapter();
    const ref = (await owner.getFieldValue({ position, fieldId: 'File' })) as FileRef;
    const resolved = await owner.resolveFileRef({ ref });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/botBOT123/getFile');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.telegram.org/file/botBOT123/voice/file_1.oga');
    expect(resolved.contentType).toBe('audio/ogg');
  });

  it('a scalar field on the attachment still reads plainly', async () => {
    const position = attachmentPosition({ file_id: 'F1', name: 'deck.pdf', contentType: 'application/pdf', size: 7 });
    expect(await adapter().getFieldValue({ position, fieldId: 'Content Type' })).toBe('application/pdf');
  });

  it('no file_id -> null (no broken ref)', async () => {
    const position = attachmentPosition({ name: 'x' });
    expect(await adapter().getFieldValue({ position, fieldId: 'File' })).toBeNull();
  });
});

describe('TelegramAdapter.resolveFileRef', () => {
  it('resolves a file_id via getFile then fetches the file path bytes', async () => {
    const fetchMock = jest.fn(
      async (url: string) => {
        if (url.includes('/getFile')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: { file_id: 'FILE9', file_unique_id: 'u9', file_path: 'documents/deck.pdf' } }),
          };
        }
        // The bytes leg.
        const { Readable } = await import('node:stream');
        const webStream = Readable.toWeb(Readable.from(Buffer.from('PDFBYTES')));
        return {
          ok: true,
          status: 200,
          body: webStream,
          headers: { get: () => 'application/pdf' },
        };
      },
    );
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const result = await adapter().resolveFileRef({
      ref: { __brand: 'FileRef', source: { adapterType: TELEGRAM_ADAPTER_TYPE, handle: 'FILE9' } },
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/botBOT123/getFile');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.telegram.org/file/botBOT123/documents/deck.pdf');
    expect(result.contentType).toBe('application/pdf');
  });

  it('throws when the FileRef has no source handle', async () => {
    await expect(
      adapter().resolveFileRef({ ref: { __brand: 'FileRef' } }),
    ).rejects.toThrow(/no source handle/);
  });
});

describe('TelegramAdapter built-in bot token resolution (BYO + env fallback)', () => {
  // Resolution order under test (Pillar A):
  //   1. per-team credential present → BYO token (BYO123, via the mocked
  //      decryptToken above).
  //   2. no per-team credential but TELEGRAM_BOT_TOKEN set → the built-in token.
  //   3. neither → construction is null (no throw); a send errors clearly.
  // The Bot API is stubbed via global.fetch; the URL carries the token, so we
  // assert which token the send used by reading `botXXX` out of the call URL.
  let fetchMock: jest.Mock;
  const ORIGINAL_ENV = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 5 }, text: 'hi' } }),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_ENV;
  });

  // The token-resolution assertions are agnostic to WHICH send shape: a DM
  // anchored on a linked user is the simplest send (chat id = the linked
  // user's own id). We only read the bot token out of the call URL.
  function sendVia(a: TelegramAdapter) {
    return a.createRecord({
      recordType: 'Message',
      fields: { Text: 'hi' },
      parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Messages' }],
      mutationContext: {} as never,
    });
  }
  function sentTokenFromUrl(): string {
    // URL is `<base>/bot<token>/sendMessage`.
    const url = fetchMock.mock.calls[0][0] as string;
    return url.match(/\/bot([^/]+)\//)?.[1] ?? '';
  }

  it('BYO present → uses the per-team token (unchanged), even with env token set', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'BUILTIN_TOKEN';
    // CRED_ID wired → decryptToken mock returns { botToken: 'BOT123' }.
    await sendVia(new TelegramAdapter(TEAM_ID, CRED_ID));
    expect(sentTokenFromUrl()).toBe('BOT123');
  });

  it('no BYO + TELEGRAM_BOT_TOKEN set → uses the built-in token', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'BUILTIN_TOKEN';
    await sendVia(new TelegramAdapter(TEAM_ID, undefined));
    expect(sentTokenFromUrl()).toBe('BUILTIN_TOKEN');
  });

  it('an empty/whitespace TELEGRAM_BOT_TOKEN counts as unset', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '   ';
    await expect(sendVia(new TelegramAdapter(TEAM_ID, undefined))).rejects.toThrow(
      /no usable Telegram bot token/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('neither BYO nor env token → send errors clearly (and construction does not crash)', async () => {
    // Construction itself never throws regardless of token state.
    const a = new TelegramAdapter(TEAM_ID, undefined);
    expect(a).toBeInstanceOf(TelegramAdapter);
    await expect(sendVia(a)).rejects.toThrow(/no usable Telegram bot token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TelegramAdapter empty (connected) credential → built-in env token (Chunk 7)', () => {
  // A wired TELEGRAM credential whose decrypted payload carries NO usable bot
  // token is the team's "connect the shared bot" gesture. It must resolve
  // EXACTLY like the no-credential case: fall back to the env built-in token.
  // BYO (a real botToken) must stay untouched.
  let fetchMock: jest.Mock;
  const ORIGINAL_ENV = process.env.TELEGRAM_BOT_TOKEN;
  const DEFAULT_PAYLOAD = JSON.stringify({ botToken: 'BOT123' });

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 5 }, text: 'hi' } }),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
  afterEach(() => {
    decryptedPayload.value = DEFAULT_PAYLOAD;
    if (ORIGINAL_ENV === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_ENV;
  });

  // The token-resolution assertions are agnostic to WHICH send shape: a DM
  // anchored on a linked user is the simplest send (chat id = the linked
  // user's own id). We only read the bot token out of the call URL.
  function sendVia(a: TelegramAdapter) {
    return a.createRecord({
      recordType: 'Message',
      fields: { Text: 'hi' },
      parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Messages' }],
      mutationContext: {} as never,
    });
  }
  function sentTokenFromUrl(): string {
    const url = fetchMock.mock.calls[0][0] as string;
    return url.match(/\/bot([^/]+)\//)?.[1] ?? '';
  }

  it('empty `{}` payload + env set → uses the built-in env token', async () => {
    decryptedPayload.value = JSON.stringify({});
    process.env.TELEGRAM_BOT_TOKEN = 'BUILTIN_TOKEN';
    await sendVia(new TelegramAdapter(TEAM_ID, CRED_ID));
    expect(sentTokenFromUrl()).toBe('BUILTIN_TOKEN');
  });

  it('blank `{ botToken: "" }` payload → treated as empty → built-in env token', async () => {
    decryptedPayload.value = JSON.stringify({ botToken: '   ' });
    process.env.TELEGRAM_BOT_TOKEN = 'BUILTIN_TOKEN';
    await sendVia(new TelegramAdapter(TEAM_ID, CRED_ID));
    expect(sentTokenFromUrl()).toBe('BUILTIN_TOKEN');
  });

  it('BYO (real botToken) is unchanged — uses the per-team token, NOT the env', async () => {
    decryptedPayload.value = JSON.stringify({ botToken: 'BYO_TOKEN' });
    process.env.TELEGRAM_BOT_TOKEN = 'BUILTIN_TOKEN';
    await sendVia(new TelegramAdapter(TEAM_ID, CRED_ID));
    expect(sentTokenFromUrl()).toBe('BYO_TOKEN');
  });

  it('empty payload + NO env token → send errors clearly (same as no-credential)', async () => {
    decryptedPayload.value = JSON.stringify({});
    await expect(sendVia(new TelegramAdapter(TEAM_ID, CRED_ID))).rejects.toThrow(
      /no usable Telegram bot token/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TelegramAdapter empty credential under the harness team (fake base url)', () => {
  // The empty-credential fallback must STILL apply the fake-base-url swap under
  // the test-harness team, so the dev-loop E2E (movement constructs
  // `telegram(credentials: <empty>)`) hits the fake Bot API on the built-in
  // client. Re-mock `lib/recording` so isTestHarnessTeam → true.
  const FAKE_BASE = 'http://localhost:5556/telegram';
  const DEFAULT_PAYLOAD = JSON.stringify({ botToken: 'BOT123' });
  let fetchMock: jest.Mock;
  const ORIGINAL_ENV = process.env.TELEGRAM_BOT_TOKEN;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../../../../lib/recording', () => ({
      isTestHarnessTeam: () => true,
      injectFakeBaseUrl: (creds: Record<string, unknown>) => ({ ...creds, baseUrl: FAKE_BASE }),
    }));
  });
  afterAll(() => {
    jest.dontMock('../../../../../lib/recording');
    jest.resetModules();
  });

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 5 }, text: 'hi' } }),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    process.env.TELEGRAM_BOT_TOKEN = 'BUILTIN_TOKEN';
    decryptedPayload.value = JSON.stringify({});
  });
  afterEach(() => {
    decryptedPayload.value = DEFAULT_PAYLOAD;
    if (ORIGINAL_ENV === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_ENV;
  });

  it('empty credential + harness team → built-in token through the fake base url', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TelegramAdapter: HarnessAdapter } = require('../index');
    const a = new HarnessAdapter(TEAM_ID, CRED_ID);
    await a.createRecord({
      recordType: 'Message',
      fields: { Text: 'hi' },
      parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Messages' }],
      mutationContext: {} as never,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(`${FAKE_BASE}/botBUILTIN_TOKEN/sendMessage`);
  });
});

describe('TelegramAdapter built-in path under the test-harness team (fake base url)', () => {
  // The fake-base-url override must still apply to the BUILT-IN client so
  // Chunk 5's dev-loop E2E hits the fake Bot API. This suite re-mocks
  // `lib/recording` so isTestHarnessTeam → true and injectFakeBaseUrl behaves
  // like the real helper (sets baseUrl to the fake-channels host), then asserts
  // the send went to the fake base — proving the override rides the built-in
  // path, not just BYO.
  const FAKE_BASE = 'http://localhost:5556/telegram';
  let fetchMock: jest.Mock;
  const ORIGINAL_ENV = process.env.TELEGRAM_BOT_TOKEN;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../../../../lib/recording', () => ({
      isTestHarnessTeam: () => true,
      injectFakeBaseUrl: (creds: Record<string, unknown>) => ({ ...creds, baseUrl: FAKE_BASE }),
    }));
  });
  afterAll(() => {
    jest.dontMock('../../../../../lib/recording');
    jest.resetModules();
  });

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 5 }, text: 'hi' } }),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    process.env.TELEGRAM_BOT_TOKEN = 'BUILTIN_TOKEN';
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_ENV;
  });

  it('built-in client (no BYO) sends through the fake base url under the harness team', async () => {
    // Re-require the adapter so it picks up the re-mocked recording module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TelegramAdapter: HarnessAdapter } = require('../index');
    const a = new HarnessAdapter(TEAM_ID, undefined);
    await a.createRecord({
      recordType: 'Message',
      fields: { Text: 'hi' },
      parentLinks: [{ recordType: 'Linked User', externalId: '5', edgeName: 'Messages' }],
      mutationContext: {} as never,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(`${FAKE_BASE}/botBUILTIN_TOKEN/sendMessage`);
  });
});

// ── Inbound parse → discriminate contract (pins the ff2bc7432 class) ──────
//
// Telegram's normalized payload carries NO literal discriminator (unlike
// Slack's inner-event `type`), so the event type is TAG-ONLY and the parse
// classifies + tags. Both inbound doors (BYO `preprocessInbound`, shared-bot
// `telegram_builtin.ts`) MUST route through `telegramEventToDiscriminable`, or
// the untagged event matches no type → no stable position → a reply write off
// the inbound message errors with "no durable record id". The second case
// demonstrates that failure mode directly (the un-tagged legacy conversion).
describe('TelegramAdapter.listEventTypes — inbound parse→discriminate contract', () => {
  const update = {
    update_id: 9001,
    message: {
      message_id: 77,
      from: { id: 424242, is_bot: false, first_name: 'Ada' },
      chat: { id: 424242, type: 'private' },
      date: 1700000000,
      text: 'ping',
    },
  };

  it('a real Update discriminates to a STABLE telegram:message position via the tagged mapper', async () => {
    const parsed = parseTelegramEvents(update);
    expect(parsed).toHaveLength(1);
    const discriminable = telegramEventToDiscriminable(parsed[0]);
    const eventTypes = await adapter().listEventTypes();
    const result = discriminateEvent({ adapterType: TELEGRAM_ADAPTER_TYPE, event: discriminable, eventTypes });
    expect(result?.eventType.positionType).toBe(TELEGRAM_MESSAGE_TYPE_ID);
    expect(result?.position.identity).toMatchObject({ kind: 'stable', recordId: '77' });
  });

  it('the UN-tagged legacy conversion does NOT discriminate — pins that both doors must use the tagged mapper', async () => {
    const parsed = parseTelegramEvents(update);
    const untagged = webhookEventToDiscriminable(parsed[0]);
    const eventTypes = await adapter().listEventTypes();
    expect(discriminateEvent({ adapterType: TELEGRAM_ADAPTER_TYPE, event: untagged, eventTypes })).toBeNull();
  });
});

describe('Telegram registry wiring', () => {
  // Import lazily so the credential/kysely mocks above are already installed
  // (registry pulls in the full adapter graph at module load).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getAdapter, getAdapterManifest, resolveAdapterSlug } = require('../../registry');

  it('constructs the adapter through getAdapter by slug and by TELEGRAM kind alias', () => {
    expect(getAdapter({ adapterType: 'telegram', teamId: TEAM_ID }).adapterType).toBe(TELEGRAM_ADAPTER_TYPE);
    expect(resolveAdapterSlug('TELEGRAM')).toBe('telegram');
    expect(getAdapter({ adapterType: 'TELEGRAM', teamId: TEAM_ID }).adapterType).toBe(TELEGRAM_ADAPTER_TYPE);
  });

  it('exposes the Telegram manifest (writable, webhook source)', () => {
    const m = getAdapterManifest('telegram');
    expect(m?.adapterType).toBe(TELEGRAM_ADAPTER_TYPE);
    expect(m?.requiredCredentialType).toBe('TELEGRAM');
    expect(m?.methods).toContain('createRecord');
    expect(m?.supportedTriggers).toContain('webhook');
  });
});
