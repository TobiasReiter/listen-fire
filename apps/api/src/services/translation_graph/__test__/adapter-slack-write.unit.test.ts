/**
 * Unit tests for the Slack adapter's unified write side
 * (message-write-unification chunk 1): ONE `slack:message` type, creates
 * only along edges — Channel-[:messages]-> posts, msg-[:replies]-> replies,
 * File values ride the write (upload flow, Message as initial_comment).
 */

import type { getSlackClient } from '../../../adapters/slack/webApi/apiClient';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MutationContext } from '../mutation_context';

import {
  SlackAdapter,
  SLACK_MESSAGE_TYPE_ID,
  SLACK_FILE_TYPE_ID,
  SLACK_REACTION_TYPE_ID,
} from '../adapters/slack';
import { SLACK_CHANNEL_TYPE_ID } from '../adapters/slack/read_graph';
import {
  addReaction,
  createUnifiedMessage,
  reactionAnchorFromParent,
  replyAnchorFromParent,
} from '../adapters/slack/write';

const TEAM_ID = 'team-1' as TeamId;

type SlackClient = ReturnType<typeof getSlackClient>;

// ── Mock Slack client ───────────────────────────────────────────────────────

interface MockCalls {
  postMessage: Record<string, unknown>[];
  conversationsList: unknown[];
  conversationsInfo: unknown[];
  conversationsJoin: unknown[];
  getUploadURL: unknown[];
  completeUpload: Record<string, unknown>[];
  reactionsAdd: Record<string, unknown>[];
  fetch: unknown[];
}

function makeMockClient(opts?: {
  channels?: { id: string; name: string }[];
  isMember?: boolean;
  postTs?: string;
  /** Override `chat.postMessage` entirely — e.g. to simulate a Slack platform
   *  error (a rejection carrying `.data`, as `@slack/web-api` throws it). */
  postMessage?: (args: Record<string, unknown>) => Promise<{ ok: boolean; ts?: string }>;
  /** Override `reactions.add` — e.g. to simulate `already_reacted`, which
   *  Slack raises as a platform error carrying `.data.error`. */
  reactionsAdd?: (args: Record<string, unknown>) => Promise<{ ok: boolean }>;
}): { client: SlackClient; calls: MockCalls } {
  const calls: MockCalls = {
    postMessage: [],
    conversationsList: [],
    conversationsInfo: [],
    conversationsJoin: [],
    getUploadURL: [],
    completeUpload: [],
    reactionsAdd: [],
    fetch: [],
  };
  const channels = opts?.channels ?? [{ id: 'C123', name: 'deals' }];
  const isMember = opts?.isMember ?? true;
  const postTs = opts?.postTs ?? '1700000000.000123';

  const client = {
    api: {
      conversations: {
        list: async (args: unknown) => {
          calls.conversationsList.push(args);
          return { channels };
        },
        info: async (args: unknown) => {
          calls.conversationsInfo.push(args);
          return { channel: { is_member: isMember } };
        },
        join: async (args: unknown) => {
          calls.conversationsJoin.push(args);
          return { ok: true };
        },
      },
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.postMessage.push(args);
          return opts?.postMessage ? opts.postMessage(args) : { ok: true, ts: postTs };
        },
      },
      reactions: {
        add: async (args: Record<string, unknown>) => {
          calls.reactionsAdd.push(args);
          return opts?.reactionsAdd ? opts.reactionsAdd(args) : { ok: true };
        },
      },
      files: {
        getUploadURLExternal: async (args: unknown) => {
          calls.getUploadURL.push(args);
          return { upload_url: 'https://upload.slack/u', file_id: 'F999' };
        },
        completeUploadExternal: async (args: Record<string, unknown>) => {
          calls.completeUpload.push(args);
          return { ok: true };
        },
      },
    },
    fetch: async (url: unknown, init: unknown) => {
      calls.fetch.push({ url, init });
      return { ok: true, status: 200 };
    },
  } as unknown as SlackClient;

  return { client, calls };
}

const mutationContext = {} as MutationContext;

// ── 1. Schema introspection ─────────────────────────────────────────────────

describe('SlackAdapter — unified schema introspection', () => {
  it('listEntryPoints publishes only the read types, none writable', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.typeId).sort()).toEqual([
      'slack:channel',
      'slack:file',
      'slack:message',
      'slack:reaction',
      'slack:user',
    ]);
    // Slack has NO writable root — creates ride the `writable` edges.
    expect(entries.every((e) => !e.writable)).toBe(true);
  });

  it('describe(slack:message) is the unified type: writable Message + File + Blocks, read-only scalars, no Thread Timestamp, no Buttons', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    expect(desc).not.toBeNull();
    const byId = new Map(desc!.fields.map((f) => [f.fieldId, f]));

    const text = byId.get('text')!;
    expect(text.displayName).toBe('Message');
    expect(text.writable).toBe(true);
    expect(text.functions?.some((fn) => fn.name === 'SLACK_MESSAGE')).toBe(true);

    const file = byId.get('file')!;
    expect(file.displayName).toBe('File');
    expect(file.kind).toBe('file');
    expect(file.writable).toBe(true);

    const blocks = byId.get('blocks')!;
    expect(blocks.displayName).toBe('Blocks');
    expect(blocks.kind).toBe('json');
    expect(blocks.cardinality).toBe('many');
    expect(blocks.writable).toBe(true);
    expect(blocks.readable).toBe(false);

    // Buttons is retired — no id, no field.
    expect(byId.has('buttons')).toBe(false);

    for (const id of ['user', 'channel', 'ts']) {
      expect(byId.get(id)!.writable).toBe(false);
    }
    // Resolution 5: no `thread_ts` field at all.
    expect(byId.has('thread_ts')).toBe(false);

    const replies = desc!.references!.find((r) => r.name === 'Replies');
    expect(replies!.writable).toBe(true);

    // The files-XOR-blocks writeUnion: every writable FIELD (text/file/blocks)
    // covered across exactly the two variants the descriptor declares.
    expect(desc!.writeUnion?.variants).toEqual([
      { name: 'a file post', fields: ['text', 'file'] },
      { name: 'an interactive post', fields: ['text', 'blocks'] },
    ]);
  });

  it('describe(slack:channel) exposes a writable `messages` reference', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_CHANNEL_TYPE_ID);
    const messages = desc!.references!.find((r) => r.name === 'Messages');
    expect(messages!.writable).toBe(true);
  });
});

// ── 2. replyAnchorFromParent ─────────────────────────────────────────────────

describe('replyAnchorFromParent', () => {
  it('splits a composite `channelId:ts` externalId (traversed history parent)', () => {
    expect(replyAnchorFromParent({ externalId: 'C123:111.222' })).toEqual({
      channelId: 'C123',
      threadTs: '111.222',
    });
  });

  it('reads the channel off `channel` in the parent data (position/event parent)', () => {
    expect(
      replyAnchorFromParent({ externalId: '111.222', data: { channel: 'C9' } }),
    ).toEqual({ channelId: 'C9', threadTs: '111.222' });
  });

  it('reads the channel off `channelId` in the parent data (WriteResult handle parent)', () => {
    expect(
      replyAnchorFromParent({ externalId: '111.222', data: { channelId: 'C9' } }),
    ).toEqual({ channelId: 'C9', threadTs: '111.222' });
  });

  it('anchors the thread ROOT: the parent`s own thread_ts wins over its ts (reply-to-a-reply)', () => {
    expect(
      replyAnchorFromParent({ externalId: '111.222', data: { channel: 'C9', thread_ts: '000.111' } })
        .threadTs,
    ).toBe('000.111');
  });

  it('yields channelId undefined when no channel is anywhere', () => {
    expect(replyAnchorFromParent({ externalId: '111.222' }).channelId).toBeUndefined();
  });
});

// ── 3. createUnifiedMessage — post ───────────────────────────────────────────

describe('createUnifiedMessage — post', () => {
  it('posts to the anchor channel with no run-time name resolution, returns the ts as externalId', async () => {
    const { client, calls } = makeMockClient({ postTs: '111.222' });
    const result = await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { text: 'hello world' },
    });
    expect(calls.conversationsList).toHaveLength(0);
    expect(calls.postMessage[0]).toMatchObject({ channel: 'C123', text: 'hello world' });
    expect(calls.postMessage[0].thread_ts).toBeUndefined();
    expect(result.externalId).toBe('111.222');
    expect(result.data).toMatchObject({ channelId: 'C123', ts: '111.222' });
  });

  it('joins the channel when the bot is not a member', async () => {
    const { client, calls } = makeMockClient({ isMember: false });
    await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { text: 'hi' },
    });
    expect(calls.conversationsJoin).toHaveLength(1);
    expect(calls.conversationsJoin[0]).toMatchObject({ channel: 'C123' });
  });

  it('does not join when the bot is already a member', async () => {
    const { client, calls } = makeMockClient({ isMember: true });
    await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { text: 'hi' },
    });
    expect(calls.conversationsJoin).toHaveLength(0);
  });
});

// ── 4. createUnifiedMessage — reply ──────────────────────────────────────────

describe('createUnifiedMessage — reply', () => {
  it('posts into the thread via thread_ts and carries threadTs on the result data', async () => {
    const { client, calls } = makeMockClient({ postTs: '333.444' });
    const result = await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'reply', channelId: 'C123', threadTs: '111.222' },
      fields: { text: 'a reply' },
    });
    expect(calls.postMessage[0]).toMatchObject({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'a reply',
    });
    expect(result.data).toMatchObject({ threadTs: '111.222' });
  });
});

// ── 5. createUnifiedMessage — file ───────────────────────────────────────────

describe('createUnifiedMessage — file', () => {
  it('uploads the file with the Message text riding as initial_comment', async () => {
    const { client, calls } = makeMockClient();
    const result = await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: {
        text: 'caption',
        file: { name: 'note.txt', contentType: 'text/plain', content: 'file body' },
      },
    });
    expect(calls.getUploadURL[0]).toMatchObject({ filename: 'note.txt' });
    expect(calls.fetch).toHaveLength(1);
    expect(calls.completeUpload[0]).toMatchObject({
      channel_id: 'C123',
      initial_comment: 'caption',
      files: [{ id: 'F999', title: 'note.txt' }],
    });
    expect(calls.completeUpload[0].thread_ts).toBeUndefined();
    expect(result.externalId).toBe('F999');
  });

  it('routes the upload into a thread when the anchor is a reply', async () => {
    const { client, calls } = makeMockClient();
    await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'reply', channelId: 'C123', threadTs: '111.222' },
      fields: {
        text: 'caption',
        file: { name: 'note.txt', contentType: 'text/plain', content: 'file body' },
      },
    });
    expect(calls.completeUpload[0]).toMatchObject({ thread_ts: '111.222' });
  });

  it('omits initial_comment when the write carries a file but no text', async () => {
    const { client, calls } = makeMockClient();
    await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { file: { name: 'note.txt', contentType: 'text/plain', content: 'body' } },
    });
    expect(calls.completeUpload[0]).not.toHaveProperty('initial_comment');
  });
});

// ── 6. at-least-one-of Message / File / Blocks ────────────────────────────────

describe('createUnifiedMessage — at-least-one', () => {
  it('rejects a write with none of Message / File / Blocks', async () => {
    const { client } = makeMockClient();
    await expect(
      createUnifiedMessage({ client, teamId: TEAM_ID, anchor: { kind: 'post', channelId: 'C123' }, fields: {} }),
    ).rejects.toThrow(/at least one of Message \/ File \/ Blocks/);
  });

  it('rejects a write whose Blocks is an empty list too — an empty list means unset', async () => {
    const { client } = makeMockClient();
    await expect(
      createUnifiedMessage({
        client,
        teamId: TEAM_ID,
        anchor: { kind: 'post', channelId: 'C123' },
        fields: { blocks: [] },
      }),
    ).rejects.toThrow(/at least one of Message \/ File \/ Blocks/);
  });
});

// ── 7. SlackAdapter.createRecord — anchor resolution ─────────────────────────

describe('SlackAdapter.createRecord — anchor resolution', () => {
  function withClient(opts?: Parameters<typeof makeMockClient>[0]) {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    const { client, calls } = makeMockClient(opts);
    jest
      .spyOn(adapter as unknown as { getSlackApiClient: () => Promise<SlackClient> }, 'getSlackApiClient')
      .mockResolvedValue(client);
    return { adapter, client, calls };
  }

  it('a Channel `messages` parent posts to that channel', async () => {
    const { adapter, calls } = withClient({ postTs: '555.666' });
    const result = await adapter.createRecord({
      recordType: 'Message',
      fields: { Message: 'dispatched' },
      parentLinks: [{ recordType: 'Channel', externalId: 'C123', edgeName: 'Messages' }],
      mutationContext,
    });
    expect(result.externalId).toBe('555.666');
    expect(calls.postMessage[0]).toMatchObject({ channel: 'C123', text: 'dispatched' });
    expect(calls.postMessage[0].thread_ts).toBeUndefined();
  });

  it('a Message `replies` parent replies into its thread', async () => {
    const { adapter, calls } = withClient();
    await adapter.createRecord({
      recordType: 'Message',
      fields: { Message: 'a reply' },
      parentLinks: [
        { recordType: 'Message', externalId: '111.222', edgeName: 'Replies', data: { channel: 'C123' } },
      ],
      mutationContext,
    });
    expect(calls.postMessage[0]).toMatchObject({ channel: 'C123', thread_ts: '111.222' });
  });

  it('rejects a write with no parent (there is no top-level create)', async () => {
    const { adapter } = withClient();
    await expect(
      adapter.createRecord({
        recordType: 'Message',
        fields: { Message: 'orphan' },
        mutationContext,
      }),
    ).rejects.toThrow(/along an edge/);
  });

  it('rejects a Channel parent along a non-messages edge', async () => {
    const { adapter } = withClient();
    await expect(
      adapter.createRecord({
        recordType: 'Message',
        fields: { Message: 'x' },
        parentLinks: [{ recordType: 'Channel', externalId: 'C123', edgeName: 'members' }],
        mutationContext,
      }),
    ).rejects.toThrow(/cannot be created along/);
  });

  it('rejects a User parent', async () => {
    const { adapter } = withClient();
    await expect(
      adapter.createRecord({
        recordType: 'Message',
        fields: { Message: 'x' },
        parentLinks: [{ recordType: 'User', externalId: 'U1', edgeName: 'Messages' }],
        mutationContext,
      }),
    ).rejects.toThrow(/cannot be created along/);
  });
});

// ── 7b. Blocks — verbatim Block Kit passthrough ───────────────────────────────

describe('createUnifiedMessage — Blocks', () => {
  const EXAMPLE_BLOCKS = [
    { type: 'section', text: { type: 'mrkdwn', text: '*New deal*' } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          value: 'https://api/asks/ask_x?answer=true',
        },
        {
          type: 'static_select',
          placeholder: { type: 'plain_text', text: 'Tier' },
          options: [{ text: { type: 'plain_text', text: 'Seed' }, value: 'https://api/asks/ask_x?answer=Seed' }],
        },
      ],
    },
  ];

  it('posts the author\'s blocks VERBATIM — no reshaping, no wrapping', async () => {
    const { client, calls } = makeMockClient();
    await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { text: 'New deal', blocks: EXAMPLE_BLOCKS },
    });
    expect(calls.postMessage[0].blocks).toEqual(EXAMPLE_BLOCKS);
  });

  it('rides Message as the notification-fallback `text` alongside Blocks', async () => {
    const { client, calls } = makeMockClient();
    await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { text: 'New deal', blocks: EXAMPLE_BLOCKS },
    });
    expect(calls.postMessage[0].text).toBe('New deal');
  });

  it('omits `text` entirely when Blocks is set with no Message — Slack accepts blocks-only', async () => {
    const { client, calls } = makeMockClient();
    await createUnifiedMessage({
      client,
      teamId: TEAM_ID,
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { blocks: EXAMPLE_BLOCKS },
    });
    expect(calls.postMessage[0]).not.toHaveProperty('text');
    expect(calls.postMessage[0].blocks).toEqual(EXAMPLE_BLOCKS);
  });

  it('is LOUD, not silent, when Blocks is not a list (the scalar-projection class of bug)', async () => {
    const { client } = makeMockClient();
    await expect(
      createUnifiedMessage({
        client,
        teamId: TEAM_ID,
        anchor: { kind: 'post', channelId: 'C123' },
        fields: { text: 'x', blocks: 'not a list' },
      }),
    ).rejects.toThrow(
      'SlackAdapter.createRecord: Blocks must be a LIST of Block Kit block objects, got the string "not a list".',
    );
  });

  it('is LOUD when a list entry is not an object', () => {
    const { client } = makeMockClient();
    return expect(
      createUnifiedMessage({
        client,
        teamId: TEAM_ID,
        anchor: { kind: 'post', channelId: 'C123' },
        fields: { text: 'x', blocks: [{ type: 'section' }, 'not a block'] },
      }),
    ).rejects.toThrow(/Blocks must be a LIST of Block Kit block objects — found the string "not a block"/);
  });

  it('File AND Blocks both present is a loud clash, mirroring the checker\'s writeUnion wording', async () => {
    const { client } = makeMockClient();
    await expect(
      createUnifiedMessage({
        client,
        teamId: TEAM_ID,
        anchor: { kind: 'post', channelId: 'C123' },
        fields: {
          file: { name: 'note.txt', contentType: 'text/plain', content: 'body' },
          blocks: EXAMPLE_BLOCKS,
        },
      }),
    ).rejects.toThrow(
      "a Slack Message is either a file post (Message, File) or an interactive post (Message, Blocks) — File and Blocks can't both be set.",
    );
  });

  it('surfaces Slack\'s invalid_blocks response_metadata.messages verbatim in the run error', async () => {
    const platformError = Object.assign(new Error('An API error occurred: invalid_blocks'), {
      code: 'slack_webapi_platform_error',
      data: {
        ok: false,
        error: 'invalid_blocks',
        response_metadata: { messages: ['[ERROR] invalid blocks: element type option is unknown'] },
      },
    });
    const { client } = makeMockClient({ postMessage: () => Promise.reject(platformError) });
    await expect(
      createUnifiedMessage({
        client,
        teamId: TEAM_ID,
        anchor: { kind: 'post', channelId: 'C123' },
        fields: { blocks: EXAMPLE_BLOCKS },
      }),
    ).rejects.toThrow(
      'SlackAdapter.createRecord: Slack rejected the post (invalid_blocks) — [ERROR] invalid blocks: element type option is unknown',
    );
  });
});

// ── 8. update / delete: unsupported, no recordType guard ─────────────────────

describe('SlackAdapter — update / delete unsupported', () => {
  it('updateRecord rejects unconditionally', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    await expect(
      adapter.updateRecord({
        recordType: 'anything',
        externalId: '111.222',
        fields: { Message: 'edit' },
        mutationContext,
      }),
    ).rejects.toThrow(/not updatable/);
  });

  it('deleteRecord rejects unconditionally', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    await expect(
      adapter.deleteRecord({
        recordType: 'anything',
        externalId: '111.222',
        mutationContext,
      }),
    ).rejects.toThrow(/not deletable/);
  });
});

// ── 9. Reactions — the write-only emoji edge ─────────────────────────────────

/** `already_reacted` as `@slack/web-api` raises it: a rejection carrying
 *  Slack's own code on `.data.error`. */
function alreadyReacted(): Error {
  return Object.assign(new Error('An API error occurred: already_reacted'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'already_reacted' },
  });
}

describe('SlackAdapter — the Reactions edge on a Message', () => {
  it('declares Reactions writable, NOT readable, and pointing at the Reaction type', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_MESSAGE_TYPE_ID);
    const reactions = desc!.references!.find((r) => r.name === 'Reactions')!;
    expect(reactions.writable).toBe(true);
    expect(reactions.readable).toBe(false);
    expect(reactions.targetTypeId).toBe(SLACK_REACTION_TYPE_ID);
    expect(reactions.cardinality).toBe('many');
  });

  it('Emoji is the ONE writable field on a Reaction — the rest stay read-only', async () => {
    const adapter = new SlackAdapter(TEAM_ID);
    const desc = await adapter.describe(SLACK_REACTION_TYPE_ID);
    const byId = new Map(desc!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('emoji')).toMatchObject({
      displayName: 'Emoji',
      kind: 'string',
      writable: true,
      required: true,
    });
    expect(desc!.fields.filter((f) => f.writable).map((f) => f.fieldId)).toEqual(['emoji']);
  });
});

describe('reactionAnchorFromParent', () => {
  it('splits a composite `channelId:ts` externalId (traversed history parent)', () => {
    expect(reactionAnchorFromParent({ externalId: 'C123:111.222' })).toEqual({
      channelId: 'C123',
      ts: '111.222',
    });
  });

  it('reads the channel off the parent data when the id is a bare ts', () => {
    expect(
      reactionAnchorFromParent({ externalId: '111.222', data: { channel: 'C9' } }),
    ).toEqual({ channelId: 'C9', ts: '111.222' });
  });

  it('sticks to the parent`s OWN ts — a reaction on a thread reply is not on the root', () => {
    expect(
      reactionAnchorFromParent({
        externalId: '333.444',
        data: { channel: 'C9', thread_ts: '111.222' },
      }).ts,
    ).toBe('333.444');
  });
});

describe('addReaction', () => {
  it('calls reactions.add with the anchor`s channel + ts and the emoji name', async () => {
    const { client, calls } = makeMockClient();
    const result = await addReaction({
      client,
      anchor: { channelId: 'C123', ts: '111.222' },
      fields: { emoji: 'thumbsup' },
    });
    expect(calls.reactionsAdd).toHaveLength(1);
    expect(calls.reactionsAdd[0]).toEqual({
      channel: 'C123',
      timestamp: '111.222',
      name: 'thumbsup',
    });
    expect(result.externalId).toBe('reaction:C123:111.222:thumbsup');
    expect(result.data).toMatchObject({
      reaction: 'thumbsup',
      item: { type: 'message', channel: 'C123', ts: '111.222' },
    });
  });

  it('joins the channel first when the bot is not a member', async () => {
    const { client, calls } = makeMockClient({ isMember: false });
    await addReaction({
      client,
      anchor: { channelId: 'C123', ts: '111.222' },
      fields: { emoji: 'eyes' },
    });
    expect(calls.conversationsJoin[0]).toMatchObject({ channel: 'C123' });
  });

  it('strips the colons an author copies out of Slack', async () => {
    const { client, calls } = makeMockClient();
    await addReaction({
      client,
      anchor: { channelId: 'C123', ts: '111.222' },
      fields: { emoji: ':eyes:' },
    });
    expect(calls.reactionsAdd[0].name).toBe('eyes');
  });

  it('treats already_reacted as a no-op success — the asked-for state is the state', async () => {
    const { client } = makeMockClient({ reactionsAdd: () => Promise.reject(alreadyReacted()) });
    const result = await addReaction({
      client,
      anchor: { channelId: 'C123', ts: '111.222' },
      fields: { emoji: 'thumbsup' },
    });
    expect(result.externalId).toBe('reaction:C123:111.222:thumbsup');
  });

  it('lets every OTHER Slack error through', async () => {
    const notInChannel = Object.assign(new Error('An API error occurred: not_in_channel'), {
      data: { ok: false, error: 'not_in_channel' },
    });
    const { client } = makeMockClient({ reactionsAdd: () => Promise.reject(notInChannel) });
    await expect(
      addReaction({
        client,
        anchor: { channelId: 'C123', ts: '111.222' },
        fields: { emoji: 'thumbsup' },
      }),
    ).rejects.toThrow(/not_in_channel/);
  });

  it('rejects a write with no Emoji', async () => {
    const { client } = makeMockClient();
    await expect(
      addReaction({ client, anchor: { channelId: 'C123', ts: '111.222' }, fields: {} }),
    ).rejects.toThrow(/the "Emoji" field must carry an emoji name/);
  });
});

describe('SlackAdapter.createRecord — Reactions anchor', () => {
  function withClient(opts?: Parameters<typeof makeMockClient>[0]) {
    const adapter = new SlackAdapter(TEAM_ID, 'cred-1');
    const { client, calls } = makeMockClient(opts);
    jest
      .spyOn(adapter as unknown as { getSlackApiClient: () => Promise<SlackClient> }, 'getSlackApiClient')
      .mockResolvedValue(client);
    return { adapter, calls };
  }

  it('a Message `Reactions` parent reacts to that message, not to its thread root', async () => {
    const { adapter, calls } = withClient();
    const result = await adapter.createRecord({
      recordType: 'Reaction',
      fields: { Emoji: 'eyes' },
      parentLinks: [
        {
          recordType: 'Message',
          externalId: '333.444',
          edgeName: 'Reactions',
          data: { channel: 'C123', thread_ts: '111.222' },
        },
      ],
      mutationContext,
    });
    expect(calls.postMessage).toHaveLength(0);
    expect(calls.reactionsAdd[0]).toEqual({
      channel: 'C123',
      timestamp: '333.444',
      name: 'eyes',
    });
    expect(result.externalId).toBe('reaction:C123:333.444:eyes');
  });

  it('reacts to a message traversed off a channel`s history (composite id, no data)', async () => {
    const { adapter, calls } = withClient();
    await adapter.createRecord({
      recordType: 'Reaction',
      fields: { Emoji: 'thumbsup' },
      parentLinks: [{ recordType: 'Message', externalId: 'C777:999.111', edgeName: 'Reactions' }],
      mutationContext,
    });
    expect(calls.reactionsAdd[0]).toMatchObject({ channel: 'C777', timestamp: '999.111' });
  });

  it('rejects a Reaction with no parent — there is no top-level react', async () => {
    const { adapter } = withClient();
    await expect(
      adapter.createRecord({
        recordType: 'Reaction',
        fields: { Emoji: 'eyes' },
        mutationContext,
      }),
    ).rejects.toThrow(/along an edge/);
  });

  it('rejects a Reaction anchored off a Channel', async () => {
    const { adapter } = withClient();
    await expect(
      adapter.createRecord({
        recordType: 'Reaction',
        fields: { Emoji: 'eyes' },
        parentLinks: [{ recordType: 'Channel', externalId: 'C123', edgeName: 'Reactions' }],
        mutationContext,
      }),
    ).rejects.toThrow(/cannot be created along/);
  });

  it('rejects a Reactions parent that carries no channel', async () => {
    const { adapter } = withClient();
    await expect(
      adapter.createRecord({
        recordType: 'Reaction',
        fields: { Emoji: 'eyes' },
        parentLinks: [{ recordType: 'Message', externalId: '111.222', edgeName: 'Reactions' }],
        mutationContext,
      }),
    ).rejects.toThrow(/the parent message carries no channel/);
  });
});
