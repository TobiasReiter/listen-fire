/**
 * Unit tests for write-time mention resolution + the mrkdwn safety net (C8).
 *
 * The pure matcher (`matchMember`/`resolveMentions`) and `normalizeMrkdwn` are
 * exercised directly; `finalizeMessageText` and a full `createUnifiedMessage`
 * post confirm the wiring resolves `@[Name]` → `<@id>` against a channel
 * roster and degrades safely when the roster can't be fetched.
 */

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { getSlackClient } from '../../../adapters/slack/webApi/apiClient';
import type { SlackWriteHost } from '@listen-fire/slack/write';

import {
  matchMember,
  resolveMentions,
  stripMentionMarkup,
  normalizeMrkdwn,
  finalizeMessageText,
  type RosterMember,
} from '@listen-fire/slack/mentions';
import { createUnifiedMessage } from '@listen-fire/slack/write';


type SlackClient = ReturnType<typeof getSlackClient>;


/** What a write reaches beyond Slack, for these tests: the mock client's
 *  `fetch` stands in for the host's, and no file is redeemed. */
function hostOf(client: unknown): SlackWriteHost {
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    log: quiet,
    fetch: ((url: unknown, init: unknown) => (client as { fetch(u: unknown, i: unknown): Promise<Response> }).fetch(url, init)) as typeof fetch,
    readFile: async () => {
      throw new Error('no file is redeemed in this test');
    },
  };
}

const ROSTER: RosterMember[] = [
  { id: 'U_FRANK', names: ['frank', 'Frank Smith'] },
  { id: 'U_ADA', names: ['ada', 'Ada Okafor'] },
];

describe('matchMember / resolveMentions — fuzzy, bidirectional', () => {
  it('matches a first name, a last name, and the full name', () => {
    expect(matchMember('frank', ROSTER)).toBe('U_FRANK');
    expect(matchMember('Smith', ROSTER)).toBe('U_FRANK');
    expect(matchMember('frank smith', ROSTER)).toBe('U_FRANK');
  });

  it('matches when the member name is a subset of the query (member ⊆ query)', () => {
    const roster: RosterMember[] = [{ id: 'U_F', names: ['Frank'] }];
    expect(matchMember('Frank Smith', roster)).toBe('U_F');
  });

  it('exact match outranks a subset match', () => {
    const roster: RosterMember[] = [
      { id: 'U_FS', names: ['Frank Smith'] },
      { id: 'U_F', names: ['Frank'] },
    ];
    expect(matchMember('Frank', roster)).toBe('U_F'); // exact beats query⊆member
  });

  it('picks the first member in roster order on a tie', () => {
    const roster: RosterMember[] = [
      { id: 'U1', names: ['Frank Smith'] },
      { id: 'U2', names: ['Frank Jones'] },
    ];
    expect(matchMember('Frank', roster)).toBe('U1');
  });

  it('returns null for a name nobody matches', () => {
    expect(matchMember('Zoe', ROSTER)).toBeNull();
  });

  it('rewrites tokens: matched → <@id>, unmatched → plain text', () => {
    expect(resolveMentions('hey @[frank], welcome', ROSTER)).toBe('hey <@U_FRANK>, welcome');
    expect(resolveMentions('cc @[Zoe Quinn]', ROSTER)).toBe('cc Zoe Quinn');
    expect(resolveMentions('@[frank] & @[Ada Okafor]', ROSTER)).toBe(
      '<@U_FRANK> & <@U_ADA>',
    );
  });

  it('an empty roster degrades every token to plain text', () => {
    expect(resolveMentions('ping @[frank]', [])).toBe('ping frank');
  });
});

describe('normalizeMrkdwn + stripMentionMarkup', () => {
  it('down-converts markdown bold, links, and headings', () => {
    expect(normalizeMrkdwn('a **bold** word')).toBe('a *bold* word');
    expect(normalizeMrkdwn('see [Acme](https://acme.com)')).toBe('see <https://acme.com|Acme>');
    expect(normalizeMrkdwn('## Title\nbody')).toBe('Title\nbody');
  });

  it('strips @[Name] markup to the plain inner name', () => {
    expect(stripMentionMarkup('hi @[Frank Smith]!')).toBe('hi Frank Smith!');
  });
});

// ── Roster-aware mock client ────────────────────────────────────────────────

function makeRosterClient(opts?: { failRoster?: boolean }): { client: SlackClient; posts: unknown[] } {
  const posts: unknown[] = [];
  const client = {
    api: {
      conversations: {
        info: async () => ({ channel: { is_member: true } }),
        members: async () => {
          if (opts?.failRoster) throw new Error('boom');
          return { members: ['U_FRANK', 'U_ADA'] };
        },
      },
      users: {
        list: async () => ({
          members: [
            { id: 'U_FRANK', name: 'frank', real_name: 'Frank Smith', deleted: false, is_bot: false },
            { id: 'U_ADA', name: 'ada', real_name: 'Ada Okafor', deleted: false, is_bot: false },
            { id: 'U_BOT', name: 'bot', real_name: 'Bot', deleted: false, is_bot: true },
          ],
        }),
      },
      chat: {
        postMessage: async (args: unknown) => {
          posts.push(args);
          return { ok: true, ts: '1700000000.000999' };
        },
      },
    },
  } as unknown as SlackClient;
  return { client, posts };
}

describe('finalizeMessageText', () => {
  it('resolves mentions against the channel roster', async () => {
    const { client } = makeRosterClient();
    const out = await finalizeMessageText({ client, log: hostOf(client).log, channelId: 'C1', text: 'hi @[frank]' });
    expect(out).toBe('hi <@U_FRANK>');
  });

  it('skips the roster fetch when there are no mention tokens', async () => {
    let fetched = false;
    const client = {
      api: { users: { list: async () => { fetched = true; return { members: [] }; } } },
    } as unknown as SlackClient;
    const out = await finalizeMessageText({ client, log: hostOf(client).log, channelId: 'C1', text: 'plain **bold**' });
    expect(out).toBe('plain *bold*');
    expect(fetched).toBe(false);
  });

  it('degrades to plain text when the roster fetch fails', async () => {
    const { client } = makeRosterClient({ failRoster: true });
    const out = await finalizeMessageText({ client, log: hostOf(client).log, channelId: 'C1', text: 'hi @[frank]' });
    expect(out).toBe('hi frank');
  });
});

describe('createUnifiedMessage — posts resolved text', () => {
  it('a post resolves @[Name] mentions before posting', async () => {
    const { client, posts } = makeRosterClient();
    await createUnifiedMessage({
      client,
      host: hostOf(client),
      anchor: { kind: 'post', channelId: 'C123' },
      fields: { text: 'welcome @[Frank Smith]!' },
    });
    expect((posts[0] as { text: string }).text).toBe('welcome <@U_FRANK>!');
  });
});
