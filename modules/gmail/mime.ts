// Turning a Gmail message into the record a movement reads.
//
// Gmail hands back a MIME TREE, not a message: the headers are a list of
// name/value pairs, the body is base64url somewhere inside a nest of parts, and
// the attachments are the parts that happen to carry a filename. Everything
// that knows about that shape lives here, so the adapter above reads a flat
// record and the decoding is testable without a network or a graph.

import { convert as htmlToText } from 'html-to-text';

import type { GmailMessage, GmailPart } from './api_client';

/** One file hanging off a message. The bytes are NOT here — Gmail serves them
 *  from their own endpoint, keyed by this id, so a movement that never opens a
 *  file never fetches one. */
export interface GmailAttachmentRef {
  attachmentId: string;
  /** The message the attachment belongs to — half of the fetch's key, carried
   *  so an attachment position is self-sufficient. */
  messageId: string;
  filename: string;
  contentType: string;
  size?: number;
}

/** A Gmail message flattened to the facts a movement reads. */
export interface GmailMessageRecord {
  id: string;
  threadId: string | null;
  /**
   * The RFC `Message-Id` header — the identity every OTHER mail system knows
   * this message by, and the only value `In-Reply-To` can carry. Gmail's own
   * `id` is a Gmail-internal handle no mail client has ever seen, so a reply
   * built from it threads nowhere. Carried on the record rather than described
   * as a field: it is currency for the reply path, not something an author
   * reads.
   */
  rfcMessageId: string | null;
  /** The `References` chain this message carried, oldest first. A reply extends
   *  it rather than starting a new one, which is how a client that does not
   *  know Gmail's thread ids still draws the conversation. */
  rfcReferences: string[];
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  /** The message's own timestamp as an ISO instant. */
  date: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** The normalised body — plain text, derived from the HTML when only HTML
   *  arrived. What an author means by "the body". */
  body: string;
  labels: string[];
  hasAttachments: boolean;
  attachments: GmailAttachmentRef[];
}

function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** A header's value, matched case-insensitively — Gmail preserves whatever
 *  casing the sender used, and senders disagree. */
function header(part: GmailPart | null | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const entry of part?.headers ?? []) {
    if ((entry.name ?? '').toLowerCase() === wanted) {
      const value = entry.value ?? '';
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * Split an address header into its addresses.
 *
 * Commas inside a display name are quoted (`"Doe, Jane" <jane@…>`), so the
 * split tracks quoting rather than calling `split(',')` and cutting a name in
 * half.
 */
export function splitAddressHeader(raw: string | null): string[] {
  if (raw === null) return [];
  const addresses: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ',' && !quoted) {
      if (current.trim() !== '') addresses.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') addresses.push(current.trim());
  return addresses;
}

/** Whether a part IS a file rather than a rendering of the message. A part with
 *  a filename is an attachment even when its type is `text/plain` — an attached
 *  `.txt` must not become the body. */
function isAttachment(part: GmailPart): boolean {
  return (part.filename ?? '') !== '';
}

interface Walked {
  text: string[];
  html: string[];
  attachments: Omit<GmailAttachmentRef, 'messageId'>[];
}

/**
 * Walk the MIME tree once, collecting the two body alternatives and the files.
 *
 * Depth-first in document order, so a `multipart/alternative` contributes its
 * text and its html to their own lists and the caller picks between them —
 * rather than the walk deciding, which is how a nested forward loses its body.
 */
function walk(part: GmailPart | null | undefined, into: Walked): void {
  if (!part) return;
  if (isAttachment(part)) {
    const attachmentId = part.body?.attachmentId ?? null;
    if (attachmentId !== null) {
      into.attachments.push({
        attachmentId,
        filename: part.filename ?? '',
        contentType: part.mimeType ?? 'application/octet-stream',
        ...(typeof part.body?.size === 'number' ? { size: part.body.size } : {}),
      });
    }
    // An attachment's own sub-parts are the attached message's, never this
    // one's — a forwarded `message/rfc822` would otherwise donate its body.
    return;
  }

  const mime = (part.mimeType ?? '').toLowerCase();
  const data = part.body?.data;
  if (data) {
    if (mime === 'text/plain') into.text.push(decodeBase64Url(data));
    else if (mime === 'text/html') into.html.push(decodeBase64Url(data));
  }

  for (const child of part.parts ?? []) walk(child, into);
}

function stripHtml(html: string): string {
  try {
    return htmlToText(html);
  } catch {
    return html;
  }
}

/** The instant Gmail records for the message. `internalDate` is epoch
 *  milliseconds as a string; the `Date` header is the sender's claim and is
 *  only the fallback. */
function messageDate(message: GmailMessage): string | null {
  const internal = Number(message.internalDate ?? '');
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const sent = header(message.payload, 'Date');
  if (sent === null) return null;
  const parsed = Date.parse(sent);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Flatten one Gmail message into the record the adapter publishes. */
export function decodeGmailMessage(message: GmailMessage): GmailMessageRecord {
  const collected: Walked = { text: [], html: [], attachments: [] };
  walk(message.payload, collected);

  const bodyText = collected.text.join('\n').trim();
  const bodyHtml = collected.html.join('\n').trim();
  const body = bodyText !== '' ? bodyText : bodyHtml !== '' ? stripHtml(bodyHtml) : '';

  const attachments: GmailAttachmentRef[] = collected.attachments.map((attachment) => ({
    ...attachment,
    messageId: message.id,
  }));

  return {
    id: message.id,
    threadId: message.threadId ?? null,
    rfcMessageId: header(message.payload, 'Message-Id'),
    rfcReferences: (header(message.payload, 'References') ?? '').split(/\s+/).filter((id) => id !== ''),
    subject: header(message.payload, 'Subject'),
    from: header(message.payload, 'From'),
    to: splitAddressHeader(header(message.payload, 'To')),
    cc: splitAddressHeader(header(message.payload, 'Cc')),
    date: messageDate(message),
    snippet: message.snippet ?? null,
    bodyText: bodyText === '' ? null : bodyText,
    bodyHtml: bodyHtml === '' ? null : bodyHtml,
    body,
    labels: message.labelIds ?? [],
    hasAttachments: attachments.length > 0,
    attachments,
  };
}
