// The Slack read graph (positions-and-edges): channels/users are stable
// collections off the meta root; a channel fans into its readable history
// and members; a message fans into its thread (`replies`) and `author`.
// The Slack web client is mocked by overriding the adapter's private
// getter — no network, no DB.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

import {
  checkProgram,
  fromCatalogSnapshot,
  parseProgram,
  type CatalogSnapshot,
} from 'movement-lang';

import type { Expression } from '#shared/expression/types';
import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { isStablePosition, makeMetaPosition, makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { SlackAdapter, SLACK_MANIFEST } from '../index';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';

const TEAM = 'team-1' as TeamId;

const channels = [
  { id: 'C001', name: 'general', topic: { value: 'Chit chat' }, is_private: false },
  { id: 'C002', name: 'dealflow', is_private: false },
];
const users = [
  {
    id: 'U001',
    name: 'ada',
    real_name: 'Ada Okafor',
    profile: { display_name: 'ada', email: 'ada@example.com' },
  },
  { id: 'U009', name: 'oldbot', deleted: true },
];
const history = [
  { ts: '2.0', user: 'U001', text: 'Deal: Acme' },
  { ts: '1.0', user: 'U001', text: 'Older message' },
];
const thread = [
  { ts: '2.0', user: 'U001', text: 'Deal: Acme' },
  { ts: '3.0', user: 'U001', text: 'ARR is 1.2M', thread_ts: '2.0' },
];

function adapterWithMockClient(): { adapter: SlackAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter = new SlackAdapter(TEAM, 'cred-1');
  const client = {
    api: {
      conversations: {
        list: async () => (calls.push('conversations.list'), { channels }),
        history: async (args: { channel: string }) => (
          calls.push(`conversations.history:${args.channel}`), { messages: history }
        ),
        replies: async (args: { channel: string; ts: string }) => (
          calls.push(`conversations.replies:${args.channel}:${args.ts}`), { messages: thread }
        ),
        members: async (args: { channel: string }) => (
          calls.push(`conversations.members:${args.channel}`), { members: ['U001'] }
        ),
        info: async (args: { channel: string }) => {
          calls.push(`conversations.info:${args.channel}`);
          const channel = channels.find((c) => c.id === args.channel);
          return channel ? { channel } : {};
        },
      },
      users: {
        list: async () => (calls.push('users.list'), { members: users }),
        info: async (args: { user: string }) => (
          calls.push(`users.info:${args.user}`), { user: users[0] }
        ),
      },
    },
  };
  (adapter as unknown as { getSlackApiClient: () => Promise<unknown> }).getSlackApiClient =
    async () => client;
  return { adapter, calls };
}

const metaRoot = makeMetaPosition('slack');

describe('Slack read graph', () => {
  it('publishes Channel/User entry points and their descriptors', async () => {
    const { adapter } = adapterWithMockClient();
    const entries = await adapter.listEntryPoints();
    // Root-readable is only what the root can genuinely enumerate — the read
    // graph's Channel/User collections. Messages and files are REACHED
    // (channel history / the event's `record` edge / a message's `files`
    // edge), never listed from the root.
    // plans/2026-07-10-adapter-entry-positions/8_event_edges.md
    const readable = entries.filter((e) => e.readable).map((e) => e.displayName);
    expect(readable).toEqual(expect.arrayContaining(['Channel', 'User']));
    expect(readable).not.toEqual(
      expect.arrayContaining(['Message']),
    );
    const channel = await adapter.describe('Channel');
    expect(channel?.references?.map((r) => r.name)).toEqual(['Messages', 'Members']);
    const message = await adapter.describe('Message');
    expect(message?.references?.map((r) => r.name)).toEqual([
      'Files',
      'Replies',
      'Reactions',
      'Author',
      'Channel',
    ]);
  });

  it('meta → Channels lists stable channel positions; fields read back', async () => {
    const { adapter } = adapterWithMockClient();
    const landed = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Channels',
      direction: 'outgoing',
    });
    expect(landed).toHaveLength(2);
    expect(isStablePosition(landed[0].position)).toBe(true);
    expect(
      await adapter.getFieldValue({ position: landed[0].position, fieldId: 'Name' }),
    ).toBe('general');
    expect(
      await adapter.getFieldValue({ position: landed[0].position, fieldId: 'Topic' }),
    ).toBe('Chit chat');
  });

  it('meta → Channels follows Slack pagination cursors so every channel is listed', async () => {
    const calls: string[] = [];
    const adapter = new SlackAdapter(TEAM, 'cred-1');
    const client = {
      api: {
        conversations: {
          list: async (args: { cursor?: string }) => {
            calls.push(`list:${args.cursor ?? 'first'}`);
            return args.cursor === 'CUR2'
              ? { channels: [{ id: 'C900', name: 'public_test', is_private: false }], response_metadata: { next_cursor: '' } }
              : { channels: [{ id: 'C001', name: 'general', is_private: false }], response_metadata: { next_cursor: 'CUR2' } };
          },
        },
      },
    };
    (adapter as unknown as { getSlackApiClient: () => Promise<unknown> }).getSlackApiClient =
      async () => client;

    const landed = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Channels',
      direction: 'outgoing',
    });
    // The next_cursor was followed (a single-page fetch would never request CUR2).
    expect(calls).toContain('list:CUR2');
    const names = await Promise.all(
      landed.map((r) => adapter.getFieldValue({ position: r.position, fieldId: 'Name' })),
    );
    // The page-2 channel is present — not dropped as it was before pagination.
    expect(names).toContain('public_test');
    expect(names).toContain('general');
  });

  it('meta → Users lists members (deleted skipped) with profile fields', async () => {
    const { adapter } = adapterWithMockClient();
    const landed = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Users',
      direction: 'outgoing',
    });
    expect(landed).toHaveLength(1);
    expect(
      await adapter.getFieldValue({ position: landed[0].position, fieldId: 'Email' }),
    ).toBe('ada@example.com');
  });

  it('channel → messages injects the channel id; message → replies excludes the parent', async () => {
    const { adapter, calls } = adapterWithMockClient();
    const [dealflow] = (
      await adapter.getRelated({ position: metaRoot, fieldId: 'Channels', direction: 'outgoing' })
    ).filter(
      (r) => (positionData(r.position) as { name?: string }).name === 'dealflow',
    );
    const messages = await adapter.getRelated({
      position: dealflow.position,
      fieldId: 'Messages',
      direction: 'outgoing',
    });
    expect(calls).toContain('conversations.history:C002');
    expect(messages).toHaveLength(2);
    expect(
      await adapter.getFieldValue({ position: messages[0].position, fieldId: 'Channel' }),
    ).toBe('C002');

    const replies = await adapter.getRelated({
      position: messages[0].position,
      fieldId: 'Replies',
      direction: 'outgoing',
    });
    expect(calls).toContain('conversations.replies:C002:2.0');
    expect(replies).toHaveLength(1);
    expect(
      await adapter.getFieldValue({ position: replies[0].position, fieldId: 'Message' }),
    ).toBe('ARR is 1.2M');
  });

  it('message → author resolves the posting user via users.info', async () => {
    const { adapter, calls } = adapterWithMockClient();
    const [channel] = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Channels',
      direction: 'outgoing',
    });
    const [message] = await adapter.getRelated({
      position: channel.position,
      fieldId: 'Messages',
      direction: 'outgoing',
    });
    const [author] = await adapter.getRelated({
      position: message.position,
      fieldId: 'Author',
      direction: 'outgoing',
    });
    expect(calls).toContain('users.info:U001');
    expect(
      await adapter.getFieldValue({ position: author.position, fieldId: 'Real Name' }),
    ).toBe('Ada Okafor');
  });

  it('message → channel resolves the containing channel via conversations.info', async () => {
    const { adapter, calls } = adapterWithMockClient();
    const [channel] = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Channels',
      direction: 'outgoing',
    });
    const [message] = await adapter.getRelated({
      position: channel.position,
      fieldId: 'Messages',
      direction: 'outgoing',
    });
    const [up] = await adapter.getRelated({
      position: message.position,
      fieldId: 'Channel',
      direction: 'outgoing',
    });
    expect(calls).toContain('conversations.info:C001');
    expect(isStablePosition(up.position)).toBe(true);
    expect(
      await adapter.getFieldValue({ position: up.position, fieldId: 'Name' }),
    ).toBe('general');
  });

  it('message → channel yields nothing when the channel cannot be honestly resolved', async () => {
    const { adapter, calls } = adapterWithMockClient();
    const [channel] = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Channels',
      direction: 'outgoing',
    });
    const [message] = await adapter.getRelated({
      position: channel.position,
      fieldId: 'Messages',
      direction: 'outgoing',
    });
    // Force conversations.info to resolve to no channel — the honest outcome is
    // an empty traversal, not a fabricated bare-id Channel node.
    (positionData(message.position) as { channel?: string }).channel = 'C_GONE';
    const up = await adapter.getRelated({
      position: message.position,
      fieldId: 'Channel',
      direction: 'outgoing',
    });
    expect(calls).toContain('conversations.info:C_GONE');
    expect(up).toHaveLength(0);
  });

  it('channel → members enriches ids from the roster', async () => {
    const { adapter } = adapterWithMockClient();
    const [channel] = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Channels',
      direction: 'outgoing',
    });
    const members = await adapter.getRelated({
      position: channel.position,
      fieldId: 'Members',
      direction: 'outgoing',
    });
    expect(members).toHaveLength(1);
    expect(
      await adapter.getFieldValue({ position: members[0].position, fieldId: 'Name' }),
    ).toBe('ada');
  });
});

describe('Slack reactions', () => {
  const reaction = () =>
    makeStablePosition({
      adapterType: 'slack',
      recordType: 'Reaction',
      recordId: 'rx-1',
      data: {
        type: 'reaction_added',
        user: 'U001',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C001', ts: '2.0' },
        item_user: 'U001',
      },
    });

  it('publishes the reaction event type, its fields, and its three edges', async () => {
    const { adapter } = adapterWithMockClient();
    const types = await adapter.listEventTypes();
    expect(types.map((t) => t.positionType)).toContain('slack:reaction');
    const descriptor = await adapter.describe('Reaction');
    expect(descriptor?.fields.map((f) => f.displayName)).toEqual(['Emoji', 'Channel', 'Reactor']);
    expect(descriptor?.references?.map((r) => r.name)).toEqual(['Message', 'Channel', 'Reactor']);
  });

  it('reads the reaction scalars — emoji / Channel / Reactor (no ts field)', async () => {
    const { adapter } = adapterWithMockClient();
    const rx = reaction();
    expect(await adapter.getFieldValue({ position: rx, fieldId: 'Emoji' })).toBe('thumbsup');
    expect(await adapter.getFieldValue({ position: rx, fieldId: 'Channel' })).toBe('C001');
    expect(await adapter.getFieldValue({ position: rx, fieldId: 'Reactor' })).toBe('U001');
  });

  it('resolves the channel, reactor, and reacted message edges', async () => {
    const { adapter, calls } = adapterWithMockClient();
    const rx = reaction();

    const [ch] = await adapter.getRelated({ position: rx, fieldId: 'Channel', direction: 'outgoing' });
    expect(await adapter.getFieldValue({ position: ch.position, fieldId: 'Name' })).toBe('general');

    const [user] = await adapter.getRelated({ position: rx, fieldId: 'Reactor', direction: 'outgoing' });
    expect(calls).toContain('users.info:U001');
    expect(
      await adapter.getFieldValue({ position: user.position, fieldId: 'Real Name' }),
    ).toBe('Ada Okafor');

    const [msg] = await adapter.getRelated({ position: rx, fieldId: 'Message', direction: 'outgoing' });
    expect(msg.position.recordType).toBe('Message');
    expect(
      await adapter.getFieldValue({ position: msg.position, fieldId: 'Message' }),
    ).toBe('Deal: Acme');
  });

  it('reaction → message yields nothing when the reacted item carries no ts', async () => {
    const { adapter } = adapterWithMockClient();
    const rx = makeStablePosition({
      adapterType: 'slack',
      recordType: 'Reaction',
      recordId: 'rx-2',
      data: { type: 'reaction_added', user: 'U001', reaction: 'eyes', item: { channel: 'C001' } },
    });
    const out = await adapter.getRelated({ position: rx, fieldId: 'Message', direction: 'outgoing' });
    expect(out).toEqual([]);
  });
});

describe('the write promises reach the CHECKER projection, not just describe()', () => {
  // Layer 13: an edge's `writable` is EXPLICIT — absent means read-only. Slack
  // writes along exactly three edges (`createRecord`: a Channel's `messages`, a
  // message's `replies`, and a message's `reactions`); every other edge is a
  // read the API serves, so this pins BOTH halves at the checker's currency,
  // not just the descriptor.
  async function project() {
    const { adapter } = adapterWithMockClient();
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    return instanceSchemaFromDescriptors({
      adapterType: 'slack',
      entries,
      descriptors,
      supportsInPlaceUpdate: false,
    });
  }

  it('the three real write paths are writable at the checker', async () => {
    const projection = await project();
    expect(projection.schema.positions.Channel!.edges.Messages).toMatchObject({
      target: 'Message',
      writable: true,
    });
    expect(projection.schema.positions.Message!.edges.Replies).toMatchObject({
      target: 'Message',
      writable: true,
    });
    // Write-only: the read side would need a `reactions.get` per message, so
    // the projection must carry the refusal, not just the write promise.
    expect(projection.schema.positions.Message!.edges.Reactions).toMatchObject({
      target: 'Reaction',
      writable: true,
      readable: false,
    });
  });

  it('every other edge carries NO write promise', async () => {
    const projection = await project();
    const readOnly: Array<[string, string]> = [
      ['Channel', 'Members'],
      ['Message', 'Files'],
      ['Message', 'Author'],
      ['Message', 'Channel'],
      ['Reaction', 'Message'],
      ['Reaction', 'Channel'],
      ['Reaction', 'Reactor'],
    ];
    for (const [position, edge] of readOnly) {
      const ref = projection.schema.positions[position]!.edges[edge];
      expect(ref).toBeDefined();
      expect(ref!.writable).not.toBe(true);
    }
  });
});

// The `Messages` hop's WHERE is a time bound Slack itself can answer, so the
// adapter turns it into a `conversations.history` window instead of taking the
// newest 200 and filtering them in memory.
describe('Slack channel history pushdown', () => {
  const dealflow = { id: 'C002', name: 'dealflow', topic: null, is_private: false };

  function historyAdapter(pages = 1): {
    adapter: SlackAdapter;
    historyCalls: Array<Record<string, unknown>>;
  } {
    const historyCalls: Array<Record<string, unknown>> = [];
    const adapter = new SlackAdapter(TEAM, 'cred-1');
    const client = {
      api: {
        conversations: {
          list: async () => ({ channels: [dealflow] }),
          history: async (args: Record<string, unknown>) => {
            historyCalls.push(args);
            const page = historyCalls.length;
            return {
              messages: [{ ts: `${1786579200 + page}.000000`, user: 'U001', text: `page ${page}` }],
              response_metadata: { next_cursor: page < pages ? `CUR${page + 1}` : '' },
            };
          },
        },
      },
    };
    (adapter as unknown as { getSlackApiClient: () => Promise<unknown> }).getSlackApiClient =
      async () => client;
    return { adapter, historyCalls };
  }

  async function channelPosition(adapter: SlackAdapter) {
    const [channel] = await adapter.getRelated({
      position: metaRoot,
      fieldId: 'Channels',
      direction: 'outgoing',
    });
    return channel.position;
  }

  const timestampAfter = (iso: string): Expression => ({
    type: 'compare',
    op: 'gt',
    left: { type: 'property', propertyTypeId: 'Timestamp' },
    right: { type: 'static', value: iso },
  });

  it('an unfiltered walk stays one page of 200 — no window, no cursor chasing', async () => {
    const { adapter, historyCalls } = historyAdapter(3);
    const messages = await adapter.getRelated({
      position: await channelPosition(adapter),
      fieldId: 'Messages',
      direction: 'outgoing',
    });
    expect(historyCalls).toEqual([{ channel: 'C002', limit: 200 }]);
    expect(messages).toHaveLength(1);
  });

  it('`WHERE Timestamp > <instant>` becomes Slack `oldest`, and the cursor is followed to the bound', async () => {
    const { adapter, historyCalls } = historyAdapter(3);
    const messages = await adapter.getRelated({
      position: await channelPosition(adapter),
      fieldId: 'Messages',
      direction: 'outgoing',
      where: timestampAfter('2026-08-13T00:00:00.000Z'),
    });
    expect(historyCalls[0]).toMatchObject({ channel: 'C002', limit: 200, oldest: '1786579200.000000' });
    expect(historyCalls[0]).not.toHaveProperty('latest');
    expect(historyCalls.map((c) => c.cursor)).toEqual([undefined, 'CUR2', 'CUR3']);
    expect(messages).toHaveLength(3);
  });

  it('`WHERE Timestamp WITHIN 7d` becomes an `oldest` seven days back', async () => {
    const { adapter, historyCalls } = historyAdapter();
    await adapter.getRelated({
      position: await channelPosition(adapter),
      fieldId: 'Messages',
      direction: 'outgoing',
      where: {
        type: 'compare',
        op: 'within',
        left: { type: 'property', propertyTypeId: 'Timestamp' },
        right: { type: 'static', value: '7d' },
      },
    });
    const oldest = Number(historyCalls[0].oldest);
    expect(oldest * 1000).toBeCloseTo(Date.now() - 7 * 86_400_000, -4);
  });

  it('a hop LIMIT caps the paging when Slack’s newest-first order is the one asked for', async () => {
    const { adapter, historyCalls } = historyAdapter(3);
    const messages = await adapter.getRelated({
      position: await channelPosition(adapter),
      fieldId: 'Messages',
      direction: 'outgoing',
      where: timestampAfter('2026-08-13T00:00:00.000Z'),
      orderBy: { fieldId: 'Timestamp', direction: 'desc' },
      limit: 1,
    });
    expect(historyCalls).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it('a LIMIT under the OPPOSITE order never truncates — the oldest N are not the ones Slack hands back first', async () => {
    const { adapter, historyCalls } = historyAdapter(3);
    const messages = await adapter.getRelated({
      position: await channelPosition(adapter),
      fieldId: 'Messages',
      direction: 'outgoing',
      where: timestampAfter('2026-08-13T00:00:00.000Z'),
      orderBy: { fieldId: 'Timestamp', direction: 'asc' },
      limit: 1,
    });
    expect(historyCalls).toHaveLength(3);
    expect(messages).toHaveLength(3);
  });

  it('the Timestamp field reads as an instant and publishes what Slack can filter it by', async () => {
    const { adapter } = historyAdapter();
    const [message] = await adapter.getRelated({
      position: await channelPosition(adapter),
      fieldId: 'Messages',
      direction: 'outgoing',
    });
    expect(await adapter.getFieldValue({ position: message.position, fieldId: 'Timestamp' })).toBe(
      '2026-08-13T00:00:01.000Z',
    );
    const descriptor = await adapter.describe('Message');
    const timestamp = descriptor?.fields.find((f) => f.displayName === 'Timestamp');
    expect(timestamp?.kind).toBe('date');
    expect(timestamp?.capability?.filterOperators).toEqual(['gt', 'gte', 'lt', 'lte', 'within']);
    const channel = await adapter.describe('Channel');
    expect(channel?.references?.find((r) => r.name === 'Messages')?.capability).toEqual({
      filter: 'bounded',
      order: 'bounded',
      supportsLimit: true,
      // Newest first is what `conversations.history` answers — the one order
      // whose LIMIT may bound the page.
      naturalOrder: { field: 'Timestamp', direction: 'desc' },
    });
  });
});

// ── The reaction write, through the REAL checker ─────────────────────────────
//
// The descriptor and the projection are only half the promise: what an author
// actually meets is the checker, over the catalog a save builds. So this runs
// the REAL adapter (listEntryPoints + describe) through the REAL projection and
// then through `checkProgram` — the same three layers a save walks — for both
// the way a movement gets a message (a listened event, and a channel's history)
// and for the two refusals that keep the edge honest.
//
// movement-lang's own jest is broken locally, so the language layer is
// exercised through apps/api's ts-jest (per repo convention).
describe('write msg-[:Reactions]-> reaches the checker', () => {
  async function slackSnapshot(): Promise<CatalogSnapshot> {
    const { adapter } = adapterWithMockClient();
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const { schema } = instanceSchemaFromDescriptors({
      adapterType: 'slack',
      entries,
      descriptors,
      supportsInPlaceUpdate: false,
    });
    return {
      adapters: {
        slack: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          canFire: true,
          triggerConfig: ['events', ...(SLACK_MANIFEST.listenConfig ?? []).map((c) => c.key)],
          triggerConfigOptions: { events: [...SLACK_MANIFEST.subscribableEvents!] },
          schemas: { team_workspace: schema },
        },
      },
      credentials: { team_workspace: { adapters: ['slack'] } },
      plugins: {},
    };
  }

  const PRELUDE = `import { slack } from adapters
import { team_workspace } from credentials

chat = connect slack using team_workspace
`;

  async function errorsFor(source: string): Promise<Array<{ code: string; message: string }>> {
    return checkProgram(parseProgram(`${PRELUDE}\n${source}`), fromCatalogSnapshot(await slackSnapshot()))
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => ({ code: d.code, message: d.message }));
  }

  const LISTENED = (body: string) => `function react(e: <chat-[:Message]->>) {
${body}
}

listen to chat { events: ["app_mention"] } fire react`;

  it('reacts to the message a listen handed the movement', async () => {
    expect(await errorsFor(LISTENED('  write e-[:`Reactions`]-> { Emoji: "eyes" }'))).toEqual([]);
  });

  it('reacts to a message read out of a channel`s history', async () => {
    expect(
      await errorsFor(`function sweep() {
  chat-[ch:\`Channels\` WHERE ch.\`Name\` == "dealflow"]-> {
    ch-[m:\`Messages\`]-> {
      write m-[:\`Reactions\`]-> { Emoji: "thumbsup" }
    }
  }
}`),
    ).toEqual([]);
  });

  it('a made-up field on the reaction is still MOV_WRITE_UNKNOWN_FIELD', async () => {
    const found = await errorsFor(
      LISTENED('  write e-[:`Reactions`]-> { Emoji: "eyes", Sparkle: "yes" }'),
    );
    expect(found.map((d) => d.code)).toContain('MOV_WRITE_UNKNOWN_FIELD');
  });

  it('READING the edge is refused — it is write-only, not silently empty', async () => {
    const found = await errorsFor(LISTENED('  e-[r:`Reactions`]-> { }'));
    expect(found.map((d) => d.code)).toContain('MOV_WRITE_ONLY_EDGE');
  });
});
