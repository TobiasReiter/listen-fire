// Gmail adapter — one Google Workspace mailbox, read as a graph of messages
// and the files on them.
//
// Gmail is a POLLED source: a minute of delay is acceptable, and polling
// removes the Pub/Sub topic, the push endpoint and the weekly watch renewal
// that a push subscription would need. This is the read and send half; event
// production is the module's poll (poll.ts). The type graph itself is
// `schema.ts`; the WHERE pushdown is `filter.ts`.
//
// It is a system beside Slack and Attio, NOT a second implementation of the
// inbound email address: that one only ever sees mail forwarded to it, while
// this one reads a real mailbox the deployment acts as.

import { Readable } from 'node:stream';

import type {
  Adapter,
  EdgesFromResult,
  EventType,
  FileRef,
  GetFieldValueInput,
  GetRelatedInput,
  ParentLink,
  ReadInput,
  RelatedResult,
  ResolveFileRefResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';
import type { ModuleLog } from 'module-kit';

import { fileHandle, singleParentLink } from 'movement-engine/public/adapter';
import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
} from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { uniformWalk } from 'module-kit/adapter/hop';
import { naturalName } from 'module-kit/adapter/name_resolution';
import { moduleFileRef } from 'module-kit/files';
import { GmailApiError, type GmailApiClient } from './api_client';
import { decodeGmailMessage, type GmailMessageRecord } from './mime';
import { gmailQueryFromWhere } from './filter';
import { GMAIL_MANIFEST } from './manifest';
import {
  GMAIL_MAILBOX_DESCRIPTOR,
  GMAIL_MAILBOX_SEARCH,
  GMAIL_ROOT,
  GMAIL_SEARCH_CEILING,
  describeGmailType,
  gmailEntryPoints,
  gmailMessageFieldName,
} from './schema';
import {
  GMAIL_ADAPTER_TYPE,
  GMAIL_ATTACHMENT_DISPLAY_NAME,
  GMAIL_MAILBOX_TYPE_ID,
  GMAIL_MESSAGES_COLLECTION,
  GMAIL_MESSAGE_ATTACHMENTS_EDGE,
  GMAIL_MESSAGE_DISPLAY_NAME,
  GMAIL_MESSAGE_EVENT_TAG,
  GMAIL_MESSAGE_REPLIES_EDGE_NAME,
  GMAIL_MESSAGE_TYPE_ID,
  decodeAttachmentId,
  encodeAttachmentId,
} from './types';
import { replyTargetFromParent, sendGmailMessage } from './write';

import { isNaturalOrder } from '#shared/expression/order_limit';

/** The client the host's credential reaches the mailbox with, asked for per
 *  call: a credential refreshed between calls is read by the next one. */
export type GmailClientSource = () => Promise<GmailApiClient>;

/** What the adapter needs of its host. */
export interface GmailAdapterHost {
  client: GmailClientSource;
  /** The bytes of a file a send was handed. */
  readFile: (ref: FileRef) => Promise<Uint8Array>;
  log: ModuleLog;
}

export class GmailAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = GMAIL_ADAPTER_TYPE;
  readonly supportedTriggers = GMAIL_MANIFEST.supportedTriggers;

  constructor(private readonly host: GmailAdapterHost) {
    super();
  }

  private client(): Promise<GmailApiClient> {
    return this.host.client();
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return gmailEntryPoints();
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    if (typeRef === ADAPTER_META_TYPE_ID || typeRef === GMAIL_MAILBOX_TYPE_ID) {
      return GMAIL_MAILBOX_DESCRIPTOR;
    }
    return describeGmailType(await this.resolveTypeRef(typeRef));
  }

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: GMAIL_ADAPTER_TYPE,
      at: position,
      root: GMAIL_ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  // ── 2. Field-level access ──────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== GMAIL_ADAPTER_TYPE) {
      throw new Error(
        `GmailAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;

    if (input.position.recordType === GMAIL_ATTACHMENT_DISPLAY_NAME && fieldId === 'data') {
      // The one field that is not on the position: the bytes live at Gmail and
      // are fetched when somebody actually reads them.
      return this.attachmentFileRef(data);
    }
    return data[fieldId] ?? null;
  }

  // ── 3. Traversal ───────────────────────────────────────────────────────

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== GMAIL_ADAPTER_TYPE) {
      throw new Error(
        `GmailAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // The root's collection name crosses VERBATIM (a meta position carries no
    // type to resolve an edge against), so match it before the per-type edge
    // resolver, which would drift on the typeless meta position.
    if (input.position.recordType === META_RECORD_TYPE) {
      return input.fieldId === GMAIL_MESSAGES_COLLECTION ? this.searchMessages(input) : [];
    }

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId !== GMAIL_MESSAGE_ATTACHMENTS_EDGE) return [];

    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    const attachments = Array.isArray(data['attachments']) ? data['attachments'] : [];
    return bounded(attachments, input.orderBy === undefined ? input.limit : undefined)
      .map(objectAt)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(attachmentPosition);
  }

  /**
   * The mailbox's search. The WHERE reaches Gmail's `q` and the LIMIT its page
   * size; what is not pushable is left to the engine, so the result is exact
   * regardless of how much travelled — only the amount fetched changes.
   *
   * Gmail returns IDS, so every message is a second request. That is why the
   * ceiling is here rather than left to the caller: an unbounded walk over a
   * real mailbox is tens of thousands of requests, and stopping at a page is
   * the honest bound (`describe` says so).
   */
  private async searchMessages(input: GetRelatedInput): Promise<RelatedResult[]> {
    const client = await this.client();
    const query = gmailQueryFromWhere(input.where);
    // A LIMIT rides along only when the order it came with is the one Gmail
    // answers in (or none was asked for): a limit taken without the sort it
    // came with answers a different question — the newest n, not the oldest.
    const inSourceOrder =
      input.orderBy === undefined ||
      isNaturalOrder(GMAIL_MAILBOX_SEARCH, {
        field: gmailMessageFieldName(input.orderBy.fieldId) ?? input.orderBy.fieldId,
        direction: input.orderBy.direction,
      });
    const cap = Math.min(
      inSourceOrder ? (input.limit ?? GMAIL_SEARCH_CEILING) : GMAIL_SEARCH_CEILING,
      GMAIL_SEARCH_CEILING,
    );

    const { messages } = await client.listMessages({
      ...(query !== undefined ? { query } : {}),
      maxResults: cap,
    });
    const records = await Promise.all(
      bounded(messages, cap).map(async (ref) => decodeGmailMessage(await client.getMessage(ref.id))),
    );
    return records.map(messagePosition);
  }

  // ── 4. Read-back by id ─────────────────────────────────────────────────

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    const typeId = await this.resolveTypeRef(input.recordType);
    if (typeId !== GMAIL_MESSAGE_TYPE_ID) {
      // An attachment has no life of its own — it is read by walking the
      // message that carries it.
      return null;
    }
    const client = await this.client();
    try {
      return { ...decodeGmailMessage(await client.getMessage(input.externalId)) };
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
  }

  // ── 5. Byte resolution (owner-side) ────────────────────────────────────
  // Gmail OWNS the files it hands out: they name themselves by the module's
  // handle, the host names them as the install's, and redeems them here.

  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    const pair = handle === undefined ? undefined : decodeAttachmentId(handle);
    if (pair === undefined) {
      throw new Error(
        `${GMAIL_ADAPTER_TYPE}.resolveFileRef: FileRef has no message/attachment handle to resolve.`,
      );
    }
    return this.fetchAttachment(pair, input.ref.contentType);
  }

  private async fetchAttachment(
    pair: { messageId: string; attachmentId: string },
    contentType: string | undefined,
  ): Promise<ResolveFileRefResult> {
    const bytes = await (await this.client()).getAttachment(pair);
    return {
      stream: Readable.from(bytes),
      ...(contentType !== undefined ? { contentType } : {}),
      size: bytes.byteLength,
    };
  }

  /** The `File` primitive for an attachment — named by this module's handle
   *  (the message and attachment pair), redeemed through `resolveFileRef`.
   *  Null when the position names no file. */
  private attachmentFileRef(data: Record<string, unknown>): FileRef | null {
    const messageId = stringAt(data['messageId']);
    const attachmentId = stringAt(data['attachmentId']);
    const filename = stringAt(data['filename']);
    if (messageId === null || attachmentId === null || filename === null) return null;
    const contentType = stringAt(data['contentType']) ?? 'application/octet-stream';
    const size = typeof data['size'] === 'number' ? data['size'] : undefined;
    return moduleFileRef({
      adapterType: GMAIL_ADAPTER_TYPE,
      handle: encodeAttachmentId({ messageId, attachmentId }),
      name: filename,
      contentType,
      ...(size !== undefined ? { size } : {}),
    });
  }

  // ── 6. Writes — send and reply ─────────────────────────────────────────
  // Dispatch is on the ANCHOR — where the write was written — never on a field
  // and never on a sentinel record type. `updateRecord` / `deleteRecord` stay
  // inherited throws: mail that has been sent cannot be edited or recalled, and
  // this connection could not delete one if it wanted to.

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const client = await this.client();
    const typeId = await this.resolveTypeRef(input.recordType);
    if (typeId !== GMAIL_MESSAGE_TYPE_ID) {
      throw new Error(
        `GmailAdapter.createRecord: '${input.recordType}' is not something this ` +
          'mailbox can create — a Gmail write is a Message, sent or replied.',
      );
    }
    // Natural currency in: the field keys are display names, so resolve them to
    // this adapter's own ids before anything reads them.
    const resolver = await this.resolver({ types: [input.recordType] });
    const fields = Object.fromEntries(
      Object.entries(input.fields).map(([key, value]) => [
        resolver.fieldId(naturalName(input.recordType), naturalName(key)),
        value,
      ]),
    );

    const parent = singleParentLink(input);
    return sendGmailMessage({
      client,
      readFile: this.host.readFile,
      log: this.host.log,
      fields,
      ...(parent !== undefined ? { replyTo: await this.replyTarget(parent) } : {}),
    });
  }

  /** The conversation a reply joins, read off the parent the write was anchored
   *  on. Any other parent is an anchor this adapter has no meaning for, and
   *  saying so beats sending mail somewhere nobody asked. */
  private async replyTarget(parent: ParentLink): Promise<ReturnType<typeof replyTargetFromParent>> {
    const parentTypeId = await this.resolveTypeRef(parent.recordType);
    const edge = naturalName(parent.edgeName);
    if (parentTypeId !== GMAIL_MESSAGE_TYPE_ID || edge !== naturalName(GMAIL_MESSAGE_REPLIES_EDGE_NAME)) {
      throw new Error(
        `GmailAdapter.createRecord: a Gmail Message cannot be created along ` +
          `'${parent.recordType}'-[:${parent.edgeName}]->. Send along the ` +
          'mailbox’s `Messages` edge, or reply along a message’s `Replies` edge.',
      );
    }
    return replyTargetFromParent(parent);
  }

  // ── 7. Event typing ────────────────────────────────────────────────────

  async listEventTypes(): Promise<EventType[]> {
    // The PollSource tags every event it produces, so discrimination is by tag
    // alone — never by sniffing the payload.
    return [
      {
        tag: GMAIL_MESSAGE_EVENT_TAG,
        positionType: GMAIL_MESSAGE_TYPE_ID,
        match: { path: 'id', equals: [] },
      },
    ];
  }
}

// ── Position minting ────────────────────────────────────────────────────────
// Every Gmail node has a durable id, so every position is STABLE. An attachment
// carries a COMPOSITE id (message + attachment) because Gmail scopes an
// attachment id to its message.

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...value }
    : undefined;
}

function stringAt(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function messagePosition(message: GmailMessageRecord): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: GMAIL_ADAPTER_TYPE,
      recordType: GMAIL_MESSAGE_DISPLAY_NAME,
      recordId: message.id,
      data: { ...message },
    }),
  };
}

function attachmentPosition(data: Record<string, unknown>): RelatedResult {
  const messageId = stringAt(data['messageId']) ?? '';
  const attachmentId = stringAt(data['attachmentId']) ?? '';
  return {
    position: makeStablePosition({
      adapterType: GMAIL_ADAPTER_TYPE,
      recordType: GMAIL_ATTACHMENT_DISPLAY_NAME,
      recordId: encodeAttachmentId({ messageId, attachmentId }),
      data,
    }),
  };
}

function bounded<T>(rows: T[], limit: number | undefined): T[] {
  return limit !== undefined && limit >= 0 ? rows.slice(0, limit) : rows;
}
