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
import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
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
} from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { LinkedIdentity, ModuleIdentities, ModuleLog } from 'module-kit';

import { fileHandle, ownedFileSource, singleParentLink } from 'movement-engine/public/adapter';
import { META_RECORD_TYPE, makeStablePosition, makeUnstablePosition, positionData } from 'movement-engine/public/catalog';
import { uniformWalk } from 'module-kit/adapter/hop';
import { BaseAdapter } from 'module-kit/adapter/base';
import { naturalName } from 'module-kit/adapter/name_resolution';
import { TelegramClient, sendUnifiedTelegramMessage, type TelegramWriteAnchor } from './write';
import { telegramInboundEvents } from './inbound';
import { TELEGRAM_MANIFEST } from './manifest';
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
  type TelegramMessagePayload,
} from './types';

/**
 * What the adapter reaches Telegram and the host through. The host decides
 * which bot speaks for an install (the team's own, or a shared one it runs)
 * and keeps the record of who linked; the adapter only uses them.
 */
export interface TelegramSources {
  /** The bot for this install; null when no usable bot token is reachable.
   *  Read paths never need one, so only a send or a download asks. */
  client(): Promise<TelegramClient | null>;
  /** Why `client` gave none, for the error a call that needs one raises. */
  missingClient(op: string): string;
  identities: ModuleIdentities;
  /** The host's name for the install's credential, which an attachment's file
   *  source carries so the host redeems it on this same install. */
  credentialRef?: string;
  log: ModuleLog;
}


export class TelegramAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = TELEGRAM_ADAPTER_TYPE;
  readonly supportedTriggers = TELEGRAM_MANIFEST.supportedTriggers;

  runtimeCapabilities(): RuntimeCapabilities {
    return { traversal: { incoming: false, edgeProperties: false }, resources: false };
  }

  constructor(private readonly sources: TelegramSources) {
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
      const linked = await this.sources.identities.list();
      return linked.map((identity) => ({ position: this.linkedUserPosition(identity) }));
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
      const identity = await this.sources.identities.find(senderId);
      return identity === null ? [] : [{ position: this.linkedUserPosition(identity) }];
    } catch (err) {
      this.sources.log.warn('[TelegramAdapter.getRelated] sender up-hop resolution failed', {
        senderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** A linked person as a node: their id is the private chat a send targets. */
  private linkedUserPosition(identity: LinkedIdentity): SourcePosition {
    return makeStablePosition({
      adapterType: this.adapterType,
      recordType: 'Linked User',
      recordId: identity.externalId,
      data: { chat_id: identity.externalId, email: identity.email, linked_at: identity.linkedAt },
    });
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
    return { events: telegramInboundEvents(input.raw) };
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
      const email = (await this.sources.identities.find(telegramUserId))?.email;
      if (typeof email !== 'string' || email.length === 0) return null;
      return email.trim().toLowerCase();
    } catch (err) {
      this.sources.log.warn('[TelegramAdapter] linked identity actor-email resolution failed', {
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
    const client = await this.sources.client();
    if (!client) throw new Error(this.sources.missingClient('resolveFileRef'));
    const file = await client.getFile(fileId);
    if (!file.file_path) {
      throw new Error(
        `${TELEGRAM_ADAPTER_TYPE}: Telegram file "${fileId}" has no file_path.`,
      );
    }
    const res = await client.fetch(client.fileUrl(file.file_path));
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
        ...(this.sources.credentialRef !== undefined ? { credentialsId: this.sources.credentialRef } : {}),
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
      log: this.sources.log,
      anchor,
      text,
      ...(fields.reply_markup !== undefined ? { replyMarkup: fields.reply_markup } : {}),
    });
  }

  /**
   * Answer a button tap — the MANDATORY ack (the tapper's client shows a
   * progress indicator until it lands) plus the keyboard retirement. Not a
   * movement write: no record position, no field mapping; the adapter itself
   * speaking as the bot, as the shared bot's handshake reply does. Lives here
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

  // ── The bot ───────────────────────────────────────────────────────────

  /** The install's bot, or a loud error naming why there is none: a call that
   *  speaks to Telegram with no usable client is a misconfiguration, not a
   *  silent drop. */
  private async requireClient(op: string): Promise<TelegramClient> {
    const client = await this.sources.client();
    if (!client) throw new Error(this.sources.missingClient(op));
    return client;
  }
}
