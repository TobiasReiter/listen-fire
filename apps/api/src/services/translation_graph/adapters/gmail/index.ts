// Gmail adapter — one Google Workspace mailbox, read as a graph of messages
// and the files on them.
//
// Gmail is READ-ONLY here and a POLLED source: a minute of delay is acceptable,
// and polling removes the Pub/Sub topic, the push endpoint and the weekly watch
// renewal that a push subscription would need. This is the read half; event
// production lives on the PollSource (gmail/poll.ts). The type graph itself is
// `schema.ts`; the WHERE pushdown is `filter.ts`.
//
// It is a system beside Slack and Attio, NOT a second implementation of the
// inbound email address: that one only ever sees mail forwarded to it, while
// this one reads a real mailbox the deployment acts as.

import { Readable } from 'node:stream';


import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  Adapter,
  AdapterManifest,
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
} from '../../adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from '../../types';

import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { fileHandle, ownedFileSource, singleParentLink } from '../../adapter';
import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
} from '../../types';
import { BaseAdapter } from '../base';
import { uniformWalk } from '../hop';
import { naturalName } from '../name_resolution';
import { GmailApiError } from '../../../../adapters/gmail/apiClient';
import { decodeGmailMessage, type GmailMessageRecord } from '../../../../adapters/gmail/mime';
import { resolveGmailClient, type GmailApiClient } from './client';
import { gmailQueryFromWhere } from './filter';
import {
  GMAIL_MAILBOX_DESCRIPTOR,
  GMAIL_MAILBOX_SEARCH,
  GMAIL_ROOT,
  GMAIL_SEARCH_CEILING,
  GMAIL_WRITE_RULE,
  describeGmailType,
  gmailEntryPoints,
  gmailMessageFieldName,
} from './schema';
import {
  GMAIL_ADAPTER_TYPE,
  GMAIL_ATTACHMENT_DISPLAY_NAME,
  GMAIL_ATTACHMENT_TYPE_ID,
  GMAIL_MAILBOX_TYPE_ID,
  GMAIL_MESSAGES_COLLECTION,
  GMAIL_MESSAGE_ATTACHMENTS_EDGE,
  GMAIL_MESSAGE_DISPLAY_NAME,
  GMAIL_MESSAGE_EVENT_TAG,
  GMAIL_MESSAGE_RECEIVED_EVENT,
  GMAIL_MESSAGE_REPLIES_EDGE_NAME,
  GMAIL_MESSAGE_TYPE_ID,
  GMAIL_SUBSCRIBABLE_EVENTS,
  decodeAttachmentId,
  encodeAttachmentId,
} from './types';
import { replyTargetFromParent, sendGmailMessage } from './write';

import { isNaturalOrder } from '#shared/expression/order_limit';

export {
  GMAIL_ADAPTER_TYPE,
  GMAIL_ATTACHMENT_TYPE_ID,
  GMAIL_MAILBOX_TYPE_ID,
  GMAIL_MESSAGE_EVENT_TAG,
  GMAIL_MESSAGE_TYPE_ID,
};

const GMAIL_HANDBOOK_CONTENT = `Gmail is ONE connected mailbox — a real Google Workspace address the connection is signed in as. It is not the forwarding address: that one only ever sees mail somebody sent to it, while this reads the inbox itself.

### running when mail arrives

\`\`\`
listen to gmail { query: "from:@acme.com" } fire triage
\`\`\`

A listener fires once per message that has arrived since the last look, a minute or so behind. \`query\` is a Gmail search written exactly as you would type it into Gmail's own search box, and it narrows what is delivered; \`pollIntervalSeconds\` overrides the one-minute default. \`labels\` says which arrivals count — mail landing in the inbox unless you say otherwise. Write \`labels: ["INBOX", "SPAM"]\` when mail you must not miss can land in Spam, such as cold inbound. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Messages\` when you want history.

### reading the message

\`\`\`
function triage(msg: <gmail-[:Message]->>) {
  who  = msg.\`From\`
  what = msg.\`Body\`
}
\`\`\`

\`Body\` is the one to reach for: it is the plain text, derived from the HTML when the message carried only HTML. \`Plain Body\` and \`HTML Body\` are there when you need the alternative that actually arrived. \`From\` is the whole header, display name included; \`To\` and \`Cc\` are lists of addresses. \`Labels\` are Gmail's label ids — \`INBOX\`, \`UNREAD\` and the rest in capitals, a user label by its own name.

### searching the mailbox

\`\`\`
recent = gmail-[m:Messages WHERE \`From\` contains "acme.com" AND \`Date\` >= DATE.TODAY - 7 DAYS]->
\`\`\`

\`Subject\`, \`From\`, \`To\`, \`Cc\`, \`Labels\`, \`Date\` and \`Body\` reach Gmail's own search; everything else is applied after the fetch, so the result is the same either way and only the amount fetched changes. A walk stops at ${GMAIL_SEARCH_CEILING} messages, because every message costs its own request — narrow it or give it a \`LIMIT\` rather than expecting the whole mailbox. Gmail answers newest first, so \`ORDER BY Date DESC LIMIT n\` costs n requests; any other \`ORDER BY\` fetches up to ${GMAIL_SEARCH_CEILING} and sorts them here.

### attachments

\`\`\`
msg-[a:Attachments]-> { … a.\`File\` … }
\`\`\`

Listing them is free — the names, types and sizes ride the message. Only reading \`File\` fetches bytes, so a message whose files nobody opens costs nothing. \`Has Attachments\` answers "are there any" without a walk.

### sending and replying

\`\`\`
write mail-[:Messages]-> {
  To: ["rita@acme.com"]
  Subject: "Your Q3 figures"
  Body: "Attached, as promised."
  Files: [doc]
}
\`\`\`

\`\`\`
write msg-[:Replies]-> { Body: "Got it — looking now." }
\`\`\`

${GMAIL_WRITE_RULE} So a reply names only what it says: it answers whoever sent the message it hangs off, it carries that subject with \`Re:\` in front, and Gmail files it in the same conversation. Override \`To\`, \`Cc\` or \`Subject\` on a reply when you mean something other than the obvious, and reach for \`HTML Body\` beside \`Body\` when the message needs formatting — both go out, and a reader that cannot show HTML still sees the text. \`Files\` takes a list of file values the run already holds; the files on a message you RECEIVED are on its \`Attachments\` edge instead.

Mail always leaves as the connected mailbox — \`From\` is not writable, because that address is the only one this deployment is allowed to be.

### what this connection cannot do

It reads mail and sends mail. It can NEVER label, archive, delete, mark as read, or touch a draft — the two scopes it holds are read and send, so those are not features waiting to be built but things the mailbox has not granted. Say so rather than working around it. A message that is edited or re-labelled afterwards does not fire again: arrival is the only event here, and nothing fires on mail this mailbox sends. Reading always works; SENDING works only where the installation enabled it, and a mailbox without it refuses a send saying so, with reads unaffected — so a send failing never means the mailbox is disconnected. An installation may also limit which addresses can be connected at all.`;

/**
 * Static manifest. A polled source AND a target: `createRecord` sends as the
 * mailbox, along the root's `Messages` edge for new mail and along a message's
 * `Replies` edge for a reply.
 */
export const GMAIL_MANIFEST: AdapterManifest = {
  adapterType: GMAIL_ADAPTER_TYPE,
  displayName: 'Gmail',
  website: 'https://mail.google.com',
  category: 'Email',
  description:
    'One Google Workspace mailbox, read and written by automations. Run when ' +
    'mail arrives, search the inbox, read a message with its attachments, and ' +
    'send or reply as the mailbox. Connected by signing in as that mailbox, so ' +
    'the connection reaches it and no other address; sending is available only ' +
    'where the installation enabled it.',
  authoringHints:
    'Gmail reads and sends, and does nothing else: no labelling, archiving, ' +
    'deleting or drafts at all — those scopes were never granted. Reading ' +
    'always works; a mailbox whose installation did not enable sending refuses ' +
    'a send outright and says so, and that never means reads are broken too. ' +
    'Read `Body` ' +
    'for what a message says; `Plain Body` and `HTML Body` are the alternatives ' +
    `as they arrived. ${GMAIL_WRITE_RULE} A send sets \`To\`, \`Subject\` and ` +
    '`Body`; a reply needs only a body. Subject, From, To, Cc, Labels, Date and ' +
    'Body reach Gmail’s own search; a walk with no WHERE stops at ' +
    `${GMAIL_SEARCH_CEILING} messages, since each one costs a request. A ` +
    'listener’s `query` option is a Gmail search string written exactly as ' +
    'in Gmail’s search box; its `labels` option (Gmail label ids, default ' +
    '`["INBOX"]`) says which arrivals count, so add `"SPAM"` when mail that ' +
    'must not be missed can land in Spam. The first poll delivers nothing.',
  handbookSection: {
    title: 'Gmail: one connected mailbox',
    content: GMAIL_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'One kind: `message_received`. It fires once per message that has ARRIVED ' +
    'in the mailbox since the last poll, about a minute behind, narrowed by the ' +
    '`query` listen option (a Gmail search string). The first poll sets the ' +
    'mark and emits nothing, so going live never replays the back catalogue. It ' +
    'reads mail arriving in the INBOX by default — widen with the `labels` ' +
    'listen option (e.g. `labels: ["INBOX", "SPAM"]` to include Spam), and ' +
    'narrow with `query`. A message that is later edited, ' +
    're-labelled or replied to does NOT fire again: arrival is the only event ' +
    'Gmail offers here. Nothing fires on mail this mailbox SENDS.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'readRecord', 'resolveFileRef', 'createRecord',
  ],
  requiredCredentialType: ExternalServiceType.GOOGLE_GMAIL,
  // `events` is projected from `subscribableEvents` — Gmail has no webhook to
  // subscribe to, but the value is what types the listened parameter.
  subscribableEvents: [...GMAIL_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [GMAIL_MESSAGE_RECEIVED_EVENT],
  listenConfig: [
    { key: 'query', required: false },
    { key: 'labels', required: false, format: 'strings' },
    { key: 'pollIntervalSeconds', required: false },
  ],
  // No `triggerKinds`: the slug self-aliases, and the uppercase `GMAIL` kind is
  // already claimed by the inbound-email adapter for forwarded mail. Trigger
  // rows for this adapter carry the slug, as every polled source's do.
  vocabulary: {
    // The envelope's flap — an M laid over a rectangle, which is the mark
    // everybody reads as mail.
    icon: {
      d: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 3.2V17h16V8.2l-8 5.3-8-5.3z',
      fill: true,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      default: [
        { template: 'When a message arrives matching `{query}`' },
        { template: 'When a message arrives in the mailbox' },
      ],
    },
  },
};

export class GmailAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = GMAIL_ADAPTER_TYPE;
  readonly supportedTriggers = GMAIL_MANIFEST.supportedTriggers;

  constructor(
    readonly teamId: TeamId,
    readonly credentialsId?: string,
    /** Injectable for tests; production resolves a credentialed client from
     *  `teamId` + `credentialsId` (the same path the poll source rides). */
    private readonly clientOverride?: GmailApiClient,
  ) {
    super();
  }

  private async client(): Promise<GmailApiClient> {
    const client =
      this.clientOverride ??
      (await resolveGmailClient({ teamId: this.teamId, credentialsId: this.credentialsId }));
    if (!client) {
      throw new Error(
        `GmailAdapter: no usable Gmail mailbox for team ${this.teamId} ` +
          `(credentialsId=${this.credentialsId ?? 'unset'}). Connect Gmail.`,
      );
    }
    return client;
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
  // Gmail OWNS the files it hands out: the host redeems their handle here, on
  // the instance (the credential) the descriptor names.

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

  /** The `File` primitive for an attachment — a FileRef descriptor naming this
   *  instance as the owner, redeemed through `resolveFileRef`. Null when the
   *  position names no file. */
  private attachmentFileRef(data: Record<string, unknown>): FileRef | null {
    const messageId = stringAt(data['messageId']);
    const attachmentId = stringAt(data['attachmentId']);
    const filename = stringAt(data['filename']);
    if (messageId === null || attachmentId === null || filename === null) return null;
    const contentType = stringAt(data['contentType']) ?? 'application/octet-stream';
    const size = typeof data['size'] === 'number' ? data['size'] : undefined;
    return {
      __brand: 'FileRef',
      name: filename,
      contentType,
      ...(size !== undefined ? { size } : {}),
      source: ownedFileSource({
        adapterType: GMAIL_ADAPTER_TYPE,
        ...(this.credentialsId !== undefined ? { credentialsId: this.credentialsId } : {}),
        handle: encodeAttachmentId({ messageId, attachmentId }),
      }),
    };
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
      teamId: this.teamId,
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

/** Factory matching the registry's AdapterFactory signature. */
export function createGmailAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): GmailAdapter {
  return new GmailAdapter(input.teamId, input.credentialsId);
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
