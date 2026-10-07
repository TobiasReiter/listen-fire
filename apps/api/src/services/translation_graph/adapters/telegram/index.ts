// Telegram adapter — ONE `telegram:message` type, readable AND writable
// (message-write-unification chunk 3). Inbound Telegram updates arrive as
// webhook POSTs (`preprocessInbound`, tagged so `listEventTypes` can seed a
// STABLE position). Outbound is the SAME type, created only along an edge:
//
//   Linked User -[:Messages]-> Telegram Message  — a proactive DM (chat id =
//                                                   the linked user's own id)
//   msg         -[:Replies]->  Telegram Message  — a threaded reply
//
// The chat and the reply target come from the parent, never from fields
// (`createRecord` → Bot API `sendMessage`). Modeled on the Slack adapter's
// edge-anchored send + the WhatsApp adapter's media receive: a
// `-[:Attachments]->` fan-out to `telegram:attachment`, identity by the
// Telegram user (no email — the WhatsApp non-email-originator pattern), and
// `resolveFileRef` turning a Bot API `file_id` into bytes via `getFile`.

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { z } from 'zod';

import type { WebhookEvent } from '../../../webhook_sync/providers/interface';
import { webhookEventToDiscriminable } from '../../../webhook_sync/event_conversion';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  DiscriminableEvent,
  EdgesFromResult,
  EventType,
  FileRef,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  ResolveFileRefResult,
  RuntimeCapabilities,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../adapter';
import { fileHandle, ownedFileSource, singleParentLink } from '../../adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from '../../types';
import { META_RECORD_TYPE, makeStablePosition, makeUnstablePosition, positionData } from '../../types';
import { uniformWalk } from '../hop';
import type { TriggerEvent } from '../../triggers/types';
import { BaseAdapter } from '../base';
import { naturalName } from '../name_resolution';
import { decryptToken } from '../../../../lib/credentials';
import { getQb, getAutomationsQb } from '../../../../lib/kysely';
import { injectFakeBaseUrl, isTestHarnessTeam } from '../../../../lib/recording';
import { logger } from '../../../logger';
import {
  TelegramClient,
  sendUnifiedTelegramMessage,
  type TelegramWriteAnchor,
} from './write';
import { TELEGRAM_HANDBOOK_SECTION } from './handbook_section';
import {
  TELEGRAM_ADAPTER_TYPE,
  TELEGRAM_ATTACHMENTS_FIELD,
  TELEGRAM_ATTACHMENT_TYPE_ID,
  TELEGRAM_ATTACHMENT_DISPLAY_NAME,
  TELEGRAM_EDGE_NAMES,
  TELEGRAM_LINKED_USER_TYPE_ID,
  TELEGRAM_MESSAGE_SENDER_EDGE,
  TELEGRAM_MESSAGE_TYPE_ID,
  type TelegramAttachment,
  type TelegramMessage,
  type TelegramMessagePayload,
  type TelegramUpdate,
} from './types';

export {
  TELEGRAM_ADAPTER_TYPE,
  TELEGRAM_MESSAGE_TYPE_ID,
  TELEGRAM_ATTACHMENT_TYPE_ID,
  TELEGRAM_ATTACHMENTS_FIELD,
  type TelegramMessagePayload,
};

/** Stored Telegram credential — just the bot token. */
const telegramCredsParser = z.object({
  botToken: z.string(),
  baseUrl: z.string().url().optional(),
});

/**
 * The shape of a CONNECTED-but-secret-less Telegram credential: the "empty
 * credential" a team creates to opt into the optional shared built-in bot
 * (Chunk 7). It satisfies movement-lang's `telegram(credentials: …)`
 * construction requirement and signals "this team connected the shared bot",
 * but carries NO bot token — the transport secret stays the env
 * `TELEGRAM_BOT_TOKEN`. A `baseUrl` may still ride it (e.g. the harness),
 * and any other keys are ignored. `botToken` is optional + blank-tolerant so
 * `{}`, `{ botToken: '' }`, and `{ baseUrl }` all parse as "empty".
 *
 */
const telegramEmptyCredsParser = z.object({
  botToken: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

/** Is a decrypted Telegram payload secret-less (the connected-empty case)? */
function hasUsableBotToken(payload: { botToken?: string }): boolean {
  return typeof payload.botToken === 'string' && payload.botToken.trim().length > 0;
}

/**
 * The shared built-in Listen-Fire bot token, read from `TELEGRAM_BOT_TOKEN`. Optional
 * by design — the env var is unset in most environments, and the adapter only
 * needs it when a team without its own BYO credential attempts a send. Read
 * directly off `process.env` (rather than the throwing `getEnvVar`) so an unset
 * token yields null instead of crashing construction; an empty/whitespace value
 * is treated as unset.
 *
 */
function builtInBotToken(): string | null {
  const raw = process.env.TELEGRAM_BOT_TOKEN;
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length > 0 ? token : null;
}

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. Telegram is BOTH source (inbound text + media) and
 * target (`createRecord` sends a message — a real write).
 *
 */
export const TELEGRAM_MANIFEST: AdapterManifest = {
  adapterType: TELEGRAM_ADAPTER_TYPE,
  displayName: 'Telegram',
  website: 'https://telegram.org',
  category: 'Messaging',
  description:
    'Telegram. Run movements on messages your bot receives, reply in-thread, ' +
    'and DM people who have linked Telegram — every send anchors on a message ' +
    'or a linked user.',
  triggerExpectation:
    'Telegram delivers a message to the bot only when the bot is in the chat ' +
    'AND the message reaches it: in a private one-to-one chat the bot sees ' +
    'every message sent to it; in a group it sees only direct replies to it ' +
    'and @-mentions. The bot has NO access to the user\'s other chats — their ' +
    'Telegram at large is never read. The natural framing is the bot chat as ' +
    'a deliberate capture channel: the user messages (or forwards to) the bot ' +
    'and that is the trigger surface. Do not promise "every message in a ' +
    'group": that requires the bot-OWNER disabling privacy mode in BotFather, ' +
    'which for Listen-Fire\'s built-in shared bot is not available (it stays on) — ' +
    'only a team running its own bot can change it, so if a user wants ' +
    'all-group capture, say it needs their own bot and ask. ' +
    'On the built-in shared bot, only linked senders reach a team at all: a ' +
    'person must complete the /start handshake before their messages route ' +
    'anywhere. A team running its own bot has no such gate — every update ' +
    'their bot sees routes to them, linked or not.',
  supportedTriggers: ['webhook'],
  // `createRecord` sends the unified message along an edge — a DM (Linked
  // User's `Messages`) or a threaded reply (a message's `Replies`) — a real
  // write (so Telegram is writable). `updateRecord` / `deleteRecord` are NOT
  // listed: the overrides throw (v1 only sends), so they aren't genuine
  // implementations. `listEventTypes` tags the inbound message so the engine
  // seeds a STABLE position (what lets a reply write anchor off the inbound).
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated',
    'preprocessInbound', 'getActorCandidates', 'extractActor', 'resolveFileRef',
    'createRecord', 'listEventTypes',
  ],
  requiredCredentialType: ExternalServiceType.TELEGRAM,
  triggerKinds: ['TELEGRAM'],
  handbookSection: TELEGRAM_HANDBOOK_SECTION,
  vocabulary: {
    icon: {
      d: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
      fill: true,
    },
  },
};

export class TelegramAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = TELEGRAM_ADAPTER_TYPE;
  readonly supportedTriggers = TELEGRAM_MANIFEST.supportedTriggers;

  runtimeCapabilities(): RuntimeCapabilities {
    return { traversal: { incoming: false, edgeProperties: false }, resources: false };
  }

  constructor(
    readonly teamId: TeamId,
    readonly credentialsId?: string,
  ) {
    super();
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // The EVENT edge lands STRAIGHT on the message: `tg -[:Telegram
      // Message]-> <the message>`. A separate `Message Received` node carried
      // no facts of its own — pure indirection — so rule 1
      // (adapters/CLAUDE.md) collapses it: a listen delivers the message
      // itself, whole (seeded stable on its message_id). `readable: false`
      // stays the honest statement — the Bot API cannot enumerate the updates
      // the bot was sent; a fires edge is reachability, never a root read.
      // Telegram has no change-kind axis (no `events:` vocabulary), so no
      // `action` field and no `firesOn`.
      {
        typeId: TELEGRAM_MESSAGE_TYPE_ID,
        displayName: 'Message',
        writable: false,
        readable: false,
        fires: true,
      },
      {
        typeId: TELEGRAM_ATTACHMENT_TYPE_ID,
        displayName: TELEGRAM_ATTACHMENT_DISPLAY_NAME,
        writable: false,
        // Reached only via `msg-[:Attachments]->` — no root collection.
        readable: false,
      },
      // The one LISTABLE noun Telegram has: linked users. The Bot API cannot
      // enumerate chats, but the handshake's identity table can — each row is
      // a person who linked this team's bot, and their user id IS the private
      // chat id a send targets.
      {
        typeId: TELEGRAM_LINKED_USER_TYPE_ID,
        displayName: 'Linked User',
        collectionName: 'Linked Users',
        description: 'A person who has linked Telegram via the connect handshake.',
        writable: false,
        readable: true,
      },
    ];
  }

  /**
   * Telegram has one thing you can list and one thing that happens to you.
   *
   * `Attachment` is absent on purpose — it hangs off a Message, so the walk
   * reaches it a hop in rather than the root claiming a read of every file
   * ever sent.
   */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Telegram',
    description:
      'A Telegram connection. The people who have linked their account can be ' +
      'listed; conversations cannot — a message has to arrive.',
    fields: [],
    references: [
      {
        fieldId: TELEGRAM_MESSAGE_TYPE_ID,
        targetTypeId: TELEGRAM_MESSAGE_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: 'Message',
        fires: true,
        readable: false,
        description: 'Somebody messaging the bot — what a listen delivers.',
      },
      {
        fieldId: TELEGRAM_LINKED_USER_TYPE_ID,
        targetTypeId: TELEGRAM_LINKED_USER_TYPE_ID,
        cardinality: 'many',
        direction: 'outgoing',
        name: 'Linked Users',
        description: 'People who have linked their Telegram account to Listen-Fire.',
        // Nothing about a linked user is intrinsically ordered — but each one
        // landed here at a moment we recorded, and the fetch orders by it
        // (`getRelated` below: `.orderBy('linked_at', 'asc')`).
        sequenced: 'arrival',
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: TELEGRAM_ADAPTER_TYPE,
      at: position,
      root: TelegramAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // Accept the NATURAL type name (engine/checker currency) or the internal id.
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === TELEGRAM_MESSAGE_TYPE_ID) {
      return {
        typeId: TELEGRAM_MESSAGE_TYPE_ID,
        displayName: 'Message',
        description:
          'A Telegram message — what a listen delivers, whole: read ' +
          '`e.`Text`` straight off the event, reply along its `Replies` edge. ' +
          'Created only along an edge: DM a linked user via their `Messages` ' +
          'edge, reply via a message\'s `Replies` edge — the chat and the ' +
          'reply target come from the parent, never from fields.',
        fields: [
          { fieldId: 'message_id', displayName: 'Message Id', kind: 'string', writable: false, required: true, description: 'The Telegram message id.' },
          {
            fieldId: 'text',
            displayName: 'Text',
            kind: 'string',
            writable: true,
            required: true,
            uiHint: 'textarea',
            description:
              'The message text. On an inbound message: the received text (or the media ' +
              'caption; empty for caption-less media). On a send: the message body — required.',
          },
          {
            fieldId: 'reply_markup',
            displayName: 'Reply Markup',
            kind: 'json',
            // ONE object — Telegram's `reply_markup` is a single object whose
            // `inline_keyboard` holds the rows, not a list at the top level.
            writable: true,
            // Send-side only: buttons ride the outbound message. A received
            // message never reads one back, so declaring it readable would leak
            // an always-null property (the File duality fix, 2026-07-13).
            readable: false,
            required: false,
            description:
              'Telegram\'s `reply_markup`, exactly as the Bot API spells it — passed ' +
              'through verbatim (no wrapping, no typed shape here; a malformed keyboard ' +
              'surfaces as a loud Telegram error at run time). Usually an inline ' +
              'keyboard: rows of buttons, each `{ text, url }` (opens a link) or ' +
              '`{ text, callback_data }` (a tap this bot handles, capped by Telegram at ' +
              '64 BYTES). To make a tap DO something, mint a callback ' +
              '(`c = callback({ … })`) and put `"${c.id}"` in `callback_data` — it fits ' +
              'the 64-byte cap comfortably — one callback per button, since its body is ' +
              'what that button means. Telegram captures nothing at tap time, so a ' +
              'callback fired from a keyboard takes no values; anything a person has to ' +
              'fill in needs a `url` button instead. ' +
              'Buttons compose with everything else on the send. ' +
              'Build strings with "${…}" interpolation (never `+`, which is numeric ' +
              'addition). Example:\n' +
              '{ inline_keyboard: [\n' +
              '  [ { text: "Approve", callback_data: "${approve.id}" },\n' +
              '    { text: "Decline", callback_data: "${decline.id}" } ],\n' +
              '] }',
          },
          { fieldId: 'chat_id', displayName: 'Chat Id', kind: 'string', writable: false, required: true, description: 'The id of the chat the message belongs to — the value to send a reply back to.' },
          { fieldId: 'chat_type', displayName: 'Chat Type', kind: 'string', writable: false, required: false, description: 'private / group / supergroup / channel.' },
          { fieldId: 'sender_id', displayName: 'Sender Id', kind: 'string', writable: false, required: false, description: 'The numeric id of the user who sent the message.' },
          { fieldId: 'sender_username', displayName: 'Sender Username', kind: 'string', writable: false, required: false, description: 'The @username of the sender, when set.' },
          { fieldId: 'sender_first_name', displayName: 'Sender First Name', kind: 'string', writable: false, required: false, description: 'The sender\'s first name.' },
          { fieldId: 'date', displayName: 'Date', kind: 'string', writable: false, required: false, description: 'When the message was sent (ISO-8601).' },
        ],
        references: [
          {
            fieldId: TELEGRAM_ATTACHMENTS_FIELD,
            targetTypeId: TELEGRAM_ATTACHMENT_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: TELEGRAM_EDGE_NAMES.attachments,
            // Read-only: Telegram attaches inbound media itself; a send's
            // file rides the send, never a created child.
            writable: false,
            description:
              'Files attached to the message — documents, photos, voice notes, audio (zero or more).',
          },
          {
            fieldId: 'replies',
            targetTypeId: TELEGRAM_MESSAGE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: TELEGRAM_EDGE_NAMES.replies,
            writable: true,
            readable: false,
            description:
              'Send a reply threaded under this message (write-only — the Bot API cannot ' +
              'list replies). The chat and the reply target come from this message.',
          },
          {
            fieldId: TELEGRAM_MESSAGE_SENDER_EDGE,
            targetTypeId: TELEGRAM_LINKED_USER_TYPE_ID,
            cardinality: 'one',
            direction: 'outgoing',
            name: TELEGRAM_EDGE_NAMES.sender,
            description:
              'The linked user who sent this message — resolves only for a sender who ' +
              'completed the connect handshake (private chats); a group chat or an ' +
              'unlinked sender resolves to nothing.',
          },
        ],
      };
    }
    if (typeId === TELEGRAM_LINKED_USER_TYPE_ID) {
      return {
        typeId: TELEGRAM_LINKED_USER_TYPE_ID,
        displayName: 'Linked User',
        description:
          'A person who linked Telegram via the connect handshake. Their ' +
          '`Chat Id` is the value a send targets (private chat id = user id).',
        fields: [
          { fieldId: 'chat_id', displayName: 'Chat Id', kind: 'string', writable: false, required: true, description: 'The private chat id a send targets (= the Telegram user id).' },
          { fieldId: 'email', displayName: 'Email', kind: 'string', writable: false, required: true, description: 'The Listen-Fire account email this Telegram user linked as.' },
          { fieldId: 'linked_at', displayName: 'Linked At', kind: 'string', writable: false, required: false, description: 'When the link handshake completed (ISO-8601).' },
        ],
        references: [
          {
            fieldId: 'messages',
            targetTypeId: TELEGRAM_MESSAGE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: TELEGRAM_EDGE_NAMES.messages,
            writable: true,
            readable: false,
            description:
              'Send a message into this person\'s private bot chat (write-only — the Bot ' +
              'API cannot list a chat\'s history). The chat id is the linked user\'s own id.',
          },
        ],
      };
    }
    if (typeId === TELEGRAM_ATTACHMENT_TYPE_ID) {
      return {
        typeId: TELEGRAM_ATTACHMENT_TYPE_ID,
        displayName: TELEGRAM_ATTACHMENT_DISPLAY_NAME,
        fields: [
          { fieldId: 'file_id', displayName: 'File Id', kind: 'string', writable: false, required: true, description: 'The Bot API file id — resolves to the file bytes.' },
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true },
          { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: false },
          { fieldId: 'size', displayName: 'Size', kind: 'number', writable: false, required: false },
          // `data` is the binary handle — the File primitive, matching the
          // Slack/WhatsApp attachment File field so File-typed expressions
          // route into File-typed targets.
          { fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false },
        ],
        references: [],
      };
    }
    return null;
  }

  // ── 2. Entity resolution ──────────────────────────────────────────────
  // Inherits BaseAdapter's linked-object id match on the message id.

  // ── 3. Field-level access ─────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== this.adapterType) {
      throw new Error(
        `TelegramAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const typeId = await this.resolveTypeRef(input.position.recordType ?? TELEGRAM_MESSAGE_TYPE_ID);
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);

    if (typeId === TELEGRAM_ATTACHMENT_TYPE_ID) {
      const att = (positionData(input.position) ?? {}) as Partial<TelegramAttachment>;
      // `data` is the File primitive — mint a self-retrieving FileRef (the
      // same contract as the email / whatsapp / manual attachment builders).
      if (fieldId === 'data') return this.telegramAttachmentFileRef(att);
      return (att as Record<string, unknown>)[fieldId] ?? null;
    }
    // Message scalars — a plain lookup on the normalised payload.
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    return data[fieldId] ?? null;
  }

  // ── 4. Reference traversal (attachments) ──────────────────────────────

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== this.adapterType) {
      throw new Error(
        `TelegramAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // Meta root → the Linked Users collection (the identity table; no Bot
    // API call — Telegram cannot enumerate chats, our handshake records can).
    if (input.position.recordType === META_RECORD_TYPE) {
      if (naturalName(input.fieldId) !== 'Linked Users' && naturalName(input.fieldId) !== 'Linked User') {
        return [];
      }
      const rows = await getAutomationsQb(['telegram_identity'] as const)
        .selectFrom('telegram_identity')
        .where('team_id', '=', this.teamId as never)
        .select(['telegram_user_id', 'email', 'linked_at'])
        .orderBy('linked_at', 'asc')
        .execute();
      return rows.map((row) => ({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: 'Linked User',
          recordId: row.telegram_user_id,
          data: {
            chat_id: row.telegram_user_id,
            email: row.email,
            linked_at: row.linked_at instanceof Date ? row.linked_at.toISOString() : String(row.linked_at),
          },
        }),
      }));
    }

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId === TELEGRAM_MESSAGE_SENDER_EDGE) {
      return this.messageSender((positionData(input.position) ?? {}) as Partial<TelegramMessagePayload>);
    }
    if (edgeId !== TELEGRAM_ATTACHMENTS_FIELD) return [];

    const data = (positionData(input.position) ?? {}) as Partial<TelegramMessagePayload>;
    const attachments = data.attachments ?? [];
    return attachments.map((att) => ({
      position: makeUnstablePosition({
        adapterType: this.adapterType,
        recordType: TELEGRAM_ATTACHMENT_DISPLAY_NAME,
        data: att,
      }),
    }));
  }

  /**
   * `m-[:Sender]->` — the Linked User who sent this message. HONEST resolution:
   * a Linked User is yielded ONLY for a sender bound to THIS team via the
   * connect handshake (`telegram_identity`). A group chat where the sender never
   * linked, a missing `sender_id`, or a DB hiccup all yield [] rather than a
   * fabricated user — the same team-clamped, failure-resilient read the actor
   * path uses.
   */
  private async messageSender(
    data: Partial<TelegramMessagePayload>,
  ): Promise<RelatedResult[]> {
    const senderId = data.sender_id;
    if (typeof senderId !== 'string' || senderId.length === 0) return [];
    try {
      const row = await getAutomationsQb(['telegram_identity'])
        .selectFrom('telegram_identity')
        .where('telegram_user_id', '=', senderId)
        .where('team_id', '=', this.teamId as unknown as string)
        .select(['telegram_user_id', 'email', 'linked_at'])
        .executeTakeFirst();
      if (!row) return [];
      return [
        {
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: 'Linked User',
            recordId: row.telegram_user_id,
            data: {
              chat_id: row.telegram_user_id,
              email: row.email,
              linked_at:
                row.linked_at instanceof Date ? row.linked_at.toISOString() : String(row.linked_at),
            },
          }),
        },
      ];
    } catch (err) {
      logger.warn('[TelegramAdapter.getRelated] sender up-hop resolution failed', {
        teamId: this.teamId,
        senderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── 5. Inbound (webhook) ──────────────────────────────────────────────
  // Telegram POSTs one `Update` per delivery. We normalise the message into a
  // single `telegram:message` event (tagged so the engine doesn't re-match)
  // and skip any update that carries no message (edited messages, channel
  // posts, callback queries, …) — v1 fires on plain messages only.

  /**
   * THE raw→events seam for the BYO door (`/api/public/webhook-sync/telegram/
   * <subId>`): the same pure `parseTelegramEvents` + legacy conversion the
   * shared-bot classifier uses, so both doors emit byte-identical events.
   * (Replaces an earlier divergent implementation that never ran — the
   * handler used the provider's `parseEvents` until that seam was retired.)
   */
  async preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[] }> {
    return { events: parseTelegramEvents(input.raw).map(telegramEventToDiscriminable) };
  }

  /**
   * Every dispatched Telegram delivery is a message — a concrete record keyed
   * by its message_id. Declaring the event type lets the engine seed a STABLE
   * `Telegram Message` position, which is what lets a reply write anchor off
   * the inbound event (`write m-[:Replies]->` needs a durable parent id — the
   * chunk-1 ff2bc7432 wall, pre-empted here). Tag-only: the normalized payload
   * carries no literal discriminator, so the parse classifies and tags.
   */
  async listEventTypes(): Promise<EventType[]> {
    return [{ tag: 'message', positionType: TELEGRAM_MESSAGE_TYPE_ID }];
  }

  // ── 6. Actor candidate parsing (acting-user split) ────────────────────
  // A Telegram sender is identified by the team-scoped binding in
  // `adapters.telegram_identity` (`telegram_user_id → email`, populated by the
  // authenticated deep-link handshake). The adapter's job is to map its
  // external token → an email; the framework's team-clamped
  // `lookupTeamUserByEmail` turns that email into the run's ActingUser. An
  // unbound sender resolves to no email → no actor → the dispatch is ignored.
  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const actor = await this.extractActor(input);
    if (!actor) return [];
    return [{ identity: actor, source: 'originator' }];
  }

  // ── 6b. Actor extraction (@actor_*) ───────────────────────────────────
  // Resolve the Telegram sender to an email-bearing identity via the adapter's
  // OWN store, scoped to this adapter's team. The numeric user id stays the
  // `identifier` (the source-system primary key) and the username/first name
  // ride `name`/`label` so `@actor_*` still surfaces the raw Telegram sender;
  // the resolved `email` + `scheme: 'email'` is the AUTHENTICATION key the
  // framework matches against the team's users. An unbound sender (no row for
  // this team) → `null` (no actor; downstream ignores it). The store read is
  // team-scoped here, and the framework's `lookupTeamUserByEmail` is itself
  // hard-clamped to the team — identification can never cross teams.
  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    const payload = (input.event.payload ?? {}) as Partial<TelegramMessagePayload>;
    const senderId = payload.sender_id;
    if (typeof senderId !== 'string' || senderId.length === 0) return null;

    const email = await this.resolveActorEmail(senderId);
    if (!email) return null;

    const username = payload.sender_username;
    const firstName = payload.sender_first_name;
    return {
      identifier: senderId,
      scheme: 'email',
      adapterType: this.adapterType,
      email,
      name: firstName ?? undefined,
      label: username ? `@${username}` : (firstName ?? senderId),
    };
  }

  /**
   * Map a Telegram user id → the bound Listen-Fire email, scoped to THIS adapter's
   * team. Reads `adapters.telegram_identity` WHERE `telegram_user_id` AND
   * `team_id` match — `UNIQUE(team_id, telegram_user_id)` guarantees at most
   * one row, so a single `executeTakeFirst` is exact. Returns null when the
   * sender has no binding in this team (the cross-team clamp: a row owned by a
   * different team is invisible here). Failure-resilient — a DB error swallows
   * to null so a read-path hiccup ignores rather than throws into dispatch.
   *
   */
  private async resolveActorEmail(telegramUserId: string): Promise<string | null> {
    try {
      const row = await getAutomationsQb(['telegram_identity'])
        .selectFrom('telegram_identity')
        .where('telegram_user_id', '=', telegramUserId)
        .where('team_id', '=', this.teamId as unknown as string)
        .select(['email'])
        .executeTakeFirst();
      const email = row?.email;
      if (typeof email !== 'string' || email.length === 0) return null;
      return email.trim().toLowerCase();
    } catch (err) {
      logger.warn('[TelegramAdapter] telegram_identity actor-email resolution failed', {
        teamId: this.teamId,
        telegramUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── 7. Byte resolution (owner-side) ───────────────────────────────────
  // Telegram OWNS the attachments it emits: the host redeems an attachment's
  // handle (the Bot API `file_id`) here, on the instance the descriptor names. Telegram's download
  // is two-step — `getFile(file_id)` returns a `file_path`, then the bytes live
  // at `<base>/file/bot<token>/<file_path>`. Both legs go through the
  // base-URL-aware client, so the fake server serves them under the dev loop.
  //
  // owners serve bytes
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error(
        `${TELEGRAM_ADAPTER_TYPE}.resolveFileRef: FileRef has no source handle to resolve.`,
      );
    }
    return this.downloadFile(handle, input.ref.contentType);
  }

  /** The two-leg Bot API download (`getFile` → file-path bytes) behind
   *  owner-side redemption (`resolveFileRef`). */
  private async downloadFile(
    fileId: string,
    fallbackContentType?: string,
  ): Promise<ResolveFileRefResult> {
    const client = await this.getClient();
    if (!client) {
      throw new Error(
        `${TELEGRAM_ADAPTER_TYPE}: no usable Telegram credential for team ` +
          `${this.teamId} (credentialsId=${this.credentialsId ?? 'unset'}).`,
      );
    }
    const file = await client.getFile(fileId);
    if (!file.file_path) {
      throw new Error(
        `${TELEGRAM_ADAPTER_TYPE}: Telegram file "${fileId}" has no file_path.`,
      );
    }
    const res = await fetch(client.fileUrl(file.file_path));
    if (!res.ok || !res.body) {
      throw new Error(
        `${TELEGRAM_ADAPTER_TYPE}: download of Telegram file "${fileId}" ` +
          `failed (status ${res.status}).`,
      );
    }
    return {
      stream: Readable.fromWeb(res.body as unknown as WebReadableStream),
      contentType: res.headers.get('content-type') ?? fallbackContentType ?? undefined,
    };
  }

  /** Mint the attachment's File primitive: a FileRef descriptor naming this
   *  instance (its credential) as the owner and the `file_id` as the handle. */
  private telegramAttachmentFileRef(att: Partial<TelegramAttachment>): FileRef | null {
    const fileId = att.file_id;
    if (!fileId) return null;
    const contentType = att.contentType ?? undefined;
    return {
      __brand: 'FileRef',
      name: att.name ?? fileId,
      contentType,
      size: att.size ?? undefined,
      source: ownedFileSource({
        adapterType: TELEGRAM_ADAPTER_TYPE,
        ...(this.credentialsId !== undefined ? { credentialsId: this.credentialsId } : {}),
        handle: fileId,
      }),
    };
  }

  // ── 8. Writes — target side (send a message) ──────────────────────────

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const client = await this.requireClient('createRecord');
    // Natural currency in: recordType is the unified type's displayName,
    // field keys are field displayNames — resolve to internal ids first.
    const resolver = await this.resolver({ types: [input.recordType] });
    const fields = Object.fromEntries(
      Object.entries(input.fields).map(([key, value]) => [
        resolver.fieldId(naturalName(input.recordType), naturalName(key)),
        value,
      ]),
    );
    const text = typeof fields.text === 'string' && fields.text.length > 0 ? fields.text : undefined;
    if (!text) {
      throw new Error('TelegramAdapter.createRecord: a Telegram Message needs a non-empty Text.');
    }
    const anchor = await this.resolveWriteAnchor(input);
    return sendUnifiedTelegramMessage({
      client,
      anchor,
      text,
      ...(fields.reply_markup !== undefined ? { replyMarkup: fields.reply_markup } : {}),
    });
  }

  /**
   * Answer a button tap — the MANDATORY ack (the tapper's client shows a
   * progress indicator until it lands) plus the keyboard retirement. Not a
   * movement write: no record position, no field mapping; the adapter itself
   * speaking as the bot, exactly like {@link sendBuiltInReply}. Lives here
   * rather than in the callback door so both doors reach a bot token through
   * the one credential-resolution path.
   */
  async answerCallbackQuery(input: { callbackQueryId: string; text?: string }): Promise<void> {
    const client = await this.requireClient('answerCallbackQuery');
    await client.answerCallbackQuery({
      callback_query_id: input.callbackQueryId,
      // Telegram caps the toast at 200 characters and rejects a longer one.
      ...(input.text !== undefined ? { text: input.text.slice(0, 200) } : {}),
    });
  }

  /** Retire the inline keyboard on a message the bot sent — Telegram's
   *  equivalent of replacing the original: `editMessageReplyMarkup` with no
   *  `reply_markup` removes it. */
  async clearReplyMarkup(input: { chatId: string; messageId: number }): Promise<void> {
    const client = await this.requireClient('clearReplyMarkup');
    await client.editMessageReplyMarkup({
      chat_id: input.chatId,
      message_id: input.messageId,
    });
  }

  /** Dispatch is keyed on the ANCHOR — (parent type, edge) — never on a
   *  sentinel recordType. Parent Linked User → DM (their id IS the private
   *  chat id); parent Telegram Message → threaded reply (chat from the
   *  parent's data, reply target from its externalId). */
  private async resolveWriteAnchor(input: WriteInput): Promise<TelegramWriteAnchor> {
    const parent = singleParentLink(input);
    if (!parent) {
      throw new Error(
        'TelegramAdapter.createRecord: a Telegram Message is created along an edge — ' +
          'DM a linked user (`u-[:Messages]->`) or reply to a message ' +
          '(`msg-[:Replies]->`). There is no top-level send.',
      );
    }
    const parentTypeId = await this.resolveTypeRef(parent.recordType);
    const edge = naturalName(parent.edgeName);
    if (parentTypeId === TELEGRAM_LINKED_USER_TYPE_ID && edge === TELEGRAM_EDGE_NAMES.messages) {
      return { kind: 'dm', chatId: parent.externalId };
    }
    if (parentTypeId === TELEGRAM_MESSAGE_TYPE_ID && edge === TELEGRAM_EDGE_NAMES.replies) {
      const chatId =
        typeof parent.data?.chat_id === 'string' && parent.data.chat_id.length > 0
          ? parent.data.chat_id
          : undefined;
      if (!chatId) {
        throw new Error(
          'TelegramAdapter.createRecord(reply): the parent message carries no chat_id — ' +
            'its parent data must include `chat_id` (inbound payload / write handle).',
        );
      }
      const replyTo = Number(parent.externalId);
      if (!Number.isFinite(replyTo)) {
        throw new Error(
          `TelegramAdapter.createRecord(reply): parent externalId "${parent.externalId}" is not a message id.`,
        );
      }
      return { kind: 'reply', chatId, replyToMessageId: replyTo };
    }
    throw new Error(
      `TelegramAdapter.createRecord: a Telegram Message cannot be created along '${parent.recordType}'-[:${parent.edgeName}]->.`,
    );
  }

  /** Telegram messages can be edited (`editMessageText`), but v1 only sends —
   *  match that parity and fail loudly rather than inventing an edit surface. */
  async updateRecord(_input: UpdateInput): Promise<UpdateResult> {
    throw new Error(
      'TelegramAdapter.updateRecord: Telegram messages are not updatable through this adapter (v1 only sends new messages).',
    );
  }

  async deleteRecord(_input: DeleteInput): Promise<DeleteResult> {
    throw new Error(
      'TelegramAdapter.deleteRecord: Telegram messages are not deletable through this adapter (v1 only sends new messages).',
    );
  }

  // ── Credential / client loading ───────────────────────────────────────

  /**
   * Lazily load a base-URL-aware Telegram client. Resolution order (Pillar A —
   * built-in bot from env, BYO door open + Chunk 7's connected-empty credential):
   *   1. BYO — a per-team `TELEGRAM` credential wired (`credentialsId`) whose
   *      decrypted payload carries a real bot token → build from THAT token.
   *   2. Connected-empty — a wired `TELEGRAM` credential whose payload is
   *      secret-less (`{}`, `{ botToken: '' }`, or just a `{ baseUrl }`). This
   *      is the team's "connect the shared bot" gesture: treated EXACTLY like
   *      the no-credential case → fall back to the env built-in token (honoring
   *      any `baseUrl` on the empty payload + the harness injection).
   *   3. Built-in — no credential at all but `TELEGRAM_BOT_TOKEN` set → the
   *      shared Listen-Fire bot token.
   *   4. Neither — return null. Construction never throws; only an actual send
   *      (`requireClient`) surfaces the missing-token error, so read-only /
   *      inbound paths don't break.
   *
   * So the effective rule is: **botToken present → BYO; empty/absent credential
   * → built-in env (if set); neither → error only on send.** Returns null (not
   * throws) when a credential id is wired but the row/payload is missing or
   * malformed — read paths must never break dispatch. Under the test-harness
   * team the base url is swapped to the fake-channels host on EVERY path so the
   * dev-loop fake Bot API is hit.
   *
   */
  private async getClient(): Promise<TelegramClient | null> {
    if (this.credentialsId) return this.getCredentialedClient(this.credentialsId);
    return this.getBuiltInClient();
  }

  /**
   * Resolve a client from a wired per-team `TELEGRAM` credential. A real
   * `botToken` → BYO (the per-team token). A secret-less ("empty") credential —
   * the connect-the-shared-bot gesture — falls back to the built-in env token,
   * carrying any `baseUrl`/harness override the empty payload supplies so the
   * dev-loop fake is still hit.
   */
  private async getCredentialedClient(credentialsId: string): Promise<TelegramClient | null> {
    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', this.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();
    if (!row) return null;

    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch {
      return null;
    }

    // BYO — the payload carries a real bot token. Use it verbatim (unchanged).
    const byo = telegramCredsParser.safeParse(this.applyFakeBaseUrl(payload));
    if (byo.success && hasUsableBotToken(byo.data)) {
      return new TelegramClient(byo.data.botToken, byo.data.baseUrl);
    }

    // Connected-empty — a secret-less `TELEGRAM` credential. Treat it exactly
    // like the no-credential case: fall back to the env built-in token. Any
    // `baseUrl` the empty payload carries (e.g. the harness) is honored.
    const empty = telegramEmptyCredsParser.safeParse(payload);
    const baseUrlOverride = empty.success ? empty.data.baseUrl : undefined;
    return this.getBuiltInClient(baseUrlOverride);
  }

  /** Built-in path — the shared Listen-Fire bot, its token read from the
   *  `TELEGRAM_BOT_TOKEN` environment variable. Returns null when unset (a send
   *  then errors clearly via `requireClient`). The base url is still swapped to
   *  the fake-channels host under the harness team, so Chunk 5's dev-loop E2E
   *  hits the fake Bot API on the built-in client. An optional `baseUrlOverride`
   *  (from a connected-empty credential's `baseUrl`) is honored when the harness
   *  injection doesn't already supply one. */
  private getBuiltInClient(baseUrlOverride?: string): TelegramClient | null {
    const botToken = builtInBotToken();
    if (!botToken) return null;
    const base = this.applyFakeBaseUrl({ botToken }) as { botToken: string; baseUrl?: string };
    const payload =
      base.baseUrl === undefined && baseUrlOverride !== undefined
        ? { ...base, baseUrl: baseUrlOverride }
        : base;
    const parsed = telegramCredsParser.safeParse(payload);
    if (!parsed.success) return null;
    return new TelegramClient(parsed.data.botToken, parsed.data.baseUrl);
  }

  /** Inject the fake-channels base url onto a creds payload under the
   *  test-harness team; identity otherwise. Shared by the BYO + built-in
   *  paths so both hit the dev-loop fake. */
  private applyFakeBaseUrl(payload: unknown): unknown {
    return isTestHarnessTeam(this.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'TELEGRAM')
      : payload;
  }

  /**
   * Send a plain text message through the SHARED built-in bot — the channel the
   * shared-bot `/start` handshake uses for its confirmation/reject reply. This
   * is NOT a movement write (no record position, no field mapping); it is the
   * adapter itself speaking as the built-in bot, so it deliberately bypasses
   * `createRecord` and rides the built-in client directly. The base-URL swap to
   * the fake Bot API still applies under the harness team (the client comes from
   * `getBuiltInClient`), so the dev-loop E2E sees the reply in the outbox.
   *
   */
  async sendBuiltInReply(input: { chatId: string; text: string }): Promise<void> {
    const client = this.getBuiltInClient();
    if (!client) {
      throw new Error(
        'TelegramAdapter.sendBuiltInReply: TELEGRAM_BOT_TOKEN is unset — the shared ' +
          'built-in bot cannot send the handshake reply. Set TELEGRAM_BOT_TOKEN.',
      );
    }
    await client.sendMessage({ chat_id: input.chatId, text: input.text });
  }

  /** Like `getClient`, but throws on a missing/malformed credential — a write
   *  with no usable client is a hard misconfiguration, not a silent drop. The
   *  message names BOTH resolution paths so a misconfig is unambiguous: either
   *  wire a per-team Telegram credential, or set `TELEGRAM_BOT_TOKEN`. */
  private async requireClient(op: string): Promise<TelegramClient> {
    const client = await this.getClient();
    if (!client) {
      throw new Error(
        `TelegramAdapter.${op}: no usable Telegram bot token for team ${this.teamId} ` +
          `(credentialsId=${this.credentialsId ?? 'unset'}; TELEGRAM_BOT_TOKEN ` +
          `${builtInBotToken() ? 'set' : 'unset'}). Connect a Telegram credential ` +
          `or set TELEGRAM_BOT_TOKEN for the shared built-in bot.`,
      );
    }
    return client;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalise a raw Telegram `Message` into the flat adapter-side payload the
 * schema descriptor advertises. `text` falls back to `caption` (a media
 * message's text rides the caption); attachments cover a document and the
 * largest photo size.
 */
/** Telegram `User` (the message `from`). `.passthrough()` so extra Bot API
 *  fields don't reject an otherwise-valid update. */
const telegramUserSchema = z
  .object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const telegramChatSchema = z
  .object({
    id: z.number(),
    type: z.string().optional(),
    title: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const telegramFileSchema = z
  .object({
    file_id: z.string(),
    file_unique_id: z.string().optional(),
    file_name: z.string().optional(),
    mime_type: z.string().optional(),
    file_size: z.number().optional(),
  })
  .passthrough();

const telegramPhotoSizeSchema = z
  .object({
    file_id: z.string(),
    file_unique_id: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    file_size: z.number().optional(),
  })
  .passthrough();

const telegramMessageSchema = z
  .object({
    message_id: z.number(),
    from: telegramUserSchema.optional(),
    chat: telegramChatSchema,
    date: z.number().optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    document: telegramFileSchema.optional(),
    photo: z.array(telegramPhotoSizeSchema).optional(),
    voice: telegramFileSchema.optional(),
    audio: telegramFileSchema.optional(),
  })
  .passthrough();

/** A Telegram `Update`. v1 fires on plain messages only — `edited_message`,
 *  `channel_post`, `callback_query`, … are accepted (so parsing doesn't throw)
 *  but yield no events. */
const telegramUpdateSchema = z
  .object({
    update_id: z.number().optional(),
    message: telegramMessageSchema.optional(),
  })
  .passthrough();

/**
 * Pure per-delivery parser — shares the adapter's `normalizeMessage` so the
 * flattened payload matches what `getFieldValue` reads off `data`. Consumed
 * by BOTH doors: the TelegramAdapter's `preprocessInbound` (BYO) and the
 * shared-bot classifier (`telegram_builtin.ts`).
 */
/** The one WebhookEvent→DiscriminableEvent mapper BOTH Telegram doors use
 *  (BYO `preprocessInbound`, shared-bot `telegram_builtin.ts`): the legacy
 *  conversion + the parse-time classification as `tag`, so discrimination
 *  types the delivery (tag-only event types — the payload carries no
 *  literal discriminator). */
export function telegramEventToDiscriminable(e: WebhookEvent): DiscriminableEvent {
  return {
    ...webhookEventToDiscriminable(e),
    tag: e.eventType,
    // A delivery is the adapter's one event kind. The changeType is a
    // stored-receipt fact these days (nothing routes on it since the variant
    // retirement); the SEED routes on discrimination — `listEventTypes`
    // names `telegram:message`, whose entry now carries the fires edge
    // itself, so the engine seeds the message stable on its message_id.
    ...(e.eventType === 'message' ? { changeType: 'create' as const } : {}),
  };
}

export function parseTelegramEvents(body: unknown): WebhookEvent[] {
  const parsed = telegramUpdateSchema.safeParse(body);
  if (!parsed.success || !parsed.data.message) return [];

  // Share the adapter's normaliser so the flattened payload the provider
  // emits matches exactly what the source-side adapter's `getFieldValue`
  // expects to read off `data`.
  const payload = normalizeMessage(parsed.data.message as TelegramMessage);

  return [
    {
      eventType: 'message',
      recordId: payload.message_id,
      objectId: TELEGRAM_MESSAGE_TYPE_ID,
      // Telegram surfaces the sender but it's a Telegram user id, not an
      // Listen-Fire authentication actor — leave undefined (same call the Slack
      // provider makes).
      actor: undefined,
      rawPayload: payload,
      // Telegram delivers whole messages, not field-level diffs — no pruning.
      changedFields: undefined,
    },
  ];
}

export function normalizeMessage(message: TelegramMessage): TelegramMessagePayload {
  const attachments: TelegramAttachment[] = [];
  if (message.document) {
    attachments.push({
      file_id: message.document.file_id,
      name: message.document.file_name ?? message.document.file_id,
      contentType: message.document.mime_type ?? null,
      size: message.document.file_size ?? null,
    });
  }
  if (message.photo && message.photo.length > 0) {
    // Telegram delivers photo sizes smallest→largest; take the largest.
    const largest = message.photo[message.photo.length - 1];
    attachments.push({
      file_id: largest.file_id,
      name: `photo_${largest.file_unique_id}.jpg`,
      contentType: 'image/jpeg',
      size: largest.file_size ?? null,
    });
  }
  if (message.voice) {
    // A voice note is always OGG/OPUS and carries no filename — synthesise one
    // so the extension classifies it downstream.
    attachments.push({
      file_id: message.voice.file_id,
      name: `voice_${message.voice.file_unique_id ?? message.voice.file_id}.ogg`,
      contentType: message.voice.mime_type ?? 'audio/ogg',
      size: message.voice.file_size ?? null,
    });
  }
  if (message.audio) {
    attachments.push({
      file_id: message.audio.file_id,
      name: message.audio.file_name ?? `audio_${message.audio.file_unique_id ?? message.audio.file_id}`,
      contentType: message.audio.mime_type ?? null,
      size: message.audio.file_size ?? null,
    });
  }
  return {
    message_id: String(message.message_id),
    text: message.text ?? message.caption ?? '',
    chat_id: String(message.chat.id),
    chat_type: message.chat.type,
    sender_id: message.from ? String(message.from.id) : '',
    sender_username: message.from?.username,
    sender_first_name: message.from?.first_name,
    date: typeof message.date === 'number'
      ? new Date(message.date * 1000).toISOString()
      : undefined,
    attachments,
  };
}

/** Factory for the registry. */
export function createTelegramAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): Adapter {
  return new TelegramAdapter(input.teamId, input.credentialsId);
}
