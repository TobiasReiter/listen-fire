// Gmail PollSource — which labels a listener watches, reading history to the
// end, and the checkpoint's resume point when a tick stops short. No network:
// the API client is faked, per label and per page.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));
jest.mock('../../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { GmailApiClient } from '../client';

import {
  GmailApiError,
  type GmailHistoryAddition,
  type GmailMessage,
  type GmailMessageRef,
  type GmailProfile,
} from '../../../../../adapters/gmail/apiClient';
import { GmailPollSource, GMAIL_LABELS_SHAPE_ERROR, listenLabels } from '../poll';

const TEAM = 'team-1' as TeamId;

function wireMessage(id: string, labelIds: string[] = ['INBOX']): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds,
    snippet: '',
    internalDate: String(Date.UTC(2026, 8, 22, 9, 0)),
    payload: {
      mimeType: 'text/plain',
      filename: '',
      headers: [
        { name: 'Subject', value: `About ${id}` },
        { name: 'From', value: 'founder@startup.example' },
      ],
      body: { size: 4, data: Buffer.from('Hi.', 'utf8').toString('base64url') },
    },
  };
}

interface HistoryPage {
  added: GmailHistoryAddition[];
  historyId?: string;
}

interface Calls {
  history: { startHistoryId: string; labelId?: string; pageToken?: string }[];
  list: { query?: string; maxResults?: number; includeSpamTrash?: boolean; pageToken?: string }[];
  get: string[];
}

/** A fake whose history is PAGED per label: page n's token is `"<label>:<n>"`. */
function fakeClient(setup: {
  messages: GmailMessage[];
  history?: Record<string, HistoryPage[]>;
  historyExpired?: boolean;
  /** What every `messages.list` returns, whatever the query. */
  search?: GmailMessageRef[];
  /** A PAGED search instead: page n's token is `"search:<n>"`. */
  searchPages?: GmailMessageRef[][];
}) {
  const calls: Calls = { history: [], list: [], get: [] };
  const byId = new Map(setup.messages.map((m) => [m.id, m]));
  const client = {
    async getProfile(): Promise<GmailProfile> {
      return { emailAddress: 'nemo@example.com', historyId: '9000' };
    },
    async listHistory(input: { startHistoryId: string; labelId?: string; pageToken?: string }) {
      calls.history.push(input);
      if (setup.historyExpired) {
        throw new GmailApiError('history_expired', 404, 'history.list', 'Not Found');
      }
      const pages = setup.history?.[input.labelId ?? ''] ?? [{ added: [], historyId: '5000' }];
      const index = input.pageToken === undefined ? 0 : Number(input.pageToken.split(':')[1]);
      const page = pages[index];
      const next = index + 1 < pages.length ? `${input.labelId}:${index + 1}` : undefined;
      return {
        added: page.added,
        ...(next !== undefined ? { nextPageToken: next } : {}),
        ...(page.historyId !== undefined ? { historyId: page.historyId } : {}),
      };
    },
    async listMessages(input: {
      query?: string;
      maxResults?: number;
      includeSpamTrash?: boolean;
      pageToken?: string;
    }) {
      calls.list.push(input);
      if (setup.searchPages === undefined) return { messages: setup.search ?? [] };
      const index = input.pageToken === undefined ? 0 : Number(input.pageToken.split(':')[1]);
      const next = index + 1 < setup.searchPages.length ? `search:${index + 1}` : undefined;
      return {
        messages: setup.searchPages[index],
        ...(next !== undefined ? { nextPageToken: next } : {}),
      };
    },
    async getMessage(id: string): Promise<GmailMessage> {
      calls.get.push(id);
      const message = byId.get(id);
      if (!message) throw new GmailApiError('other', 404, 'users.messages.get', 'gone');
      return message;
    },
  };
  return { client, calls };
}

/** The fake implements exactly the methods the poll calls. */
function asClient(client: unknown): GmailApiClient {
  return client as GmailApiClient;
}

function pollWith(setup: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(setup);
  return { source: new GmailPollSource(TEAM, 'cred-1', asClient(client)), calls };
}

const added = (id: string, historyId: string): GmailHistoryAddition => ({
  id,
  threadId: `thread-${id}`,
  historyId,
});

const MARK = { historyId: '4000', lastSeenAt: '2026-09-21T00:00:00.000Z' };

describe('which labels a listener watches', () => {
  it('watches the inbox alone when the listen says nothing', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }] },
    });
    const result = await source.getEvents({ config: {}, checkpoint: MARK });

    expect(calls.history.map((c) => c.labelId)).toEqual(['INBOX']);
    expect(result.events.map((e) => e.externalId)).toEqual(['m1']);
    expect(result.checkpoint).toMatchObject({ historyId: '5000' });
  });

  it('unions the history of every label and admits a spam arrival', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('inbox-1'), wireMessage('pitch', ['SPAM'])],
      history: {
        INBOX: [{ added: [added('inbox-1', '4001')], historyId: '5000' }],
        SPAM: [{ added: [added('pitch', '4002')], historyId: '5001' }],
      },
      search: [
        { id: 'inbox-1', threadId: 't' },
        { id: 'pitch', threadId: 't' },
      ],
    });
    const result = await source.getEvents({
      config: { query: '-from:project-a.vc', labels: ['INBOX', 'SPAM'] },
      checkpoint: MARK,
    });

    expect(calls.history.map((c) => c.labelId)).toEqual(['INBOX', 'SPAM']);
    expect(calls.list).toEqual([
      {
        query: '{label:INBOX label:SPAM} -from:project-a.vc',
        maxResults: 100,
        includeSpamTrash: true,
      },
    ]);
    expect(result.events.map((e) => e.externalId).sort()).toEqual(['inbox-1', 'pitch']);
    // The LOWER of the two markers: a message landing in the inbox between
    // the two reads is only covered from the earlier one.
    expect(result.checkpoint).toMatchObject({ historyId: '5000' });
  });

  it('delivers a message seen on two labels once', async () => {
    const { source } = pollWith({
      messages: [wireMessage('m1', ['INBOX', 'IMPORTANT'])],
      history: {
        INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }],
        IMPORTANT: [{ added: [added('m1', '4001')], historyId: '5000' }],
      },
    });
    const result = await source.getEvents({
      config: { labels: ['INBOX', 'IMPORTANT'] },
      checkpoint: MARK,
    });
    expect(result.events).toHaveLength(1);
  });

  it('asks the search for Spam only when a watched label needs it', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }] },
      search: [{ id: 'm1', threadId: 't' }],
    });
    await source.getEvents({ config: { query: 'from:acme.com' }, checkpoint: MARK });
    expect(calls.list).toEqual([{ query: 'label:INBOX from:acme.com', maxResults: 100 }]);
  });

  it('reads the labels a listen names, trimmed and once each', () => {
    expect(listenLabels({})).toEqual(['INBOX']);
    expect(listenLabels({ labels: ['INBOX', ' SPAM ', 'SPAM'] })).toEqual(['INBOX', 'SPAM']);
  });

  it('refuses a malformed labels value rather than quietly watching the inbox', () => {
    for (const labels of [[], 'SPAM', ['INBOX', ''], [3]]) {
      expect(() => listenLabels({ labels })).toThrow(GMAIL_LABELS_SHAPE_ERROR);
    }
  });

  it('fails the tick on a malformed labels value before touching the mailbox', async () => {
    const { source, calls } = pollWith({ messages: [] });
    await expect(source.getEvents({ config: { labels: [] }, checkpoint: MARK })).rejects.toThrow(
      /non-empty list of Gmail label ids/,
    );
    expect(calls.history).toHaveLength(0);
  });
});

describe('reading history to the end', () => {
  it('follows every page of a label', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('p1'), wireMessage('p2'), wireMessage('p3')],
      history: {
        INBOX: [
          { added: [added('p1', '4001')] },
          { added: [added('p2', '4002')] },
          { added: [added('p3', '4003')], historyId: '5000' },
        ],
      },
    });
    const result = await source.getEvents({ config: {}, checkpoint: MARK });

    expect(calls.history.map((c) => c.pageToken)).toEqual([undefined, 'INBOX:1', 'INBOX:2']);
    expect(result.events.map((e) => e.externalId).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(result.checkpoint).toMatchObject({ historyId: '5000' });
  });

  it('stops at a tick’s worth and marks just before the first arrival it left', async () => {
    const first = Array.from({ length: 100 }, (_, i) => added(`a${i}`, String(4001 + i)));
    const second = Array.from({ length: 5 }, (_, i) => added(`b${i}`, String(4101 + i)));
    const { source, calls } = pollWith({
      messages: [...first, ...second].map((ref) => wireMessage(ref.id)),
      history: { INBOX: [{ added: first }, { added: second }, { added: [], historyId: '5000' }] },
    });
    const result = await source.getEvents({ config: {}, checkpoint: MARK });

    // One page was a tick's worth — the next page stays in Gmail's history.
    expect(calls.history).toHaveLength(1);
    expect(result.events).toHaveLength(100);
    expect(result.checkpoint).toMatchObject({ historyId: '4100' });
  });

  it('caps the union across labels and resumes from the first message not taken', async () => {
    const inbox = Array.from({ length: 60 }, (_, i) => added(`i${i}`, String(4001 + 2 * i)));
    const spam = Array.from({ length: 60 }, (_, i) => added(`s${i}`, String(4002 + 2 * i)));
    const { source } = pollWith({
      messages: [...inbox, ...spam].map((ref) => wireMessage(ref.id)),
      history: {
        INBOX: [{ added: inbox, historyId: '5000' }],
        SPAM: [{ added: spam, historyId: '5000' }],
      },
    });
    const result = await source.getEvents({
      config: { labels: ['INBOX', 'SPAM'] },
      checkpoint: MARK,
    });

    // Interleaved by history id, 4001…4100 are the hundred taken.
    expect(result.events).toHaveLength(100);
    expect(result.checkpoint).toMatchObject({ historyId: '4100' });
  });
});

describe('an expired change marker', () => {
  it('resyncs over the same label group, asking the search for Spam', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('pitch', ['SPAM'])],
      historyExpired: true,
      search: [{ id: 'pitch', threadId: 't' }],
    });
    const result = await source.getEvents({
      config: { query: '-from:project-a.vc', labels: ['INBOX', 'SPAM'] },
      checkpoint: MARK,
    });

    const since = Date.parse(MARK.lastSeenAt) / 1000;
    expect(calls.list[0]).toEqual({
      query: `{label:INBOX label:SPAM} after:${since} -from:project-a.vc`,
      maxResults: 100,
      includeSpamTrash: true,
    });
    expect(result.events.map((e) => e.externalId)).toEqual(['pitch']);
    expect(result.events[0].payload).toMatchObject({ resynced: true });
    expect(result.checkpoint).toMatchObject({ historyId: '9000' });
  });
});

describe('an arrival the search has not caught up on', () => {
  const T0 = Date.UTC(2026, 8, 28, 12, 0);
  let clock = T0;
  beforeEach(() => {
    clock = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  const QUERY = { query: '-from:project-a.vc', labels: ['INBOX', 'SPAM'] };

  it('is carried as pending with the time it was first seen, not dropped', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('pitch', ['SPAM'])],
      history: { SPAM: [{ added: [added('pitch', '4001')], historyId: '5000' }] },
      search: [],
    });
    const result = await source.getEvents({ config: QUERY, checkpoint: MARK });

    expect(result.events).toEqual([]);
    expect(calls.get).toEqual([]);
    expect(result.checkpoint).toMatchObject({
      historyId: '5000',
      pending: [{ id: 'pitch', firstSeenAt: new Date(T0).toISOString() }],
    });
  });

  it('is delivered on a later tick once the search admits it', async () => {
    const pending = [{ id: 'pitch', firstSeenAt: new Date(T0).toISOString() }];
    clock = T0 + 2 * 60 * 1000;
    const { source, calls } = pollWith({
      messages: [wireMessage('pitch', ['SPAM'])],
      search: [{ id: 'pitch', threadId: 't' }],
    });
    const result = await source.getEvents({ config: QUERY, checkpoint: { ...MARK, pending } });

    expect(result.events.map((e) => e.externalId)).toEqual(['pitch']);
    expect(calls.get).toEqual(['pitch']);
    expect(result.checkpoint).not.toHaveProperty('pending');
  });

  it('keeps its first-seen time while it waits', async () => {
    const firstSeenAt = new Date(T0).toISOString();
    clock = T0 + 5 * 60 * 1000;
    const { source } = pollWith({ messages: [], search: [] });
    const result = await source.getEvents({
      config: QUERY,
      checkpoint: { ...MARK, pending: [{ id: 'pitch', firstSeenAt }] },
    });
    expect(result.checkpoint).toMatchObject({ pending: [{ id: 'pitch', firstSeenAt }] });
  });

  it('is given up once the grace window has passed — the query excludes it', async () => {
    clock = T0 + 15 * 60 * 1000;
    const { source, calls } = pollWith({ messages: [], search: [] });
    const result = await source.getEvents({
      config: QUERY,
      checkpoint: {
        ...MARK,
        pending: [{ id: 'internal', firstSeenAt: new Date(T0).toISOString() }],
      },
    });
    expect(calls.list).toHaveLength(1);
    expect(result.events).toEqual([]);
    expect(result.checkpoint).not.toHaveProperty('pending');
  });

  it('reads further search pages for an id the first page did not hold', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }] },
      searchPages: [[{ id: 'newer', threadId: 't' }], [{ id: 'm1', threadId: 't' }], [{ id: 'x' }]],
    });
    const result = await source.getEvents({
      config: { query: 'from:acme.com' },
      checkpoint: MARK,
    });

    expect(calls.list.map((c) => c.pageToken)).toEqual([undefined, 'search:1']);
    expect(result.events.map((e) => e.externalId)).toEqual(['m1']);
  });

  it('never holds anything pending when the listen has no query', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }] },
    });
    const result = await source.getEvents({ config: {}, checkpoint: MARK });
    expect(calls.list).toEqual([]);
    expect(result.checkpoint).not.toHaveProperty('pending');
  });

  it('reads a checkpoint written before pending existed, and skips a malformed entry', async () => {
    const { source } = pollWith({ messages: [], search: [] });
    const old = await source.getEvents({ config: QUERY, checkpoint: MARK });
    expect(old.checkpoint).toMatchObject({ historyId: '5000' });
    expect(old.checkpoint).not.toHaveProperty('pending');

    const odd = await source.getEvents({
      config: QUERY,
      checkpoint: {
        ...MARK,
        pending: [{ id: 'ok', firstSeenAt: new Date(T0).toISOString() }, { id: 3 }, 'x'],
      },
    });
    expect(odd.checkpoint).toMatchObject({ pending: [{ id: 'ok' }] });
  });
});
