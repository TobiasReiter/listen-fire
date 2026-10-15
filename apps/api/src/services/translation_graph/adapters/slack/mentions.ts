// Write-time mention resolution + a minimal mrkdwn safety net (C8).
//
// SLACK_MESSAGE composes roster-free, emitting `@[Name]` mention tokens. The
// channel — and therefore the member roster — is only known here, at the write
// boundary, so this is where tokens become real `<@U…>` mentions. Resolution
// is deterministic and channel-scoped:
//
//   • only `conversations.members` are candidates, so a non-member can never be
//     tagged — its token degrades to plain text;
//   • matching is case-insensitive, token-based, and bidirectional, so `frank`,
//     `Smith`, and `frank smith` all resolve to *Frank Smith*, and `Frank
//     Smith` resolves against a member named just *Frank*;
//   • on a tier tie (two equally-good matches) we pick the first in roster
//     order — ambiguous prompting is the author's problem.
//
// C8 / M6 / M7

import type { getSlackClient } from '../../../../adapters/slack/webApi/apiClient';

import { logger } from 'movement-engine/services/logger';

type SlackClient = ReturnType<typeof getSlackClient>;

/** A channel member and the names a mention token may match against. */
export interface RosterMember {
  id: string;
  names: string[];
}

/** `@[Name]` — non-greedy to the first `]`. Names containing `]` aren't
 *  supported (Slack display names don't use it). */
const MENTION_RE = /@\[([^\]]+)\]/g;

function tokenize(value: string): string[] {
  return value.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * Score a query token set against a member token set:
 *   3 — exact (same set)
 *   2 — bidirectional subset (one fully contains the other)
 *   1 — non-empty overlap
 *   0 — no overlap (not a candidate)
 */
function scoreTier(query: Set<string>, member: Set<string>): number {
  if (query.size === member.size && isSubset(query, member)) return 3;
  if (isSubset(query, member) || isSubset(member, query)) return 2;
  for (const t of query) if (member.has(t)) return 1;
  return 0;
}

/**
 * Resolve a single `@[query]` name to a member id, or null if nothing matches.
 * Highest tier wins; ties resolve to the first member in roster order.
 */
export function matchMember(query: string, roster: RosterMember[]): string | null {
  const q = new Set(tokenize(query));
  if (q.size === 0) return null;
  let best: { tier: number; id: string } | null = null;
  for (const member of roster) {
    const mset = new Set<string>();
    for (const name of member.names) for (const t of tokenize(name)) mset.add(t);
    if (mset.size === 0) continue;
    const tier = scoreTier(q, mset);
    // Strictly-better only, so the first member at a given tier wins the tie.
    if (tier > 0 && (!best || tier > best.tier)) best = { tier, id: member.id };
  }
  return best?.id ?? null;
}

/**
 * Rewrite every `@[Name]` token: matched → `<@id>`, unmatched → the plain inner
 * name (brackets stripped). With an empty roster every token degrades to plain
 * text — which is also the fetch-failure path.
 */
export function resolveMentions(text: string, roster: RosterMember[]): string {
  return text.replace(MENTION_RE, (_full, name: string) => {
    const id = matchMember(name, roster);
    return id ? `<@${id}>` : name.trim();
  });
}

/** Strip `@[Name]` markup to the plain inner name — for display labels where
 *  neither a token nor a Slack id is wanted. */
export function stripMentionMarkup(text: string): string {
  return text.replace(MENTION_RE, (_full, name: string) => name.trim());
}

/**
 * Minimal markdown → Slack mrkdwn normaliser (the P6 safety net). Defends
 * against stray markdown the composer's system prompt didn't suppress; it is a
 * backstop, not the mechanism.
 */
export function normalizeMrkdwn(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // **bold** → *bold*
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>') // [t](url) → <url|t>
    .replace(/^#{1,6}[ \t]+/gm, ''); // strip markdown headings
}

async function fetchChannelRoster(client: SlackClient, channelId: string): Promise<RosterMember[]> {
  try {
    const [users, channelMembers] = await Promise.all([
      client.api.users.list({}),
      client.api.conversations.members({ channel: channelId }),
    ]);
    const memberIds = new Set<string>((channelMembers.members ?? []) as string[]);
    return (users.members ?? [])
      .filter((u) => !u.deleted && !u.is_bot && typeof u.id === 'string' && memberIds.has(u.id))
      .map((u) => ({
        id: u.id as string,
        names: [u.name, u.real_name, u.profile?.display_name].filter(
          (n): n is string => typeof n === 'string' && n.length > 0,
        ),
      }));
  } catch (error) {
    logger.warn('[SlackAdapter] failed to fetch channel roster for mention resolution', { error });
    return [];
  }
}

/**
 * Finalise a composed message for posting: resolve `@[Name]` mentions against
 * the channel roster and apply the mrkdwn safety net. The roster is fetched
 * only when the text actually carries mention tokens (the common case posts
 * nothing extra).
 */
export async function finalizeMessageText(input: {
  client: SlackClient;
  channelId: string;
  text: string;
}): Promise<string> {
  const hasMentions = /@\[[^\]]+\]/.test(input.text);
  const roster = hasMentions ? await fetchChannelRoster(input.client, input.channelId) : [];
  return normalizeMrkdwn(resolveMentions(input.text, roster));
}
