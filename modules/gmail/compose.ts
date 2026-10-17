// Building the RFC 2822 message Gmail sends.
//
// `users.messages.send` takes ONE field: the whole message as base64url bytes.
// There is no "to/subject/body" surface to post — Gmail parses the headers out
// of what we hand it, which means the headers are ours to get right. So this is
// the mirror of `mime.ts`: that one flattens a MIME tree into a record, this one
// assembles a record into a tree.
//
// Hand-rolled rather than pulled in: apps/api has no mail composer (no
// nodemailer, no mimetext), and the subset a send needs — a text part, an
// optional HTML alternative, attachments, and the two reply headers — is a
// hundred lines with no configuration surface. A dependency here would be
// carrying a whole SMTP client to format four headers.

import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

/** RFC 2045's ceiling on an encoded line. */
const BASE64_LINE = 76;

/** Where a header line is folded. RFC 5322 says 78 including the field name. */
const HEADER_LINE = 78;

export interface GmailOutboundAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** A message to send, in the terms the write path speaks. Addresses arrive as
 *  whole header values (`"Rita Okoye" <rita@…>` or a bare address) — the same
 *  shape `splitAddressHeader` hands back off a received message, so a reply can
 *  address itself from what it read. */
export interface GmailOutboundMessage {
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: GmailOutboundAttachment[];
  /** The RFC `Message-Id` of the message being replied to — NOT Gmail's own id,
   *  which no mail client has ever seen. */
  inReplyTo?: string;
  /** The conversation's chain, oldest first. The parent's own `References` plus
   *  the parent's `Message-Id` is what a well-behaved client sends. */
  references?: string[];
  date?: Date;
}

/** Overridable so a test can assert a whole message rather than a message with
 *  a random boundary cut out of it. */
export interface ComposeOptions {
  boundary?: () => string;
}

function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e\t]*$/.test(value);
}

/** RFC 2047 encoded-word. Only reached for a value that is not plain ASCII —
 *  encoding an ASCII header would make it unreadable for no gain. */
function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function headerText(value: string): string {
  return isAscii(value) ? value : encodedWord(value);
}

/**
 * One address, with only its DISPLAY NAME encoded.
 *
 * Encoding the whole value would swallow the angle brackets and leave Gmail
 * with a header it cannot route — the address itself is ASCII by definition
 * (RFC 5321), so only the name in front of it can ever need encoding.
 */
export function encodeAddress(address: string): string {
  const trimmed = address.trim();
  const match = /^(.*?)\s*<([^>]+)>$/.exec(trimmed);
  if (!match) return trimmed;
  const display = (match[1] ?? '').replace(/^"|"$/g, '').trim();
  const mailbox = match[2] ?? '';
  if (display === '') return `<${mailbox}>`;
  return `${headerText(display)} <${mailbox}>`;
}

/** An address header, folded between addresses when the line gets long. A
 *  continuation line starts with whitespace, which is what makes it a
 *  continuation. */
function addressHeader(name: string, addresses: string[]): string {
  const encoded = addresses.map(encodeAddress);
  const lines: string[] = [];
  let current = `${name}:`;
  for (const address of encoded) {
    const candidate = current === `${name}:` ? `${current} ${address}` : `${current}, ${address}`;
    if (candidate.length > HEADER_LINE && current !== `${name}:`) {
      lines.push(`${current},`);
      current = ` ${address}`;
      continue;
    }
    current = candidate;
  }
  lines.push(current);
  return lines.join(CRLF);
}

function base64Body(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return (encoded.match(new RegExp(`.{1,${BASE64_LINE}}`, 'g')) ?? []).join(CRLF);
}

function base64Bytes(value: Buffer): string {
  const encoded = value.toString('base64');
  return (encoded.match(new RegExp(`.{1,${BASE64_LINE}}`, 'g')) ?? []).join(CRLF);
}

/** One MIME entity: its own headers, then its body. */
interface Part {
  headers: string[];
  body: string;
}

function textPart(input: { mimeType: string; content: string }): Part {
  return {
    headers: [
      `Content-Type: ${input.mimeType}; charset="UTF-8"`,
      'Content-Transfer-Encoding: base64',
    ],
    // base64 throughout, so a body with an emoji, a 300-character line or a
    // line that happens to start with "From " survives the trip intact.
    body: base64Body(input.content),
  };
}

function attachmentPart(attachment: GmailOutboundAttachment): Part {
  return {
    headers: [
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
    ],
    body: base64Bytes(attachment.content),
  };
}

function renderPart(part: Part): string {
  return `${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`;
}

function multipart(input: { subtype: string; parts: Part[]; boundary: string }): Part {
  const sections = input.parts.map((part) => `--${input.boundary}${CRLF}${renderPart(part)}`);
  return {
    headers: [`Content-Type: multipart/${input.subtype}; boundary="${input.boundary}"`],
    body: `${sections.join(CRLF)}${CRLF}--${input.boundary}--`,
  };
}

function defaultBoundary(): string {
  return `=_listen_fire_${randomUUID().replace(/-/g, '')}`;
}

/**
 * The body of the message, before any attachments: the two alternatives when
 * both were given, otherwise the one that was.
 *
 * `multipart/alternative` is ordered WORST first — a reader picks the last
 * alternative it understands — so the plain text goes before the HTML.
 */
function bodyPart(input: {
  bodyText: string | undefined;
  bodyHtml: string | undefined;
  boundary: () => string;
}): Part {
  const text =
    input.bodyText !== undefined
      ? textPart({ mimeType: 'text/plain', content: input.bodyText })
      : undefined;
  const html =
    input.bodyHtml !== undefined
      ? textPart({ mimeType: 'text/html', content: input.bodyHtml })
      : undefined;
  if (text && html) {
    return multipart({ subtype: 'alternative', parts: [text, html], boundary: input.boundary() });
  }
  if (text) return text;
  if (html) return html;
  // Unreachable through the write path, which refuses a message with no body;
  // kept so this function is honest on its own rather than trusting its caller.
  return textPart({ mimeType: 'text/plain', content: '' });
}

/**
 * Assemble the whole message. The return is the RFC 2822 text — the caller
 * base64urls it, because that encoding belongs to Gmail's `raw` field rather
 * than to the message.
 *
 * No `Message-Id` header: Gmail stamps its own on every message it accepts, and
 * a second one is a message two clients disagree about the identity of.
 */
export function buildRfc2822(
  message: GmailOutboundMessage,
  options: ComposeOptions = {},
): string {
  const boundary = options.boundary ?? defaultBoundary;
  const attachments = message.attachments ?? [];

  const body = bodyPart({
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    boundary,
  });
  const root =
    attachments.length > 0
      ? multipart({
          subtype: 'mixed',
          parts: [body, ...attachments.map(attachmentPart)],
          boundary: boundary(),
        })
      : body;

  const headers = [
    addressHeader('From', [message.from]),
    addressHeader('To', message.to),
    ...(message.cc && message.cc.length > 0 ? [addressHeader('Cc', message.cc)] : []),
    `Subject: ${headerText(message.subject ?? '')}`,
    `Date: ${(message.date ?? new Date()).toUTCString()}`,
    ...(message.inReplyTo !== undefined ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references && message.references.length > 0
      ? [`References: ${message.references.join(' ')}`]
      : []),
    'MIME-Version: 1.0',
    ...root.headers,
  ];

  return `${headers.join(CRLF)}${CRLF}${CRLF}${root.body}`;
}

/** What Gmail's `raw` field takes. */
export function toGmailRaw(rfc2822: string): string {
  return Buffer.from(rfc2822, 'utf8').toString('base64url');
}
