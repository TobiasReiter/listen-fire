// Slack's read graph (2026-07-05) — the positions-and-edges model applied
// to Slack (plans/2026-07-05-sheets-graph-topology/1_positions_and_edges.md):
//
//   meta ─[Channels]→ Channel ─[Messages]→ Message ─[Replies]→ Message
//        └[Users]───→ User    └[Members]─→ User     └[Author]─→ User
//
// `Channel ─[Messages]→ Message` is creatable — a post writes along it;
// `msg-[Replies]→` likewise. A create along either edge is a real Slack post.
//                                                    └[Files]──→ File
//
// Channels and users are STABLE nouns (C…/U… ids) → stable positions,
// homogeneous collections off the meta root, selected with WHERE
// (`slk-[c:Channels WHERE \`Name\` == "dealflow"]->`). Threads are NOT a
// type: a thread is the `Replies` edge off its parent message. Everything
// here is the pure half — type ids, descriptors, entry points, and payload
// normalizers; the client-backed reads live on the adapter.

import type { EdgeCapability } from '#shared/expression/types';
import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';

export const SLACK_CHANNEL_TYPE_ID = 'slack:channel';

/** The surface name of a message's `ts` — named once, because the channel's
 *  `Messages` edge declares its natural order by it. */
export const SLACK_MESSAGE_TIMESTAMP_NAME = 'Timestamp';

/**
 * A channel's `Messages`. BOUNDED, not native: a time bound on `Timestamp`
 * narrows the fetch at Slack (the adapter turns it into a history window), but
 * every other predicate — and every other ORDER BY — is satisfied over the
 * page-bounded set the hop yields. Declaring it native would tell the checker
 * that only the server-filterable fields may appear in a WHERE, which is both
 * untrue here and a step backwards for authors.
 *
 * `conversations.history` takes no sort argument and answers newest first, so
 * `Timestamp` descending is the natural order — the one ORDER BY whose LIMIT
 * may bound the page (`channelMessages`).
 */
export const SLACK_CHANNEL_MESSAGES_CAPABILITY = {
  filter: 'bounded',
  order: 'bounded',
  supportsLimit: true,
  naturalOrder: { field: SLACK_MESSAGE_TIMESTAMP_NAME, direction: 'desc' },
} satisfies EdgeCapability;
export const SLACK_USER_TYPE_ID = 'slack:user';

/** Collection names off the meta root — what block heads hop. */
export const SLACK_CHANNELS_COLLECTION = 'Channels';
export const SLACK_USERS_COLLECTION = 'Users';

/** Edge INTERNAL ids — the `fieldId` each reference carries and the currency
 *  `getRelated` dispatches on. Never author-facing. */
export const SLACK_CHANNEL_EDGES = { messages: 'messages', members: 'members' } as const;
export const SLACK_MESSAGE_THREAD_EDGES = {
  replies: 'replies',
  author: 'author',
  reactions: 'reactions',
} as const;
/** A message's up-hop to the Channel it was posted in — the reverse of
 *  `Channel -[Messages]-> Message`. Lets a movement post a fresh
 *  top-level message back to the channel an event arrived in (via
 *  `msg-[:Channel]->Messages`), not only a thread reply. */
export const SLACK_MESSAGE_CHANNEL_EDGE = 'channel';

/** The NATURAL names those edges publish — Title Case, the one convention
 *  across every adapter surface. This is what a movement writes
 *  (`ch-[:Messages]->`) and what `edgeWriteName` resolves to, so the write
 *  anchor dispatch keys on THESE, not on the ids above. */
export const SLACK_CHANNEL_EDGE_NAMES = { messages: 'Messages', members: 'Members' } as const;
export const SLACK_MESSAGE_THREAD_EDGE_NAMES = {
  replies: 'Replies',
  author: 'Author',
  reactions: 'Reactions',
} as const;
export const SLACK_MESSAGE_CHANNEL_EDGE_NAME = 'Channel';

export function readGraphEntryPoints(): SchemaEntryPoint[] {
  return [
    {
      typeId: SLACK_CHANNEL_TYPE_ID,
      displayName: 'Channel',
      collectionName: SLACK_CHANNELS_COLLECTION,
      writable: false,
      readable: true,
    },
    {
      typeId: SLACK_USER_TYPE_ID,
      displayName: 'User',
      collectionName: SLACK_USERS_COLLECTION,
      writable: false,
      readable: true,
    },
  ];
}

export function describeChannel(input: { messageTypeId: string }): SchemaTypeDescriptor {
  return {
    typeId: SLACK_CHANNEL_TYPE_ID,
    displayName: 'Channel',
    description:
      'A Slack channel the connected bot can see. Select one with WHERE on ' +
      '`Name`, then walk its `Messages` (history the bot can read) or `Members`. ' +
      'A WHERE on a message\'s `Timestamp` narrows the history at Slack rather ' +
      'than after the fetch.',
    fields: [
      { fieldId: 'id', displayName: 'Id', kind: 'string', writable: false, required: true },
      { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true },
      { fieldId: 'topic', displayName: 'Topic', kind: 'string', writable: false, required: false },
      {
        fieldId: 'is_private',
        displayName: 'Is Private',
        kind: 'boolean',
        writable: false,
        required: false,
      },
    ],
    references: [
      {
        fieldId: SLACK_CHANNEL_EDGES.messages,
        targetTypeId: input.messageTypeId,
        cardinality: 'many',
        direction: 'outgoing',
        name: SLACK_CHANNEL_EDGE_NAMES.messages,
        writable: true,
        capability: SLACK_CHANNEL_MESSAGES_CAPABILITY,
        // Inherently sequenced, which is a separate fact from the `order`
        // above: `conversations.history` takes no sort argument and answers
        // newest-first, and the hop returns that page as it came.
        sequenced: 'chronological',
      },
      {
        fieldId: SLACK_CHANNEL_EDGES.members,
        targetTypeId: SLACK_USER_TYPE_ID,
        cardinality: 'many',
        direction: 'outgoing',
        name: SLACK_CHANNEL_EDGE_NAMES.members,
      },
    ],
  };
}

export function describeUser(): SchemaTypeDescriptor {
  return {
    typeId: SLACK_USER_TYPE_ID,
    displayName: 'User',
    description: 'A Slack workspace member.',
    fields: [
      { fieldId: 'id', displayName: 'Id', kind: 'string', writable: false, required: true },
      { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
      {
        fieldId: 'real_name',
        displayName: 'Real Name',
        kind: 'string',
        writable: false,
        required: false,
      },
      { fieldId: 'email', displayName: 'Email', kind: 'string', writable: false, required: false },
    ],
    references: [],
  };
}

/** Normalised channel record — what channel positions carry as `data`. */
export interface SlackChannelRecord {
  id: string;
  name: string;
  topic: string | null;
  is_private: boolean;
}

/** Normalised user record — what user positions carry as `data`. */
export interface SlackUserRecord {
  id: string;
  name: string | null;
  real_name: string | null;
  email: string | null;
}

/** Raw `conversations.list` / `conversations.info` channel → record. Real
 *  Slack wraps topic as `{ value }`; accept a plain string too. */
export function normalizeChannel(raw: Record<string, unknown>): SlackChannelRecord | null {
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const topic = raw.topic;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    topic:
      typeof topic === 'string'
        ? topic
        : topic && typeof topic === 'object' && typeof (topic as { value?: unknown }).value === 'string'
          ? ((topic as { value: string }).value || null)
          : null,
    is_private: raw.is_private === true,
  };
}

/** Raw `users.list` / `users.info` member → record. Display name wins over
 *  the legacy handle; email needs the users:read.email scope. */
export function normalizeUser(raw: Record<string, unknown>): SlackUserRecord | null {
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const profile = (raw.profile ?? {}) as Record<string, unknown>;
  const displayName = typeof profile.display_name === 'string' ? profile.display_name : '';
  const handle = typeof raw.name === 'string' ? raw.name : '';
  return {
    id,
    name: displayName || handle || null,
    real_name:
      typeof raw.real_name === 'string'
        ? raw.real_name
        : typeof profile.real_name === 'string'
          ? profile.real_name
          : null,
    email: typeof profile.email === 'string' ? profile.email : null,
  };
}

export function readChannelField(record: SlackChannelRecord | null, fieldId: string): unknown {
  if (!record) return null;
  switch (fieldId) {
    case 'id': return record.id || null;
    case 'name': return record.name || null;
    case 'topic': return record.topic ?? null;
    case 'is_private': return record.is_private;
    default: return null;
  }
}

export function readUserField(record: SlackUserRecord | null, fieldId: string): unknown {
  if (!record) return null;
  switch (fieldId) {
    case 'id': return record.id || null;
    case 'name': return record.name ?? null;
    case 'real_name': return record.real_name ?? null;
    case 'email': return record.email ?? null;
    default: return null;
  }
}
