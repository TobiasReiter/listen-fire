// The Gmail write path — sending as the mailbox and replying inside a thread.
//
// The assertions read the BUILT MESSAGE back rather than the call arguments:
// what Gmail receives is one blob of bytes, so "the reply named its parent" is
// only true if those bytes say so.


import type { FileRef, ParentLink, WriteInput } from 'movement-engine/public/adapter';
import type { GmailApiClient } from '../api_client';

import { GmailApiError } from '../api_client';
import { decodeGmailMessage } from '../mime';
import { adapterOver } from './host';
import { GMAIL_MESSAGE_DISPLAY_NAME } from '../types';

const MAILBOX = 'deals@example.com';

/** The write path never reads it; every WriteInput carries one. */
const MUTATION = {} as WriteInput['mutationContext'];

interface SentCall {
  raw: string;
  threadId?: string;
}

function fakeClient(over: { fail?: GmailApiError } = {}) {
  const sent: SentCall[] = [];
  const client = {
    credentials: { mailbox: MAILBOX, method: 'delegated' },
    async sendMessage(input: { raw: string; threadId?: string }) {
      sent.push(input);
      if (over.fail) throw over.fail;
      return { id: 'sent-1', threadId: input.threadId ?? 'thread-new', labelIds: ['SENT'] };
    },
  } as unknown as GmailApiClient;
  return { client, sent };
}

/** The RFC 2822 text the adapter handed Gmail. */
function raw(call: SentCall): string {
  return Buffer.from(call.raw, 'base64url').toString('utf8');
}

function header(call: SentCall, name: string): string | undefined {
  const text = raw(call);
  const head = text.slice(0, text.indexOf('\r\n\r\n')).replace(/\r\n[ \t]+/g, ' ');
  const line = head
    .split('\r\n')
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(line.indexOf(':') + 1).trim();
}

/** The message a listener would have been handed — the same currency the write
 *  path reads a reply's parent out of. */
const PARENT_RECORD = decodeGmailMessage({
  id: 'm-42',
  threadId: 'thread-7',
  labelIds: ['INBOX'],
  internalDate: String(Date.UTC(2026, 8, 22, 9, 0)),
  payload: {
    mimeType: 'text/plain',
    filename: '',
    headers: [
      { name: 'Subject', value: 'Quarterly figures' },
      { name: 'From', value: '"Rita Okoye" <rita@northwind.example>' },
      { name: 'To', value: MAILBOX },
      { name: 'Message-Id', value: '<parent@northwind.example>' },
      { name: 'References', value: '<first@northwind.example>' },
    ],
    body: { size: 4, data: Buffer.from('Hello', 'utf8').toString('base64url') },
  },
});

function replyParent(over: Partial<Record<string, unknown>> = {}): ParentLink {
  return {
    recordType: GMAIL_MESSAGE_DISPLAY_NAME,
    externalId: PARENT_RECORD.id,
    edgeName: 'Replies',
    data: { ...PARENT_RECORD, ...over },
  };
}

function write(input: {
  fields: Record<string, unknown>;
  parentLinks?: ParentLink[];
}): WriteInput {
  return {
    recordType: GMAIL_MESSAGE_DISPLAY_NAME,
    fields: input.fields,
    mutationContext: MUTATION,
    ...(input.parentLinks !== undefined ? { parentLinks: input.parentLinks } : {}),
  };
}

describe('sending a new message', () => {
  it('addresses it, titles it and returns the id Gmail gave it', async () => {
    const { client, sent } = fakeClient();
    const adapter = adapterOver(client);

    const result = await adapter.createRecord(
      write({
        fields: {
          To: ['rita@northwind.example', 'books@example.com'],
          Cc: ['anil@example.com'],
          Subject: 'Your figures',
          Body: 'Attached, as promised.',
        },
      }),
    );

    expect(sent).toHaveLength(1);
    expect(header(sent[0], 'From')).toBe(MAILBOX);
    expect(header(sent[0], 'To')).toBe('rita@northwind.example, books@example.com');
    expect(header(sent[0], 'Cc')).toBe('anil@example.com');
    expect(header(sent[0], 'Subject')).toBe('Your figures');
    expect(header(sent[0], 'In-Reply-To')).toBeUndefined();
    // No thread: new mail starts its own conversation.
    expect(sent[0].threadId).toBeUndefined();

    expect(result.externalId).toBe('sent-1');
    expect(result.adapterType).toBe('gmail');
    expect(result.data).toMatchObject({ id: 'sent-1', from: MAILBOX, subject: 'Your figures' });
  });

  it('sends both bodies as alternatives when HTML rides along', async () => {
    const { client, sent } = fakeClient();
    const adapter = adapterOver(client);
    await adapter.createRecord(
      write({
        fields: {
          To: ['rita@northwind.example'],
          Body: 'Plain words.',
          'HTML Body': '<p>Rich words.</p>',
        },
      }),
    );
    expect(header(sent[0], 'Content-Type')).toMatch(/^multipart\/alternative; boundary=/);
    expect(raw(sent[0])).toContain('text/plain');
    expect(raw(sent[0])).toContain('text/html');
  });

  it('attaches the files the run is holding', async () => {
    const { client, sent } = fakeClient();
    const adapter = adapterOver(client);
    const file: FileRef & { content: string } = {
      __brand: 'FileRef',
      name: 'figures.csv',
      contentType: 'text/csv',
      content: 'period,revenue\nQ3,120',
    };
    await adapter.createRecord(
      write({
        fields: { To: ['rita@northwind.example'], Body: 'See attached.', Files: [file] },
      }),
    );
    expect(header(sent[0], 'Content-Type')).toMatch(/^multipart\/mixed; boundary=/);
    expect(raw(sent[0])).toContain('Content-Disposition: attachment; filename="figures.csv"');
    expect(raw(sent[0])).toContain(
      Buffer.from('period,revenue\nQ3,120', 'utf8').toString('base64'),
    );
  });

  it('refuses a message with nobody to send it to', async () => {
    const { client } = fakeClient();
    const adapter = adapterOver(client);
    await expect(
      adapter.createRecord(write({ fields: { Subject: 'Hi', Body: 'Hello' } })),
    ).rejects.toThrow('a new message needs at least one `To` address');
  });

  it('refuses a message with nothing in it', async () => {
    const { client } = fakeClient();
    const adapter = adapterOver(client);
    await expect(
      adapter.createRecord(write({ fields: { To: ['rita@northwind.example'] } })),
    ).rejects.toThrow('needs a `Body` (plain text) or an `HTML Body`');
  });

  it('names the send scope, the mailbox, and that reads still work when the send scope was never granted', async () => {
    const { client } = fakeClient({
      fail: new GmailApiError(
        'missing_send_scope',
        403,
        'users.messages.send',
        'Request had insufficient authentication scopes.',
      ),
    });
    const adapter = adapterOver(client);
    const send = adapter.createRecord(
      write({ fields: { To: ['rita@northwind.example'], Body: 'Hello' } }),
    );
    await expect(send).rejects.toThrow(MAILBOX);
    await expect(send).rejects.toThrow('gmail.send');
    await expect(send).rejects.toThrow('Reads still work');
  });
});

describe('replying inside a thread', () => {
  it('threads on Gmail’s side and in the headers, without being told either', async () => {
    const { client, sent } = fakeClient();
    const adapter = adapterOver(client);

    await adapter.createRecord(
      write({ fields: { Body: 'Got it.' }, parentLinks: [replyParent()] }),
    );

    expect(sent[0].threadId).toBe('thread-7');
    expect(header(sent[0], 'In-Reply-To')).toBe('<parent@northwind.example>');
    expect(header(sent[0], 'References')).toBe(
      '<first@northwind.example> <parent@northwind.example>',
    );
    expect(header(sent[0], 'Subject')).toBe('Re: Quarterly figures');
    expect(header(sent[0], 'To')).toBe('Rita Okoye <rita@northwind.example>');
  });

  it('does not stack Re: on a conversation that already carries one', async () => {
    const { client, sent } = fakeClient();
    const adapter = adapterOver(client);
    await adapter.createRecord(
      write({
        fields: { Body: 'Still here.' },
        parentLinks: [replyParent({ subject: 'Re: Quarterly figures' })],
      }),
    );
    expect(header(sent[0], 'Subject')).toBe('Re: Quarterly figures');
  });

  it('lets the author override the address and the subject', async () => {
    const { client, sent } = fakeClient();
    const adapter = adapterOver(client);
    await adapter.createRecord(
      write({
        fields: { To: ['anil@example.com'], Subject: 'Handing this over', Body: 'Over to you.' },
        parentLinks: [replyParent()],
      }),
    );
    expect(header(sent[0], 'To')).toBe('anil@example.com');
    expect(header(sent[0], 'Subject')).toBe('Handing this over');
    // Still the same conversation — the override is about the words, not the place.
    expect(sent[0].threadId).toBe('thread-7');
  });

  it('fails plainly when the message it hangs off carries no thread', async () => {
    const { client, sent } = fakeClient();
    const adapter = adapterOver(client);
    await expect(
      adapter.createRecord(
        write({ fields: { Body: 'Got it.' }, parentLinks: [replyParent({ threadId: null })] }),
      ),
    ).rejects.toThrow('carries no `Thread Id`, so Gmail has no conversation to file it in');
    expect(sent).toHaveLength(0);
  });

  it('refuses an anchor that is not a reply', async () => {
    const { client } = fakeClient();
    const adapter = adapterOver(client);
    await expect(
      adapter.createRecord(
        write({
          fields: { Body: 'Got it.' },
          parentLinks: [{ ...replyParent(), edgeName: 'Attachments' }],
        }),
      ),
    ).rejects.toThrow('cannot be created along');
  });
});
