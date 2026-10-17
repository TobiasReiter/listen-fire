// Building the message Gmail sends — the headers, the structure the parts take,
// how bytes are encoded, and the two headers that make a reply a reply.
//
// The decoder (`mime.ts`) is the other half of this, so most assertions run the
// built message back through it: a builder that agrees with a reader is the
// only evidence worth having.

import {
  buildRfc2822,
  encodeAddress,
  toGmailRaw,
} from '../compose';

/** A deterministic boundary supply, so a whole message can be asserted rather
 *  than a message with a random string cut out of it. */
function boundaries(): () => string {
  let n = 0;
  return () => `B${(n += 1)}`;
}

function sections(raw: string): { headers: string; body: string } {
  const at = raw.indexOf('\r\n\r\n');
  return { headers: raw.slice(0, at), body: raw.slice(at + 4) };
}

function headerLines(raw: string): string[] {
  // Unfold before reading: a folded To list is one header on several lines.
  return sections(raw).headers.replace(/\r\n[ \t]+/g, ' ').split('\r\n');
}

function headerValue(raw: string, name: string): string | undefined {
  const line = headerLines(raw).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(line.indexOf(':') + 1).trim();
}

describe('a plain message', () => {
  const raw = buildRfc2822(
    {
      from: 'deals@example.com',
      to: ['rita@northwind.example'],
      subject: 'Quarterly figures',
      bodyText: 'Attached, as promised.',
      date: new Date(Date.UTC(2026, 8, 22, 9, 0, 0)),
    },
    { boundary: boundaries() },
  );

  it('carries the envelope headers', () => {
    expect(headerValue(raw, 'From')).toBe('deals@example.com');
    expect(headerValue(raw, 'To')).toBe('rita@northwind.example');
    expect(headerValue(raw, 'Subject')).toBe('Quarterly figures');
    expect(headerValue(raw, 'Date')).toBe('Tue, 22 Sep 2026 09:00:00 GMT');
    expect(headerValue(raw, 'MIME-Version')).toBe('1.0');
  });

  it('is a single base64 text part, not a multipart', () => {
    expect(headerValue(raw, 'Content-Type')).toBe('text/plain; charset="UTF-8"');
    expect(headerValue(raw, 'Content-Transfer-Encoding')).toBe('base64');
    expect(Buffer.from(sections(raw).body, 'base64').toString('utf8')).toBe(
      'Attached, as promised.',
    );
  });

  it('stamps no Message-Id — Gmail assigns its own', () => {
    expect(headerValue(raw, 'Message-Id')).toBeUndefined();
  });

  it('sets no reply headers when it is not a reply', () => {
    expect(headerValue(raw, 'In-Reply-To')).toBeUndefined();
    expect(headerValue(raw, 'References')).toBeUndefined();
  });

  it('is base64url on the way to Gmail', () => {
    expect(Buffer.from(toGmailRaw(raw), 'base64url').toString('utf8')).toBe(raw);
  });
});

describe('addresses', () => {
  it('leaves a bare address alone', () => {
    expect(encodeAddress('rita@northwind.example')).toBe('rita@northwind.example');
  });

  it('keeps an ASCII display name readable', () => {
    expect(encodeAddress('"Rita Okoye" <rita@northwind.example>')).toBe(
      'Rita Okoye <rita@northwind.example>',
    );
  });

  it('encodes only the display name when it is not ASCII', () => {
    // Encoding the whole value would swallow the angle brackets and leave Gmail
    // a header it cannot route.
    expect(encodeAddress('Ana Ruíz <ana@example.com>')).toBe(
      '=?UTF-8?B?QW5hIFJ1w616?= <ana@example.com>',
    );
  });

  it('folds a long To list between addresses', () => {
    const raw = buildRfc2822(
      {
        from: 'deals@example.com',
        to: [
          'aaaaaaaaaaaaaaaaaaaa@example.com',
          'bbbbbbbbbbbbbbbbbbbb@example.com',
          'cccccccccccccccccccc@example.com',
        ],
        bodyText: 'x',
      },
      { boundary: boundaries() },
    );
    // Folded on the wire, and every line inside the limit …
    expect(sections(raw).headers).toContain(',\r\n ');
    for (const line of sections(raw).headers.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    // … and one header again once unfolded.
    expect(headerValue(raw, 'To')).toBe(
      'aaaaaaaaaaaaaaaaaaaa@example.com, bbbbbbbbbbbbbbbbbbbb@example.com, cccccccccccccccccccc@example.com',
    );
  });

  it('encodes a subject that is not ASCII', () => {
    const raw = buildRfc2822(
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Café ☕', bodyText: 'x' },
      { boundary: boundaries() },
    );
    expect(headerValue(raw, 'Subject')).toBe(
      `=?UTF-8?B?${Buffer.from('Café ☕', 'utf8').toString('base64')}?=`,
    );
  });
});

describe('a message with both bodies', () => {
  const raw = buildRfc2822(
    {
      from: 'deals@example.com',
      to: ['rita@northwind.example'],
      cc: ['books@example.com'],
      subject: 'Both',
      bodyText: 'Plain words.',
      bodyHtml: '<p>Rich words.</p>',
    },
    { boundary: boundaries() },
  );

  it('is a multipart/alternative', () => {
    expect(headerValue(raw, 'Content-Type')).toBe('multipart/alternative; boundary="B1"');
    expect(headerValue(raw, 'Cc')).toBe('books@example.com');
  });

  it('puts the plain text FIRST — a reader takes the last one it understands', () => {
    const body = sections(raw).body;
    expect(body.indexOf('text/plain')).toBeLessThan(body.indexOf('text/html'));
  });

  it('closes the multipart', () => {
    expect(sections(raw).body.trimEnd().endsWith('--B1--')).toBe(true);
  });
});

describe('attachments', () => {
  const bytes = Buffer.from('%PDF-1.4 fake bytes');
  const raw = buildRfc2822(
    {
      from: 'deals@example.com',
      to: ['rita@northwind.example'],
      subject: 'With a file',
      bodyText: 'See attached.',
      attachments: [{ filename: 'figures.pdf', contentType: 'application/pdf', content: bytes }],
    },
    { boundary: boundaries() },
  );

  it('wraps the body and the files in a multipart/mixed', () => {
    expect(headerValue(raw, 'Content-Type')).toBe('multipart/mixed; boundary="B1"');
  });

  it('declares the file as an attachment by name', () => {
    expect(raw).toContain('Content-Type: application/pdf; name="figures.pdf"');
    expect(raw).toContain('Content-Disposition: attachment; filename="figures.pdf"');
  });

  it('encodes the bytes base64, wrapped', () => {
    const encoded = bytes.toString('base64');
    expect(raw).toContain(encoded);
    for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
  });

  it('nests the alternative INSIDE the mixed when there are two bodies', () => {
    const both = buildRfc2822(
      {
        from: 'deals@example.com',
        to: ['rita@northwind.example'],
        bodyText: 'Plain.',
        bodyHtml: '<p>Rich.</p>',
        attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('hi') }],
      },
      { boundary: boundaries() },
    );
    // The alternative's boundary is minted before the mixed's, so it is B1
    // inside B2 — the files sit beside the body, never inside the alternative.
    expect(headerValue(both, 'Content-Type')).toBe('multipart/mixed; boundary="B2"');
    expect(both).toContain('Content-Type: multipart/alternative; boundary="B1"');
    expect(both.indexOf('--B2--')).toBeGreaterThan(both.indexOf('--B1--'));
  });
});

describe('a reply', () => {
  const raw = buildRfc2822(
    {
      from: 'deals@example.com',
      to: ['rita@northwind.example'],
      subject: 'Re: Quarterly figures',
      bodyText: 'Got it.',
      inReplyTo: '<parent@northwind.example>',
      references: ['<first@northwind.example>', '<parent@northwind.example>'],
    },
    { boundary: boundaries() },
  );

  it('names the message it answers', () => {
    expect(headerValue(raw, 'In-Reply-To')).toBe('<parent@northwind.example>');
  });

  it('carries the whole chain, oldest first', () => {
    expect(headerValue(raw, 'References')).toBe(
      '<first@northwind.example> <parent@northwind.example>',
    );
  });
});

describe('bodies that would not survive a naive encoding', () => {
  it('keeps a long line and an emoji intact', () => {
    const body = `${'x'.repeat(500)} 🚀`;
    const raw = buildRfc2822(
      { from: 'a@example.com', to: ['b@example.com'], bodyText: body },
      { boundary: boundaries() },
    );
    expect(Buffer.from(sections(raw).body, 'base64').toString('utf8')).toBe(body);
    for (const line of sections(raw).body.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});
