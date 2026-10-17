// Slack adapter — Slack-as-source. Inbound Slack messages arrive as
// `event_callback` payloads (text body plus zero-or-more file attachments).
// This adapter projects them into the unified Adapter contract so the
// translation-graph framework can run TGs over Slack messages alongside
// every other channel.
//
// Scope (R4a):
//   • Source-side introspection: a single `slack:message` entry point.
//   • Identity resolution by `record.id` (the Slack message `ts`),
//     inherited from BaseAdapter — webhook-bridged messages get back to
//     the original record via the linked_object bridge.
//   • Field reads on `external-record` positions: text / user / channel /
//     ts / thread_ts surface as scalar property reads off the cached
//     event payload.
//   • `getRelated('files', { position })`: fans a slack:message position
//     out into one slack:file position per file attachment. The retired
//     input-side `#resources` reference is gone — body + files are now
//     accessed explicitly via `Text` field + `Files` edge.
//
// Slack is BOTH source and target through ONE `slack:message` type
// (message-write-unification chunk 1). It is created only along an edge —
// post via a Channel's `Messages`, reply via a message's `Replies` — with
// the channel + thread supplied by the parent, and a `File` value riding the
// write as the message's caption. `createRecord` (below) implements it;
// `writeResource` stays undefined because Slack's outbound API doesn't model
// "attach facts + per-property evidence to an existing message".

import { Readable } from 'node:stream';

import { z } from 'zod';

import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  AwaitableCapability,
  AwaitPoint,
  AwaitResolution,
  DeleteInput,
  DeleteResult,
  DiscriminableEvent,
  EdgesFromResult,
  EventType,
  FileRef,
  GetFieldValueInput,
  GetRelatedInput,
  InvokeFieldFunctionInput,
  ParentLink,
  RelatedResult,
  ResolveFileRefResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { ModuleLog } from 'module-kit';
import type { SlackAPIClient } from './api_client';
import type { SlackWriteHost } from './write';

import { fileHandle, ownedFileSource, singleParentLink } from 'movement-engine/public/adapter';
import { META_RECORD_TYPE, makeStablePosition, makeUnstablePosition, positionData } from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { naturalName } from 'module-kit/adapter/name_resolution';
import { historyWindowFromWhere, type SlackHistoryWindow } from './history_window';
import {
  addReaction,
  createUnifiedMessage,
  reactionAnchorFromParent,
  replyAnchorFromParent,
  type SlackWriteAnchor,
} from './write';
import { SLACK_MESSAGE_EVENT_TYPES, parseSlackDeliveries, slackInboundEvents } from './inbound';
import { SLACK_MANIFEST } from './manifest';
import { SLACK_MESSAGE_FUNCTION } from './compose';
import {
  SLACK_CHANNELS_COLLECTION,
  SLACK_CHANNEL_EDGES,
  SLACK_CHANNEL_EDGE_NAMES,
  SLACK_CHANNEL_TYPE_ID,
  SLACK_MESSAGE_CHANNEL_EDGE,
  SLACK_MESSAGE_CHANNEL_EDGE_NAME,
  SLACK_MESSAGE_THREAD_EDGES,
  SLACK_MESSAGE_THREAD_EDGE_NAMES,
  SLACK_USERS_COLLECTION,
  SLACK_USER_TYPE_ID,
  describeChannel,
  describeUser,
  normalizeChannel,
  normalizeUser,
  readChannelField,
  readGraphEntryPoints,
  readUserField,
  SLACK_CHANNEL_MESSAGES_CAPABILITY,
  SLACK_MESSAGE_TIMESTAMP_NAME,
  type SlackChannelRecord,
  type SlackUserRecord,
} from './read_graph';
import { SLACK_ADAPTER_TYPE } from './types';
import { uniformWalk } from 'module-kit/adapter/hop';

/**
 * What the adapter reaches Slack and the host through. The host decides
 * which workspace token an install speaks with and serves what a module
 * cannot do alone: the model the composition function writes with, and the
 * bytes of a file another system owns.
 */
export interface SlackSources extends SlackWriteHost {
  /** The workspace's client; null when no usable credential is reachable.
   *  The read paths that need one answer nothing without it. */
  client(): Promise<SlackAPIClient | null>;
  /** Why `client` gave none, for the error a call that needs one raises. */
  missingClient(op: string): string;
  /** The tenant, on log lines. */
  tenant: string;
  /** The host's name for the install's credential, which a file's source
   *  carries so the host redeems it on this same install. */
  credentialRef?: string;
  log: ModuleLog;
  /** The composition function's model: the composed mrkdwn for a brief. */
  compose(args: { instructions: string; data: unknown[] }): Promise<string>;
}

import { isNaturalOrder } from '#shared/expression/order_limit';
export { SLACK_ADAPTER_TYPE } from './types';

/** Single source entry-point type id — a Slack message in a channel. */
export const SLACK_MESSAGE_TYPE_ID = 'slack:message';

/** Every parent-anchored write needs the parent's channel, and every way a
 *  Slack Message position is minted carries one — so its absence is a broken
 *  parent, not a missing field, and says so identically for both writes. */
const NO_PARENT_CHANNEL = (op: string): string =>
  `SlackAdapter.createRecord(${op}): the parent message carries no channel — ` +
  'its parent data must include `channel` (position/event) or `channelId` (write handle).';

/** The inner Slack event types the message's fires edge covers (`firesOn`) —
 *  the `events:` config values that deliver a `Slack Message`. The fires edge
 *  lands STRAIGHT on the message (rule 1, adapters/CLAUDE.md): a field-less
 *  `Message Received` node carried no facts and was pure indirection, so a
 *  listen delivers the message itself, whole, seeded stable on its ts. */
export { SLACK_MESSAGE_EVENT_TYPES } from './inbound';

/**
 * A reaction added to a message (`reaction_added`). Its own inbound event type
 * — discriminated apart from messages so a movement opts in via
 * `listen to <slack> { events: ["reaction_added"] }`. Graph-first: the reacted
 * message, the channel, and the reactor are all reachable as edges. Mirrors the
 * WhatsApp Reaction model.
 */
export const SLACK_REACTION_TYPE_ID = 'slack:reaction';

/** The inner Slack event types the reaction's fires edge covers (`firesOn`) —
 *  the `events:` config value that delivers a `Slack Reaction`. Mirrors
 *  `SLACK_MESSAGE_EVENT_TYPES`: a reaction is an inbound event, delivered on
 *  its own fires edge, discriminated apart from messages. */
export const SLACK_REACTION_EVENT_TYPES = ['reaction_added'] as const;

/** Edge ids on a Slack Reaction — the up-hops to the message it's on, the
 *  channel it's in, and the user who added it. */
export const SLACK_REACTION_EDGES = {
  message: 'message',
  channel: 'channel',
  reactor: 'reactor',
} as const;

/** Their NATURAL names — Title Case, the one convention across every adapter
 *  surface (the ids above stay internal `getRelated` currency). */
export const SLACK_REACTION_EDGE_NAMES = {
  message: 'Message',
  channel: 'Channel',
  reactor: 'Reactor',
} as const;

/** Safety bound on cursor pagination of `conversations.list` — 50 pages ×
 *  1000 = up to 50k channels before we stop and log the truncation. */
const MAX_CONVERSATION_PAGES = 50;

/** The shape of `conversations.list` this adapter depends on — the channels
 *  page plus the cursor that drives pagination (`response_metadata.next_cursor`). */
type SlackConversationsList = (
  args: Record<string, unknown>,
) => Promise<{ channels?: unknown[]; response_metadata?: { next_cursor?: string } }>;

type SlackConversationsHistory = (
  args: { channel: string; limit: number; cursor?: string; oldest?: string; latest?: string },
) => Promise<{ messages?: unknown[]; response_metadata?: { next_cursor?: string } }>;

/** One history request's size, and the ceiling on how many a single bounded
 *  hop may issue. Slack caps `limit` at 1000 but recommends no more than 200. */
const HISTORY_PAGE_SIZE = 200;
const MAX_HISTORY_PAGES = 25;

type SlackConversationsReplies = (
  args: { channel: string; ts: string; limit: number; cursor?: string },
) => Promise<{ messages?: unknown[]; response_metadata?: { next_cursor?: string } }>;

/** Same bound as history, over a thread's replies instead of a channel's
 *  top-level messages — a bare `Replies` read is now unbounded (it reads
 *  everything posted so far), so it needs the same loud cap `pageHistory`
 *  applies rather than silently stopping at Slack's first-page default. */
const REPLIES_PAGE_SIZE = 200;
const MAX_REPLIES_PAGES = 25;

/**
 * Per-attachment record type. One position per file attached to a Slack
 * message; reached by walking the `files` reference off `slack:message`.
 * Mirrors the email adapter's `email:attachment` pattern so the
 * composition materialiser's `getRelated('files', …)` walk has a real
 * destination type to land on (G1 Gap D-1). The descriptor publishes
 * the file's shape — name, contentType, url, size, and the binary
 * handle — without the adapter having to fan out into separate Resource
 * objects at the materialiser layer.
 */
export const SLACK_FILE_TYPE_ID = 'slack:file';

/**
 * Field ids on the slack:message descriptor. Stable strings — used by the
 * editor, by `getFieldValue` lookups against the cached event payload, and
 * by tests.
 */
export const SLACK_MESSAGE_FIELDS = {
  text: 'text',
  file: 'file',
  user: 'user',
  channel: 'channel',
  ts: 'ts',
  blocks: 'blocks',
} as const;

/**
 * The `Timestamp` field's value: Slack's `ts` (epoch seconds, microseconds
 * after the point) read as the instant it denotes. The raw `ts` keeps flowing
 * everywhere it is an IDENTIFIER — record ids, thread anchors, reply
 * correlation, the write anchor — because to Slack it is a key, not a time.
 * The FIELD is the time, which is what a movement compares and filters on.
 */
function isoInstantFromSlackTs(ts: string | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Reference id on slack:message that walks to file records. Per
 * `resources_currency.md`, attachments are normalised to records reached
 * via a regular edge (`msg-[:Files]->{ name, contentType, data }`). The
 * field id is the edge name authors write in TGs.
 */
export const SLACK_MESSAGE_FILES_REFERENCE = 'files';
/** Its NATURAL name — Title Case, the convention across every adapter. */
export const SLACK_MESSAGE_FILES_REFERENCE_NAME = 'Files';

/**
 * Minimal Slack file shape we care about for resource shaping. Mirrors
 * the subset of the Slack `files.info` response the knowledge-pipeline
 * inbound handler relies on; the adapter never round-trips the full
 * payload through the Resource. Adapters can write more into `metadata`
 * as new use-cases emerge.
 */
interface SlackFileRef {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
}

/**
 * Normalised per-file record exposed via `getRelated('files', …)` and
 * read by `getFieldValue` on `slack:file` positions. Field names match
 * the `slack:file` descriptor published by `describe()` (R10) — `name`
 * (not `title`), `contentType` (not `mimetype`), `url` (not the raw
 * Slack URL fields). The raw Slack file ref shape is an inbound-only
 * concern; downstream callers see the normalised projection.
 */
export interface SlackFileRecord {
  id: string;
  name: string;
  contentType: string | null;
  url: string | null;
  size: number | null;
  /**
   * Binary handle slot. Today the adapter doesn't fetch file bytes;
   * downstream consumers that need the raw stream do so via the FILE
   * Resource. `data` is reserved for the binary primitive
   * (resources_currency.md) and kept null at this layer so the shape
   * matches the descriptor.
   */
  data: unknown;
}

/**
 * Minimal Slack message shape we expect to live on the source position's
 * `data` field. The trigger router populates this from the inbound
 * `event_callback.event` payload — the same shape today's
 * `webApi/input.ts` parses.
 */
interface SlackMessageData {
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFileRef[];
}

/**
 * The inner `reaction_added` event a `slack:reaction` position carries on its
 * `data`. `user` is the reactor; `reaction` the emoji name; `item` the message
 * reacted to (its channel + ts); `item_user` the reacted message's author.
 */
interface SlackReactionData {
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  item_user?: string;
}

/** The thread a `Replies` await parks on and an inbound reply wakes:
 *  `channel:thread_ts`. Both sides take the thread from `replyAnchorFromParent`,
 *  the same anchor a reply write uses, so all three agree on what "the thread"
 *  of a message is. */
function replyCorrelationKey(anchor: { channelId: string; threadTs: string }): string {
  return `${anchor.channelId}:${anchor.threadTs}`;
}

/** The fields of an inbound message event that make it a thread reply. */
const SlackThreadReply = z.object({ channel: z.string(), thread_ts: z.string() });

export class SlackAdapter extends BaseAdapter {

  /**
   * THE raw→events seam for Slack deliveries — the pure `slackInboundEvents`
   * (the retired provider `parseEvents` logic) + the legacy conversion, so
   * the event shape downstream is byte-identical to the old path.
   */
  async preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[] }> {
    return { events: slackInboundEvents(input.raw) };
  }

  /**
   * Two inbound event shapes, discriminated on the inner event's `type`:
   *   • `message` / `app_mention` → a STABLE `Slack Message` position (recordId =
   *     the message ts), which is what lets a reply write anchor off the inbound
   *     message (`write sm-[:Replies]->`): the linked write needs a durable
   *     parent id, and the ts is it.
   *   • `reaction_added` → a `Slack Reaction` position — kept separate so a
   *     reaction never mis-discriminates as a message and a movement opts in via
   *     `events: ["reaction_added"]`.
   */
  async listEventTypes(): Promise<EventType[]> {
    return [
      {
        tag: SLACK_MESSAGE_TYPE_ID,
        positionType: SLACK_MESSAGE_TYPE_ID,
        match: { path: 'type', equals: ['message', 'app_mention'] },
      },
      {
        tag: SLACK_REACTION_TYPE_ID,
        positionType: SLACK_REACTION_TYPE_ID,
        match: { path: 'type', equals: [...SLACK_REACTION_EVENT_TYPES] },
      },
    ];
  }
  readonly adapterType = SLACK_ADAPTER_TYPE;
  readonly supportedTriggers = SLACK_MANIFEST.supportedTriggers;

  constructor(private readonly sources: SlackSources) {
    super();
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // The EVENT edge lands STRAIGHT on the message: `chat -[:Slack
      // Message]-> <the message>`. A separate `Message Received` node carried
      // no facts of its own — pure indirection — so rule 1
      // (adapters/CLAUDE.md) collapses it: a listen delivers the message
      // itself, whole (seeded stable on its ts). No change-kind axis
      // (`app_mention` vs `message` is a subscription fact, not a field), so
      // `firesOn` says WHICH `events:` values deliver here. `reaction_added`
      // is deliberately not on it — a different event kind (`Slack
      // Reaction`).
      //
      // ONE Slack Message type — writable ONLY along an edge (Channel's
      // `Messages`, a message's `Replies`), never as a top-level create, and
      // readable ONLY by arriving: the fires edge, a channel's `Messages`
      // edge, a reaction's `Message` edge. The root can enumerate neither
      // ("all Slack messages" is not a read Slack serves) — a fires edge is
      // reachability, never a root collection
      // (7_readable_means_readable.md).
      {
        typeId: SLACK_MESSAGE_TYPE_ID,
        displayName: 'Message',
        writable: false,
        readable: false,
        fires: true,
        firesOn: [...SLACK_MESSAGE_EVENT_TYPES],
      },
      {
        typeId: SLACK_FILE_TYPE_ID,
        displayName: 'File',
        // Reached by walking `slack:message -[:Files]-> slack:file` — no
        // root collection (nothing can list "all Slack files" here).
        writable: false,
        readable: false,
      },
      {
        typeId: SLACK_REACTION_TYPE_ID,
        displayName: 'Reaction',
        // An inbound EVENT — a `reaction_added` position delivered on its own
        // fires edge (`events: ["reaction_added"]`), exactly like `Message`
        // and like the WhatsApp `Reaction`. NOT a readable root: "all Slack
        // reactions" is not a read Slack serves, so a reaction is reached only
        // by arriving (the fires edge) or by walking a message — never listed
        // from the root (7_readable_means_readable.md). The reacted message,
        // its channel, and the reactor are all edges off it.
        //
        // No `defaultSubscribedEvents` on Slack: a config-less listen's
        // runtime gate (`eventMatchesTriggerScope`) passes EVERY event, so the
        // checker's absent default — which types a config-less listen as
        // firing every declared event edge — matches the runtime. (WhatsApp
        // differs: its gate defaults config-less to messages only, hence its
        // `defaultSubscribedEvents: ['message']`.)
        writable: false,
        readable: false,
        fires: true,
        firesOn: [...SLACK_REACTION_EVENT_TYPES],
      },
      // The read graph (positions-and-edges model): channels and users are
      // stable nouns, collections off the meta root, WHERE-selectable.
      ...readGraphEntryPoints(),
    ];
  }

  /**
   * Slack's root: two things you can list, and two that happen to you.
   *
   * `File` is not here — it hangs off a message's `Files` edge, and "all Slack
   * files" is not a read Slack serves. Nor is Message or Reaction READABLE
   * from the root for the same reason: a fires edge is reachability, never a
   * root collection (7_readable_means_readable.md).
   */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Slack',
    description:
      'A Slack workspace the connected bot can see. List its `Channels` and ' +
      '`Users`, or listen for a message or a reaction arriving.',
    fields: [],
    references: [
      {
        fieldId: SLACK_CHANNELS_COLLECTION,
        targetTypeId: SLACK_CHANNEL_TYPE_ID,
        cardinality: 'many',
        direction: 'outgoing',
        name: SLACK_CHANNELS_COLLECTION,
        description: 'Channels the connected bot can see.',
      },
      {
        fieldId: SLACK_USERS_COLLECTION,
        targetTypeId: SLACK_USER_TYPE_ID,
        cardinality: 'many',
        direction: 'outgoing',
        name: SLACK_USERS_COLLECTION,
        description: 'Members of the workspace.',
      },
      {
        fieldId: SLACK_MESSAGE_TYPE_ID,
        targetTypeId: SLACK_MESSAGE_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: 'Message',
        fires: true,
        firesOn: [...SLACK_MESSAGE_EVENT_TYPES],
        readable: false,
        description: 'A message arriving — what a listen delivers.',
      },
      {
        fieldId: SLACK_REACTION_TYPE_ID,
        targetTypeId: SLACK_REACTION_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: 'Reaction',
        fires: true,
        firesOn: [...SLACK_REACTION_EVENT_TYPES],
        readable: false,
        description: 'Somebody reacting to a message.',
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: SLACK_ADAPTER_TYPE,
      at: position,
      root: SlackAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // Accept the NATURAL type name (engine / checker currency) or the internal
    // id (resolver build, legacy callers) — `resolveTypeRef` normalizes both.
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === SLACK_MESSAGE_TYPE_ID) {
      return {
        typeId: SLACK_MESSAGE_TYPE_ID,
        displayName: 'Message',
        description:
          'A Slack message — what a listen delivers, whole: read ' +
          '`e.`Message`` straight off the event, reply along its `Replies` ' +
          'edge, react to it along its `Reactions` edge. Created only along an ' +
          'edge: post via a Channel\'s `Messages` edge, reply via a message\'s ' +
          '`Replies` edge — the channel and thread come from the parent, never ' +
          'from fields.',
        fields: [
          {
            fieldId: SLACK_MESSAGE_FIELDS.text,
            displayName: 'Message',
            kind: 'string',
            writable: true,
            required: false,
            uiHint: 'textarea',
            description:
              'The message body. Required unless a File is attached or Blocks are ' +
              'set (at least one of Message / File / Blocks). Use Slack-native ' +
              'formatting (*bold*, _italic_, <url|text>).',
            functions: [SLACK_MESSAGE_FUNCTION],
          },
          {
            fieldId: SLACK_MESSAGE_FIELDS.file,
            displayName: 'File',
            kind: 'file',
            writable: true,
            // Send-side only: an upload to include with the post. A received
            // message's files are on its `files` edge, never this field —
            // without the flag it leaks as a readable-but-always-null
            // property (the WhatsApp `File` duality, fixed 2026-07-13).
            readable: false,
            required: false,
            description:
              'Optional file to upload with the message — the Message text rides ' +
              'as the file caption, one visible Slack message. Send-side only: a ' +
              'received message\'s files are on its Files edge — read ' +
              '`msg-[:Files]->.File`. A message is either a File or Blocks, never both.',
          },
          {
            fieldId: SLACK_MESSAGE_FIELDS.blocks,
            displayName: 'Blocks',
            kind: 'json',
            // A LIST of blocks — many-cardinality so the projected field type is
            // `list<…>` and the engine passes the author's list literal through as
            // an array, verbatim, straight onto `chat.postMessage`'s `blocks`.
            // Without it json→scalar text would flatten the list to one string.
            cardinality: 'many',
            // Send-side only: interactive Block Kit content on the posted
            // message. A received message never has this, so it must never read
            // back as a property (the same File duality fix, 2026-07-13).
            writable: true,
            readable: false,
            required: false,
            description:
              'Slack Block Kit blocks, exactly as in Slack\'s docs — assembled ' +
              'verbatim and passed through (no wrapping, no typed shape here; a ' +
              'malformed block surfaces as a loud Slack error at run time). To make ' +
              'a control DO something, mint a callback (`c = callback({ … })`) and ' +
              'put `"${c.id}"` in a button\'s or select option\'s `value` — one ' +
              'callback per control, since its body is what that control means. A ' +
              '`datepicker`/`timepicker`/text input has no `value` field and no ' +
              'value until the tap, so carry the id on the element\'s `action_id` ' +
              'instead — e.g. `action_id: "${c.id}"` — and the picked value binds to ' +
              'the callback\'s first parameter. ' +
              'Build strings with "${…}" interpolation (never ' +
              '`+`, which is numeric addition). Example, a section plus an actions ' +
              'block with a button and a static_select:\n' +
              '[\n' +
              '  { type: "section", text: { type: "mrkdwn", text: "*${deal.Name}*" } },\n' +
              '  { type: "actions", elements: [\n' +
              '    { type: "button", text: { type: "plain_text", text: "Approve" },\n' +
              '      value: "${approve.id}" },\n' +
              '    { type: "static_select",\n' +
              '      placeholder: { type: "plain_text", text: "Tier" },\n' +
              '      options: [\n' +
              '        { text: { type: "plain_text", text: "Seed" }, value: "${seed.id}" },\n' +
              '      ] },\n' +
              '  ] },\n' +
              ']\n' +
              'A message is either a File or Blocks, never both.',
          },
          {
            fieldId: SLACK_MESSAGE_FIELDS.user,
            displayName: 'User',
            kind: 'string',
            writable: false,
            required: false,
          },
          {
            fieldId: SLACK_MESSAGE_FIELDS.channel,
            displayName: 'Channel',
            kind: 'string',
            writable: false,
            required: false,
            description: 'The C… channel id (read-only — a post is written along a Channel\'s `Messages` edge).',
          },
          {
            fieldId: SLACK_MESSAGE_FIELDS.ts,
            displayName: SLACK_MESSAGE_TIMESTAMP_NAME,
            // A real instant, not the raw `ts` string — so a movement can
            // compare it to `@current_date` or ask for `WITHIN 7d` and have
            // Slack itself narrow the fetch (see `channelMessages`). The raw
            // `ts` stays the record's identity and thread anchor internally.
            kind: 'date',
            writable: false,
            required: false,
            description: 'When the message was posted.',
            capability: {
              filterOperators: ['gt', 'gte', 'lt', 'lte', 'within'],
              // `conversations.history` takes a window, never a sort order —
              // it always answers newest-first.
              orderable: false,
            },
          },
        ],
        // Files reach the source graph as a regular outgoing many-edge:
        // one `slack:file` position per attachment. The composition
        // materialiser walks `slack:message -[:Files]-> slack:file` via
        // `getRelated` and the editor's edge picker reads this reference
        // to enumerate the available walks. The file payload surfaces as
        // field reads on the `slack:file` record (via `getFieldValue`),
        // and the message body via the `Message` field.
        references: [
          {
            fieldId: SLACK_MESSAGE_FILES_REFERENCE,
            targetTypeId: SLACK_FILE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: SLACK_MESSAGE_FILES_REFERENCE_NAME,
            // Read-only: Slack attaches a message's files itself; a send's
            // upload is the message's own `File` field, never a created child.
            writable: false,
            // The message payload carries its files as an array and
            // `getRelated` walks it in place — so they come back in the order
            // the message attached them.
            sequenced: 'document',
          },
          // A thread is the `Replies` edge — a reply is CREATED along it (post a
          // thread reply), READABLE (a bare `m-[:Replies]->` reads the replies
          // posted so far — zero before any exist, an ordinary empty traversal,
          // not a special state), AND AWAITABLE: `await m-[:Replies]->` waits
          // for the first NEW reply and binds it (S18, consent-by-silence).
          // Same edge, two read modes — the `Called` callback edge is the
          // precedent (movement-lang/checker/typing.ts `callbackType`).
          // `resolvesEmpty: false` on the awaited form — a reply always has
          // content (no empty settlement; unlike an ask `Response`, no cancel
          // resolves this edge empty).
          {
            fieldId: SLACK_MESSAGE_THREAD_EDGES.replies,
            targetTypeId: SLACK_MESSAGE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: SLACK_MESSAGE_THREAD_EDGE_NAMES.replies,
            writable: true,
            awaitable: true,
            // An inbound Slack event carries the reply and wakes the run parked
            // on the thread (`wakeKeys`) — real push, no poll behind it.
            watchable: true,
            resolvesEmpty: false,
            // `conversations.replies` answers oldest-first and the hop only
            // drops the root message from that page — it never reorders.
            sequenced: 'chronological',
          },
          // React to the message you were handed: `write msg-[:Reactions]-> {
          // Emoji: "eyes" }`. Channel + ts come from the parent position, the
          // same way `Replies` takes its thread from the parent — nothing about
          // WHICH message a reaction lands on is ever a field.
          //
          // WRITE-ONLY, deliberately. Slack does put a `reactions` array on
          // `conversations.history` / `.replies` items, but the message a
          // movement usually holds arrived as an inbound `event_callback`, and
          // that payload carries no reactions at all. A readable edge would
          // therefore answer honestly off a traversed message and silently
          // empty off the delivered one — the dominant case — and the only fix
          // is a `reactions.get` per message, an N+1 this adapter will not add.
          // Absent a guarantee on every position there is no guarantee, so the
          // checker rejects the read (MOV_WRITE_ONLY_EDGE) instead.
          {
            fieldId: SLACK_MESSAGE_THREAD_EDGES.reactions,
            targetTypeId: SLACK_REACTION_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: SLACK_MESSAGE_THREAD_EDGE_NAMES.reactions,
            writable: true,
            readable: false,
            description:
              'React to this message with an emoji (write-only — reading a ' +
              'message\'s reactions would cost a call per message, so this edge ' +
              'only writes).',
          },
          {
            fieldId: SLACK_MESSAGE_THREAD_EDGES.author,
            targetTypeId: SLACK_USER_TYPE_ID,
            cardinality: 'one',
            direction: 'outgoing',
            name: SLACK_MESSAGE_THREAD_EDGE_NAMES.author,
          },
          // The up-hop to the containing Channel — the reverse of
          // `Channel -[Messages]->`. Walk it to post a fresh top-level message
          // back to the channel (`msg-[:Channel]->Messages`, a create along the
          // Channel's own edge) instead of replying in-thread. Distinct
          // namespace from the read-only `Channel` scalar field above.
          {
            fieldId: SLACK_MESSAGE_CHANNEL_EDGE,
            targetTypeId: SLACK_CHANNEL_TYPE_ID,
            cardinality: 'one',
            direction: 'outgoing',
            name: SLACK_MESSAGE_CHANNEL_EDGE_NAME,
          },
        ],
        // Files and Blocks are alternative write shapes, never both — Slack's
        // upload surface has no blocks, and blocks-with-a-file has no single
        // rendering. Untagged: nothing discriminates which shape a write means,
        // the fields it sets do.
        writeUnion: {
          variants: [
            { name: 'a file post', fields: [SLACK_MESSAGE_FIELDS.text, SLACK_MESSAGE_FIELDS.file] },
            { name: 'an interactive post', fields: [SLACK_MESSAGE_FIELDS.text, SLACK_MESSAGE_FIELDS.blocks] },
          ],
        },
      };
    }
    if (typeId === SLACK_CHANNEL_TYPE_ID) {
      return this.withLiveChannelKnownValues(
        describeChannel({ messageTypeId: SLACK_MESSAGE_TYPE_ID }),
      );
    }
    if (typeId === SLACK_USER_TYPE_ID) {
      return describeUser();
    }
    if (typeId === SLACK_FILE_TYPE_ID) {
      return {
        typeId: SLACK_FILE_TYPE_ID,
        displayName: 'File',
        fields: [
          { fieldId: 'id', displayName: 'File Id', kind: 'string', writable: false, required: true },
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true },
          { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: false },
          { fieldId: 'url', displayName: 'URL', kind: 'string', writable: false, required: false },
          { fieldId: 'size', displayName: 'Size', kind: 'number', writable: false, required: false },
          // Binary handle (the File primitive per
          // resources_currency.md). E5 (wave-2) widened SchemaFieldKind
          // to include `file` so the editor can recognise File-typed
          // expressions (e.g., `msg-[:Files]->.data`) and route them
          // only into File-typed target fields.
          { fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false },
        ],
        references: [],
      };
    }
    if (typeId === SLACK_REACTION_TYPE_ID) {
      return {
        typeId: SLACK_REACTION_TYPE_ID,
        displayName: 'Reaction',
        description:
          'An emoji reaction added to a message. Fires when someone reacts, ' +
          'if you listen with `events: ["reaction_added"]`. Walk `Message` to ' +
          'the message it\'s on, `Channel` to the channel, `Reactor` to the user. ' +
          'Also the reaction WRITE: created along a message\'s `Reactions` edge, ' +
          'which is how a movement reacts to the message it was handed.',
        fields: [
          {
            fieldId: 'emoji',
            displayName: 'Emoji',
            kind: 'string',
            writable: true,
            required: true,
            description:
              'The reaction emoji name (e.g. "thumbsup"), without colons. On a ' +
              'write along `msg-[:Reactions]->`: the single emoji to react with — ' +
              'required.',
          },
          {
            fieldId: 'channel',
            displayName: 'Channel',
            kind: 'string',
            writable: false,
            required: false,
            description: 'The C… channel id the reaction is in (read-only — walk the `Channel` edge for the Channel node).',
          },
          {
            fieldId: 'reactor',
            displayName: 'Reactor',
            kind: 'string',
            writable: false,
            required: false,
            description: 'The U… id of the user who added the reaction (read-only — walk the `Reactor` edge for the User node).',
          },
        ],
        references: [
          // The message the reaction is on — a real Slack Message (read its
          // text, walk to its author, reply to it, …).
          {
            fieldId: SLACK_REACTION_EDGES.message,
            targetTypeId: SLACK_MESSAGE_TYPE_ID,
            cardinality: 'one',
            direction: 'outgoing',
            name: SLACK_REACTION_EDGE_NAMES.message,
          },
          // The channel the reaction is in.
          {
            fieldId: SLACK_REACTION_EDGES.channel,
            targetTypeId: SLACK_CHANNEL_TYPE_ID,
            cardinality: 'one',
            direction: 'outgoing',
            name: SLACK_REACTION_EDGE_NAMES.channel,
          },
          // The user who added the reaction.
          {
            fieldId: SLACK_REACTION_EDGES.reactor,
            targetTypeId: SLACK_USER_TYPE_ID,
            cardinality: 'one',
            direction: 'outgoing',
            name: SLACK_REACTION_EDGE_NAMES.reactor,
          },
        ],
      };
    }
    return null;
  }

  // ── 2. Entity resolution ──────────────────────────────────────────────
  // Inherits BaseAdapter's linked-object id match — the Slack message `ts`
  // is the stable record id and the webhook bridge writes it to
  // linked_object.external_id.

  // ── 3. Field-level access ─────────────────────────────────────────────
  //
  // Two position kinds carry Slack message data:
  //
  //   • `external-record` — what R4a originally shipped; constructed by
  //     unit-test fixtures and by callers that materialise positions
  //     from cached payloads.
  //   • `webhook-event` — what I1's production webhook bridge constructs
  //     and what R6's composition materialiser seeds via
  //     `seedRootPositionFromTrigger`. The `data` is the inner Slack
  //     `event_callback.event` object — same shape, same scalar fields.
  //
  // Both arms read from `position.data` with the same `SlackMessageData`
  // projection; the message-scalar reads are identical. Per-file reads
  // are gated on `recordType === SLACK_FILE_TYPE_ID` (only reachable via
  // the `external-record` arm — `getRelated('files', …)` returns
  // webhook-event-kind file positions; this method also accepts file
  // reads off those, see below).

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== this.adapterType) {
      throw new Error(
        `SlackAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }

    const payload = positionData(input.position);
    // A TYPED position needs exactly its own type described — whichever branch
    // wins reads a field of it.
    //
    // A TYPELESS one needs the types the branches can still SELECT without
    // being told: the file branch sniffs the payload shape, and everything
    // unmatched falls through to the message type. Scoping those away left the
    // resolver knowing nothing, so every field read off a typeless position
    // drifted — `'Message' is not a known field of 'Message'`, which reads like
    // schema drift and is really an empty resolver.
    //
    // Typeless is not hypothetical: the engine's seed still mints one when
    // neither `surfaceType` nor `rootRecordType` is known (`run.ts`, where
    // typeless-at-seed is documented as a normal intermediate state). The guard
    // for it lives at the RESOLUTION boundary, which is a reason to describe
    // what resolution needs — not a reason to starve it.
    const resolver = await this.resolver({
      types:
        input.position.recordType !== null
          ? [input.position.recordType]
          : [SLACK_MESSAGE_TYPE_ID, SLACK_FILE_TYPE_ID],
    });

    // slack:file positions (reached via `getRelated('files', …)` with a null
    // recordType, or via `#resources` with the slack:file id) carry a per-file
    // record on `data`. The program names the field by its NATURAL displayName
    // (`Name`, `Content Type`); resolve it to the internal field id
    // `readSlackFileField` keys by, against the slack:file type's natural name.
    if (
      input.position.recordType === SLACK_FILE_TYPE_ID
      || input.position.recordType === resolver.naturalTypeName(SLACK_FILE_TYPE_ID)
      || isSlackFileRecord(payload)
    ) {
      const fileFieldId = resolver.fieldId(
        naturalName(resolver.naturalTypeName(SLACK_FILE_TYPE_ID)),
        naturalName(input.fieldId),
      );
      // The `File` (`data`) field is the binary primitive — a `FileRef`
      // descriptor redeemed via the bot credential (the same FileRef the
      // retired input-side `_resources` bundle built). This is what
      // `msg-[:Files]->.\`File\`` evaluates so file bytes reach extraction /
      // carry-forward.
      if (fileFieldId === 'data') {
        return this.slackFileRef(payload as SlackFileRecord | null);
      }
      return readSlackFileField(payload as SlackFileRecord | null, fileFieldId);
    }

    // Channel / user positions (the read graph) — stamped with the natural
    // type name by the collection/edge reads below.
    if (this.isRecordOfType(input.position.recordType, SLACK_CHANNEL_TYPE_ID, resolver)) {
      const fieldId = resolver.fieldId(
        naturalName(resolver.naturalTypeName(SLACK_CHANNEL_TYPE_ID)),
        naturalName(input.fieldId),
      );
      return readChannelField(payload as SlackChannelRecord | null, fieldId);
    }
    if (this.isRecordOfType(input.position.recordType, SLACK_USER_TYPE_ID, resolver)) {
      const fieldId = resolver.fieldId(
        naturalName(resolver.naturalTypeName(SLACK_USER_TYPE_ID)),
        naturalName(input.fieldId),
      );
      return readUserField(payload as SlackUserRecord | null, fieldId);
    }

    // A slack:reaction position. `data` is the inner `reaction_added` event —
    // emoji on `reaction`, reactor on `user`, channel on `item.channel`. The
    // reacted message's `item.ts` is kept on the payload for the `Message` edge
    // but is not a field (no value to the author).
    if (this.isRecordOfType(input.position.recordType, SLACK_REACTION_TYPE_ID, resolver)) {
      const fieldId = resolver.fieldId(
        naturalName(resolver.naturalTypeName(SLACK_REACTION_TYPE_ID)),
        naturalName(input.fieldId),
      );
      const reaction = (payload ?? {}) as SlackReactionData;
      switch (fieldId) {
        case 'emoji':
          return reaction.reaction ?? null;
        case 'channel':
          return reaction.item?.channel ?? null;
        case 'reactor':
          return reaction.user ?? null;
        default:
          return null;
      }
    }

    // A slack:message position. Resolve the NATURAL field name to the internal
    // id the payload is keyed by, against the message type's natural name (the
    // read wrapper stamps `position.recordType` with it; a typeless seed uses
    // the message type as-is).
    const fieldId = resolver.fieldId(
      naturalName(input.position.recordType ?? resolver.naturalTypeName(SLACK_MESSAGE_TYPE_ID)),
      naturalName(input.fieldId),
    );
    const data = (payload ?? {}) as SlackMessageData;
    switch (fieldId) {
      case SLACK_MESSAGE_FIELDS.text:
        return data.text ?? null;
      case SLACK_MESSAGE_FIELDS.user:
        return data.user ?? null;
      case SLACK_MESSAGE_FIELDS.channel:
        return data.channel ?? null;
      case SLACK_MESSAGE_FIELDS.ts:
        return isoInstantFromSlackTs(data.ts);
      default:
        return null;
    }
  }

  // ── 4. Reference traversal (files) ───────────────────────────────────
  //
  // `getRelated('files', …)` fans a slack:message position out into one
  // per-file `slack:file` position (the navigable domain edge). Used by
  // R6's composition materialiser to walk the `slack:message -[:Files]->
  // slack:file` edge.
  //
  // The yielded positions are `kind: 'webhook-event'` so they round-trip
  // through `getFieldValue` on the file branches — same kind as the seed
  // position the composition materialiser starts from.

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.direction !== 'outgoing') {
      throw new Error(
        `SlackAdapter.getRelated only supports outgoing direction (incoming traversal isn't supported by Slack's webhook contract).`,
      );
    }
    if (input.position.adapterType !== this.adapterType) {
      throw new Error(
        `SlackAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }

    const payload = positionData(input.position);
    const resolver = await this.resolver();

    // Meta root → collections: `slk-[c:Channels]->` / `slk-[u:Users]->`.
    // The engine passes the authored collection name through as the fieldId.
    if (input.position.recordType === META_RECORD_TYPE) {
      const collection = naturalName(input.fieldId);
      if (collection === SLACK_CHANNELS_COLLECTION || collection === 'Channel') {
        return this.listChannelPositions();
      }
      if (collection === SLACK_USERS_COLLECTION || collection === 'User') {
        return this.listUserPositions();
      }
      return [];
    }

    // Per-file positions don't fan out further — no outbound edges on
    // slack:file (reached via the null-recordType fan-out or the slack:file id
    // from `#resources`). Anything asked of a file position is a no-op.
    if (
      input.position.recordType === SLACK_FILE_TYPE_ID
      || input.position.recordType === resolver.naturalTypeName(SLACK_FILE_TYPE_ID)
      || isSlackFileRecord(payload)
    ) {
      return [];
    }

    // Channel positions: `Messages` (readable history) and `Members`.
    if (this.isRecordOfType(input.position.recordType, SLACK_CHANNEL_TYPE_ID, resolver)) {
      const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
      const channel = payload as SlackChannelRecord | null;
      if (!channel?.id) return [];
      if (edgeId === SLACK_CHANNEL_EDGES.messages) return this.channelMessages(channel.id, input);
      if (edgeId === SLACK_CHANNEL_EDGES.members) return this.channelMembers(channel.id);
      return [];
    }

    // User positions carry no outgoing edges.
    if (this.isRecordOfType(input.position.recordType, SLACK_USER_TYPE_ID, resolver)) {
      return [];
    }

    // A slack:reaction position: hop to the message it's on, the channel it's
    // in, or the user who added it. Each resolves honestly (yields [] when the
    // reacted message / channel / user can't be resolved).
    if (this.isRecordOfType(input.position.recordType, SLACK_REACTION_TYPE_ID, resolver)) {
      const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
      const reaction = (payload ?? {}) as SlackReactionData;
      if (edgeId === SLACK_REACTION_EDGES.message) return this.reactedMessage(reaction);
      if (edgeId === SLACK_REACTION_EDGES.channel) {
        return this.messageChannel({ channel: reaction.item?.channel });
      }
      if (edgeId === SLACK_REACTION_EDGES.reactor) {
        return this.messageAuthor({ user: reaction.user });
      }
      return [];
    }

    // A slack:message position. Resolve the NATURAL edge name to this adapter's
    // read currency (for slack the reference `name` IS the fieldId, so it's
    // identity, but resolve it uniformly so drift on a mistyped edge is loud).
    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId === SLACK_MESSAGE_THREAD_EDGES.replies) {
      return this.messageReplies((payload ?? {}) as SlackMessageData);
    }
    if (edgeId === SLACK_MESSAGE_THREAD_EDGES.author) {
      return this.messageAuthor((payload ?? {}) as SlackMessageData);
    }
    if (edgeId === SLACK_MESSAGE_CHANNEL_EDGE) {
      return this.messageChannel((payload ?? {}) as SlackMessageData);
    }
    if (edgeId !== SLACK_MESSAGE_FILES_REFERENCE) {
      return [];
    }

    const data = (payload ?? {}) as SlackMessageData;
    const files = data.files ?? [];
    // NAME THE TYPE. These are slack:file positions and this method knows it —
    // minting them typeless made every consumer re-derive the fact, which
    // `getFieldValue` did by SNIFFING THE PAYLOAD SHAPE (`isSlackFileRecord`).
    // A shape check standing in for a type is a guess that happens to be right;
    // stamping the natural name, as every other Slack position already does,
    // makes it a fact.
    const naturalFile = (await this.resolver()).naturalTypeName(SLACK_FILE_TYPE_ID);
    const results: RelatedResult[] = [];
    for (const file of files) {
      if (!file.id) continue;
      const record = normalizeSlackFileRef(file);
      results.push({
        position: makeUnstablePosition({
          adapterType: this.adapterType,
          recordType: naturalFile,
          data: record,
        }),
      });
    }
    return results;
  }

  /** Natural-or-internal record-type match for the read-graph branches. */
  private isRecordOfType(
    recordType: string | null | undefined,
    typeId: string,
    resolver: { naturalTypeName(typeId: string): string },
  ): boolean {
    return recordType === typeId || recordType === resolver.naturalTypeName(typeId);
  }

  // ── 4b. The read graph's client-backed fans ──────────────────────────────
  // Channels and users are stable nouns → stable positions (recordId = the
  // Slack C…/U… id), stamped with their NATURAL type names so field reads
  // resolve without another lookup. All reads go through the bot credential;
  // a missing credential fails loudly (a read the author asked for cannot be
  // silently empty).

  /**
   * List conversations resiliently: Slack rejects the WHOLE call with
   * `missing_scope` when the token lacks `groups:read`, even though
   * `channels:read` alone could list every public channel — so on that error
   * retry public-only. Partial data beats an empty workspace (the prod
   * "adapter sees no channels" class, 2026-07-07). Any final failure is
   * enriched with the fix rather than surfacing as a bare platform error.
   */
  private async listConversationsResilient(client: {
    api: { conversations: { list: SlackConversationsList } };
  }): Promise<{ channels: unknown[]; publicOnly: boolean }> {
    const slackError = (err: unknown): string | undefined =>
      (err as { data?: { error?: string } } | undefined)?.data?.error;
    try {
      return { channels: await this.pageConversations(client, 'public_channel,private_channel'), publicOnly: false };
    } catch (err) {
      if (slackError(err) !== 'missing_scope') throw this.enrichListError(err);
      try {
        return { channels: await this.pageConversations(client, 'public_channel'), publicOnly: true };
      } catch (retryErr) {
        throw this.enrichListError(retryErr);
      }
    }
  }

  /**
   * Page through `conversations.list` following `response_metadata.next_cursor`
   * until it's empty — Slack returns ONE page per call, so a single request
   * silently drops every channel past the first page (the "known channel X
   * isn't listed" class). Bounded by `MAX_CONVERSATION_PAGES`; if that cap is
   * hit with a cursor still pending we LOG the truncation rather than pretend
   * the list is complete.
   */
  private async pageConversations(
    client: { api: { conversations: { list: SlackConversationsList } } },
    types: string,
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const listed = await client.api.conversations.list({
        types,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...(listed.channels ?? []));
      cursor = listed.response_metadata?.next_cursor || undefined;
      pages += 1;
      if (cursor && pages >= MAX_CONVERSATION_PAGES) {
        this.sources.log.warn('[SlackAdapter] conversations.list truncated at the page cap', {
          teamId: this.sources.tenant,
          pages,
          listed: all.length,
        });
        break;
      }
    } while (cursor);
    return all;
  }

  private enrichListError(err: unknown): Error {
    const code = (err as { data?: { error?: string } } | undefined)?.data?.error;
    if (code === undefined) return err instanceof Error ? err : new Error(String(err));
    return new Error(
      `Slack couldn't list channels (${code}) — reconnect Slack so the bot token carries ` +
        'the current permissions (channels:read, groups:read).',
    );
  }

  private async listChannelPositions(): Promise<RelatedResult[]> {
    const client = await this.requireSlackApiClient('getRelated(Channels)');
    const resolver = await this.resolver();
    const naturalChannel = resolver.naturalTypeName(SLACK_CHANNEL_TYPE_ID);
    const listed = await this.listConversationsResilient(client);
    const results: RelatedResult[] = [];
    for (const raw of listed.channels) {
      const record = normalizeChannel(raw as Record<string, unknown>);
      if (!record) continue;
      results.push({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: naturalChannel,
          recordId: record.id,
          data: record,
        }),
      });
    }
    return results;
  }

  private async listUserPositions(): Promise<RelatedResult[]> {
    const client = await this.requireSlackApiClient('getRelated(Users)');
    const listed = await client.api.users.list({ limit: 1000 });
    const results: RelatedResult[] = [];
    for (const raw of listed.members ?? []) {
      if ((raw as { deleted?: boolean }).deleted === true) continue;
      const position = await this.userPosition(normalizeUser(raw as Record<string, unknown>));
      if (position) results.push(position);
    }
    return results;
  }

  private async userPosition(record: SlackUserRecord | null): Promise<RelatedResult | null> {
    if (!record) return null;
    const resolver = await this.resolver();
    return {
      position: makeStablePosition({
        adapterType: this.adapterType,
        recordType: resolver.naturalTypeName(SLACK_USER_TYPE_ID),
        recordId: record.id,
        data: record,
      }),
    };
  }

  /**
   * Resolve a channel id → its name — the dispatch gate uses this for the
   * `channels` listen filter (`listen to <slack> { channels: [...] }`), matching
   * an inbound event's channel against the author's names. Cached via
   * `conversations.info` (so the hot path is one call per channel per window);
   * null when there's no usable client or the lookup fails.
   */
  async resolveChannelName(channelId: string): Promise<string | null> {
    const client = await this.getSlackApiClient();
    if (!client) return null;
    try {
      const info = await client.api.conversations.info({ channel: channelId });
      const record = info.channel
        ? normalizeChannel(info.channel as Record<string, unknown>)
        : null;
      return record?.name ?? null;
    } catch (err) {
      this.sources.log.warn('[SlackAdapter] channel-name resolution failed (listen channel filter)', {
        teamId: this.sources.tenant,
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * `reaction-[m:message]->` — the message a reaction is on. Fetched by ts via
   * `conversations.history` (a one-message window: `latest = oldest = ts,
   * inclusive`). HONEST: no channel/ts, no usable client, or a miss (the message
   * was deleted, or is a thread reply history doesn't surface) yields [].
   */
  private async reactedMessage(reaction: SlackReactionData): Promise<RelatedResult[]> {
    const channelId = reaction.item?.channel;
    const ts = reaction.item?.ts;
    if (!channelId || !ts) return [];
    const client = await this.getSlackApiClient();
    if (!client) return [];
    const resolver = await this.resolver();
    const naturalMessage = resolver.naturalTypeName(SLACK_MESSAGE_TYPE_ID);
    try {
      const history = await client.api.conversations.history({
        channel: channelId,
        latest: ts,
        oldest: ts,
        inclusive: true,
        limit: 1,
      });
      const raw = (history.messages ?? [])[0];
      if (!raw) return [];
      return [
        {
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: naturalMessage,
            recordId: `${channelId}:${(raw as { ts?: string }).ts ?? ts}`,
            data: { ...(raw as Record<string, unknown>), channel: channelId },
          }),
        },
      ];
    } catch (err) {
      this.sources.log.warn('[SlackAdapter.getRelated] reacted-message resolution failed', {
        teamId: this.sources.tenant,
        channelId,
        ts,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** `channel-[m:messages]->` — the channel's readable history (what the bot
   *  can see). Top-of-channel messages only; thread replies live behind each
   *  parent's `Replies` edge. A time bound in the hop's WHERE becomes Slack's
   *  own history window (`oldest`/`latest`) rather than a filter over the
   *  newest 200 — see `historyWindowFromWhere`. */
  private async channelMessages(
    channelId: string,
    input: GetRelatedInput,
  ): Promise<RelatedResult[]> {
    const client = await this.requireSlackApiClient('getRelated(messages)');
    // Scoped to Message: the WHERE names its fields naturally (`Timestamp`),
    // and a bare resolver describes nothing to match them against.
    const resolver = await this.resolver({ types: [SLACK_MESSAGE_TYPE_ID] });
    const naturalMessage = resolver.naturalTypeName(SLACK_MESSAGE_TYPE_ID);
    const isTimestampRead = (name: string) =>
      resolver.tryFieldId(naturalName(naturalMessage), naturalName(name))
        === SLACK_MESSAGE_FIELDS.ts;
    const window = historyWindowFromWhere({ where: input.where, isTimestampRead });
    // `conversations.history` answers newest-first and takes no sort order, so
    // a LIMIT is only ours to apply when the hop wants that same order —
    // otherwise the N we kept would be the opposite end from the N the engine
    // is about to take, and the messages the author asked for are simply gone.
    const slackOrder =
      input.orderBy === undefined
      || isNaturalOrder(SLACK_CHANNEL_MESSAGES_CAPABILITY, {
        field: isTimestampRead(input.orderBy.fieldId)
          ? SLACK_MESSAGE_TIMESTAMP_NAME
          : input.orderBy.fieldId,
        direction: input.orderBy.direction,
      });
    const messages = await this.pageHistory({
      client,
      channelId,
      window,
      cap: slackOrder ? input.limit : undefined,
    });
    return messages.map((raw) => ({
      position: makeStablePosition({
        adapterType: this.adapterType,
        recordType: naturalMessage,
        recordId: `${channelId}:${(raw as { ts?: string }).ts ?? ''}`,
        // History messages don't carry their channel — inject it so scalar
        // reads (`Channel`) and the `Replies` walk work off the position.
        data: { ...(raw as Record<string, unknown>), channel: channelId },
      }),
    }));
  }

  /**
   * The history pages behind one `Messages` hop. WITHOUT a time bound we take
   * ONE page and stop — an unfiltered walk has no natural end, and paging a
   * busy channel back to its beginning to throw nearly all of it away is the
   * very cost the bound exists to avoid. WITH a bound the window IS the end
   * condition, so the cursor is followed to it (loudly capped, never silently
   * truncated).
   */
  private async pageHistory(input: {
    client: { api: { conversations: { history: SlackConversationsHistory } } };
    channelId: string;
    window: SlackHistoryWindow;
    cap: number | undefined;
  }): Promise<unknown[]> {
    const bounded = input.window.oldest !== undefined || input.window.latest !== undefined;
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await input.client.api.conversations.history({
        channel: input.channelId,
        limit: HISTORY_PAGE_SIZE,
        ...input.window,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
      pages += 1;
      if (!bounded) break;
      if (input.cap !== undefined && all.length >= input.cap) break;
      if (cursor && pages >= MAX_HISTORY_PAGES) {
        this.sources.log.warn('[SlackAdapter] conversations.history truncated at the page cap', {
          teamId: this.sources.tenant,
          channelId: input.channelId,
          pages,
          fetched: all.length,
        });
        break;
      }
    } while (cursor);
    return input.cap !== undefined ? all.slice(0, input.cap) : all;
  }

  private async channelMembers(channelId: string): Promise<RelatedResult[]> {
    const client = await this.requireSlackApiClient('getRelated(members)');
    const memberIds = new Set(
      ((await client.api.conversations.members({ channel: channelId })).members ?? []),
    );
    if (memberIds.size === 0) return [];
    // One users.list (client-cached) enriches every member; ids the roster
    // doesn't return (rare races) still yield a bare-id record.
    const roster = new Map<string, SlackUserRecord>();
    for (const raw of (await client.api.users.list({ limit: 1000 })).members ?? []) {
      const record = normalizeUser(raw as Record<string, unknown>);
      if (record) roster.set(record.id, record);
    }
    const results: RelatedResult[] = [];
    for (const id of memberIds) {
      const position = await this.userPosition(
        roster.get(id) ?? { id, name: null, real_name: null, email: null },
      );
      if (position) results.push(position);
    }
    return results;
  }

  /** `msg-[r:replies]->` — the thread under this message (replies only, the
   *  parent itself excluded). A message with no thread yields nothing. This
   *  is now the BARE-READ side of `Replies` (the edge is readable AND
   *  awaitable, per the `Called` callback precedent) — a busy thread pages
   *  the same way `pageHistory` pages channel history. */
  private async messageReplies(data: SlackMessageData): Promise<RelatedResult[]> {
    const channelId = data.channel;
    const rootTs = data.thread_ts ?? data.ts;
    if (!channelId || !rootTs) return [];
    const client = await this.requireSlackApiClient('getRelated(replies)');
    const resolver = await this.resolver();
    const naturalMessage = resolver.naturalTypeName(SLACK_MESSAGE_TYPE_ID);
    const messages = await this.pageReplies({ client, channelId, rootTs });
    return messages
      .filter((raw) => (raw as { ts?: string }).ts !== rootTs)
      .map((raw) => ({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: naturalMessage,
          recordId: `${channelId}:${(raw as { ts?: string }).ts ?? ''}`,
          data: { ...(raw as Record<string, unknown>), channel: channelId },
        }),
      }));
  }

  /** Pages `conversations.replies` to the cap, following
   *  `response_metadata.next_cursor` the way `pageHistory` follows it over
   *  channel history — logging and stopping at the cap rather than silently
   *  truncating a thread that outgrows one page. */
  private async pageReplies(input: {
    client: { api: { conversations: { replies: SlackConversationsReplies } } };
    channelId: string;
    rootTs: string;
  }): Promise<unknown[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await input.client.api.conversations.replies({
        channel: input.channelId,
        ts: input.rootTs,
        limit: REPLIES_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
      pages += 1;
      if (cursor && pages >= MAX_REPLIES_PAGES) {
        this.sources.log.warn('[SlackAdapter] conversations.replies truncated at the page cap', {
          teamId: this.sources.tenant,
          channelId: input.channelId,
          rootTs: input.rootTs,
          pages,
          fetched: all.length,
        });
        break;
      }
    } while (cursor);
    return all;
  }

  /** `msg-[u:author]->` — the posting user, resolved via users.info. */
  private async messageAuthor(data: SlackMessageData): Promise<RelatedResult[]> {
    if (!data.user) return [];
    const client = await this.requireSlackApiClient('getRelated(author)');
    const info = await client.api.users.info({ user: data.user });
    const record = info.user
      ? normalizeUser(info.user as Record<string, unknown>)
      : { id: data.user, name: null, real_name: null, email: null };
    const position = await this.userPosition(record);
    return position ? [position] : [];
  }

  /**
   * `msg-[c:channel]->` — the up-hop to the Channel this message is in, so a
   * movement can post a fresh top-level message back to it. HONEST resolution:
   * we only yield a Channel node we can genuinely resolve — no `data.channel`,
   * no usable client, or a failed / channel-less `conversations.info` all yield
   * `[]` rather than fabricating a bare-id Channel. (The common post-back case
   * always resolves: the bot is a member of the channel it was mentioned in.)
   */
  private async messageChannel(data: SlackMessageData): Promise<RelatedResult[]> {
    const channelId = data.channel;
    if (!channelId) return [];
    const client = await this.getSlackApiClient();
    if (!client) return [];
    const resolver = await this.resolver();
    try {
      const info = await client.api.conversations.info({ channel: channelId });
      const record = info.channel
        ? normalizeChannel(info.channel as Record<string, unknown>)
        : null;
      if (!record) return [];
      return [
        {
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: resolver.naturalTypeName(SLACK_CHANNEL_TYPE_ID),
            recordId: record.id,
            data: record,
          }),
        },
      ];
    } catch (err) {
      this.sources.log.warn('[SlackAdapter.getRelated] channel up-hop resolution failed', {
        teamId: this.sources.tenant,
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── 4d. The AWAITABLE capability — `await m-[:Replies]->` (§A) ────────────
  //
  // The proof the awaitable capability isn't ask-shaped (S18, consent-by-
  // silence). Slack advertises `Replies` awaitable because it can CORRELATE, not
  // because a thread is stable: the write handle carries the message's channel +
  // ts, and an inbound thread reply carries the same channel + thread_ts — so the
  // correlation key is `channel:thread_ts`, mapping the thread to its parks.
  //
  // Resolution is EVENT-DRIVEN (no poll): `wakeKeys` names an inbound reply's
  // thread, the engine wakes the parks correlated to it, and `resolveAwait` then
  // re-checks the thread live and binds the reply. The
  // reply's own fields ride the landing raw (the message schema keys them), so a
  // resumed body reads `o.`Message`` / `o.User` through the ordinary message
  // `getFieldValue` — no ask-style Response node.
  //
  // Cancellation is the engine's alone (F7): it drops its correlation row, and
  // there is nothing to freeze about a thread. A reply after the race settles
  // finds no correlation and is just a Slack message.
  readonly awaitable: AwaitableCapability = {
    resolveAwait: async (point: AwaitPoint): Promise<AwaitResolution> => {
      if (
        point.edge !== SLACK_MESSAGE_THREAD_EDGE_NAMES.replies &&
        point.edge !== SLACK_MESSAGE_THREAD_EDGES.replies
      ) {
        throw new Error(
          `SlackAdapter.resolveAwait: '${point.edge}' is not an awaitable edge (only 'Replies').`,
        );
      }
      const anchor = replyAnchorFromParent({
        externalId: point.recordId,
        data: point.headData,
      });
      if (anchor.channelId === undefined) {
        throw new Error(
          'SlackAdapter.resolveAwait: a Replies await needs the message channel to ' +
            'correlate on (headData.channelId) — none was carried.',
        );
      }
      const correlationKey = replyCorrelationKey({ channelId: anchor.channelId, threadTs: anchor.threadTs });
      const client = await this.getSlackApiClient();
      if (!client) {
        this.sources.log.warn('[SlackAdapter.resolveAwait] no Slack client — parking (will retry)', {
          teamId: this.sources.tenant,
          channelId: anchor.channelId,
        });
        return { status: 'pending', correlationKey };
      }
      const resolver = await this.resolver();
      const naturalMessage = resolver.naturalTypeName(SLACK_MESSAGE_TYPE_ID);
      const thread = await client.api.conversations.replies({
        channel: anchor.channelId,
        ts: anchor.threadTs,
        limit: 200,
      });
      // The thread root is the awaited message itself, not a reply — exclude it.
      // A reply always carries content (resolvesEmpty: false), so a non-empty
      // reply set is always a real landing; the engine binds the FIRST match
      // (F9: first landing settles — replies come oldest-first).
      const replies = (thread.messages ?? []).filter(
        (raw) => (raw as { ts?: string }).ts !== anchor.threadTs,
      );
      if (replies.length === 0) return { status: 'pending', correlationKey };
      return {
        status: 'landed',
        correlationKey,
        landings: replies.map((raw) => ({
          recordId: `${anchor.channelId}:${(raw as { ts?: string }).ts ?? ''}`,
          recordType: naturalMessage,
          // The reply message's raw payload — the same shape `getFieldValue` keys
          // a message by (`text`, `user`, `ts`); inject the channel so `Channel`
          // reads and any onward hop resolve off the bound node.
          fields: { ...(raw as Record<string, unknown>), channel: anchor.channelId },
        })),
      };
    },
  };

  /** An inbound thread reply wakes the `Replies` awaits parked on its thread. */
  async wakeKeys(input: { raw: unknown }): Promise<string[]> {
    const keys: string[] = [];
    for (const delivery of parseSlackDeliveries(input.raw)) {
      const reply = SlackThreadReply.safeParse(delivery.event);
      if (!reply.success) continue;
      const { threadTs } = replyAnchorFromParent({ externalId: delivery.recordId, data: reply.data });
      keys.push(replyCorrelationKey({ channelId: reply.data.channel, threadTs }));
    }
    return keys;
  }

  // ── 4c. Actor candidate parsing (acting-user split) ─────────────────────
  // Slack has no service-account concept the way email does (every Slack
  // user is a first-class person), so it surfaces at most one `originator`
  // candidate: the inbound actor's email, resolved at runtime via
  // `users.info` (the Slack bot token carries the `users:read.email` scope
  // — see the connector install scopes). No persistence — no `user_slack`
  // mapping table, no stored actors (ruling 2026-06-01). The call is
  // failure-resilient: any API error / missing scope / missing email
  // swallows to null and yields an empty candidate list.
  //
  // External-system API enrichment (the `users.info` round-trip) is
  // explicitly allowed in `getActorCandidates`; Listen-Fire DB access is NOT.
  // The creator-override (T6), the email→user match, the creator-fallback
  // (`trigger.config.fallbackToCreatorIfActorUnregistered`), and the
  // null-on-no-match rejection all live in `resolveActingUser`.
  //
  // A genuine miss (no actor id, no client, no email on the profile)
  // swallows to an empty candidate list. A `users.info` call that FAILS
  // (missing scope, rate limit, network/outage) is not swallowed — it
  // throws out of `resolveActorEmail` uncaught, so this method rejects too.
  // That lets `consultActorGate` tell "actor unregistered" apart from
  // "couldn't check" (see `resolveActorEmail`'s doc comment).
  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const resolved = await this.resolveActorEmail(input.event);
    if (!resolved) return [];
    // `identifier` stays the raw Slack user id (the source-system primary key);
    // the API-resolved address rides `email`, which makes the candidate
    // email-resolvable (`scheme: 'email'`).
    return [
      {
        identity: {
          identifier: resolved.userId,
          scheme: 'email',
          adapterType: this.adapterType,
          email: resolved.email,
        },
        source: 'originator',
      },
    ];
  }

  /**
   * Resolve the inbound Slack actor's email at runtime via `users.info`.
   *
   * The Slack event payload carries only the user id (`U…`), never an
   * email, so resolving the email requires an API round-trip with the
   * `users:read.email` scope (granted at install — see
   * `adapters/slack/webApi/connector.ts:generateInstallUrl`). T6 makes
   * this call at dispatch and does NOT persist the result.
   *
   * Two different kinds of "no email" get treated differently:
   *   - GENUINE MISSES return null: no actor on the event, no working
   *     Slack API client (missing/malformed credential — `getSlackApiClient`
   *     never throws), or a profile with no email set. These fall through
   *     the resolution chain the same as an unregistered sender.
   *   - A `users.info` call that itself FAILS (missing scope, rate limit,
   *     network error, Slack outage) is not a miss — we don't know whether
   *     the actor is registered, so it THROWS. `getActorCandidates` has no
   *     catch around this call and `resolveActingUser` has no catch around
   *     `getCandidates()`, so the throw propagates to `consultActorGate`'s
   *     own try/catch, which drops the event with the lookup-failure reason
   *     (replayable) instead of the "unregistered sender" reason.
   */
  private async resolveActorEmail(
    event: TriggerEvent,
  ): Promise<{ userId: string; email: string } | null> {
    const actor = await this.extractActor({ event });
    const slackUserId = actor?.identifier;
    if (!slackUserId) return null;

    const client = await this.getSlackApiClient();
    if (!client) return null;

    let info: Awaited<ReturnType<typeof client.api.users.info>>;
    try {
      info = await client.api.users.info({ user: slackUserId });
    } catch (err) {
      this.sources.log.warn('[SlackAdapter] users.info actor-email lookup failed', {
        teamId: this.sources.tenant,
        slackUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const email = info.user?.profile?.email;
    const normalized = email ? email.trim().toLowerCase() : null;
    return normalized ? { userId: slackUserId, email: normalized } : null;
  }

  /**
   * Stamp the workspace's REAL channel names onto the Channel type's `Name`
   * field as OPEN knownValues, so a typo'd `WHERE \`Name\` == "genral"` warns at
   * author time with a did-you-mean (the lookup-miss safety net — §5.4). No
   * knownValuePattern: ids don't belong in a Name equality, so an id-shaped
   * literal warning is a feature. Best-effort: any failure returns the
   * static descriptor with the failure noted, never a false "no channels".
   *
   * The prose says HOW MANY and where to look; it does not list them. It used
   * to inline the first 50, sorted — which on a real workspace reads as the
   * authoritative list while stopping partway through the alphabet. An agent
   * grounding on it called every channel past the cut unknown (reported live
   * against `hjjs-action-items` and `test-inbound-slack`, both real, while the
   * complete list sat in `knownValues` beside it).
   *
   * The list was never truncated; the SECOND COPY of it was. Two renderings of
   * one fact, only one of them complete, is the same defect class as a schema
   * the editor and the compiler each computed their own way: whichever copy the
   * reader happens to trust decides the answer. So there is one list, and the
   * prose points at it instead of paraphrasing it.
   */
  private async withLiveChannelKnownValues(
    descriptor: SchemaTypeDescriptor,
  ): Promise<SchemaTypeDescriptor> {
    const nameField = descriptor.fields.find((f) => f.fieldId === 'name');
    if (!nameField) return descriptor;
    const withNote = (note: string): SchemaTypeDescriptor => ({
      ...descriptor,
      fields: descriptor.fields.map((f) =>
        f === nameField
          ? { ...f, description: `${f.description ?? ''} ${note}`.trim() }
          : f,
      ),
    });
    try {
      const client = await this.getSlackApiClient();
      if (!client) return descriptor;
      const listed = await this.listConversationsResilient(client);
      const names = listed.channels
        .map((ch) => (ch as { name?: unknown }).name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
        .sort();
      if (names.length === 0) return descriptor;
      const noted = withNote(
        `This workspace has ${names.length} ${names.length === 1 ? 'channel' : 'channels'} — ` +
          "every one of them is offered as a value for this field, so use the field's " +
          'own values rather than guessing or assuming a channel is missing.' +
          (listed.publicOnly
            ? ' (Public channels only — reconnect Slack to include private ones.)'
            : ''),
      );
      return {
        ...noted,
        fields: noted.fields.map((f) =>
          f.fieldId === 'name' ? { ...f, knownValues: names } : f,
        ),
      };
    } catch (err) {
      const code =
        (err as { data?: { error?: string } } | undefined)?.data?.error ??
        (err instanceof Error && /\((\w+)\)/.test(err.message)
          ? /\((\w+)\)/.exec(err.message)![1]
          : 'error');
      return withNote(
        `Channel listing unavailable (${code}) — reconnect Slack if this persists.`,
      );
    }
  }

  /** The workspace's client, or null (the read paths that need one answer
   *  nothing without it). The one seam every Slack call goes through. */
  private async getSlackApiClient(): Promise<SlackAPIClient | null> {
    return this.sources.client();
  }

  /**
   * The `File` primitive for a Slack file record — a `FileRef` descriptor
   * naming this instance as the owner and the raw Slack file id as the handle,
   * redeemed through `resolveFileRef`. Returns null when the record carries no
   * file id.
   */
  private slackFileRef(record: SlackFileRecord | null): FileRef | null {
    if (!record?.id) return null;
    const id = record.id;
    const contentType = record.contentType ?? undefined;
    return {
      __brand: 'FileRef',
      name: record.name || undefined,
      contentType,
      size: record.size ?? undefined,
      source: ownedFileSource({
        adapterType: SLACK_ADAPTER_TYPE,
        ...(this.sources.credentialRef !== undefined ? { credentialsId: this.sources.credentialRef } : {}),
        handle: id,
      }),
    };
  }

  // ── 4c. Byte resolution (owner-side) ─────────────────────────────────────
  // Slack OWNS the FILE resources it emits (P4): the host redeems their
  // handle here, on the instance the descriptor names. The handle is the raw Slack file id; Slack file
  // bytes live behind an authenticated `url_private_download`, so we resolve
  // the id to that URL via `files.info` and fetch it WITH the bot token
  // (`SlackAPIClient.fetch` attaches the bearer) — the owner's own creds, as
  // P4 requires. The host receives a Node stream.
  //
  // owners serve bytes
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error(
        `${SLACK_ADAPTER_TYPE}.resolveFileRef: FileRef has no source handle to resolve.`,
      );
    }
    return this.streamSlackFileBytes(handle, input.ref.contentType);
  }

  /**
   * The byte channel for a Slack file id, behind `resolveFileRef` — Slack file
   * bytes live behind an authenticated `url_private_download`, resolved via
   * `files.info` and fetched WITH the bot token (`client.fetch` attaches the
   * bearer). A fresh round trip each call.
   */
  private async streamSlackFileBytes(
    handle: string,
    fallbackContentType?: string,
  ): Promise<ResolveFileRefResult> {
    const client = await this.getSlackApiClient();
    if (!client) throw new Error(this.sources.missingClient('streamSlackFileBytes'));
    const info = await client.api.files.info({ file: handle });
    const downloadUrl =
      info.file?.url_private_download ?? info.file?.url_private ?? undefined;
    if (!downloadUrl) {
      throw new Error(
        `${SLACK_ADAPTER_TYPE}.streamSlackFileBytes: Slack file "${handle}" has no ` +
          `private download URL (missing files:read scope, or the file was deleted).`,
      );
    }
    const res = await this.sources.fetch(downloadUrl, { headers: { Authorization: `Bearer ${client.api.token}` } });
    if (!res.ok || !res.body) {
      throw new Error(
        `${SLACK_ADAPTER_TYPE}.streamSlackFileBytes: download of Slack file "${handle}" ` +
          `failed (status ${res.status}).`,
      );
    }
    return {
      stream: Readable.fromWeb(res.body as unknown as WebReadableStream),
      contentType: res.headers.get('content-type') ?? fallbackContentType ?? undefined,
    };
  }

  // ── 4d. Actor extraction (T5) ────────────────────────────────────────────
  // Raw Slack actor — the user id that posted the inbound message.
  // Independent of auth; populates `@actor_id` so authors can attribute
  // events to their raw originator (the Slack member id) even when auth
  // went through the creator fallback. Email/name slots are left blank:
  // Slack's inbound event_callback payload doesn't carry them without a
  // separate `users.info` round trip, which `extractActor`'s pure-parse
  // contract forbids.
  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    const payload = (input.event.payload ?? {}) as Record<string, unknown>;
    // event_callback envelope: payload.event.user; raw event: payload.user.
    const inner = (payload.event ?? payload) as Record<string, unknown>;
    const userId = inner.user;
    if (typeof userId !== 'string' || userId.length === 0) return null;
    return {
      identifier: userId,
      // Pure parse — no email/phone resolved here, so this identity maps to
      // no Listen-Fire user (`@actor_email` stays null until the candidate path's
      // `users.info` resolution supplies one).
      scheme: 'opaque',
      adapterType: this.adapterType,
      label: userId,
    };
  }

  // ── 5. Writes — target side (edge-anchored posts / replies) ───────────
  // `writeResource` stays undefined: Slack's outbound API doesn't model
  // "attach this set of facts + per-property evidence to an existing
  // message". A Slack Message is created ONLY along an edge — post via a
  // Channel's `Messages`, reply via a message's `Replies` — and the channel
  // + thread come from the parent, never from fields. Overriding
  // `createRecord` here (vs inheriting BaseAdapter's notWriteCapable() throw)
  // is how the framework promotes a source-only adapter to source+target —
  // the method-presence signal the editor's target picker reads.

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const client = await this.requireSlackApiClient('createRecord');
    // Natural currency in: recordType is the written type's displayName,
    // field keys are field displayNames — resolve to internal ids first.
    const resolver = await this.resolver({ types: [input.recordType] });
    const fields = Object.fromEntries(
      Object.entries(input.fields).map(([key, value]) => [
        resolver.fieldId(naturalName(input.recordType), naturalName(key)),
        value,
      ]),
    );
    const parent = singleParentLink(input);
    if (!parent) {
      throw new Error(
        'SlackAdapter.createRecord: a Slack write is created along an edge — ' +
          'post via a Channel (`ch-[:Messages]->`), reply via a message ' +
          '(`msg-[:Replies]->`), or react to one (`msg-[:Reactions]->`). ' +
          'There is no top-level create.',
      );
    }
    const parentTypeId = await this.resolveTypeRef(parent.recordType);
    const edge = naturalName(parent.edgeName);
    if (parentTypeId === SLACK_MESSAGE_TYPE_ID && edge === SLACK_MESSAGE_THREAD_EDGE_NAMES.reactions) {
      const { channelId, ts } = reactionAnchorFromParent(parent);
      if (!channelId) throw new Error(NO_PARENT_CHANNEL('reaction'));
      return addReaction({ client, log: this.sources.log, anchor: { channelId, ts }, fields });
    }
    return createUnifiedMessage({
      client,
      host: this.sources,
      anchor: this.messageWriteAnchor({ parent, parentTypeId, edge }),
      fields,
    });
  }

  /** Dispatch is keyed on the ANCHOR — (parent type, edge) — never on a
   *  sentinel recordType. Parent Channel → post; parent Slack Message →
   *  reply (thread + channel derived from the parent's identity/data). */
  private messageWriteAnchor(input: {
    parent: ParentLink;
    parentTypeId: string;
    edge: string;
  }): SlackWriteAnchor {
    const { parent, parentTypeId, edge } = input;
    if (parentTypeId === SLACK_CHANNEL_TYPE_ID && edge === SLACK_CHANNEL_EDGE_NAMES.messages) {
      return { kind: 'post', channelId: parent.externalId };
    }
    if (parentTypeId === SLACK_MESSAGE_TYPE_ID && edge === SLACK_MESSAGE_THREAD_EDGE_NAMES.replies) {
      const { channelId, threadTs } = replyAnchorFromParent(parent);
      if (!channelId) throw new Error(NO_PARENT_CHANNEL('reply'));
      return { kind: 'reply', channelId, threadTs };
    }
    throw new Error(
      `SlackAdapter.createRecord: a Slack Message cannot be created along '${parent.recordType}'-[:${parent.edgeName}]->.`,
    );
  }

  /**
   * SLACK_MESSAGE — the field function advertised on the message `text`
   * fields. Composes a Slack-formatted message (roster-free; `@[Name]`
   * mention tokens are resolved at the write boundary). No Slack client
   * needed — composition is a pure LLM call.
   *
   */
  async invokeFieldFunction(input: InvokeFieldFunctionInput): Promise<unknown> {
    if (input.functionName.toUpperCase() === SLACK_MESSAGE_FUNCTION.name) {
      return this.sources.compose(input.args as { instructions: string; data: unknown[] });
    }
    throw new Error(
      `SlackAdapter.invokeFieldFunction: unknown function "${input.functionName}" ` +
        `on "${input.recordType}.${input.fieldId}".`,
    );
  }

  /**
   * Slack messages can technically be edited via `chat.update`, but this
   * adapter only ever posts — so an update fails loudly rather than
   * inventing an edit surface the write side never had.
   */
  async updateRecord(_input: UpdateInput): Promise<UpdateResult> {
    throw new Error(
      'SlackAdapter.updateRecord: Slack messages are not updatable through this adapter.',
    );
  }

  /** Slack messages can be deleted via `chat.delete`, but — as with
   *  update — this adapter only ever posts, so deletion is unsupported. */
  async deleteRecord(_input: DeleteInput): Promise<DeleteResult> {
    throw new Error(
      'SlackAdapter.deleteRecord: Slack messages are not deletable through this adapter.',
    );
  }

  /**
   * Like `getSlackApiClient`, but throws on a missing / malformed
   * credential. The actor-email read path is failure-resilient (returns
   * null), but a write with no usable Slack client is a hard
   * misconfiguration — fail loudly so the engine surfaces it rather than
   * silently dropping the post.
   */
  private async requireSlackApiClient(
    op: string,
  ): Promise<SlackAPIClient> {
    const client = await this.getSlackApiClient();
    if (!client) throw new Error(this.sources.missingClient(op));
    return client;
  }
}

/**
 * Normalise a raw Slack file ref (the shape Slack delivers on
 * `event.files[]`) into the adapter's descriptor-aligned record shape.
 * Single conversion point so the FILE Resource builder and the
 * `getRelated('files', …)` fan-out always emit consistent field names.
 */
function normalizeSlackFileRef(file: SlackFileRef): SlackFileRecord {
  const url = file.url_private_download ?? file.url_private ?? null;
  const name = file.name ?? file.title ?? file.id ?? '';
  return {
    id: file.id ?? '',
    name,
    contentType: file.mimetype ?? null,
    url,
    size: file.size ?? null,
    data: null,
  };
}

/**
 * Field reads for slack:file positions. Field ids match the descriptor
 * (`id` / `name` / `contentType` / `url` / `size` / `data`). Unknown
 * ids return null so authors who walk a non-published field get the
 * scalar `null` (matching the message-scalar default), not an exception.
 */
function readSlackFileField(record: SlackFileRecord | null, fieldId: string): unknown {
  if (!record) return null;
  switch (fieldId) {
    case 'id': return record.id || null;
    case 'name': return record.name || null;
    case 'contentType': return record.contentType ?? null;
    case 'url': return record.url ?? null;
    case 'size': return record.size ?? null;
    case 'data': return record.data ?? null;
    default: return null;
  }
}

/**
 * Heuristic: a `webhook-event` position whose `data` carries the
 * normalised file shape (id + name + contentType/url/size/data slots)
 * is a slack:file traversal target, not the inbound Slack event itself.
 * Inbound Slack events don't carry an `id` field on the inner event
 * object (they have `ts` / `event_ts`), so the `id`-typed key is the
 * disambiguator. Field-name diff (`contentType` vs `text`) provides a
 * second-level safety check against ambiguity.
 */
function isSlackFileRecord(data: unknown): data is SlackFileRecord {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.id === 'string' && 'contentType' in obj && 'url' in obj;
}
