/**
 * Unit tests for the WhatsApp source adapter's read path — `getFieldValue`
 * and the `attachments` edge traversal (`getRelated`) — plus the shared phone
 * normaliser.
 *
 * The message body and its media are exposed EXPLICITLY and losslessly: the
 * body via the `Body` field and media via the `-[:Attachments]->` edge (each
 * attachment carrying a `data` File plus `name`/`contentType`/`url`). The
 * input-side `_resources` reference is gone — that hop is EXTRACTED-NODE
 * provenance only and no longer reachable off an input/source position, so
 * walking it off an input drifts.
 *
 * The defining concern here is dual-shape tolerance. No producer reshapes
 * the raw Twilio webhook into the TG-side `WhatsappPayload` before it
 * reaches the adapter, so the webhook dict (`From`/`Body`/`NumMedia`/
 * `MediaUrl{i}`/…) lands on the position verbatim. The adapter must read
 * that raw shape identically to the camelCase TG shape — otherwise the
 * sender authenticates but the body/attachments silently vanish. These
 * tests pin both shapes to the same observable output, mirroring v3's
 * `twilio.adapter.ts` field handling.
 */

// `mime` v4 is ESM-only; the adapter resolves extensions via
// `await import('mime')` (the same pattern as the v3 twilio/mailgun/slack
// inbound adapters). Under ts-jest's CJS runtime that import can't be
// evaluated, so we mock it with the exact mappings the real package returns
// for these inputs (verified: image/jpeg→jpeg, application/pdf→pdf,
// image/png→png).
const sendReactionMock = jest.fn();
const sendTextMessageMock = jest.fn();
const sendMediaMessageMock = jest.fn();
const sendTypingOnMock = jest.fn();
const sendInteractiveMock = jest.fn();
jest.mock('../../whatsapp/metaApi', () => {
  const api = {
    sendReaction: (...args: unknown[]) => sendReactionMock(...args),
    sendTextMessage: (...args: unknown[]) => sendTextMessageMock(...args),
    sendMediaMessage: (...args: unknown[]) => sendMediaMessageMock(...args),
    sendTypingOn: (...args: unknown[]) => sendTypingOnMock(...args),
    sendInteractive: (...args: unknown[]) => sendInteractiveMock(...args),
  };
  // The adapter now selects a send client by the message's receiving number;
  // the tests exercise one number, so every id maps to the same mock.
  return { metaWhatsappApi: api, getMetaWhatsappApi: () => api };
});

jest.mock('mime', () => ({
  __esModule: true,
  default: {
    getExtension: (contentType: string): string | null =>
      ({ 'image/jpeg': 'jpeg', 'application/pdf': 'pdf', 'image/png': 'png' }[contentType] ?? null),
  },
}));

import { parseProgram, checkProgram, mockCatalog, type Catalog } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { SchemaTypeDescriptor, SourcePosition } from '../types';

import {
  WhatsappAdapter,
  WHATSAPP_ADAPTER_TYPE,
  WHATSAPP_RECORD_TYPE_ID,
  WHATSAPP_ATTACHMENT_TYPE_ID,
  WHATSAPP_INBOUND_REACTION_TYPE,
  WHATSAPP_INBOUND_LOCATION_TYPE,
  WHATSAPP_TYPING_TYPE,
  type WhatsappPayload,
} from '../adapters/whatsapp';
import { fileValue, RESOURCES_REFERENCE_FIELD_ID } from '../adapter';
import { installMemoryDocumentStore } from '../engine/files/__test__/memory_document_store';
import { normalizeWhatsappPhone } from '../adapters/acting_user/phone';
import { discriminateEvent } from '../engine/inbound/discriminate';
import { parseWhatsappEvents } from '../../webhook_sync/providers/whatsapp';
import { webhookEventToDiscriminable } from '../../webhook_sync/event_conversion';
import { makeStablePosition, makeUnstablePosition } from '../types';
import { instanceSchemaFromDescriptors } from '../movement/schema_projection';

const TEAM_ID = 'team-1' as TeamId;

function makeMessagePosition(data: Record<string, unknown>, recordId = 'rec-1'): SourcePosition {
  return makeStablePosition({
    adapterType: WHATSAPP_ADAPTER_TYPE,
    // The source-read wrapper stamps the NATURAL type name (the entry's
    // displayName) onto a read position; field resolution keys off it.
    recordType: 'Message',
    recordId,
    data,
  });
}

// The webhook router seeds the source as the EVENT NODE the fires edge lands
// on — which, after rule 1's collapse, IS the Message — typed by its canonical
// address (nothing is pinned, so the key is the bare node name `Message`), with
// the raw Twilio webhook dict riding as `data`.
//
// It used to mint `recordType: null` here, and that is the state that no longer
// exists: a typeless position is an ERROR (ruling 2026-07-19), because nothing
// downstream can resolve a field or an edge without knowing what holds it.
// Unstable rather than stable only because stability changes nothing about how
// names resolve; what this fixture exercises is the RAW payload shape.
function makeWebhookPosition(data: Record<string, unknown>): SourcePosition {
  return makeUnstablePosition({
    adapterType: WHATSAPP_ADAPTER_TYPE,
    recordType: 'Message',
    data,
  });
}

// `getRelated` emits attachment positions stamped with the INTERNAL type id;
// the engine's source-read wrapper restamps a related position with the
// NATURAL type displayName before field resolution keys off it. Mirror that
// here so attachment fields resolve by their natural names (`name`/`url`/…).
function asReadPosition(position: SourcePosition): SourcePosition {
  return makeUnstablePosition({
    adapterType: WHATSAPP_ADAPTER_TYPE,
    recordType: 'Attachment',
    data: (position.identity.data ?? {}) as Record<string, unknown>,
  });
}

// A representative raw Twilio webhook payload (the shape Twilio POSTs).
const RAW_TWILIO = {
  MessageSid: 'SM123',
  From: 'whatsapp:+15551234567',
  To: 'whatsapp:+14155550000',
  Body: 'hello from whatsapp',
  WaId: '15551234567',
  ProfileName: 'Ada',
  NumMedia: '2',
  MediaUrl0: 'https://api.twilio.com/media/0',
  MediaContentType0: 'image/jpeg',
  MediaUrl1: 'https://api.twilio.com/media/1',
  MediaContentType1: 'application/pdf',
};

// The equivalent TG-side payload (what a future producer would emit).
const TG_PAYLOAD: WhatsappPayload = {
  messageId: 'SM123',
  from: '+15551234567',
  to: '+14155550000',
  body: 'hello from whatsapp',
  waId: '15551234567',
  profileName: 'Ada',
  attachments: [
    { key: 'https://api.twilio.com/media/0', url: 'https://api.twilio.com/media/0', contentType: 'image/jpeg', filename: 'Attachment 1.jpeg' },
    { key: 'https://api.twilio.com/media/1', url: 'https://api.twilio.com/media/1', contentType: 'application/pdf', filename: 'Attachment 2.pdf' },
  ],
};

describe('WhatsappAdapter — getFieldValue', () => {
  it('reads the raw Twilio webhook shape, stripping the whatsapp: prefix off phone fields', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const pos = makeWebhookPosition(RAW_TWILIO);
    // Read by NATURAL name — the currency the program names fields by, and the
    // only one a typed position resolves. What differs from the test below is
    // the PAYLOAD shape (raw Twilio keys), not the names read off it.
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'From' })).toBe('+15551234567');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'To' })).toBe('+14155550000');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe('hello from whatsapp');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'WhatsApp Id' })).toBe('15551234567');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Profile Name' })).toBe('Ada');
  });

  it('reads the TG-side camelCase shape identically', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const pos = makeMessagePosition(TG_PAYLOAD as unknown as Record<string, unknown>);
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'From' })).toBe('+15551234567');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe('hello from whatsapp');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'WhatsApp Id' })).toBe('15551234567');
  });

  it('returns null for an absent field', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const pos = makeWebhookPosition({ From: 'whatsapp:+15551234567' });
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe('');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Profile Name' })).toBeNull();
  });
});

describe('WhatsappAdapter — describe (references)', () => {
  it('exposes the `attachments` edge and no longer exposes `_resources`', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const descriptor = await adapter.describe('Message');
    const referenceNames = (descriptor?.references ?? []).map((r) => r.name);
    const referenceFieldIds = (descriptor?.references ?? []).map((r) => r.fieldId);

    expect(referenceNames).toContain('Attachments');
    // `_resources` is EXTRACTED-NODE provenance only — never an input-side
    // reference. It must not appear in the message descriptor.
    expect(referenceFieldIds).not.toContain(RESOURCES_REFERENCE_FIELD_ID);
  });
});

describe('WhatsappAdapter — `_resources` is not reachable off an input position', () => {
  it('drifts when a `_resources` hop is walked off an input whatsapp message', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    // A typed message position — the resolver runs against the descriptor,
    // where `_resources` is absent, so the hop throws drift rather than
    // resolving to a body/media resource.
    const position = makeMessagePosition(TG_PAYLOAD as unknown as Record<string, unknown>);
    await expect(
      adapter.getRelated({ position, fieldId: RESOURCES_REFERENCE_FIELD_ID, direction: 'outgoing' }),
    ).rejects.toThrow();
  });
});

describe('WhatsappAdapter — attachments edge (explicit media path)', () => {
  it('expands a raw Twilio webhook into one attachment per media, with v3-style filenames and a File handle', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const related = await adapter.getRelated({
      position: makeMessagePosition(RAW_TWILIO),
      fieldId: 'Attachments',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(2);

    const attachmentPositions = related.map((r) => asReadPosition(r.position));
    // Fields are read by their NATURAL displayName — the currency the program
    // names them by, exactly as the message reads `From`/`Body`.
    const names = await Promise.all(
      attachmentPositions.map((position) => adapter.getFieldValue({ position, fieldId: 'Name' })),
    );
    const contentTypes = await Promise.all(
      attachmentPositions.map((position) => adapter.getFieldValue({ position, fieldId: 'Content Type' })),
    );
    const urls = await Promise.all(
      attachmentPositions.map((position) => adapter.getFieldValue({ position, fieldId: 'URL' })),
    );

    expect(names).toEqual(['Attachment 1.jpeg', 'Attachment 2.pdf']);
    expect(contentTypes).toEqual(['image/jpeg', 'application/pdf']);
    expect(urls).toEqual(['https://api.twilio.com/media/0', 'https://api.twilio.com/media/1']);

    // The `File` primitive (`data`) is the explicit, lossless media byte
    // handle — the attachment descriptor declares it so File-typed media
    // routes into File-typed targets.
    const attachmentDescriptor = await adapter.describe('Attachment');
    const fileField = (attachmentDescriptor?.fields ?? []).find((f) => f.displayName === 'File');
    expect(fileField?.kind).toBe('file');
  });

  it('walks the TG-side payload attachments identically', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const related = await adapter.getRelated({
      position: makeMessagePosition(TG_PAYLOAD as unknown as Record<string, unknown>),
      fieldId: 'Attachments',
      direction: 'outgoing',
    });
    const names = await Promise.all(
      related.map((r) => adapter.getFieldValue({ position: asReadPosition(r.position), fieldId: 'Name' })),
    );
    expect(names).toEqual(['Attachment 1.jpeg', 'Attachment 2.pdf']);
  });

  it('yields no attachments when NumMedia is 0 — the body still reads off the Body field', async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const position = makeWebhookPosition({ From: 'whatsapp:+15551234567', Body: 'text only', NumMedia: '0' });
    const related = await adapter.getRelated({ position, fieldId: 'Attachments', direction: 'outgoing' });
    expect(related).toEqual([]);
    // The explicit body path stays lossless even with no media.
    expect(await adapter.getFieldValue({ position, fieldId: 'Body' })).toBe('text only');
  });
});

describe('normalizeWhatsappPhone', () => {
  it('strips the whatsapp: transport prefix', () => {
    expect(normalizeWhatsappPhone('whatsapp:+15551234567')).toBe('+15551234567');
  });

  it('trims surrounding whitespace but preserves internal characters (v3 parity)', () => {
    expect(normalizeWhatsappPhone('  whatsapp:+15551234567  ')).toBe('+15551234567');
    // v3 matched the number verbatim — internal spaces are NOT stripped, so
    // the surfaced identifier equals the value matched against the DB.
    expect(normalizeWhatsappPhone('+1 555 123 4567')).toBe('+1 555 123 4567');
  });

  it('is idempotent — re-normalising an already-bare number is a no-op', () => {
    const once = normalizeWhatsappPhone('whatsapp:+15551234567');
    expect(normalizeWhatsappPhone(once)).toBe(once);
  });

  it('returns null for empty / missing input', () => {
    expect(normalizeWhatsappPhone('')).toBeNull();
    expect(normalizeWhatsappPhone('whatsapp:')).toBeNull();
    expect(normalizeWhatsappPhone(null)).toBeNull();
    expect(normalizeWhatsappPhone(undefined)).toBeNull();
  });
});


// ── Unified write surface ───────────────────────────────────────────────
// The `(send)` sentinel family is gone. Every WhatsApp write is created ALONG
// an edge off a message: replies → the message type itself, reactions → the
// inbound `Reaction` type, typing → the ephemeral `Typing`
// action. `To` is not a field — the other party derives from the anchor's
// data (an inbound parent's `from`, a sent handle's `to`).

const adapter = () => new WhatsappAdapter('team-1' as TeamId);
const mutationContext = {
  source: { type: 'structured_input' as const },
  occurredAt: new Date('2026-07-07T00:00:00Z').toISOString(),
};
// The inbound parent an ordinary reply/reaction anchors off (its `from` is the
// other party a send addresses).
const inboundParent = (edgeName: string) => ({
  recordType: 'Message',
  externalId: 'wamid.A',
  edgeName,
  data: { from: '+15551234567', body: 'ping' },
});

describe('WhatsappAdapter — unified write schema', () => {
  it('publishes the read/action types, NONE writable — the (send) sentinels are gone', async () => {
    const entries = await adapter().listEntryPoints();
    const typeIds = entries.map((e) => e.typeId);
    expect(typeIds).toEqual(
      expect.arrayContaining([
        WHATSAPP_RECORD_TYPE_ID,
        WHATSAPP_ATTACHMENT_TYPE_ID,
        WHATSAPP_INBOUND_REACTION_TYPE,
        WHATSAPP_INBOUND_LOCATION_TYPE,
        WHATSAPP_TYPING_TYPE,
      ]),
    );
    // No entry is a writable picker root — writes are edges off the message.
    expect(entries.every((e) => e.writable === false)).toBe(true);
    // The (send) sentinels no longer exist.
    expect(typeIds.some((t) => /\(send\)/.test(t))).toBe(false);
  });

  it('every entry typeId is colon-namespaced — an id never spells out the system', async () => {
    const entries = await adapter().listEntryPoints();
    // A typeId is an INTERNAL identity and follows the cross-adapter
    // convention (`attio:note`, `slack:reaction`); the human-facing name is
    // the displayName, which carries no system prefix (rule 5,
    // adapters/CLAUDE.md). Guards the 2026-07-18 rename of the three
    // outliers (`WhatsApp Reaction` / `Location` / `Typing`).
    expect(entries.map((e) => e.typeId)).toEqual(
      expect.arrayContaining([
        'whatsapp:message',
        'whatsapp:attachment',
        'whatsapp:reaction',
        'whatsapp:location',
        'whatsapp:typing',
      ]),
    );
    for (const entry of entries) {
      expect(entry.typeId).toMatch(/^whatsapp:[a-z]+$/);
      expect(entry.displayName).not.toMatch(/whatsapp/i);
    }
  });

  it('Message: Body + File writable, To read-only, and the three write edges re-point', async () => {
    const message = await adapter().describe('Message');
    const fields = Object.fromEntries((message?.fields ?? []).map((f) => [f.displayName, f]));
    expect(fields['Body']).toMatchObject({ writable: true });
    expect(fields['File']).toMatchObject({ writable: true, kind: 'file' });
    expect(fields['To']).toMatchObject({ writable: false });

    const refs = Object.fromEntries((message?.references ?? []).map((r) => [r.name, r]));
    expect(refs['Replies']).toMatchObject({ targetTypeId: WHATSAPP_RECORD_TYPE_ID, writable: true });
    expect(refs['Reactions']).toMatchObject({ targetTypeId: WHATSAPP_INBOUND_REACTION_TYPE, writable: true });
    expect(refs['Typing']).toMatchObject({
      targetTypeId: WHATSAPP_TYPING_TYPE,
      writable: true,
      ephemeral: true,
    });
  });

  it('Reaction: Emoji is the one writable, required field', async () => {
    const reaction = await adapter().describe(WHATSAPP_INBOUND_REACTION_TYPE);
    const emoji = reaction?.fields.find((f) => f.displayName === 'Emoji');
    expect(emoji).toMatchObject({ writable: true, required: true });
    // Everything else stays read-only.
    expect((reaction?.fields ?? []).filter((f) => f.writable).map((f) => f.displayName)).toEqual(['Emoji']);
  });

  it('Typing: a described action shape with NO writable fields', async () => {
    const typing = await adapter().describe(WHATSAPP_TYPING_TYPE);
    expect(typing?.fields).toEqual([]);
  });

  it('the (send) sentinel type no longer describes', async () => {
    expect(await adapter().describe('Message (send)')).toBeNull();
  });
});

describe('WhatsappAdapter.createRecord — reply (msg-[:Replies]->)', () => {
  beforeEach(() => {
    sendTextMessageMock.mockReset();
    sendTextMessageMock.mockResolvedValue('wamid.SENT');
    sendMediaMessageMock.mockReset();
  });

  it('threads a text reply, deriving the recipient from the parent’s `from`', async () => {
    const result = await adapter().createRecord({
      recordType: 'Message',
      fields: { Body: 'pong' },
      parentLinks: [inboundParent('Replies')],
      mutationContext,
    });
    expect(sendTextMessageMock).toHaveBeenCalledWith('+15551234567', 'pong', {
      replyToMessageId: 'wamid.A',
    });
    expect(result.externalId).toBe('wamid.SENT');
    expect(result.data).toMatchObject({
      to: '+15551234567',
      body: 'pong',
      reply_to_message_id: 'wamid.A',
    });
  });

  it('a File field sends media with the Body as caption', async () => {
    sendMediaMessageMock.mockResolvedValue('wamid.MEDIA');
    const store = installMemoryDocumentStore();
    const result = await adapter().createRecord({
      recordType: 'Message',
      fields: {
        Body: 'the report',
        File: fileValue(store.file('PDFBYTES', { name: 'report.pdf', contentType: 'application/pdf' })),
      },
      parentLinks: [inboundParent('Replies')],
      mutationContext,
    });
    expect(sendMediaMessageMock).toHaveBeenCalledTimes(1);
    const [to, media, options] = sendMediaMessageMock.mock.calls[0];
    expect(to).toBe('+15551234567');
    expect(media).toMatchObject({ filename: 'report.pdf', mimeType: 'application/pdf' });
    expect((media.buffer as Buffer).toString()).toBe('PDFBYTES');
    expect(options).toEqual({ caption: 'the report', replyToMessageId: 'wamid.A' });
    expect(result.externalId).toBe('wamid.MEDIA');
  });

  it('rejects a send with neither Body nor File', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Message',
        fields: {},
        parentLinks: [inboundParent('Replies')],
        mutationContext,
      }),
    ).rejects.toThrow(/Body.*File|File.*Body/);
  });

  it('a refused send fails loud and names the 24-hour service window', async () => {
    sendTextMessageMock.mockResolvedValue(null);
    await expect(
      adapter().createRecord({
        recordType: 'Message',
        fields: { Body: 'hello' },
        parentLinks: [inboundParent('Replies')],
        mutationContext,
      }),
    ).rejects.toThrow(/24/);
  });

  it('a chained send handle derives the recipient from its own `to`', async () => {
    await adapter().createRecord({
      recordType: 'Message',
      fields: { Body: 'again' },
      parentLinks: [
        {
          recordType: 'Message',
          externalId: 'wamid.SENT',
          edgeName: 'Replies',
          data: { to: '+15551234567', body: 'prev', reply_to_message_id: 'wamid.A' },
        },
      ],
      mutationContext,
    });
    expect(sendTextMessageMock).toHaveBeenCalledWith('+15551234567', 'again', {
      replyToMessageId: 'wamid.SENT',
    });
  });
});

describe('WhatsappAdapter.createRecord — Interactive (msg-[:Replies]->)', () => {
  beforeEach(() => {
    sendInteractiveMock.mockReset();
    sendInteractiveMock.mockResolvedValue('wamid.INTERACTIVE');
    sendTextMessageMock.mockReset();
  });

  it('passes the Interactive object through VERBATIM — no reshaping', async () => {
    const interactive = {
      type: 'button',
      body: { text: 'Ship the release?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'cb_approve', title: 'Approve' } },
          { type: 'reply', reply: { id: 'cb_reject', title: 'Reject' } },
        ],
      },
    };
    const result = await adapter().createRecord({
      recordType: 'Message',
      fields: { Interactive: interactive },
      parentLinks: [inboundParent('Replies')],
      mutationContext,
    });
    expect(sendInteractiveMock).toHaveBeenCalledWith('+15551234567', interactive, {
      replyToMessageId: 'wamid.A',
    });
    // Verbatim: the exact object reference/shape rides through untouched.
    expect(sendInteractiveMock.mock.calls[0][1]).toEqual(interactive);
    expect(result.externalId).toBe('wamid.INTERACTIVE');
    expect(result.data).toMatchObject({ to: '+15551234567', interactive: true, reply_to_message_id: 'wamid.A' });
    // Interactive REPLACES the plain-text send — Body is never also posted.
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('a refused interactive send fails loud', async () => {
    sendInteractiveMock.mockResolvedValue(null);
    await expect(
      adapter().createRecord({
        recordType: 'Message',
        fields: { Interactive: { type: 'button', body: { text: 'x' }, action: { buttons: [] } } },
        parentLinks: [inboundParent('Replies')],
        mutationContext,
      }),
    ).rejects.toThrow(/24/);
  });
});

describe('WhatsappAdapter.createRecord — reaction (msg-[:Reactions]->)', () => {
  beforeEach(() => {
    sendReactionMock.mockReset();
    sendReactionMock.mockResolvedValue(true);
  });

  it('reacts with the Emoji, deriving the recipient from the parent', async () => {
    const result = await adapter().createRecord({
      recordType: 'Reaction',
      fields: { Emoji: '👍' },
      parentLinks: [{ recordType: 'Message', externalId: 'wamid.A', edgeName: 'Reactions', data: { from: '+15551234567' } }],
      mutationContext,
    });
    expect(sendReactionMock).toHaveBeenCalledWith('+15551234567', 'wamid.A', '👍');
    expect(result.externalId).toContain('wamid.A');
    expect(result.data).toMatchObject({ to: '+15551234567', emoji: '👍', message_id: 'wamid.A' });
  });

  it('rejects a blank Emoji', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Reaction',
        fields: { Emoji: '' },
        parentLinks: [{ recordType: 'Message', externalId: 'wamid.A', edgeName: 'Reactions', data: { from: '+15551234567' } }],
        mutationContext,
      }),
    ).rejects.toThrow(/Emoji/);
    expect(sendReactionMock).not.toHaveBeenCalled();
  });

  it('rejects when the parent carries no sender (no from/to in its data)', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Reaction',
        fields: { Emoji: '👍' },
        parentLinks: [{ recordType: 'Message', externalId: 'wamid.A', edgeName: 'Reactions', data: {} }],
        mutationContext,
      }),
    ).rejects.toThrow(/sender/);
  });

  it('a rejected reaction fails loud, never silently', async () => {
    sendReactionMock.mockResolvedValue(false);
    await expect(
      adapter().createRecord({
        recordType: 'Reaction',
        fields: { Emoji: '👍' },
        parentLinks: [{ recordType: 'Message', externalId: 'wamid.A', edgeName: 'Reactions', data: { from: '+15551234567' } }],
        mutationContext,
      }),
    ).rejects.toThrow(/reaction/i);
  });
});

describe('WhatsappAdapter.createRecord — typing (msg-[:Typing]-> {})', () => {
  beforeEach(() => {
    sendTypingOnMock.mockReset();
    sendTypingOnMock.mockResolvedValue(true);
  });

  it('an empty write shows the indicator against the parent message', async () => {
    const result = await adapter().createRecord({
      recordType: 'Typing',
      fields: {},
      parentLinks: [{ recordType: 'Message', externalId: 'wamid.A', edgeName: 'Typing' }],
      mutationContext,
    });
    expect(sendTypingOnMock).toHaveBeenCalledWith('wamid.A');
    expect(result.externalId).toBe('typing:wamid.A');
  });
});

describe('WhatsappAdapter.createRecord — anchor discipline', () => {
  it('a write with no parent rejects — every WhatsApp write is created along an edge', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Message',
        fields: { Body: 'hi' },
        parentLinks: [],
        mutationContext,
      }),
    ).rejects.toThrow(/along an edge/);
  });

  it('a non-message parent rejects, naming the Message anchor', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Message',
        fields: { Body: 'hi' },
        parentLinks: [{ recordType: 'Attachment', externalId: 'x', edgeName: 'Replies', data: { from: '+15551234567' } }],
        mutationContext,
      }),
    ).rejects.toThrow(/anchor off a Message/);
  });

  it('an unknown edge off a message rejects, naming the edge', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Message',
        fields: { Body: 'hi' },
        parentLinks: [{ recordType: 'Message', externalId: 'wamid.A', edgeName: 'bogus', data: { from: '+15551234567' } }],
        mutationContext,
      }),
    ).rejects.toThrow(/bogus/);
  });
});

// ── Inbound parse → discriminate pin (the chunk-1 carry-note) ────────────
// WhatsApp's normalized payloads carry NO literal discriminator, so the event
// type is TAG-ONLY: `preprocessInbound` stamps the parse-time classification
// as the tag. After rule 1's collapse each kind discriminates to the RECORD
// its fires edge delivers (`Message` / `Reaction` /
// `Location`), seeded STABLE on the wamid — no event-node
// indirection. This pins that a REACTION envelope lands on the reaction
// record, never the message, and that the un-tagged conversion discriminates
// NOTHING (the tag is load-bearing).
describe('WhatsappAdapter.listEventTypes — inbound parse→discriminate pin', () => {
  const envelope = (message: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '14155550000' },
              contacts: [{ wa_id: '15551234567', profile: { name: 'Ada' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
  const TEXT = { from: '15551234567', id: 'wamid.TEXT', timestamp: '1700000000', type: 'text', text: { body: 'hi' } };
  const REACTION = { from: '15551234567', id: 'wamid.RX', reaction: { message_id: 'wamid.TARGET', emoji: '👍' } };
  const LOCATION = { from: '15551234567', id: 'wamid.LOC', location: { latitude: 1, longitude: 2 } };

  it('a text message discriminates to Message, seeded stable on the wamid', async () => {
    const { events } = await adapter().preprocessInbound({ raw: envelope(TEXT) });
    expect(events).toHaveLength(1);
    const eventTypes = await adapter().listEventTypes();
    const result = discriminateEvent({ adapterType: WHATSAPP_ADAPTER_TYPE, event: events[0], eventTypes });
    expect(result?.eventType.positionType).toBe(WHATSAPP_RECORD_TYPE_ID);
    expect(result?.position.identity).toMatchObject({ kind: 'stable', recordId: 'wamid.TEXT' });
  });

  it('a REACTION envelope lands on Reaction, NEVER the message', async () => {
    const { events } = await adapter().preprocessInbound({ raw: envelope(REACTION) });
    const eventTypes = await adapter().listEventTypes();
    const result = discriminateEvent({ adapterType: WHATSAPP_ADAPTER_TYPE, event: events[0], eventTypes });
    expect(result?.eventType.positionType).toBe(WHATSAPP_INBOUND_REACTION_TYPE);
    expect(result?.eventType.positionType).not.toBe(WHATSAPP_RECORD_TYPE_ID);
  });

  it('a location envelope lands on Location', async () => {
    const { events } = await adapter().preprocessInbound({ raw: envelope(LOCATION) });
    const eventTypes = await adapter().listEventTypes();
    const result = discriminateEvent({ adapterType: WHATSAPP_ADAPTER_TYPE, event: events[0], eventTypes });
    expect(result?.eventType.positionType).toBe(WHATSAPP_INBOUND_LOCATION_TYPE);
  });

  it('the UN-tagged legacy conversion discriminates NONE — pins that the tag is load-bearing', async () => {
    const eventTypes = await adapter().listEventTypes();
    for (const message of [TEXT, REACTION, LOCATION]) {
      const parsed = parseWhatsappEvents(envelope(message));
      const untagged = webhookEventToDiscriminable(parsed[0]);
      expect(discriminateEvent({ adapterType: WHATSAPP_ADAPTER_TYPE, event: untagged, eventTypes })).toBeNull();
    }
  });
});

// ── The File duality, end to end against the REAL schema ────────────────────
// The customer defect (2026-07-13): a movement read the MESSAGE-level `File`
// (the send-side field) expecting inbound media, type-checked clean, and
// silently read null forever. These tests compile movement source against the
// real adapter's projected schema — listEntryPoints + describe(), the exact
// surface authoring sees — and pin that each wrong reading path is now a
// CHECK-TIME error steering to the right one, while the right paths stay
// clean.
describe('File duality — movement compile against the real projected schema', () => {
  let catalog: Catalog;

  beforeAll(async () => {
    const adapter = new WhatsappAdapter(TEAM_ID);
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map<string, SchemaTypeDescriptor>();
    for (const entry of entries) {
      const descriptor = await adapter.describe(entry.typeId);
      if (descriptor) descriptors.set(entry.typeId, descriptor);
    }
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: WHATSAPP_ADAPTER_TYPE,
      entries,
      descriptors,
    });
    catalog = mockCatalog({
      adapters: {
        whatsapp: {
          constructionArgs: [],
          // Mirror the real catalog projection: a config-less listen is
          // subscribed to MESSAGES ONLY (the manifest's
          // defaultSubscribedEvents), so it types against `Message`
          // (the fires edge lands straight on it — rule 1's collapse).
          defaultEvents: ['message'],
          schema: projected.schema,
        },
      },
    });
  });

  // The fires edge lands STRAIGHT on the message (rule 1's collapse), so the
  // movement types the message itself — `m` is the parameter; the record-edge
  // hop is gone and the bodies read straight off it.
  const compile = (body: string) =>
    checkProgram(
      parseProgram(
        [
          'import { whatsapp } from adapters',
          '',
          'wa = whatsapp()',
          '',
          'movement handle_message(m: <wa-[:`Message`]->>) {',
          body,
          '}',
          '',
          'listen to wa {} fire handle_message',
        ].join('\n'),
      ),
      catalog,
    ).filter((d) => (d.severity ?? 'error') === 'error');

  it("the customer's movement — reading the message-level File — errors with the attachments steer", () => {
    const diagnostics = compile('  write m-[:Replies]-> { Body: "got: ${m.`File`}" }');
    expect(diagnostics.map((d) => d.code)).toEqual(['MOV_WRITE_ONLY_PROPERTY']);
    expect(diagnostics[0].message).toContain('write-only');
    expect(diagnostics[0].message).toContain('Attachments');
  });

  it('the correct read path — msg-[:Attachments]->.File — checks clean, including sending it back out', () => {
    expect(
      compile(
        [
          '  m-[a:Attachments]-> {',
          '    write m-[:Replies]-> { Body: "file: ${a.`Name`}", File: a.`File` }',
          '  }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('reading back a write-only edge (replies traversal) errors', () => {
    const diagnostics = compile(
      [
        '  m-[r:Replies]-> {',
        '    write m-[:Reactions]-> { Emoji: r.`Body` }',
        '  }',
      ].join('\n'),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(['MOV_WRITE_ONLY_EDGE']);
  });

  it('writing along the read-only attachments edge errors, naming the create edges', () => {
    const diagnostics = compile('  write m-[:Attachments]-> { Name: "x" }');
    expect(diagnostics.map((d) => d.code)).toEqual(['MOV_WRITE_READ_ONLY_EDGE']);
    expect(diagnostics[0].message).toContain('read-only');
    expect(diagnostics[0].message).toContain('Replies');
  });

  it('the unified write surface stays clean (reaction, typing, reply with File)', () => {
    expect(
      compile(
        [
          '  write m-[:Reactions]-> { Emoji: "👍" }',
          '  write m-[:Typing]-> {}',
          '  write m-[:Replies]-> { Body: "Noted: ${m.`Body`}", File: FILE("summary", "pdf") }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  // The live customer movement's EXACT reading form: a bare assignment
  // (`f = msg.\`File\``), not a read inside a write field — the assignment
  // path must fire the same diagnostic.
  it('a bare assignment of the message-level File errors the same way', () => {
    const diagnostics = compile('  f = m.`File`\n  write m-[:Replies]-> { Body: "ok" }');
    expect(diagnostics.map((d) => d.code)).toEqual(['MOV_WRITE_ONLY_PROPERTY']);
    expect(diagnostics[0].message).toContain('Attachments');
  });

  it('an extract source reading the message-level File errors the same way', () => {
    const diagnostics = compile(
      [
        '  intent = extract from [m.`Body`, m.`File`] {',
        '    is_question: <boolean> "is this a question"',
        '  }',
        '  write m-[:Replies]-> { Body: "${intent.`is_question`}" }',
      ].join('\n'),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(['MOV_WRITE_ONLY_PROPERTY']);
  });
});
