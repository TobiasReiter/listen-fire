// WhatsApp adapter — implements the translation-graph Adapter contract for
// inbound WhatsApp messages as a source. The phone-based twin of the email
// adapter (`adapters/email/index.ts`): source-only, no writes.
//
// WhatsApp has a real v3 input (`adapters/pipeline/inbound/twilio.adapter.ts`)
// but had no TG adapter. This mirrors the email SOURCE adapter exactly,
// adapting field names: body via `Text` field, media via the
// `-[:Attachments]->` edge, a single phone-based originator candidate.
// The retired input-side `#resources` bundle is gone.
//
// Position payload shape: `external-record` with `recordType ===
// 'whatsapp:message'` and `data` matching `WhatsappPayload` — mirrors the
// inbound payload `twilio.adapter.ts` produces, but is *not* imported from
// it (R4b "mirror; don't import"): keeping the type local lets the TG-side
// contract evolve independently from the pre-existing webhook adapter.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  AdapterManifest,
  DiscriminableEvent,
  EdgesFromResult,
  EventType,
  FileRef,
  GetRelatedInput,
  ParentLink,
  RelatedResult,
  ResolveFileRefResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/public/adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/public/catalog';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { parseWhatsappEvents } from '../../../webhook_sync/providers/whatsapp';
import { webhookEventToDiscriminable } from '../../../webhook_sync/event_conversion';
import { fileHandle, isFileValue, ownedFileSource, singleParentLink } from 'movement-engine/public/adapter';
import { naturalName } from 'module-kit/adapter/name_resolution';
import { getMetaWhatsappApi } from '../../../whatsapp/metaApi';
import { fetchUrlToStream } from '../../engine/files/fetch-stream';
import { isExposedFileUrl } from '../../engine/files/expose';
import { FileOutsideTeamError } from 'movement-engine/public/files';
import { streamFileRef } from '../../engine/files/retrieve';
import { META_RECORD_TYPE, makeUnstablePosition, positionData } from 'movement-engine/public/catalog';
import { uniformWalk } from 'module-kit/adapter/hop';
import { BaseAdapter } from 'module-kit/adapter/base';
import { normalizeWhatsappPhone } from '../acting_user/phone';
import { WHATSAPP_HANDBOOK_SECTION } from './handbook_section';
import {
  WHATSAPP_ADAPTER_TYPE,
  WHATSAPP_RECORD_TYPE_ID,
  WHATSAPP_ATTACHMENTS_FIELD,
  WHATSAPP_ATTACHMENT_TYPE_ID,
  WHATSAPP_ATTACHMENT_DISPLAY_NAME,
  WHATSAPP_EDGE_NAMES,
  WHATSAPP_INBOUND_REACTION_TYPE,
  WHATSAPP_INBOUND_LOCATION_TYPE,
  WHATSAPP_TYPING_TYPE,
  type WhatsappAttachment,
  type WhatsappPayload,
} from './types';

export {
  WHATSAPP_ADAPTER_TYPE,
  WHATSAPP_RECORD_TYPE_ID,
  WHATSAPP_ATTACHMENTS_FIELD,
  WHATSAPP_ATTACHMENT_TYPE_ID,
  WHATSAPP_INBOUND_REACTION_TYPE,
  WHATSAPP_INBOUND_LOCATION_TYPE,
  WHATSAPP_TYPING_TYPE,
  type WhatsappAttachment,
  type WhatsappPayload,
};

// ── Adapter ────────────────────────────────────────────────────────────────

/**
 * Translation-graph adapter for inbound WhatsApp. Source-only.
 *
 * Capability profile mirrors the email source adapter:
 *   • runtime — minimal expression surface (property reads, basic
 *     comparisons, AND/OR/NOT, EXISTS).
 *     No traversal beyond the canonical `-[:Attachments]->` edge, no LLM
 *     at the source side. The input-side `#resources` bundle is retired —
 *     body and attachments are accessed via explicit fields/edges only.
 *   • pushdown — none. Inbound WhatsApp messages are dispatched one at a
 *     time by the webhook router; there's no native query API to push
 *     filters into.
 */
/**
 * Static manifest. Source-only — no write methods (so NOT a target) and no
 * `requiredCredentialType` (inbound creds live on the legacy `pipeline_input`,
 * not a team credential). No meta root.
 *
 */
/** The shared WhatsApp number people message to trigger movements — a stable
 *  public contact point, surfaced in the manifest so the authoring agent can
 *  tell users exactly which number to message. Which number that is belongs to
 *  the deployment, so it comes from env; an install that has not registered a
 *  WhatsApp sender leaves it unset and nothing quotes a number. */
export const WHATSAPP_MOVEMENTS_NUMBER = process.env.WHATSAPP_MOVEMENTS_NUMBER?.trim() || null;

/** Click-to-chat link that opens a WhatsApp conversation with the shared
 *  number. Hand it to the user once their number is linked so getting started
 *  is a single tap rather than saving a contact by hand. `wa.me` wants digits
 *  only (no `+`, no spaces). */
export const WHATSAPP_MOVEMENTS_WA_ME_LINK = WHATSAPP_MOVEMENTS_NUMBER
  ? `https://wa.me/${WHATSAPP_MOVEMENTS_NUMBER.replace(/\D/g, '')}`
  : null;

export const WHATSAPP_MANIFEST: AdapterManifest = {
  adapterType: WHATSAPP_ADAPTER_TYPE,
  displayName: 'WhatsApp',
  website: 'https://www.whatsapp.com',
  category: 'Messaging',
  description:
    `WhatsApp on the shared Listen-Fire number${
      WHATSAPP_MOVEMENTS_NUMBER ? ` (${WHATSAPP_MOVEMENTS_NUMBER})` : ''
    }. ` +
    'Message it and a movement runs on each message — text and media ' +
    'included (voice notes transcribe). Movements can reply (threaded), ' +
    'react with an emoji, and show the typing indicator. Built in; no account ' +
    "to connect — but the sender's phone must be linked to their Listen-Fire " +
    'account first, or their messages are ignored.',
  supportedTriggers: ['webhook'],
  // `listen to wa { events: [...] }` — no `events` subscribes to messages
  // only, so reactions/locations never fire a movement that didn't opt in.
  subscribableEvents: ['message', 'reaction', 'location'],
  // A config-less listen receives MESSAGES ONLY (the dispatch gate,
  // `triggerAcceptsWhatsappKind`) — declared so the checker types it the
  // same way the runtime delivers it.
  defaultSubscribedEvents: ['message'],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'preprocessInbound',
    'getActorCandidates', 'extractActor', 'resolveFileRef', 'createRecord', 'listEventTypes',
  ],
  triggerKinds: ['INBOUND_WHATSAPP', 'TWILIO'],
  triggerExpectation:
    `Fires when a WhatsApp message arrives at the shared Listen-Fire number` +
    `${WHATSAPP_MOVEMENTS_NUMBER ? ` (${WHATSAPP_MOVEMENTS_NUMBER})` : ''} — ` +
    `each message (text and media; voice ` +
    `notes transcribe) is one event. The number is common to every Listen-Fire user: ` +
    `routing works by identifying the sender from their linked phone, so ONLY ` +
    `messages the user sends from their own linked number reach their ` +
    `movements. A message from anyone else — a founder, an LP, any unlinked ` +
    `number — is unrecognized and dropped, and it never reads anyone's ` +
    `WhatsApp chats or groups. So it is a channel the user messages ` +
    `deliberately: always frame it first-person ("when I forward or send … to ` +
    `the Listen-Fire number"), never as someone else messaging the number.`,
  handbookSection: WHATSAPP_HANDBOOK_SECTION,
  vocabulary: {
    icon: {
      d: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
      fill: true,
    },
    eventPhrase: {
      // No per-event phrasing today (`message` / `reaction` / `location`
      // all shared the same generic sentence in the former switch) —
      // `default` mirrors that, channel→tag→bare.
      default: [
        { template: 'When a WhatsApp message arrives in {channel}' },
        { template: 'When a WhatsApp message arrives in `{key}`' },
        { template: 'When a WhatsApp message arrives' },
      ],
    },
  },
};

export class WhatsappAdapter extends BaseAdapter implements Adapter {

  /**
   * THE raw→events seam for the webhook-sync WhatsApp door — the pure
   * `parseWhatsappEvents` (the retired provider `parseEvents` logic) + the
   * legacy conversion, STAMPED with the parse-time classification as the
   * discrimination tag (`e.eventType` is `message`/`reaction`/`location`). The
   * dedicated Meta route (`services/whatsapp/dispatch.ts`) dispatches
   * separately — it already sets `rootRecordType` from the classification.
   */
  async preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[] }> {
    return {
      events: parseWhatsappEvents(input.raw).map((e) => ({
        ...webhookEventToDiscriminable(e),
        tag: e.eventType,
      })),
    };
  }

  /**
   * WhatsApp's inbound kinds are classified at parse time
   * (`classifyMetaMessage`) — the normalized payloads carry no literal
   * discriminator, so the union is TAG-ONLY and `preprocessInbound` stamps
   * the tag. Each kind discriminates to the RECORD its fires edge delivers
   * (rule 1's collapse — no event-node indirection), which is what lets the
   * engine seed a STABLE position (recordId = the wamid) so
   * replies/reactions/typing anchor off the PARAMETER, and guarantees a
   * reaction can never mis-discriminate as a message.
   */
  async listEventTypes(): Promise<EventType[]> {
    return [
      { tag: 'message', positionType: WHATSAPP_RECORD_TYPE_ID },
      { tag: 'reaction', positionType: WHATSAPP_INBOUND_REACTION_TYPE },
      { tag: 'location', positionType: WHATSAPP_INBOUND_LOCATION_TYPE },
    ];
  }
  readonly adapterType = WHATSAPP_ADAPTER_TYPE;
  readonly supportedTriggers = WHATSAPP_MANIFEST.supportedTriggers;

  // teamId is accepted for parity with other adapters even though the
  // WhatsApp adapter has no per-team configuration today.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly teamId: TeamId) {
    super();
  }

  // ── 1. Schema introspection ──────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // The EVENT edges land STRAIGHT on the records — one per inbound kind
      // (rule 1, adapters/CLAUDE.md): the retired `Message Received` /
      // `Reaction Received` / `Location Received` nodes carried no facts of
      // their own, so a listen delivers the message / reaction / location
      // itself, whole (seeded stable on its wamid). `readable: false` stays
      // the honest statement (nobody enumerates the number's traffic — a
      // fires edge is reachability, never a root read); `firesOn` says which
      // `events:` value selects each edge. No change-kind axis, so no
      // `action` field on any of them.
      {
        typeId: WHATSAPP_RECORD_TYPE_ID,
        displayName: 'Message',
        // The unified type: the anchor for every write — replies/reactions/
        // typing are edges off it, never top-level writable roots — and
        // reached ONLY by arriving (the fires edge): nobody can enumerate
        // the number's messages, so no root read either.
        writable: false,
        readable: false,
        fires: true,
        firesOn: ['message'],
      },
      {
        typeId: WHATSAPP_ATTACHMENT_TYPE_ID,
        displayName: WHATSAPP_ATTACHMENT_DISPLAY_NAME,
        // Reached only via `msg-[:Attachments]->` — no root collection.
        writable: false,
        readable: false,
      },
      {
        typeId: WHATSAPP_INBOUND_REACTION_TYPE,
        displayName: 'Reaction',
        // Arrives on its own fires edge (`events: ["reaction"]`), and is
        // created along a message's `Reactions` edge — never enumerated
        // from the root.
        writable: false,
        readable: false,
        fires: true,
        firesOn: ['reaction'],
      },
      {
        typeId: WHATSAPP_INBOUND_LOCATION_TYPE,
        displayName: 'Location',
        // Arrives on its own fires edge (`events: ["location"]`).
        writable: false,
        readable: false,
        fires: true,
        firesOn: ['location'],
      },
      // The typing ACTION's target type — an action, not a record: never a
      // picker root (not writable) and never a readable position (not
      // readable). It is published only so the `Typing` edge lands on a
      // described shape.
      {
        typeId: WHATSAPP_TYPING_TYPE,
        displayName: 'Typing',
        writable: false,
        readable: false,
      },
    ];
  }

  /**
   * WhatsApp is entered ONLY by being messaged. Three fires edges and no
   * readable one is the honest statement of what WhatsApp is — you cannot
   * enumerate a conversation you were not part of — not a gap in the graph.
   *
   * `Attachment` and `Typing` are absent here on purpose: both are reached
   * from a Message (one by reading its media, one by writing along an
   * ephemeral edge), so the walk arrives at them a hop in and the root never
   * claims a read that has no call behind it.
   */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'WhatsApp',
    description:
      'A WhatsApp connection. Nothing here can be listed — there is no call ' +
      'that enumerates conversations — so the way in is somebody messaging ' +
      'you, which a listen delivers whole.',
    fields: [],
    references: [
      {
        fieldId: WHATSAPP_RECORD_TYPE_ID,
        targetTypeId: WHATSAPP_RECORD_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: 'Message',
        fires: true,
        firesOn: ['message'],
        readable: false,
        description: 'Somebody sending a message — what a listen delivers.',
      },
      {
        fieldId: WHATSAPP_INBOUND_REACTION_TYPE,
        targetTypeId: WHATSAPP_INBOUND_REACTION_TYPE,
        cardinality: 'one',
        direction: 'outgoing',
        name: 'Reaction',
        fires: true,
        firesOn: ['reaction'],
        readable: false,
        description: 'Somebody reacting to a message.',
      },
      {
        fieldId: WHATSAPP_INBOUND_LOCATION_TYPE,
        targetTypeId: WHATSAPP_INBOUND_LOCATION_TYPE,
        cardinality: 'one',
        direction: 'outgoing',
        name: 'Location',
        fires: true,
        firesOn: ['location'],
        readable: false,
        description: 'Somebody sharing their location.',
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: WHATSAPP_ADAPTER_TYPE,
      at: position,
      root: WhatsappAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // Accept the NATURAL type name (engine / checker currency) or the internal
    // id (resolver build, legacy callers) — `resolveTypeRef` normalizes both.
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === WHATSAPP_RECORD_TYPE_ID) {
      return {
        typeId: WHATSAPP_RECORD_TYPE_ID,
        displayName: 'Message',
        description:
          'A single inbound WhatsApp message — what a listen delivers, ' +
          'whole: read `e.`Body`` straight off the event, reply along its ' +
          '`Replies` edge.',
        fields: [
          { fieldId: 'messageId', displayName: 'Message Id', kind: 'string', writable: false, required: true, description: 'The WhatsApp message id — the value a reply or reaction addresses.' },
          { fieldId: 'from', displayName: 'From', kind: 'string', writable: false, required: true, description: 'The sender\'s phone number.' },
          { fieldId: 'to', displayName: 'To', kind: 'string', writable: false, required: false, description: 'Inbound: the team\'s own WhatsApp business number (the message\'s recipient). On a send: the other party\'s phone number, derived from the message the write is anchored on (an inbound parent\'s From, a sent parent\'s To) — read-only either way.' },
          { fieldId: 'body', displayName: 'Body', kind: 'string', writable: true, required: false, description: 'The message text. Empty for media-only messages. At least one of Body / File on a send (the Body captions the file).' },
          // Send-side only (`readable: false`): outbound media rides the send;
          // INBOUND media is never here — it lives on the `Attachments` edge.
          // Without the flag this field leaks as a readable-but-always-null
          // property and `msg.File` silently reads nothing (the customer bug
          // this closes, 2026-07-13).
          { fieldId: 'data', displayName: 'File', kind: 'file', writable: true, readable: false, required: false, description: 'A file to send (image / PDF / audio / video, routed by content type). At least one of Body / File. Send-side only: a received message\'s media is on its Attachments edge — read `msg-[:Attachments]->.File`.' },
          // Send-side only, same reasoning as `File`: WhatsApp attaches an
          // interactive reply to nothing on the way in (a tap arrives as its
          // own message, handled by the callback door before it ever reaches
          // this adapter), so declaring it readable would leak an
          // always-null property.
          {
            fieldId: 'interactive',
            displayName: 'Interactive',
            kind: 'json',
            // ONE object — WhatsApp's `interactive` is a single object whose
            // `action.buttons` / `action.sections` holds the rows, not a list
            // at the top level.
            writable: true,
            readable: false,
            required: false,
            description:
              'WhatsApp\'s `interactive` object, exactly as the Cloud API spells it — passed ' +
              'through verbatim (no wrapping, no typed shape here; a malformed object ' +
              'surfaces as a loud WhatsApp error at run time, not at save time). Sending ' +
              'this REPLACES a plain-text send: the interactive type carries its own ' +
              '`body.text`, so the message\'s words go inside `interactive.body.text`, ' +
              'never in `Body` on the same send. Usually reply buttons: up to 3, each ' +
              '`{ type: "reply", reply: { id, title } }` (`title` capped at 20 characters). ' +
              'To make a tap DO something, mint a callback (`c = callback({ … })`) and put ' +
              '`"${c.id}"` in `reply.id` — WhatsApp allows up to 256 characters there, ' +
              'roomy for it — one callback per button, since its body is what that button ' +
              'means. WhatsApp captures nothing at tap time, so a callback fired from a ' +
              'button takes no values; anything a person has to fill in needs a plain-text ' +
              'reply instead. Build strings with "${…}" interpolation (never `+`, which is ' +
              'numeric addition). Example:\n' +
              '{ type: "button",\n' +
              '  body: { text: "Ship the release?" },\n' +
              '  action: { buttons: [\n' +
              '    { type: "reply", reply: { id: "${approve.id}", title: "Approve" } },\n' +
              '    { type: "reply", reply: { id: "${reject.id}", title: "Reject" } } ] } }',
          },
          { fieldId: 'waId', displayName: 'WhatsApp Id', kind: 'string', writable: false, required: false, description: 'The sender\'s WhatsApp account id.' },
          { fieldId: 'profileName', displayName: 'Profile Name', kind: 'string', writable: false, required: false, description: 'The sender\'s WhatsApp profile display name.' },
          { fieldId: 'timestamp', displayName: 'Timestamp', kind: 'string', writable: false, required: false, description: 'When the message was received (ISO-8601), when known.' },
        ],
        references: [
          {
            fieldId: WHATSAPP_ATTACHMENTS_FIELD,
            targetTypeId: WHATSAPP_ATTACHMENT_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: WHATSAPP_EDGE_NAMES.attachments,
            // Read-only: WhatsApp attaches inbound media itself; a send's
            // file is the message's own `File` field, never a created child.
            writable: false,
            description: 'Media attached to the message (zero or more).',
          },
          // Write edges: a write off the message threads a reply
          // (`write msg-[:Replies]->`), reacts to it
          // (`write msg-[:Reactions]->`), or shows typing
          // (`write msg-[:Typing]-> {}`) — the parent supplies the message id
          // and, via its data, the other party. Meta exposes no read API for
          // any of them, so all three are `readable: false` — a read
          // traversal is a check-time error, never a silent empty. Because `replies`
          // targets the message type itself, a reply-to-a-reply chain comes
          // from ONE declaration (the sentinel's parallel edge set is gone).
          {
            fieldId: 'replies',
            targetTypeId: WHATSAPP_RECORD_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: WHATSAPP_EDGE_NAMES.replies,
            writable: true,
            readable: false,
            description:
              'Send a reply threaded to this message (write-only — Meta has no read ' +
              'API). The recipient derives from this message; sends only reach a ' +
              'conversation someone opened by messaging the number (Meta\'s 24-hour ' +
              'service window).',
          },
          {
            fieldId: 'reactions',
            targetTypeId: WHATSAPP_INBOUND_REACTION_TYPE,
            cardinality: 'many',
            direction: 'outgoing',
            name: WHATSAPP_EDGE_NAMES.reactions,
            writable: true,
            readable: false,
            description: 'React to this message with an emoji (write-only).',
          },
          {
            fieldId: 'typing',
            targetTypeId: WHATSAPP_TYPING_TYPE,
            cardinality: 'many',
            direction: 'outgoing',
            name: WHATSAPP_EDGE_NAMES.typing,
            writable: true,
            readable: false,
            ephemeral: true,
            description:
              'Show the typing indicator (and mark this message read) while a longer ' +
              'step runs. An action, not a record — nothing is created; do not bind ' +
              'the result.',
          },
        ],
      };
    }
    if (typeId === WHATSAPP_ATTACHMENT_TYPE_ID) {
      return {
        typeId: WHATSAPP_ATTACHMENT_TYPE_ID,
        displayName: WHATSAPP_ATTACHMENT_DISPLAY_NAME,
        fields: [
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true },
          { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: true },
          { fieldId: 'url', displayName: 'URL', kind: 'string', writable: false, required: false },
          // `data` is the binary handle — the File primitive per
          // resources_currency.md, matching the email attachment's File
          // field so File-typed expressions route into File-typed targets.
          { fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false },
        ],
        references: [],
      };
    }
    if (typeId === WHATSAPP_INBOUND_REACTION_TYPE) {
      return {
        typeId: WHATSAPP_INBOUND_REACTION_TYPE,
        displayName: 'Reaction',
        description:
          'Someone reacted to a message in the team-number conversation. ' +
          'Listen with `events: ["reaction"]`. Also the reaction WRITE: ' +
          'created along a message\'s `Reactions` edge.',
        fields: [
          { fieldId: 'emoji', displayName: 'Emoji', kind: 'string', writable: true, required: true, description: 'The reaction emoji. Inbound: empty when the reaction was removed. On a write along msg-[:Reactions]->: the single emoji to react with — required.' },
          { fieldId: 'reactedMessageId', displayName: 'Reacted Message Id', kind: 'string', writable: false, required: true, description: 'The message the reaction is on.' },
          { fieldId: 'messageId', displayName: 'Message Id', kind: 'string', writable: false, required: true, description: 'The reaction event\'s own id.' },
          { fieldId: 'from', displayName: 'From', kind: 'string', writable: false, required: true, description: 'The reactor\'s phone number.' },
          { fieldId: 'profileName', displayName: 'Profile Name', kind: 'string', writable: false, required: false },
          { fieldId: 'timestamp', displayName: 'Timestamp', kind: 'string', writable: false, required: false },
        ],
        references: [],
      };
    }
    if (typeId === WHATSAPP_INBOUND_LOCATION_TYPE) {
      return {
        typeId: WHATSAPP_INBOUND_LOCATION_TYPE,
        displayName: 'Location',
        description:
          'Someone shared a location with the team number. Listen with ' +
          '`events: ["location"]`.',
        fields: [
          { fieldId: 'latitude', displayName: 'Latitude', kind: 'number', writable: false, required: true },
          { fieldId: 'longitude', displayName: 'Longitude', kind: 'number', writable: false, required: true },
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false, description: 'The place name, when the sender picked one.' },
          { fieldId: 'address', displayName: 'Address', kind: 'string', writable: false, required: false },
          { fieldId: 'messageId', displayName: 'Message Id', kind: 'string', writable: false, required: true },
          { fieldId: 'from', displayName: 'From', kind: 'string', writable: false, required: true },
          { fieldId: 'profileName', displayName: 'Profile Name', kind: 'string', writable: false, required: false },
          { fieldId: 'timestamp', displayName: 'Timestamp', kind: 'string', writable: false, required: false },
        ],
        references: [],
      };
    }
    if (typeId === WHATSAPP_TYPING_TYPE) {
      return {
        typeId: WHATSAPP_TYPING_TYPE,
        displayName: 'Typing',
        description:
          'The typing-indicator action, written along a message\'s `Typing` edge ' +
          '(`write msg-[:Typing]-> {}` — no fields; Meta\'s API is on-only, so ' +
          'there is no off to write). An action, not a record: nothing is ' +
          'created and nothing reads back. WhatsApp clears the indicator itself ' +
          'when your reply sends, or after ~25 seconds.',
        fields: [],
        references: [],
      };
    }
    return null;
  }

  // ── 2. Field-level access ────────────────────────────────────────────────
  // Override the base default so the attachment `name` alias resolves
  // alongside the cached payload. Everything else falls through to a scalar
  // lookup on `position.data`.

  async getFieldValue(input: { position: SourcePosition; fieldId: string }): Promise<unknown> {
    if (input.position.adapterType !== WHATSAPP_ADAPTER_TYPE) {
      throw new Error(
        `WhatsappAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }

    // The program names the field by its NATURAL displayName (`From`, `Body`);
    // the position's `recordType` is the NATURAL type name (the read wrapper
    // stamps it). Resolve both to this adapter's internal currency — the field
    // ids the payload is keyed by — on the first line. The webhook router seeds
    // a typeless message (`recordType: null`); treat that as the message type
    // and use the natural field name as-is (nothing to resolve against).
    const typeId = await this.resolveTypeRef(input.position.recordType ?? WHATSAPP_RECORD_TYPE_ID);
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);

    // A whole inbound message; attachments are only reached via the
    // `-[:Attachments]->` edge. Treat it as the whatsapp:message record.
    if (typeId === WHATSAPP_RECORD_TYPE_ID) {
      const scalars = coerceMessageScalars((positionData(input.position) ?? {}) as Record<string, unknown>);
      return (scalars as Record<string, unknown>)[fieldId] ?? null;
    }
    if (typeId === WHATSAPP_INBOUND_REACTION_TYPE || typeId === WHATSAPP_INBOUND_LOCATION_TYPE) {
      const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
      return data[fieldId] ?? null;
    }
    if (typeId === WHATSAPP_ATTACHMENT_TYPE_ID) {
      const att = (positionData(input.position) ?? {}) as Partial<WhatsappAttachment>;
      // `name` is a friendly alias for `filename`.
      if (fieldId === 'name') return att.filename ?? null;
      // The `File` (`data`) field is the binary primitive — a `FileRef`
      // descriptor this adapter redeems (`resolveFileRef`), the same FileRef
      // the retired input-side `_resources` bundle built. This is what
      // `msg-[:Attachments]->.\`File\`` evaluates so media bytes reach
      // extraction / carry-forward.
      if (fieldId === 'data') return whatsappMediaFileRef(att);
      return (att as Record<string, unknown>)[fieldId] ?? null;
    }
    return null;
  }

  // ── 3. Reference traversal (attachments) ─────────────────────────────────
  // The `-[:Attachments]->` domain edge yields attachment-typed positions; the
  // body is read explicitly off the message (`msg.\`Body\``). The source content
  // that fed an extraction is reached off the extracted node
  // (`extractedNode-[:_resources]->`), not off the input.

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== WHATSAPP_ADAPTER_TYPE) {
      throw new Error(
        `WhatsappAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // The `Attachments` edge — resolve the NATURAL edge name to this adapter's
    // read currency (for whatsapp the reference `name` IS the fieldId, so it's
    // identity, but resolve it uniformly so drift on a mistyped edge is loud).
    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId === WHATSAPP_ATTACHMENTS_FIELD) {
      const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
      const attachments = await coerceAttachments(data);
      return attachments.map((att) => ({
        position: makeUnstablePosition({
          adapterType: WHATSAPP_ADAPTER_TYPE,
          recordType: WHATSAPP_ATTACHMENT_DISPLAY_NAME,
          data: att,
        }),
      }));
    }

    return [];
  }

  // ── 3a. Actor candidate parsing (acting-user split) ─────────────────────
  // WhatsApp's resolution chain — the phone twin of email's. Pure parse: NO
  // Listen-Fire DB access.
  //
  //   • Sender (`From` / `from`) → ONE `originator` candidate with a
  //     `scheme: 'phone'` identity (the `whatsapp:` prefix stripped).
  //     `resolveActingUser` matches it against the `phone_number` table.
  //
  // WhatsApp has no forwarding / relay concept (no header chain), so there
  // are no `relay` candidates — a single originator only.
  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const payload = (input.event.payload ?? {}) as Record<string, unknown>;
    const phone = normalizeWhatsappPhone(readSender(payload));
    if (!phone) return [];
    return [
      {
        identity: { identifier: phone, scheme: 'phone', adapterType: this.adapterType },
        source: 'originator',
      },
    ];
  }

  // ── 3b. Actor extraction (T5) ────────────────────────────────────────────
  // Synchronous parse of the raw sender. Independent of auth — populates
  // `@actor_*` so authors can see the raw sender even when auth went through
  // a fallback. Surfaces the profile name as the friendly label when present.
  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    const payload = (input.event.payload ?? {}) as Record<string, unknown>;
    const phone = normalizeWhatsappPhone(readSender(payload));
    if (!phone) return null;
    const profileName = readProfileName(payload);
    return {
      identifier: phone,
      scheme: 'phone',
      adapterType: this.adapterType,
      name: profileName ?? undefined,
      label: profileName ?? phone,
    };
  }

  // ── 3c. Byte resolution (owner-side) ─────────────────────────────────────
  // WhatsApp OWNS the FILE resources it emits (P4): the host redeems their
  // handle here. The handle is the media url (`key`) — the same Twilio media
  // URL the inbound layer uses to fetch the bytes — so we fetch it and hand
  // back a Node stream.
  //
  // owners serve bytes
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error(
        `${WHATSAPP_ADAPTER_TYPE}.resolveFileRef: FileRef has no source handle to resolve.`,
      );
    }
    // Only a handle this adapter issued is fetched: refused by name otherwise.
    const issued = issuedMediaHandle(handle);
    if (issued !== true) throw new FileOutsideTeamError('handle', issued);
    return fetchUrlToStream(handle);
  }

  // ── 4. Writes — anchor-keyed dispatch ────────────────────────────────────
  // Every WhatsApp write is created ALONG an edge off a message (the 24-hour
  // service window means there is no cold outreach, so there is no top-level
  // send): `write msg-[:Replies]-> {…}` (a threaded reply), `write
  // msg-[:Reactions]-> {…}` (an emoji reaction), `write msg-[:Typing]-> {}`
  // (the ephemeral typing action). Dispatch keys on the EDGE, never on a
  // sentinel recordType. The other party derives from the anchor's data — an
  // inbound parent's `from`, a sent handle's `to` — never a field. Sends go
  // through the Meta Cloud API; `updateRecord` / `deleteRecord` keep
  // BaseAdapter's `notWriteCapable` throws (Meta offers no edit surface).

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const parent = singleParentLink(input);
    if (!parent) {
      throw new Error(
        'WhatsappAdapter.createRecord: a WhatsApp write is created along an edge off a ' +
          'message — `write msg-[:Replies]-> {…}`, `write msg-[:Reactions]-> {…}`, ' +
          '`write msg-[:Typing]-> {}`. There is no top-level send.',
      );
    }
    const parentTypeId = await this.resolveTypeRef(parent.recordType);
    if (parentTypeId !== WHATSAPP_RECORD_TYPE_ID) {
      throw new Error(
        `WhatsappAdapter.createRecord: writes anchor off a Message, not '${parent.recordType}'.`,
      );
    }
    // Natural currency in — resolve the written type's field displayNames to
    // internal ids (tryFieldId: unknown keys pass through and are ignored).
    const resolver = await this.resolver({ types: [input.recordType] });
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.fields)) {
      fields[resolver.tryFieldId(naturalName(input.recordType), naturalName(key)) ?? key] = value;
    }
    const edge = naturalName(parent.edgeName);
    if (edge === WHATSAPP_EDGE_NAMES.typing) return this.typingAction(parent);
    if (edge === WHATSAPP_EDGE_NAMES.reactions) return this.reactionWrite(parent, fields);
    if (edge === WHATSAPP_EDGE_NAMES.replies) return this.messageSend(parent, fields);
    throw new Error(
      `WhatsappAdapter.createRecord: a ${naturalName(input.recordType)} cannot be created along '-[:${parent.edgeName}]->'.`,
    );
  }

  /** The other party's number, derived from the anchor — never a field
   *  (§2.3: an inbound parent's `from`, a sent parent's `to`; Meta offers no
   *  message-id→phone lookup, so the parent's data closes that hole). */
  private deriveTo(parent: ParentLink): string {
    const data = parent.data ?? {};
    const raw =
      (typeof data.from === 'string' && data.from.length > 0 ? data.from : undefined) ??
      (typeof data.to === 'string' && data.to.length > 0 ? data.to : undefined);
    const to = normalizeWhatsappPhone(raw);
    if (!to) {
      throw new Error(
        'WhatsappAdapter.createRecord: the parent message carries no sender — parent ' +
          'data must include `from` (an inbound message) or `to` (a send handle).',
      );
    }
    return to;
  }

  /** The send client for a write, chosen by the number the parent message
   *  arrived on (`businessPhoneNumberId`) so a reply goes out FROM the number
   *  that received it. Absent → the primary number (unchanged behaviour). */
  private apiFor(parent: ParentLink): ReturnType<typeof getMetaWhatsappApi> {
    const data = parent.data ?? {};
    const numberId =
      typeof data.businessPhoneNumberId === 'string' && data.businessPhoneNumberId.length > 0
        ? data.businessPhoneNumberId
        : undefined;
    return getMetaWhatsappApi(numberId);
  }

  /** Typing — the ephemeral action (§6.4 resolution 1, on-only per the
   *  2026-07-07 amendment). The write is bare — no fields — because Meta's
   *  API has no dismiss (verified 2026-07-07 — the indicator clears itself
   *  when a reply sends or after ~25s); there is nothing for an `off` to do,
   *  so there is no `off` to write. */
  private async typingAction(parent: ParentLink): Promise<WriteResult> {
    const shown = await this.apiFor(parent).sendTypingOn(parent.externalId);
    if (!shown) {
      throw new Error(`WhatsApp did not accept the typing indicator for ${parent.externalId}.`);
    }
    return {
      adapterType: WHATSAPP_ADAPTER_TYPE,
      externalId: `typing:${parent.externalId}`,
      data: { message_id: parent.externalId },
    };
  }

  /** Reaction — the unified inbound type, created along msg-[:Reactions]->. */
  private async reactionWrite(parent: ParentLink, fields: Record<string, unknown>): Promise<WriteResult> {
    const emoji = typeof fields.emoji === 'string' && fields.emoji.trim().length > 0
      ? fields.emoji.trim()
      : undefined;
    if (!emoji) {
      throw new Error('WhatsappAdapter.createRecord(reaction): the "Emoji" field must carry a non-empty value.');
    }
    const to = this.deriveTo(parent);
    const accepted = await this.apiFor(parent).sendReaction(to, parent.externalId, emoji);
    if (!accepted) {
      throw new Error(
        `WhatsApp did not accept the reaction to ${parent.externalId} — the message may be ` +
          'too old to react to, or the number may not have messaged the team number recently.',
      );
    }
    return {
      adapterType: WHATSAPP_ADAPTER_TYPE,
      externalId: `reaction:${parent.externalId}:${emoji}`,
      data: { to, emoji, message_id: parent.externalId },
    };
  }

  /** The send: text, or a file with the text as caption — always threaded to
   *  the parent (WhatsApp writes are parent-anchored always; the 24-hour
   *  service window means there is no cold outreach to address). */
  private async messageSend(parent: ParentLink, fields: Record<string, unknown>): Promise<WriteResult> {
    const to = this.deriveTo(parent);
    const bodyValue = typeof fields.body === 'string' ? fields.body.trim() : '';
    const fileValue = fields.data;
    const interactiveValue = fields.interactive;
    let sentId: string | null = null;
    if (interactiveValue !== undefined) {
      // Interactive REPLACES the plain-text send entirely — Meta's interactive
      // type carries its own `body.text`, mutually exclusive with the top-level
      // `text`/media types, so Body/File are not also sent here.
      sentId = await this.apiFor(parent).sendInteractive(to, interactiveValue, {
        replyToMessageId: parent.externalId,
      });
    } else if (isFileValue(fileValue)) {
      const resolved = await streamFileRef(fileValue, { teamId: this.teamId });
      const chunks: Buffer[] = [];
      for await (const chunk of resolved.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      sentId = await this.apiFor(parent).sendMediaMessage(
        to,
        {
          buffer: Buffer.concat(chunks),
          filename: fileValue.name ?? 'file',
          mimeType: resolved.contentType ?? fileValue.contentType ?? 'application/octet-stream',
        },
        {
          ...(bodyValue.length > 0 ? { caption: bodyValue } : {}),
          replyToMessageId: parent.externalId,
        },
      );
    } else if (bodyValue.length > 0) {
      try {
        sentId = await this.apiFor(parent).sendTextMessage(to, bodyValue, {
          replyToMessageId: parent.externalId,
        });
      } catch {
        sentId = null;
      }
    } else {
      throw new Error(
        'WhatsappAdapter.createRecord: a Message send needs a "Body", a "File", ' +
          'or an "Interactive" object (Interactive replaces Body/File — put the text ' +
          'inside `interactive.body.text`).',
      );
    }
    if (sentId === null) {
      throw new Error(
        `WhatsApp did not accept the message to ${to} — free-form sends only reach people ` +
          "who messaged the team number within the last 24 hours (Meta's customer-service " +
          'window). Outside it WhatsApp requires an approved template, which movements ' +
          "can't send yet.",
      );
    }
    return {
      adapterType: WHATSAPP_ADAPTER_TYPE,
      externalId: sentId,
      data: {
        to,
        ...(bodyValue.length > 0 ? { body: bodyValue } : {}),
        ...(isFileValue(fileValue) ? { file_name: fileValue.name ?? 'file' } : {}),
        ...(interactiveValue !== undefined ? { interactive: true } : {}),
        reply_to_message_id: parent.externalId,
      },
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read the first non-empty string value across a set of candidate keys.
 * Underpins the dual-shape tolerance: every reader accepts both the TG-side
 * camelCase field (`from`, `body`, …) and the raw Twilio webhook key
 * (`From`, `Body`, …), since no producer reshapes the webhook before it
 * reaches the adapter — the adapter carries that burden (adapter
 * minimalism).
 */
function readString(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Read the raw sender value from the payload, tolerating both the TG-side
 * `from` field and the raw Twilio `From` key (which carries the
 * `whatsapp:` prefix).
 */
function readSender(payload: Record<string, unknown>): string | undefined {
  return readString(payload, 'from', 'From');
}

/**
 * Read the sender's WhatsApp profile display name, tolerating both the
 * TG-side `profileName` field and the raw Twilio `ProfileName` key.
 */
function readProfileName(payload: Record<string, unknown>): string | null {
  const name = readString(payload, 'profileName', 'ProfileName');
  return name ? name.trim() : null;
}

/**
 * Project either payload shape — the TG-side `WhatsappPayload` or the raw
 * Twilio webhook (`From`/`To`/`Body`/`WaId`/`MessageSid`/`ProfileName`) —
 * onto the uniform scalar fields the schema descriptor advertises. Phone
 * fields are run through the canonical normaliser so `from`/`to` are always
 * the bare, prefix-stripped numbers `describe()` promises.
 *
 * Attachments are handled separately (`coerceAttachments`) because deriving
 * a friendly filename from the MIME type needs an async `mime` import.
 */
function coerceMessageScalars(payload: Record<string, unknown>): Partial<WhatsappPayload> {
  return {
    messageId: readString(payload, 'messageId', 'MessageSid'),
    from: normalizeWhatsappPhone(readString(payload, 'from', 'From')) ?? undefined,
    to: normalizeWhatsappPhone(readString(payload, 'to', 'To')) ?? undefined,
    body: readString(payload, 'body', 'Body') ?? '',
    waId: readString(payload, 'waId', 'WaId'),
    profileName: readProfileName(payload) ?? undefined,
    timestamp: readString(payload, 'timestamp'),
  };
}

/**
 * Resolve the message's media into the uniform `WhatsappAttachment[]`,
 * tolerating both shapes:
 *   • TG-side — a ready `attachments` array is returned as-is.
 *   • Raw Twilio — `NumMedia` + `MediaUrl{i}` / `MediaContentType{i}` are
 *     expanded into attachments, deriving the filename from the MIME type
 *     exactly as v3 did (`Attachment 1.jpeg`, …). Mirrors
 *     `twilio.adapter.ts:getContent`.
 */
async function coerceAttachments(payload: Record<string, unknown>): Promise<WhatsappAttachment[]> {
  const existing = payload.attachments;
  if (Array.isArray(existing)) return existing as WhatsappAttachment[];

  const numMedia = Number(payload.NumMedia) || 0;
  const attachments: WhatsappAttachment[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = payload[`MediaUrl${i}`];
    const contentType = payload[`MediaContentType${i}`];
    if (typeof url === 'string' && typeof contentType === 'string') {
      const extension = await getMimeExtension(contentType);
      attachments.push({
        key: url,
        url,
        contentType,
        filename: `Attachment ${i + 1}${extension ? `.${extension}` : ''}`,
      });
    }
  }
  return attachments;
}

/** Lazily resolve a file extension from a MIME type, matching v3's `mime`
 *  usage. Returns null when the type is unknown. */
async function getMimeExtension(contentType: string): Promise<string | null> {
  const { default: mime } = await import('mime');
  return mime.getExtension(contentType);
}

/**
 * The `File` primitive for a WhatsApp media item — a `FileRef` descriptor
 * whose handle is the media url (`key`), redeemed through the owner
 * (`resolveFileRef`). WhatsApp takes no credential, so the descriptor names
 * none. Returns null when the media carries no url handle.
 */
function whatsappMediaFileRef(att: Partial<WhatsappAttachment>): FileRef | null {
  if (!att.key || !att.filename) return null;
  const key = att.key;
  return {
    __brand: 'FileRef',
    name: att.filename,
    contentType: att.contentType,
    source: ownedFileSource({ adapterType: WHATSAPP_ADAPTER_TYPE, handle: key }),
  };
}

/** Factory matching the registry's AdapterFactory signature. */
export function createWhatsappAdapter(input: { teamId: TeamId }): WhatsappAdapter {
  return new WhatsappAdapter(input.teamId);
}

/**
 * Whether a media handle is one this adapter issued, by its configuration:
 * a URL this deployment exposed (the Meta door's downloaded media,
 * `services/whatsapp/dispatch.ts`), or a Twilio media URL of this
 * deployment's own Twilio account (`TWILIO_ACCOUNT_SID`), over https. True,
 * or the owner as the refusal names it — with why, where the account is not
 * configured (then no Twilio media is its).
 */
function issuedMediaHandle(handle: string): true | string {
  if (isExposedFileUrl(handle)) return true;
  const account = process.env.TWILIO_ACCOUNT_SID;
  if (account === undefined || account === '') {
    return `${WHATSAPP_ADAPTER_TYPE} (TWILIO_ACCOUNT_SID is not configured, so it issues no Twilio media)`;
  }
  try {
    const url = new URL(handle);
    if (url.protocol === 'https:' && url.hostname === 'api.twilio.com' && url.pathname.startsWith(`/2010-04-01/Accounts/${account}/`)) return true;
  } catch {
    // Not a URL: no handle it issued.
  }
  return WHATSAPP_ADAPTER_TYPE;
}
