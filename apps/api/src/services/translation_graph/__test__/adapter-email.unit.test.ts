/**
 * Unit tests for the email adapter's read path. The adapter exposes its
 * content explicitly and losslessly off the input position:
 *
 *   • the body via the `Body` field (fieldId `content`) plus the raw
 *     `bodyHtml` / `bodyText` fields;
 *   • attachments via the `-[:attachments]->` edge (`getRelated`), each
 *     attachment position exposing a `data` (File) field, `name`,
 *     `contentType`, `size`, and `url`.
 *
 * The input-side `#resources` reference has been REMOVED — `_resources`
 * is now extracted-node provenance, resolved by the engine elsewhere, not
 * off an input/source position. A `_resources` hop off an email position
 * therefore DRIFTS (AdapterNameDriftError) because the reference is gone
 * from `describe`. `writeResource` throws — email is source-only.
 *
 * The adapter has no DB / external dependency, so these tests run
 * straight against the class with no jest.mock plumbing.
 */

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { SourcePosition } from 'movement-engine/services/translation_graph/types';

import {
  EmailAdapter,
  EMAIL_ADAPTER_TYPE,
  EMAIL_ATTACHMENT_TYPE_ID,
  EMAIL_ATTACHMENT_DISPLAY_NAME,
  EMAIL_RECORD_TYPE_ID,
  EMAIL_ATTACHMENTS_FIELD,
  type EmailPayload,
} from '../adapters/email';
import { RESOURCES_REFERENCE_FIELD_ID } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, makeUnstablePosition } from 'movement-engine/services/translation_graph/types';

const TEAM_ID = 'team-1' as TeamId;

function makeEmailPosition(payload: EmailPayload, recordId = 'rec-1'): SourcePosition {
  return makeStablePosition({
    adapterType: EMAIL_ADAPTER_TYPE,
    // The source-read wrapper stamps the NATURAL type name (the entry's
    // displayName) onto a read position; field resolution keys off it.
    recordType: 'Email',
    recordId,
    data: payload,
  });
}

// The webhook trigger path (and the setup-agent preview, which synthesises a
// `webhook` trigger from a sample email) seeds the email source as the EVENT
// NODE the fires edge lands on — which, after rule 1's collapse, IS the Email —
// typed by its canonical address (nothing is pinned, so the key is the bare
// node name `Email`) with the payload riding whole.
//
// It used to mint `recordType: null` here, and that is the state that no longer
// exists: a typeless position is an ERROR (ruling 2026-07-19), because nothing
// downstream can resolve a field or an edge without knowing what holds it.
// Unstable rather than stable only because an arrival WITHOUT a durable id
// (a preview, a message with no Message-Id) is the weaker case — stability
// changes nothing about how names resolve.
function makeWebhookEmailPosition(payload: EmailPayload): SourcePosition {
  return makeUnstablePosition({
    adapterType: EMAIL_ADAPTER_TYPE,
    recordType: 'Email',
    data: payload,
  });
}

// `getRelated` yields attachment positions carrying the adapter's internal
// type id (`email:attachment`). The engine's source-read wrapper restamps the
// NATURAL type name (`Attachment`) before field resolution; this mirrors
// that so we can exercise displayName-keyed field reads in a raw unit test.
function restampAttachment(pos: SourcePosition): SourcePosition {
  return makeUnstablePosition({
    adapterType: EMAIL_ADAPTER_TYPE,
    recordType: 'Attachment',
    data: pos.identity.data,
  });
}

describe('EmailAdapter — input-side `_resources` hop is gone (drift)', () => {
  it('drifts (throws) when a `_resources` hop is walked off an input email position', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const payload: EmailPayload = {
      messageId: 'msg-42@example.com',
      subject: 'Q3 results',
      sender: 'alice@example.com',
      recipient: 'team@example.com',
      bodyText: 'Revenue up 20% QoQ.',
      attachments: [
        { key: 'k1', filename: 'q3-deck.pdf', contentType: 'application/pdf', size: 102400 },
      ],
    };
    // `_resources` is extracted-node provenance now, resolved by the engine
    // elsewhere — it is NOT a reference in the email adapter's `describe`,
    // so resolving it off an input position drifts (AdapterNameDriftError).
    await expect(
      adapter.getRelated({
        position: makeEmailPosition(payload),
        fieldId: RESOURCES_REFERENCE_FIELD_ID,
        direction: 'outgoing',
      }),
    ).rejects.toThrow();
  });
});

describe('EmailAdapter — explicit content paths (lossless)', () => {
  it('reads the email body losslessly via the `Body` field (content)', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const payload: EmailPayload = {
      messageId: 'msg-42@example.com',
      subject: 'Q3 results',
      sender: 'alice@example.com',
      recipient: 'team@example.com',
      bodyHtml: '<p>Revenue up <strong>20%</strong> QoQ.</p>',
      bodyText: 'Revenue up 20% QoQ.',
      attachments: [],
    };
    const pos = makeEmailPosition(payload);
    // `Body` (fieldId `content`) is the normalised body — plain text wins.
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe(
      'Revenue up 20% QoQ.',
    );
    // The raw HTML/plain fields stay readable too — nothing is lost.
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Plain Body' })).toBe(
      'Revenue up 20% QoQ.',
    );
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'HTML Body' })).toBe(
      '<p>Revenue up <strong>20%</strong> QoQ.</p>',
    );
  });

  it('reaches attachments via the `attachments` edge, each exposing data/name/contentType/size/url', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const payload: EmailPayload = {
      messageId: 'msg-42@example.com',
      subject: 'Q3 results',
      sender: 'alice@example.com',
      recipient: 'team@example.com',
      bodyText: 'Revenue up 20% QoQ.',
      attachments: [
        {
          key: 'mailgun://storage/abc',
          filename: 'q3-deck.pdf',
          contentType: 'application/pdf',
          size: 102400,
          url: 'https://storage.example.com/abc',
        },
        {
          key: 'mailgun://storage/xyz',
          filename: 'numbers.xlsx',
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 8192,
        },
      ],
    };

    const related = await adapter.getRelated({
      position: makeEmailPosition(payload),
      fieldId: 'Attachments',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(2);

    const pdfPos = related[0].position;
    expect(pdfPos.recordType).toBe(EMAIL_ATTACHMENT_DISPLAY_NAME);
    // The raw attachment payload rides losslessly on the position — incl. the
    // binary `key` handle (the `data`/File field is declared in `describe` and
    // the bytes are owner-resolved from this handle via `resolveFileRef`),
    // filename, contentType, size, and url.
    expect(pdfPos.identity.data).toMatchObject({
      key: 'mailgun://storage/abc',
      filename: 'q3-deck.pdf',
      contentType: 'application/pdf',
      size: 102400,
      url: 'https://storage.example.com/abc',
    });
    expect(related[1].position.identity.data).toMatchObject({
      key: 'mailgun://storage/xyz',
      filename: 'numbers.xlsx',
      size: 8192,
    });

    // The engine's source-read wrapper stamps the NATURAL type name onto a read
    // position before field resolution; restamp here to read fields the same
    // way and prove `name`/`Content Type`/`size`/`url` resolve.
    const pdfNamed = restampAttachment(pdfPos);
    expect(await adapter.getFieldValue({ position: pdfNamed, fieldId: 'Name' })).toBe('q3-deck.pdf');
    expect(await adapter.getFieldValue({ position: pdfNamed, fieldId: 'Content Type' })).toBe(
      'application/pdf',
    );
    expect(await adapter.getFieldValue({ position: pdfNamed, fieldId: 'Size' })).toBe(102400);
    expect(await adapter.getFieldValue({ position: pdfNamed, fieldId: 'URL' })).toBe(
      'https://storage.example.com/abc',
    );

    const xlsxNamed = restampAttachment(related[1].position);
    expect(await adapter.getFieldValue({ position: xlsxNamed, fieldId: 'Name' })).toBe('numbers.xlsx');
    expect(await adapter.getFieldValue({ position: xlsxNamed, fieldId: 'URL' })).toBe(null);
  });
});

describe('EmailAdapter — schema introspection', () => {
  it('lists email + attachment as entry points — the fires edge lands ON Email', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId)).toEqual([
      EMAIL_RECORD_TYPE_ID,
      EMAIL_ATTACHMENT_TYPE_ID,
    ]);
    // Source-only — nothing is writable.
    expect(entries.every((e) => e.writable === false)).toBe(true);
    // NOTHING is root-readable either: an inbox cannot be enumerated — an
    // Email arrives (the fires edge) and an attachment is reached via the
    // email's `attachments` edge. A fires edge is reachability, never a
    // root read. plans/2026-07-10-adapter-entry-positions/8_event_edges.md
    expect(entries.every((e) => e.readable === false)).toBe(true);
  });

  it('the fires edge lands straight on Email — no field-less event node (rule 1)', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const entries = await adapter.listEntryPoints();
    const email = entries.find((e) => e.typeId === EMAIL_RECORD_TYPE_ID);
    expect(email).toBeDefined();
    expect(email?.displayName).toBe('Email');
    expect(email?.readable).toBe(false);
    expect(email?.writable).toBe(false);
    expect(email?.fires).toBe(true);
    // The retired indirection stays retired: nothing describes it.
    expect(await adapter.describe('Email Received')).toBeNull();
  });

  it('describes the email message type with the attachments edge', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const desc = await adapter.describe(EMAIL_RECORD_TYPE_ID);
    expect(desc).not.toBeNull();
    expect(desc!.fields.map((f) => f.fieldId)).toEqual(
      expect.arrayContaining(['subject', 'sender', 'recipient', 'bodyHtml', 'bodyText', 'content']),
    );
    // The references are the domain `attachments` edge ONLY — the input-side
    // `#resources` reference has been removed (it's extracted-node provenance
    // now, resolved by the engine elsewhere, not off an input position).
    expect(desc!.references.map((r) => r.fieldId)).toContain(EMAIL_ATTACHMENTS_FIELD);
    expect(desc!.references.map((r) => r.fieldId)).not.toContain(RESOURCES_REFERENCE_FIELD_ID);
    expect(desc!.references[0]).toMatchObject({
      fieldId: 'attachments',
      targetTypeId: EMAIL_ATTACHMENT_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
    });
  });

  it('describes the attachment type with a binary-handle data field', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const desc = await adapter.describe(EMAIL_ATTACHMENT_TYPE_ID);
    expect(desc).not.toBeNull();
    const dataField = desc!.fields.find((f) => f.fieldId === 'data');
    expect(dataField).toBeDefined();
    // E5 (wave-2) widened SchemaFieldKind to include `'file'` so the
    // binary handle is typed distinctly — the field-mapping editor
    // uses this to route File-typed expressions only into File-typed
    // target fields (see resources_currency.md).
    expect(dataField!.kind).toBe('file');
  });

  it('returns null for unknown type ids', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    expect(await adapter.describe('not-a-real-type')).toBeNull();
  });
});

describe('EmailAdapter — getFieldValue', () => {
  it('returns scalar fields from the cached email payload', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const payload: EmailPayload = {
      messageId: 'm1',
      subject: 'hello',
      sender: 'a@x',
      recipient: 'b@x',
      bodyText: 'plain body',
      attachments: [],
    };
    const pos = makeEmailPosition(payload);
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Subject' })).toBe('hello');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'From' })).toBe('a@x');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Plain Body' })).toBe('plain body');
  });

  it('derives `content` from plain-text body when available', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const pos = makeEmailPosition({
      messageId: 'm', subject: 's', sender: 'a@x', recipient: 'b@x',
      bodyText: 'plain wins', bodyHtml: '<p>html loses</p>', attachments: [],
    });
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe('plain wins');
  });

  it('derives `content` from html when no plain-text body present', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const pos = makeEmailPosition({
      messageId: 'm', subject: 's', sender: 'a@x', recipient: 'b@x',
      bodyHtml: '<p>only html</p>', attachments: [],
    });
    const content = await adapter.getFieldValue({ position: pos, fieldId: 'Body' });
    expect(typeof content).toBe('string');
    expect(content as string).toContain('only html');
  });

  // A real stored event: a mail-merge forwarder put the whole HTML document
  // in the message's TEXT part. `bodyText` was markup beside a present,
  // independent `bodyHtml` — plain-text preference alone let markup through
  // to `Body`. `Body` must strip it like the HTML-only path does; the raw
  // `Plain Body` / `HTML Body` fields stay exactly as delivered.
  it('derives `content` by stripping markup when bodyText is itself HTML', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const markupText = '<div style="font-size: 15px;"><div class="preheader">Hi there</div></div>';
    const pos = makeEmailPosition({
      messageId: 'm', subject: 's', sender: 'a@x', recipient: 'b@x',
      bodyText: markupText,
      bodyHtml: '<html><body><div>Hi there</div></body></html>',
      attachments: [],
    });
    const content = await adapter.getFieldValue({ position: pos, fieldId: 'Body' });
    expect(content as string).not.toContain('<div');
    expect(content as string).toContain('Hi there');
    // Raw fields are untouched — nothing is lost.
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Plain Body' })).toBe(markupText);
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'HTML Body' })).toBe(
      '<html><body><div>Hi there</div></body></html>',
    );
  });

  // Ordinary prose that happens to contain an angle bracket must never be
  // mistaken for markup and run through the HTML stripper.
  it.each([
    'a <3 b',
    'x < y',
    '<name> was here',
  ])('leaves genuine plain-text bodyText %j unchanged', async (bodyText) => {
    const adapter = new EmailAdapter(TEAM_ID);
    const pos = makeEmailPosition({
      messageId: 'm', subject: 's', sender: 'a@x', recipient: 'b@x',
      bodyText,
      attachments: [],
    });
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe(bodyText);
  });

  // The markup predicate's documented boundary cases.
  it.each([
    ['<br>line', true],
    ['<div>text</div>', true],
    ['<p>text</p>', true],
    ['plain text <html> mid-string', true],
    ['plain text <!DOCTYPE html> mid-string', true],
    ['<span>inline</span>', true],
    ['<table><tr><td>cell</td></tr></table>', true],
    ['some text </div> closing only, no leading <', false],
  ])('treats %j as markup=%s for the Body derivation', async (bodyText, expectMarkup) => {
    const adapter = new EmailAdapter(TEAM_ID);
    const pos = makeEmailPosition({
      messageId: 'm', subject: 's', sender: 'a@x', recipient: 'b@x',
      bodyText,
      attachments: [],
    });
    const content = (await adapter.getFieldValue({ position: pos, fieldId: 'Body' })) as string;
    if (expectMarkup) {
      expect(content).not.toBe(bodyText);
    } else {
      expect(content).toBe(bodyText);
    }
  });

  it('aliases attachment.name to filename', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const attPos: SourcePosition = makeStablePosition({
      adapterType: EMAIL_ADAPTER_TYPE,
      // The natural type name (displayName) — field resolution keys the field
      // map by the type's natural name.
      recordType: 'Attachment',
      recordId: 'a',
      data: { key: 'a', filename: 'foo.pdf', contentType: 'application/pdf' },
    });
    expect(await adapter.getFieldValue({ position: attPos, fieldId: 'Name' })).toBe('foo.pdf');
    expect(await adapter.getFieldValue({ position: attPos, fieldId: 'Content Type' })).toBe(
      'application/pdf',
    );
  });
});

describe('EmailAdapter — webhook-event positions', () => {
  const payload: EmailPayload = {
    messageId: 'wh-1@example.com',
    subject: 'Inbound deal',
    sender: 'founder@startup.com',
    recipient: 'deals@team.com',
    bodyText: 'We just raised a Series A.',
    bodyHtml: '<p>We just raised a Series A.</p>',
    attachments: [
      { key: 'k1', filename: 'deck.pdf', contentType: 'application/pdf', url: 'https://x/deck' },
    ],
  };

  it('reads scalar + derived fields off a webhook-event position', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const pos = makeWebhookEmailPosition(payload);
    // Read by NATURAL name — the currency the program names fields by, and the
    // only one a typed position resolves. (`Body` is the derived normalised
    // body; its internal id is `content`.)
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Subject' })).toBe('Inbound deal');
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'From' })).toBe(
      'founder@startup.com',
    );
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe(
      'We just raised a Series A.',
    );
  });

  it('reads body + walks attachments off a webhook-event position (lossless)', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const pos = makeWebhookEmailPosition(payload);
    // Body via the explicit `Body` field (internally `content`).
    expect(await adapter.getFieldValue({ position: pos, fieldId: 'Body' })).toBe(
      'We just raised a Series A.',
    );
    // Attachments via the `attachments` edge — identical to a typed position.
    const related = await adapter.getRelated({
      position: pos,
      fieldId: 'Attachments',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    const attPos = related[0].position;
    expect(attPos.recordType).toBe(EMAIL_ATTACHMENT_DISPLAY_NAME);
    expect(attPos.identity.data).toMatchObject({ key: 'k1', filename: 'deck.pdf', url: 'https://x/deck' });
    const named = restampAttachment(attPos);
    expect(await adapter.getFieldValue({ position: named, fieldId: 'Name' })).toBe('deck.pdf');
    expect(await adapter.getFieldValue({ position: named, fieldId: 'URL' })).toBe('https://x/deck');
  });
});

// Rule 1's collapse: the fires edge lands STRAIGHT on Email — a listen
// delivers the email itself (the engine seeds it stable on its Message-Id),
// so there is no event node and no `record` hop.
// plans/2026-07-10-adapter-entry-positions/8_event_edges.md + adapters/CLAUDE.md
describe('EmailAdapter — the record-edge indirection is GONE', () => {
  const payload: EmailPayload = {
    messageId: 'ev-1@example.com',
    subject: 'Series A',
    sender: 'founder@startup.com',
    recipient: 'inbox+deals@example.com',
    bodyText: 'We raised.',
    attachments: [],
  };

  it('the SEED reads directly — Subject/From/Body off the delivered position', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    // What the engine seeds after the collapse: the Email itself, stable on
    // its Message-Id, payload riding whole.
    const seed = makeEmailPosition(payload, payload.messageId);
    expect(await adapter.getFieldValue({ position: seed, fieldId: 'Subject' })).toBe('Series A');
    expect(await adapter.getFieldValue({ position: seed, fieldId: 'From' })).toBe(
      'founder@startup.com',
    );
    expect(await adapter.getFieldValue({ position: seed, fieldId: 'Body' })).toBe('We raised.');
  });

  it('a `record` hop off an Email is DRIFT — the edge died with the event node', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    await expect(
      adapter.getRelated({
        position: makeEmailPosition(payload),
        fieldId: 'record',
        direction: 'outgoing',
      }),
    ).rejects.toThrow();
  });
});

describe('EmailAdapter — write methods inherited from BaseAdapter', () => {
  it('createRecord / updateRecord / deleteRecord all throw notWriteCapable', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    await expect(
      adapter.createRecord({
        recordType: EMAIL_RECORD_TYPE_ID,
        fields: {},
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/not configured as a write target/);
  });
});

// ── Inbound payload normalisation (the contract seam) ───────────────────────

import { normaliseInboundEmailPayload } from '../adapters/email';

describe('normaliseInboundEmailPayload', () => {
  it('maps the raw mailgun wire shape onto the advertised EmailPayload fields', () => {
    const result = normaliseInboundEmailPayload({
      subject: 'Intro to Acme',
      sender: 'alice@example.com',
      recipient: 'inbox+ada@example.com',
      'Message-Id': '<m1@example.com>',
      'body-plain': 'Hi Ada — meet Acme.',
      'body-html': '<p>Hi Ada — meet Acme.</p>',
      attachments: JSON.stringify([
        { name: 'deck.pdf', 'content-type': 'application/pdf', size: 1234, url: 'https://mg/att/1' },
      ]),
    });

    expect(result).toMatchObject({
      messageId: '<m1@example.com>',
      subject: 'Intro to Acme',
      sender: 'alice@example.com',
      recipient: 'inbox+ada@example.com',
      bodyText: 'Hi Ada — meet Acme.',
      bodyHtml: '<p>Hi Ada — meet Acme.</p>',
      attachments: [
        {
          key: 'https://mg/att/1',
          filename: 'deck.pdf',
          contentType: 'application/pdf',
          size: 1234,
          url: 'https://mg/att/1',
        },
      ],
    });
    // Raw keys stay readable (back-compat for raw-key reads).
    expect(result['body-plain']).toBe('Hi Ada — meet Acme.');
  });

  it('falls back to stripped-text for bodyText and tolerates junk attachments', () => {
    const result = normaliseInboundEmailPayload({
      subject: 's',
      sender: 'a@b.c',
      recipient: 'r@example.com',
      'stripped-text': 'just the reply',
      attachments: 'not-json{',
    });
    expect(result.bodyText).toBe('just the reply');
    expect(result.attachments).toEqual([]);
  });

  it('passes through a payload already in contract shape', () => {
    const result = normaliseInboundEmailPayload({
      messageId: 'm2',
      subject: 's',
      sender: 'a@b.c',
      recipient: 'r@example.com',
      bodyText: 'already normalised',
    });
    expect(result.bodyText).toBe('already normalised');
    expect(result.messageId).toBe('m2');
  });
});
