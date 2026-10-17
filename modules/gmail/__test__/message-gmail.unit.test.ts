// Decoding a Gmail message — the MIME tree walk, the body preference, the
// address headers and the attachment listing. No network, no graph.

import type { GmailMessage, GmailPart } from '../api_client';

import {
  decodeGmailMessage,
  splitAddressHeader,
} from '../mime';

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function textPart(mime: string, body: string): GmailPart {
  return { mimeType: mime, filename: '', body: { size: body.length, data: b64(body) } };
}

function message(payload: GmailPart, over: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'a snippet',
    internalDate: String(Date.UTC(2026, 8, 22, 9, 30)),
    payload,
    ...over,
  };
}

const HEADERS = [
  { name: 'Subject', value: 'Quarterly figures' },
  { name: 'From', value: '"Rita Okoye" <rita@northwind.example>' },
  { name: 'To', value: 'deals@example.com, "Patel, Anil" <anil@example.com>' },
  { name: 'Cc', value: 'books@example.com' },
];

describe('a multipart message', () => {
  const decoded = decodeGmailMessage(
    message({
      mimeType: 'multipart/mixed',
      filename: '',
      headers: HEADERS,
      parts: [
        {
          mimeType: 'multipart/alternative',
          filename: '',
          parts: [
            textPart('text/plain', 'The figures are attached.'),
            textPart('text/html', '<p>The figures are <b>attached</b>.</p>'),
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'figures.pdf',
          body: { attachmentId: 'att-1', size: 2048 },
        },
      ],
    }),
  );

  it('reads the headers whatever the nesting', () => {
    expect(decoded.subject).toBe('Quarterly figures');
    expect(decoded.from).toBe('"Rita Okoye" <rita@northwind.example>');
  });

  it('prefers the plain-text alternative for the body', () => {
    expect(decoded.body).toBe('The figures are attached.');
    expect(decoded.bodyText).toBe('The figures are attached.');
    expect(decoded.bodyHtml).toContain('<b>attached</b>');
  });

  it('splits the recipient headers without cutting a quoted name in half', () => {
    expect(decoded.to).toEqual(['deals@example.com', '"Patel, Anil" <anil@example.com>']);
    expect(decoded.cc).toEqual(['books@example.com']);
  });

  it('lists the attachment by its id and says the message has one', () => {
    expect(decoded.hasAttachments).toBe(true);
    expect(decoded.attachments).toEqual([
      {
        attachmentId: 'att-1',
        messageId: 'm1',
        filename: 'figures.pdf',
        contentType: 'application/pdf',
        size: 2048,
      },
    ]);
  });

  it('carries the thread id, the labels and the instant Gmail recorded', () => {
    expect(decoded.threadId).toBe('t1');
    expect(decoded.labels).toEqual(['INBOX', 'UNREAD']);
    expect(decoded.date).toBe(new Date(Date.UTC(2026, 8, 22, 9, 30)).toISOString());
  });
});

describe('a message with only HTML', () => {
  const decoded = decodeGmailMessage(
    message({
      mimeType: 'text/html',
      filename: '',
      headers: HEADERS,
      body: { size: 40, data: b64('<p>Hello there</p><p>Second line</p>') },
    }),
  );

  it('derives the body from the HTML', () => {
    expect(decoded.bodyText).toBeNull();
    expect(decoded.body).toContain('Hello there');
    expect(decoded.body).not.toContain('<p>');
  });

  it('keeps the HTML available in its own right', () => {
    expect(decoded.bodyHtml).toContain('<p>Hello there</p>');
  });
});

describe('an attached text file', () => {
  const decoded = decodeGmailMessage(
    message({
      mimeType: 'multipart/mixed',
      filename: '',
      headers: HEADERS,
      parts: [
        textPart('text/plain', 'See the notes.'),
        {
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { attachmentId: 'att-2', size: 12 },
        },
      ],
    }),
  );

  it('is an attachment, not the body — a filename settles it', () => {
    expect(decoded.body).toBe('See the notes.');
    expect(decoded.attachments.map((a) => a.filename)).toEqual(['notes.txt']);
  });
});

describe('a message with nothing to read', () => {
  const decoded = decodeGmailMessage(
    message({ mimeType: 'multipart/mixed', filename: '', headers: [] }),
  );

  it('says so rather than inventing a body', () => {
    expect(decoded.body).toBe('');
    expect(decoded.bodyText).toBeNull();
    expect(decoded.bodyHtml).toBeNull();
    expect(decoded.subject).toBeNull();
    expect(decoded.to).toEqual([]);
    expect(decoded.hasAttachments).toBe(false);
  });
});

describe('the date', () => {
  it('falls back to the sender’s own header when Gmail records no instant', () => {
    const decoded = decodeGmailMessage(
      message(
        {
          mimeType: 'text/plain',
          filename: '',
          headers: [{ name: 'Date', value: 'Tue, 22 Sep 2026 09:30:00 +0000' }],
        },
        { internalDate: null },
      ),
    );
    expect(decoded.date).toBe(new Date(Date.UTC(2026, 8, 22, 9, 30)).toISOString());
  });
});

describe('splitAddressHeader', () => {
  it('returns nothing for a header that is not there', () => {
    expect(splitAddressHeader(null)).toEqual([]);
  });

  it('trims each address', () => {
    expect(splitAddressHeader('a@x.com ,  b@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });
});
