// Gmail adapter + PollSource — the entry surface, every describe, the edge
// walk, the WHERE pushdown and the poll's checkpoint and resync behaviour.
// No network: the API client is faked.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Expression } from '#shared/expression/types';
import type { GmailApiClient } from '@listen-fire/gmail';

import {
  ADAPTER_META_TYPE_ID,
  makeMetaPosition,
  makeStablePosition,
  positionRecordId,
} from 'movement-engine/services/translation_graph/types';
import {
  GmailApiError,
  type GmailMessage,
  type GmailMessageRef,
  type GmailProfile,
} from '@listen-fire/gmail';
import { decodeGmailMessage } from '@listen-fire/gmail';
import { GmailAdapter, GMAIL_MANIFEST, createGmailAdapter } from '../index';

/** The module's adapter over a test's client: no files, a silent log. */
function adapterOver(client: GmailApiClient): GmailAdapter {
  const quiet = () => undefined;
  return new GmailAdapter({
    client: async () => client,
    readFile: async () => {
      throw new Error('this test hands the adapter no files to read');
    },
    log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
  });
}
import { GmailPollSource, listenQuery } from '@listen-fire/gmail';
import { combineGmailQueries, gmailQueryFromWhere } from '@listen-fire/gmail';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { normaliseSchemaForAgent } from '../../../movement/agent_schema';
import {
  GMAIL_ATTACHMENT_TYPE_ID,
  GMAIL_MAILBOX_TYPE_ID,
  GMAIL_MESSAGE_EVENT_TAG,
  GMAIL_MESSAGE_TYPE_ID,
  decodeAttachmentId,
} from '@listen-fire/gmail';

import { applyHopOrderLimit, hopPushdown } from '#shared/expression/order_limit';

const TEAM = 'team-1' as TeamId;

// ── fixtures ────────────────────────────────────────────────────────────────

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function wireMessage(over: {
  id: string;
  subject?: string;
  from?: string;
  body?: string;
  at?: number;
  attachment?: { id: string; filename: string };
}): GmailMessage {
  return {
    id: over.id,
    threadId: `thread-${over.id}`,
    labelIds: ['INBOX'],
    snippet: over.subject ?? '',
    internalDate: String(over.at ?? Date.UTC(2026, 8, 22, 9, 0)),
    payload: {
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        { name: 'Subject', value: over.subject ?? 'A subject' },
        { name: 'From', value: over.from ?? 'ops@northwind.example' },
        { name: 'To', value: 'deals@example.com' },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          filename: '',
          body: { size: 10, data: b64(over.body ?? 'Body text.') },
        },
        ...(over.attachment
          ? [
              {
                mimeType: 'application/pdf',
                filename: over.attachment.filename,
                body: { attachmentId: over.attachment.id, size: 99 },
              },
            ]
          : []),
      ],
    },
  };
}

interface FakeCalls {
  profile: number;
  history: { startHistoryId: string; labelId?: string }[];
  list: { query?: string; maxResults?: number }[];
  get: string[];
  attachments: { messageId: string; attachmentId: string }[];
}

function fakeClient(setup: {
  messages: GmailMessage[];
  profile?: Partial<GmailProfile>;
  historyAdded?: GmailMessageRef[];
  historyExpired?: boolean;
  /** Ids the next `messages.list` will return, whatever the query. */
  listResult?: GmailMessageRef[];
}) {
  const calls: FakeCalls = { profile: 0, history: [], list: [], get: [], attachments: [] };
  const byId = new Map(setup.messages.map((m) => [m.id, m]));
  const client = {
    async getProfile(): Promise<GmailProfile> {
      calls.profile += 1;
      return { emailAddress: 'deals@example.com', historyId: '5000', ...setup.profile };
    },
    async listHistory(input: { startHistoryId: string; labelId?: string }) {
      calls.history.push(input);
      if (setup.historyExpired) {
        throw new GmailApiError('history_expired', 404, 'history.list', 'Not Found');
      }
      return { added: setup.historyAdded ?? [], historyId: '5100' };
    },
    async listMessages(input: { query?: string; maxResults?: number }) {
      calls.list.push(input);
      return {
        messages:
          setup.listResult ?? setup.messages.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })),
      };
    },
    async getMessage(id: string): Promise<GmailMessage> {
      calls.get.push(id);
      const message = byId.get(id);
      if (!message) throw new GmailApiError('no_such_mailbox', 404, 'users.messages.get', 'gone');
      return message;
    },
    async getAttachment(input: { messageId: string; attachmentId: string }): Promise<Buffer> {
      calls.attachments.push(input);
      return Buffer.from('file bytes', 'utf8');
    },
  };
  // The adapter takes the real client type; the fake implements exactly the
  // methods it calls, which is the seam these tests exist to exercise.
  return { client, calls };
}

/** The fake as the adapter's own client type. The methods above are exactly the
 *  ones the adapter and the poll call; nothing else is reachable from here. */
function asClient(client: unknown): GmailApiClient {
  return client as GmailApiClient;
}

function adapterWith(setup: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(setup);
  return { adapter: adapterOver(asClient(client)), calls };
}

function pollWith(setup: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(setup);
  return { source: new GmailPollSource(async () => asClient(client)), calls };
}

const property = (name: string): Expression => ({ type: 'property', propertyTypeId: name } as Expression);
const literal = (value: string | number): Expression => ({ type: 'static', value } as Expression);
const compare = (left: Expression, op: string, right: Expression): Expression =>
  ({ type: 'compare', op, left, right } as Expression);

// ── the manifest ────────────────────────────────────────────────────────────

describe('the manifest', () => {
  it('is a polled source AND a send target, needing a Gmail credential', () => {
    expect(GMAIL_MANIFEST.adapterType).toBe('gmail');
    expect(GMAIL_MANIFEST.supportedTriggers).toEqual(['poll']);
    expect(GMAIL_MANIFEST.requiredCredentialType).toBe('GOOGLE_GMAIL');
    expect(GMAIL_MANIFEST.methods).toContain('createRecord');
    // Mail that has been sent cannot be edited or recalled, and this connection
    // could not delete one if it wanted to.
    expect(GMAIL_MANIFEST.methods).not.toContain('updateRecord');
    expect(GMAIL_MANIFEST.methods).not.toContain('deleteRecord');
  });

  it('claims no uppercase trigger kind — `GMAIL` belongs to forwarded mail', () => {
    expect(GMAIL_MANIFEST.triggerKinds).toBeUndefined();
  });

  it('declares one event and lets a listen narrow it with a Gmail query', () => {
    expect(GMAIL_MANIFEST.subscribableEvents).toEqual(['message_received']);
    expect(GMAIL_MANIFEST.listenConfig?.map((k) => k.key)).toEqual([
      'query',
      'labels',
      'pollIntervalSeconds',
    ]);
    expect(GMAIL_MANIFEST.listenConfig?.find((k) => k.key === 'labels')?.format).toBe('strings');
  });

  it('says what the connector cannot do, rather than leaving it to be found out', () => {
    const said = `${GMAIL_MANIFEST.authoringHints} ${GMAIL_MANIFEST.handbookSection?.content}`;
    expect(said).toMatch(/labelling|labell?ing/i);
    expect(said).toMatch(/draft/i);
    expect(said).toMatch(/delet/i);
  });

  it('warns that the first poll delivers nothing', () => {
    expect(GMAIL_MANIFEST.triggerExpectation).toMatch(/first poll/i);
  });
});

// ── the type graph ──────────────────────────────────────────────────────────

describe('the entry surface', () => {
  const adapter = createGmailAdapter({ teamId: TEAM });

  it('publishes a readable + writable Messages collection and a fires edge onto the same node', async () => {
    const entries = await adapter.listEntryPoints();
    const messages = entries.filter((e) => e.typeId === GMAIL_MESSAGE_TYPE_ID);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ readable: true, writable: true, collectionName: 'Messages' });
    expect(messages[1]).toMatchObject({ readable: false, fires: true, firesOn: ['message_received'] });
  });

  it('keeps Attachment unreadable from the root — it is reached through its message', async () => {
    const attachment = (await adapter.listEntryPoints()).find(
      (e) => e.typeId === GMAIL_ATTACHMENT_TYPE_ID,
    );
    expect(attachment).toMatchObject({ readable: false, writable: false });
    expect(attachment?.collectionName).toBeUndefined();
  });

  it('the message collection is the ONLY writable entry — an attachment is never created', async () => {
    const writable = (await adapter.listEntryPoints())
      .filter((e) => e.writable)
      .map((e) => e.collectionName);
    expect(writable).toEqual(['Messages']);
  });
});

describe('describe', () => {
  const adapter = createGmailAdapter({ teamId: TEAM });

  it('answers for the mailbox meta node by either address', async () => {
    const byMeta = await adapter.describe(ADAPTER_META_TYPE_ID);
    const byId = await adapter.describe(GMAIL_MAILBOX_TYPE_ID);
    expect(byMeta?.references.map((r) => r.name)).toEqual(['Messages', 'Message']);
    expect(byId?.description).toBe(byMeta?.description);
    expect(byMeta?.description).toMatch(/no labelling, no archiving, no deleting, no drafts/);
  });

  it('describes a message by its NATURAL name as well as its type id', async () => {
    const byName = await adapter.describe('Message');
    const byId = await adapter.describe(GMAIL_MESSAGE_TYPE_ID);
    expect(byName?.typeId).toBe(GMAIL_MESSAGE_TYPE_ID);
    expect(byId?.typeId).toBe(GMAIL_MESSAGE_TYPE_ID);
  });

  it('carries every field the plan asked a message to publish', async () => {
    const descriptor = await adapter.describe(GMAIL_MESSAGE_TYPE_ID);
    expect(descriptor?.fields.map((f) => f.displayName)).toEqual([
      'Message Id', 'Thread Id', 'Subject', 'From', 'To', 'Cc', 'Date', 'Snippet',
      'Body', 'Plain Body', 'HTML Body', 'Files', 'Labels', 'Has Attachments',
    ]);
    expect(descriptor?.references.map((r) => r.name)).toEqual(['Attachments', 'Replies']);
  });

  it('names the send-side fields, and only those, as writable', async () => {
    const descriptor = await adapter.describe(GMAIL_MESSAGE_TYPE_ID);
    expect(descriptor?.fields.filter((f) => f.writable).map((f) => f.displayName)).toEqual([
      'Subject', 'To', 'Cc', 'Body', 'HTML Body', 'Files',
    ]);
    // `From` is not among them: mail always leaves as the connected mailbox,
    // and `Thread Id` is not either — a reply joins a conversation by WHERE it
    // is written, never by naming one.
    const byName = (name: string) => descriptor?.fields.find((f) => f.displayName === name);
    expect(byName('From')?.writable).toBe(false);
    expect(byName('Thread Id')?.writable).toBe(false);
    // Send-side only: the files on a received message are on the edge.
    expect(byName('Files')?.readable).toBe(false);
  });

  it('makes the reply edge write-only and un-linkable', async () => {
    const replies = (await adapter.describe(GMAIL_MESSAGE_TYPE_ID))?.references.find(
      (r) => r.name === 'Replies',
    );
    expect(replies).toMatchObject({ writable: true, readable: false, linkable: false });
    expect(replies?.targetTypeId).toBe(GMAIL_MESSAGE_TYPE_ID);
  });

  it('states the send-versus-reply rule wherever an author meets it', async () => {
    const said = [
      (await adapter.describe(ADAPTER_META_TYPE_ID))?.description,
      (await adapter.describe(GMAIL_MESSAGE_TYPE_ID))?.description,
      GMAIL_MANIFEST.authoringHints,
      GMAIL_MANIFEST.handbookSection?.content,
    ];
    for (const text of said) {
      expect(text).toMatch(/`Messages` edge is a NEW message/);
      expect(text).toMatch(/`Replies` edge is a reply/);
    }
  });

  it('gives an attachment its bytes as a File field', async () => {
    const descriptor = await adapter.describe(GMAIL_ATTACHMENT_TYPE_ID);
    expect(descriptor?.fields.find((f) => f.displayName === 'File')?.kind).toBe('file');
  });

  // The surface an authoring agent actually reads. Exactly two edges carry a
  // write promise — the mailbox's own `Messages` and a message's `Replies` —
  // and every other reference omits `writable`, which IS the read-only fact
  // rather than an absent opinion.
  it('projects an instance whose only writes are the send and the reply', async () => {
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const metaDescriptor = await adapter.describe(ADAPTER_META_TYPE_ID);
    const { schema } = instanceSchemaFromDescriptors({
      adapterType: 'gmail',
      entries,
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate: false,
    });
    const agentSchema = normaliseSchemaForAgent(schema);

    const writable = Object.entries(agentSchema.positions).flatMap(([position, p]) =>
      Object.entries(p.edges)
        .filter(([, edge]) => edge.writable !== false)
        .map(([edge]) => `${position}-[:${edge}]->`),
    );
    expect(writable).toEqual(['Message-[:Replies]->']);
    expect(Object.keys(agentSchema.positions).sort()).toEqual(['Attachment', 'Message']);
    // The send itself hangs off the MAILBOX, not off a position — the root's
    // own collection is where a new message is created.
    expect(Object.keys(agentSchema.writableRoots)).toEqual(['Message']);
    // The order Gmail answers in names a real, orderable Message field by the
    // name an ORDER BY writes — or the checker could never match it.
    const natural = schema.collections['Messages']?.capability?.naturalOrder;
    expect(natural).toEqual({ field: 'Date', direction: 'desc' });
    expect(schema.positions['Message']?.properties['Date']).toBeDefined();
    expect(schema.positions['Message']?.propertyCapabilities?.['Date']?.orderable).toBe(true);
  });
});

describe('the walk', () => {
  it('lands on Message from the root and on Attachment from a message', async () => {
    const adapter = createGmailAdapter({ teamId: TEAM });
    const fromRoot = await adapter.edgesFrom?.(makeMetaPosition('gmail'));
    expect(fromRoot?.targetNodes?.['Messages']).toMatchObject({ displayName: 'Message' });

    const fromMessage = await adapter.edgesFrom?.(
      makeStablePosition({
        adapterType: 'gmail',
        recordType: 'Message',
        recordId: 'm1',
        data: {},
      }),
    );
    expect(fromMessage?.targetNodes?.['message_attachments']).toMatchObject({
      displayName: 'Attachment',
    });
  });
});

// ── reads ───────────────────────────────────────────────────────────────────

describe('searching the mailbox', () => {
  it('turns a WHERE into a Gmail query and reads back the decoded messages', async () => {
    const { adapter, calls } = adapterWith({
      messages: [wireMessage({ id: 'm1', subject: 'Q3 figures', from: 'rita@northwind.example' })],
    });
    const results = await adapter.getRelated({
      position: makeMetaPosition('gmail'),
      fieldId: 'Messages',
      direction: 'outgoing',
      where: compare(property('From'), 'contains', literal('northwind.example')),
    });

    expect(calls.list[0].query).toBe('from:northwind.example');
    expect(results).toHaveLength(1);
    expect(positionRecordId(results[0].position)).toBe('m1');
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Subject' }),
    ).resolves.toBe('Q3 figures');
  });

  it('bounds an unbounded walk rather than paging the whole mailbox', async () => {
    const { adapter, calls } = adapterWith({ messages: [wireMessage({ id: 'm1' })] });
    await adapter.getRelated({
      position: makeMetaPosition('gmail'),
      fieldId: 'Messages',
      direction: 'outgoing',
    });
    expect(calls.list[0].maxResults).toBe(100);
    expect(calls.list[0].query).toBeUndefined();
  });

  it('takes a LIMIT only when no ORDER BY came with it, or the one Gmail answers in', async () => {
    const { adapter, calls } = adapterWith({ messages: [wireMessage({ id: 'm1' })] });
    const walk = (extra: Partial<Parameters<typeof adapter.getRelated>[0]>) =>
      adapter.getRelated({
        position: makeMetaPosition('gmail'),
        fieldId: 'Messages',
        direction: 'outgoing',
        limit: 3,
        ...extra,
      });

    await walk({});
    expect(calls.list[0].maxResults).toBe(3);

    // Newest first IS the order Gmail answers in, whichever spelling of the
    // field the hop carries: the LIMIT reaches the request.
    await walk({ orderBy: { fieldId: 'Date', direction: 'desc' } });
    expect(calls.list[1].maxResults).toBe(3);
    await walk({ orderBy: { fieldId: 'date', direction: 'desc' } });
    expect(calls.list[2].maxResults).toBe(3);

    // Any other order is the engine's sort, so the fetch runs to the ceiling.
    await walk({ orderBy: { fieldId: 'Date', direction: 'asc' } });
    expect(calls.list[3].maxResults).toBe(100);
    await walk({ orderBy: { fieldId: 'Subject', direction: 'desc' } });
    expect(calls.list[4].maxResults).toBe(100);
  });

  it('answers ORDER BY `Date` ASC LIMIT n with the OLDEST n, not the first n newest', async () => {
    // Gmail hands the search back newest first; the oldest two are at the END.
    const day = (d: number) => Date.UTC(2026, 8, d, 9, 0);
    const messages = [5, 4, 3, 2, 1].map((d) => wireMessage({ id: `m${d}`, at: day(d) }));
    const { adapter, calls } = adapterWith({ messages });
    const cardinality = {
      mode: 'n' as const,
      limit: 2,
      orderBy: property('Date'),
      orderDirection: 'asc' as const,
    };
    const pushed = hopPushdown({ cardinality });
    const fetched = await adapter.getRelated({
      position: makeMetaPosition('gmail'),
      fieldId: 'Messages',
      direction: 'outgoing',
      ...pushed,
    });
    expect(calls.list[0].maxResults).toBe(100);
    expect(fetched).toHaveLength(5);
    // The engine's sort over the bounded fetch — the walker's own last step.
    const answered = await applyHopOrderLimit(fetched, cardinality, {
      value: (r) => adapter.getFieldValue({ position: r.position, fieldId: 'Date' }),
    });
    expect(answered.map((r) => positionRecordId(r.position))).toEqual(['m1', 'm2']);
  });
});

describe('attachments', () => {
  it('walks to one per file, keyed by the message AND the attachment', async () => {
    const { adapter } = adapterWith({ messages: [] });
    const message = decodeGmailMessage(
      wireMessage({ id: 'm1', attachment: { id: 'att-1', filename: 'figures.pdf' } }),
    );
    const results = await adapter.getRelated({
      position: makeStablePosition({
        adapterType: 'gmail',
        recordType: 'Message',
        recordId: 'm1',
        data: { ...message },
      }),
      fieldId: 'Attachments',
      direction: 'outgoing',
    });

    expect(results).toHaveLength(1);
    expect(decodeAttachmentId(positionRecordId(results[0].position) ?? '')).toEqual({
      messageId: 'm1',
      attachmentId: 'att-1',
    });
    await expect(
      adapter.getFieldValue({ position: results[0].position, fieldId: 'Name' }),
    ).resolves.toBe('figures.pdf');
  });

  it('fetches bytes only when the File field is read', async () => {
    const { adapter, calls } = adapterWith({ messages: [] });
    const message = decodeGmailMessage(
      wireMessage({ id: 'm1', attachment: { id: 'att-1', filename: 'figures.pdf' } }),
    );
    const [attachment] = await adapter.getRelated({
      position: makeStablePosition({
        adapterType: 'gmail',
        recordType: 'Message',
        recordId: 'm1',
        data: { ...message },
      }),
      fieldId: 'Attachments',
      direction: 'outgoing',
    });

    expect(calls.attachments).toHaveLength(0);
    const file = await adapter.getFieldValue({
      position: attachment.position,
      fieldId: 'File',
    });
    expect(file).toMatchObject({ __brand: 'FileRef', name: 'figures.pdf' });
    expect(calls.attachments).toHaveLength(0);

    await adapter.resolveFileRef({
      ref: { __brand: 'FileRef', source: { adapterType: 'gmail', handle: 'm1:att-1' } },
    });
    expect(calls.attachments).toEqual([{ messageId: 'm1', attachmentId: 'att-1' }]);
  });
});

describe('event typing', () => {
  it('discriminates by tag alone — the poll stamps every event', async () => {
    const types = await createGmailAdapter({ teamId: TEAM }).listEventTypes?.();
    expect(types).toEqual([
      { tag: GMAIL_MESSAGE_EVENT_TAG, positionType: GMAIL_MESSAGE_TYPE_ID, match: { path: 'id', equals: [] } },
    ]);
  });
});

// ── the query pushdown ──────────────────────────────────────────────────────

describe('gmailQueryFromWhere', () => {
  it('pushes nothing when there is nothing to push', () => {
    expect(gmailQueryFromWhere(undefined)).toBeUndefined();
    expect(gmailQueryFromWhere(compare(property('Snippet'), 'eq', literal('x')))).toBeUndefined();
  });

  it('quotes a value Gmail would otherwise read as two terms', () => {
    expect(gmailQueryFromWhere(compare(property('Subject'), 'eq', literal('Q3 figures')))).toBe(
      'subject:"Q3 figures"',
    );
  });

  it('turns a date bound into whole epoch seconds', () => {
    const at = Date.UTC(2026, 8, 20);
    expect(gmailQueryFromWhere(compare(property('Date'), 'gte', literal(at)))).toBe(
      `after:${at / 1000}`,
    );
    expect(gmailQueryFromWhere(compare(property('Date'), 'lt', literal(at)))).toBe(
      `before:${at / 1000}`,
    );
  });

  it('pushes a Cc filter — Gmail has its own `cc:` operator', () => {
    expect(gmailQueryFromWhere(compare(property('Cc'), 'contains', literal('books@x.com')))).toBe(
      'cc:books@x.com',
    );
  });

  it('groups an IN so it means either, not both', () => {
    const list: Expression = {
      type: 'list',
      elements: [literal('INBOX'), literal('IMPORTANT')],
    } as Expression;
    expect(gmailQueryFromWhere(compare(property('Labels'), 'in', list))).toBe(
      '{label:INBOX label:IMPORTANT}',
    );
  });

  it('ANDs the conjuncts of an AND tree and ignores anything under an OR', () => {
    const and: Expression = {
      type: 'logical',
      op: 'and',
      operands: [
        compare(property('From'), 'eq', literal('rita@northwind.example')),
        compare(property('Labels'), 'eq', literal('INBOX')),
      ],
    } as Expression;
    expect(gmailQueryFromWhere(and)).toBe('from:rita@northwind.example label:INBOX');

    const or: Expression = {
      type: 'logical',
      op: 'or',
      operands: [compare(property('From'), 'eq', literal('a@x.com'))],
    } as Expression;
    expect(gmailQueryFromWhere(or)).toBeUndefined();
  });

  it('combines a listen filter with a walk’s own narrowing', () => {
    expect(combineGmailQueries('label:INBOX', undefined, 'from:x')).toBe('label:INBOX from:x');
    expect(combineGmailQueries(undefined, '')).toBeUndefined();
  });
});

// ── the poll ────────────────────────────────────────────────────────────────

describe('the first poll', () => {
  it('takes the mailbox’s marker and delivers nothing', async () => {
    const { source, calls } = pollWith({ messages: [wireMessage({ id: 'm1' })] });
    const result = await source.getEvents({ config: {} });

    expect(result.events).toEqual([]);
    expect(result.checkpoint).toMatchObject({ historyId: '5000' });
    expect(calls.profile).toBe(1);
    expect(calls.history).toHaveLength(0);
    expect(calls.get).toHaveLength(0);
  });

  it('records when it looked, so a later resync has a floor', async () => {
    const { source } = pollWith({ messages: [] });
    const { checkpoint } = await source.getEvents({ config: {} });
    const lastSeenAt = (checkpoint as { lastSeenAt?: string }).lastSeenAt;
    expect(Date.parse(lastSeenAt ?? '')).not.toBeNaN();
  });
});

describe('a normal poll', () => {
  it('asks history for what arrived in the inbox and advances the marker', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage({ id: 'm1', subject: 'Q3 figures' })],
      historyAdded: [{ id: 'm1', threadId: 'thread-m1' }],
    });
    const result = await source.getEvents({
      config: {},
      checkpoint: { historyId: '4000', lastSeenAt: '2026-09-21T00:00:00.000Z' },
    });

    expect(calls.history).toEqual([{ startHistoryId: '4000', labelId: 'INBOX' }]);
    expect(result.checkpoint).toMatchObject({ historyId: '5100' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      tag: GMAIL_MESSAGE_EVENT_TAG,
      externalId: 'm1',
      idempotencyKey: 'gmail:m1',
    });
    expect(result.events[0].payload).toMatchObject({ subject: 'Q3 figures' });
  });

  it('delivers one event per message even when history records it twice', async () => {
    const { source } = pollWith({
      messages: [wireMessage({ id: 'm1' })],
      historyAdded: [
        { id: 'm1', threadId: 'thread-m1' },
        { id: 'm1', threadId: 'thread-m1' },
      ],
    });
    const result = await source.getEvents({ config: {}, checkpoint: { historyId: '4000' } });
    expect(result.events).toHaveLength(1);
  });

  it('delivers oldest first', async () => {
    const { source } = pollWith({
      messages: [
        wireMessage({ id: 'later', at: Date.UTC(2026, 8, 22, 10, 0) }),
        wireMessage({ id: 'earlier', at: Date.UTC(2026, 8, 22, 8, 0) }),
      ],
      historyAdded: [
        { id: 'later', threadId: 't' },
        { id: 'earlier', threadId: 't' },
      ],
    });
    const result = await source.getEvents({ config: {}, checkpoint: { historyId: '4000' } });
    expect(result.events.map((e) => e.externalId)).toEqual(['earlier', 'later']);
  });

  it('does nothing but advance when nothing arrived', async () => {
    const { source, calls } = pollWith({ messages: [], historyAdded: [] });
    const result = await source.getEvents({ config: {}, checkpoint: { historyId: '4000' } });
    expect(result.events).toEqual([]);
    expect(calls.get).toHaveLength(0);
  });
});

describe('the author’s filter', () => {
  it('narrows delivery with one search rather than a fetch per message', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage({ id: 'm1' }), wireMessage({ id: 'm2' })],
      historyAdded: [
        { id: 'm1', threadId: 't' },
        { id: 'm2', threadId: 't' },
      ],
      listResult: [{ id: 'm2', threadId: 't' }],
    });
    const result = await source.getEvents({
      config: { query: 'from:acme.com' },
      checkpoint: { historyId: '4000' },
    });

    expect(calls.list).toHaveLength(1);
    expect(calls.list[0].query).toBe('label:INBOX from:acme.com');
    expect(result.events.map((e) => e.externalId)).toEqual(['m2']);
    expect(calls.get).toEqual(['m2']);
  });

  it('costs no search at all when the listen has no filter', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage({ id: 'm1' })],
      historyAdded: [{ id: 'm1', threadId: 't' }],
    });
    await source.getEvents({ config: {}, checkpoint: { historyId: '4000' } });
    expect(calls.list).toHaveLength(0);
  });

  it('reads a blank filter as no filter', () => {
    expect(listenQuery({ query: '   ' })).toBeUndefined();
    expect(listenQuery({})).toBeUndefined();
    expect(listenQuery({ query: ' from:x ' })).toBe('from:x');
  });
});

describe('an expired change marker', () => {
  it('resyncs from the last seen time and says so on the event', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage({ id: 'm1' })],
      historyExpired: true,
      listResult: [{ id: 'm1', threadId: 't' }],
    });
    const result = await source.getEvents({
      config: {},
      checkpoint: { historyId: '1', lastSeenAt: '2026-09-15T00:00:00.000Z' },
    });

    expect(calls.list[0].query).toBe(
      `label:INBOX after:${Date.parse('2026-09-15T00:00:00.000Z') / 1000}`,
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload).toMatchObject({ resynced: true });
    // The marker is taken fresh from the profile, so the NEXT poll is a normal
    // one rather than resyncing forever.
    expect(result.checkpoint).toMatchObject({ historyId: '5000' });
  });

  it('carries the author’s filter into the resync', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage({ id: 'm1' })],
      historyExpired: true,
      listResult: [{ id: 'm1', threadId: 't' }],
    });
    await source.getEvents({
      config: { query: 'from:acme.com' },
      checkpoint: { historyId: '1', lastSeenAt: '2026-09-15T00:00:00.000Z' },
    });
    expect(calls.list[0].query).toContain('from:acme.com');
  });

  it('lets any other failure through rather than resyncing over it', async () => {
    const { client } = fakeClient({ messages: [] });
    const failing = {
      ...client,
      async listHistory() {
        throw new GmailApiError('other', 500, 'history.list', 'boom');
      },
    };
    const source = new GmailPollSource(async () => asClient(failing));
    await expect(
      source.getEvents({ config: {}, checkpoint: { historyId: '4000' } }),
    ).rejects.toThrow(/boom/);
  });
});
