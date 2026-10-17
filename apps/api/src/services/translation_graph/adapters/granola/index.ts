// Granola adapter (read side) — Granola-as-source. Granola is a POLLED source:
// the event production lives on the PollSource (granola/poll.ts), driven by the
// poll-source worker. This Adapter is the clean read half — `describe` over a
// meeting note + its attendees, field reads, the `Attendees` edge, and the
// summary/transcript as TEXT `#resources`. Source-only: no writes.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  AdapterManifest,
  EdgesFromResult,
  EventType,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
} from 'movement-engine/services/translation_graph/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { Expression } from '#shared/expression/types';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';

import { uniformWalk } from 'module-kit/adapter/hop';
import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  makeUnstablePosition,
  positionData,
} from 'movement-engine/services/translation_graph/types';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { BaseAdapter } from 'module-kit/adapter/base';
import {
  GRANOLA_ADAPTER_TYPE,
  GRANOLA_ATTENDEES_FIELD,
  GRANOLA_ATTENDEE_TYPE_ID,
  GRANOLA_ATTENDEE_DISPLAY_NAME,
  GRANOLA_MEETINGS_COLLECTION,
  GRANOLA_NOTE_EVENT_TAG,
  GRANOLA_NOTE_TYPE_ID,
  GRANOLA_NOTE_DISPLAY_NAME,
  GRANOLA_WORKSPACE_TYPE_ID,
  type GranolaClient,
  noteHasContent,
  normalizeNote,
  resolveGranolaClient,
  type GranolaNotePayload,
} from './client';

export {
  GRANOLA_ADAPTER_TYPE,
  GRANOLA_NOTE_TYPE_ID,
  GRANOLA_NOTE_DISPLAY_NAME,
  GRANOLA_ATTENDEE_TYPE_ID,
  GRANOLA_ATTENDEE_DISPLAY_NAME,
  GRANOLA_ATTENDEES_FIELD,
  GRANOLA_WORKSPACE_TYPE_ID,
  GRANOLA_MEETINGS_COLLECTION,
};

// The `Meetings` collection has NO default lookback: `granola-[m:Meetings]->`
// with no date WHERE pulls the whole archive (an arbitrary floor is surprising —
// if the query implies the whole archive, that's what it gets). When the hop's
// WHERE carries a date lower bound we push it to the API's `updated_after`; the
// rest of the WHERE the engine post-filters. See `pushDownUpdatedAfter` +
// `listMeetings`.

// Date fields whose lower bound (`>=` / `>`) is SAFE to push to `updated_after`:
// each is always <= a note's `updated_at` (a note can't be updated before it was
// created or before the meeting started), so `updated_after = V` never drops a
// meeting whose `<field> >= V`. `scheduled_end` is deliberately excluded — a
// future meeting's end can exceed `updated_at`, so pushing it would under-fetch.
// Matched by BOTH fieldId and displayName (whichever the hop WHERE carries); a
// miss just widens the fetch — the engine post-filters for correctness either way.
const PUSHABLE_LOWER_BOUND_NAMES = new Set([
  'scheduled_start', 'Meeting Start',
  'created_at', 'Created At',
  'updated_at', 'Updated At',
]);

/**
 * Static manifest. Source-only, polled. `requiredCredentialType: GRANOLA` (an
 * API key). `listenConfig` declares the two `listen` options (P4): an optional
 * folder filter and an optional poll-interval override (seconds) — strong
 * defaults apply when omitted. No `subscribableEvents` / `ensureEventSubscription`:
 * Granola has no external subscription; the poll-source worker scans its trigger
 * rows directly.
 */
export const GRANOLA_MANIFEST: AdapterManifest = {
  adapterType: GRANOLA_ADAPTER_TYPE,
  displayName: 'Granola',
  website: 'https://www.granola.ai',
  category: 'Meetings',
  description:
    'Granola meeting notes. Run a movement on each new or updated note — push ' +
    'attendees into your CRM, file the summary, share takeaways.',
  triggerExpectation:
    'Fires once per meeting note that is new or has changed since the last ' +
    'poll, for notes the connected Granola account can see. Notes with neither ' +
    'a summary nor a transcript are skipped. A folder filter (a `listen` option) ' +
    'narrows it to notes in named folders.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated',
    'getActorCandidates', 'extractActor',
  ],
  requiredCredentialType: ExternalServiceType.GRANOLA,
  listenConfig: [
    { key: 'folder', required: false },
    { key: 'pollIntervalSeconds', required: false },
  ],
  triggerKinds: ['GRANOLA'],
  vocabulary: {
    // Path data must OPEN with a moveto — a `d` starting on a bare coordinate
    // pair is in error from its first token, and a browser draws none of it.
    // That is why this mark went missing wherever it was rendered.
    icon: {
      d: 'M1033.77 1021.55c-21.6 24.24-40.11 38.92-50.31 45.93-4.8 3.19-7.8 7.65-11.99 11.48-22.2 19.14-46.26 24.83-63.06 38.23-22.8 17.86-107.98 39.1-132.18 46.54-40.96 9.31-87.03 12.67-137.43 10.75-10.91 0-20.99 0-30.26-.72-3.76-.29-7.54.68-11.31.72-.15 0-.29 0-.42 0-.4 0-1.07-.29-2.01-.86-1.06-.65-2.26-1.06-3.51-1.06-.33 0-.65-.03-.97-.07-5.08-.7-7.78 1.09-9.73 2.08-1.48.75-3.09.12-4.49-.77-4.43-2.81-14.32-9.14-17.68-10.16-3.32-1.01-3.64.37-5.41.68-1.18.21-2.41-.21-3.3-1.01-.99-.9-2.06-2.2-4.5-3.5-4.49-2.39-6.88 3.04-13.55-3.03-.97-.88-1.54-2.61-2.85-2.7-.33-.02-.56-.04-.89-.1-6.72-1.3-18.92-3.8-27.12-6.29-9.6-2.55-6.61-4.46-10.81-6.37-56.4-21.05-136.79-62.52-166.19-91.86-10.8-10.84-23.4-35.72-31.2-42.1-6-5.1-18-15.31-21-20.41-2.4-4.47-.004-12.75-4.2-18.49-5.4-7.02-16.2-10.85-26.4-26.79-11.4-17.86-18-41.46-29.4-65.7C201.997 854.91 175 786.02 175 660.36c0-84.2 39-200.93 55.8-216.88 10.8-10.21 9.6-32.53 17.39-43.37 89.01-123.75 244.8-214.79 430.2-224.35 7.53-.39 15.07-.63 22.62-.72 45.74-.53 91.58 4.47 136.04 15.31 44.41 10.83 86.87 27.73 128.26 46.95 0 0 4.91.39 6.21 1.03 2.16 1.06 3.07 2.99 5.23 4.06 2.16 1.06 5.28.16 7.64.64 7.77 1.59 9.17 6.21 10.6 8.05 1.74 2.23 3.83 3.09 7.78 4.22 10.31 2.96 11.67 6.37 13.07 7.94 1.12 1.25 1.61 2.88 2.17 4.34.57 1.48 1.7 2.84 3.28 3.21 3.42.8 8.06 4.98 9.02 10.69.63 3.72 4.65 5.32 3.55 12.3-.36 2.26 2.05 5.6-10.6 18.07s-39.18 20.33-55.34 14.14c-55.85-21.41-64.13-25.53-86.57-31.65-40.96-11.17-75.85-18.76-118.36-17.96-67.8 1.28-121.21 7.66-185.41 29.98-28.14 9.97-81.27 37.11-107.93 58.24-26.66 21.13-65.26 50.32-81.19 77.33-5.58 9.46-11.86 18.5-25.06 33.17-19.2 21.05-41.42 81.93-48.62 111.28-1.8 6.38 2.99 13.4.59 19.78-2.4 7.02-13.8 10.21-15 15.95-4.8 20.41-3.6 46.56-3.6 68.88 0 12.12 3.6 28.7 7.8 38.27 3 6.38 12.6 10.85 13.8 17.22.6 4.46-5.39 9.56-5.4 13.39 0 3.19 5.39 46.57 8.39 52.95 4.2 7.65 17.4 17.22 21 26.15 2.4 6.38-4.21 12.76.59 19.14 3 3.83 12.61 3.82 16.21 8.92 4.8 6.38 15 24.87 19.8 30.62 3.6 4.47 10.2 6.39 13.2 8.3 9 6.38 1.2 12.11 9.6 21.68 26.4 29.98 67.2 66.98 106.2 83.57 6.02 2.56 67.75 26.13 71.39 26.15 87 12.83 184.84 11.63 269.44-35.58 19.8-10.85 131.97-88.81 150.57-181.3 4.2-18.5 9.6-63.16 7.2-81.02-9.6-66.34-50.48-161.76-125.41-197.09-39.91-18.82-70.2-18.5-78-17.22-22.8 4.46-30.6-8.93-51.6-7.02-64.2 5.1-127.2 22.97-176.4 74.63-45 47.84-54.01 109.08-31.21 147.99 2.4 5.1 1.2 11.48-3.6 14.67-2.1 1.28-4.05 2.87-4.95 4.55-1.79 3.33 3.39 5.11 6.95 6.36 24.96 8.73 33.96 50.84 67 49.06h7.2c0 0 13.8 0 19.2-6.38 4.44-5.24 4.42-11.35 1.27-14.06-1.4-1.21-3.18-1.93-3.59-3.74-.45-1.99-.68-4.61-.68-5.79 0-1.28 1.8-1.92 1.8-3.2 0-3.83-4.2-7.01-3.6-10.84.38-2.04 3.21-4.85 5.21-6.96 1.52-1.6 1.54-3.63.55-5.6-.04-.07-.07-.14-.11-.21-.96-1.97-1.14-4.32-.49-6.41.38-1.2.83-2.49.83-3.78.6-5.74-1.79-8.29-2.39-12.76 0-1.58 8.54-5.32 11.56-7.66.89-.69.98-1.84.69-2.93-.62-2.32-1.45-3.03-1.45-7.27 0-1.02.86-2.44 1.89-3.79 2.08-2.71 4-5.6 4.94-8.88l1.66-5.79c.69-2.42 2.53-4.34 4.92-5.15 4.13-1.39 2.22-8.13 6.16-10.01 1.15-.55 4.02.15 8.63-.83 9.59-1.91 3-5.1 4.8-10.21.84-3.12 3.44-2.81 5.96-2.56 2.02.2 3.98-.46 5.43-1.88 1.43-1.39 2.87-3.02 4.81-3.85 2.43-1.03 8.81-1.23 13.38-1.27 1.88-.02 3.74-.29 5.61-.51 5.1-.6 12.33-.24 15.82-.77 4.2-.64 6.6-4.47 10.19-4.47 3 0 7.21 5.1 10.21 5.1 3 0 6-.55 9-2.55 1.8 0 2.4 3.19 5.4 3.19h1.2c0 0 27.6.64 56.4 18.49 19.8 12.12 34.2 41.47 34.2 41.47 13.8 23.6-1.51 47.86-1.51 69.55 0 8.93 3 16.58 1.2 24.88-1.2 6.38-6 11.49-7.8 16.59-1.8 4.46-1.79 10.21-7.79 18.49-4.8 7.02-7.21 7.01-8.41 8.29-1.8 1.91-17.34 25.41-27.54 34.34-27 24.24-51.96 31.34-88.56 31.97-16.2.64-18 3.83-20.4 3.83-8.4.64-46.79-1.27-58.8-3.19 0 0-53.4-10.21-74.4-20.41-11.4-5.1-86.41-60.6-103.21-91.86-52.2-98.23-40.2-202.84 13.8-273.01 39-51.03 103.2-117.37 255.59-130.13 77.4-6.38 146.41 3.83 200.41 29.35 76.2 35.72 132 98.87 166.8 173.5C1154.8 743.28 1151.37 887.6 1033.77 1021.55z',
      fill: true,
      viewBox: '120 130 1090 1090',
    },
    eventPhrase: {
      default: [{ template: 'When a Granola meeting note arrives' }],
    },
  },
};

export class GranolaAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = GRANOLA_ADAPTER_TYPE;
  readonly supportedTriggers = GRANOLA_MANIFEST.supportedTriggers;

  constructor(
    readonly teamId: TeamId,
    readonly credentialsId?: string,
    /** Injectable for tests; production resolves a credentialed client from
     *  `teamId` + `credentialsId` (the same path the poll source rides). */
    private readonly clientOverride?: GranolaClient,
  ) {
    super();
  }

  /** The credentialed Granola client — needed only when a movement traverses
   *  the `Meetings` collection (the read-from-records paths read inline
   *  position data and need none). Throws a clear "connect Granola" error
   *  when no usable credential resolves, mirroring the poll source. */
  private async client(): Promise<GranolaClient> {
    const client =
      this.clientOverride ??
      (await resolveGranolaClient({ teamId: this.teamId, credentialsId: this.credentialsId }));
    if (!client) {
      throw new Error(
        `GranolaAdapter: no usable Granola credential for team ${this.teamId} ` +
          `(credentialsId=${this.credentialsId ?? 'unset'}). Connect Granola.`,
      );
    }
    return client;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      {
        typeId: GRANOLA_NOTE_TYPE_ID,
        displayName: GRANOLA_NOTE_DISPLAY_NAME,
        writable: false,
        readable: true,
        // The meta-root collection that fans out to PAST meeting notes is
        // named `Meetings` (not `Meeting Note`) so an author traverses
        // `granola-[m:Meetings]-> …` without colliding with the poll-fired
        // note type. The collection still yields `Meeting Note` positions —
        // the engine restamps each landed record to this entry's displayName.
        collectionName: GRANOLA_MEETINGS_COLLECTION,
      },
      // The EVENT edge onto the SAME node the readable collection lands on
      // (adapters/CLAUDE.md rule 9 — two edges, two promises, one node). The
      // poll source has always delivered these: `GranolaPollSource.getEvents`
      // emits one `granola:note`-tagged event per new-or-updated note and
      // `listEventTypes` discriminates it to this type. Only the DECLARATION
      // was missing, so the projection fell back to its single-readable
      // heuristic and `eventPositions` stayed empty — a real promise the
      // surface did not make. Declaring it is behaviour-preserving for the
      // seed: the fires edge lands straight on the record (rule 1's collapse),
      // the address pins nothing, so `eventAddressKey` is the bare node name
      // and the seed stays the same stable `Meeting Note` position it already
      // was — now typed by a declared event edge rather than a guess.
      {
        typeId: GRANOLA_NOTE_TYPE_ID,
        displayName: GRANOLA_NOTE_DISPLAY_NAME,
        writable: false,
        readable: false,
        fires: true,
        description:
          'Delivered when a meeting note is new or has changed since the last ' +
          'poll. The note itself — read its summary, transcript and attendees.',
      },
      // A CHILD type: an attendee is reached through its meeting
      // (`note-[:Attendees]->`), never enumerated from the root — `getRelated`
      // has no meta branch for it, so the root collection `readable: true` used
      // to mint was a read that could only ever return nothing. `readable:
      // false` is the true statement about that one meta edge; the position
      // (and the fields resolving after `-[:Attendees]->`) now derive from
      // REACHABILITY — the entry stays published so the name resolver and
      // `describe` still know the type.
      {
        typeId: GRANOLA_ATTENDEE_TYPE_ID,
        displayName: GRANOLA_ATTENDEE_DISPLAY_NAME,
        writable: false,
        readable: false,
      },
    ];
  }

  /**
   * Granola is the case adapters/CLAUDE.md rule 9 describes: a readable
   * collection AND a fires edge landing on the SAME node. Both are real
   * promises — you can pull in past notes, and you can be told about a new
   * one — so they are two edges, not a conflict.
   */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Granola Meetings',
    description:
      'The Granola workspace. Walk `Meetings` to pull in PAST meeting notes; ' +
      'listen on `Meeting Note` to be told about new or changed ones.',
    fields: [],
    references: [
      {
        fieldId: GRANOLA_MEETINGS_COLLECTION,
        targetTypeId: GRANOLA_NOTE_TYPE_ID,
        cardinality: 'many',
        direction: 'outgoing',
        name: GRANOLA_MEETINGS_COLLECTION,
        description:
          'Past meeting notes the connected Granola account can see. No default ' +
          'lookback — an unbounded walk covers the whole archive, so give the ' +
          'WHERE a date lower bound (e.g. `Meeting Start` >= a date) to keep it ' +
          'fast; other filters (like `Title`) still scan every note.',
        // The client sorts the fetched archive by `updated_at`, newest first
        // (`client.ts` `listMeetingsSince`), and the hop returns that array.
        sequenced: 'chronological',
      },
      {
        fieldId: `fires:${GRANOLA_NOTE_TYPE_ID}`,
        targetTypeId: GRANOLA_NOTE_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: GRANOLA_NOTE_DISPLAY_NAME,
        fires: true,
        readable: false,
        description: 'A meeting note being created or changed — what a listen delivers.',
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: GRANOLA_ADAPTER_TYPE,
      at: position,
      root: GranolaAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // The meta-root descriptor — the "Granola Meetings" node a constructed
    // instance roots at. Its one outgoing reference is the `Meetings`
    // collection: many past Meeting Notes. (The constructed-movement
    // traversal reads collections off `listEntryPoints`; this descriptor
    // gives author-time / editor introspection the same meta-edge.)
    if (typeRef === ADAPTER_META_TYPE_ID || typeRef === GRANOLA_WORKSPACE_TYPE_ID) {
      return {
        typeId: GRANOLA_WORKSPACE_TYPE_ID,
        displayName: 'Granola Meetings',
        description:
          'The Granola workspace — traverse its `Meetings` to pull in PAST meeting notes ' +
          '(distinct from a live listener, which fires only on new or changed notes).',
        fields: [],
        references: [
          {
            fieldId: GRANOLA_MEETINGS_COLLECTION,
            targetTypeId: GRANOLA_NOTE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: GRANOLA_MEETINGS_COLLECTION,
            description:
              'Past meeting notes the connected Granola account can see. No default ' +
              'lookback — an unbounded walk covers the whole archive, so give the ' +
              'WHERE a date lower bound (e.g. `Meeting Start` >= a date) to keep it ' +
              'fast; other filters (like `Title`) still scan every note.',
          },
        ],
      };
    }
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === GRANOLA_NOTE_TYPE_ID) {
      return {
        typeId: GRANOLA_NOTE_TYPE_ID,
        displayName: GRANOLA_NOTE_DISPLAY_NAME,
        description: 'A Granola meeting note — summary, transcript, attendees.',
        fields: [
          { fieldId: 'title', displayName: 'Title', kind: 'string', writable: false, required: true, description: 'The note title (or the calendar event title).' },
          { fieldId: 'summary', displayName: 'Summary', kind: 'string', writable: false, required: false, description: 'The meeting summary (markdown when available).' },
          { fieldId: 'transcript_text', displayName: 'Transcript', kind: 'string', writable: false, required: false, description: 'The full meeting transcript (`[You]/[Speaker]: …` lines), when the note has one.' },
          { fieldId: 'scheduled_start', displayName: 'Meeting Start', kind: 'date', writable: false, required: false, description: 'When the meeting was scheduled to start.' },
          { fieldId: 'scheduled_end', displayName: 'Meeting End', kind: 'date', writable: false, required: false, description: 'When the meeting was scheduled to end.' },
          { fieldId: 'organizer_email', displayName: 'Organizer Email', kind: 'string', writable: false, required: false, description: 'The meeting organizer.' },
          { fieldId: 'folder_names', displayName: 'Folder Names', kind: 'string', writable: false, required: false, description: 'The Granola folders this note belongs to.' },
          { fieldId: 'note_owner_email', displayName: 'Note Owner Email', kind: 'string', writable: false, required: true, description: 'The Granola user who owns the note.' },
          { fieldId: 'note_owner_name', displayName: 'Note Owner Name', kind: 'string', writable: false, required: false },
          { fieldId: 'created_at', displayName: 'Created At', kind: 'date', writable: false, required: true },
          { fieldId: 'updated_at', displayName: 'Updated At', kind: 'date', writable: false, required: true },
          { fieldId: 'granola_note_id', displayName: 'Granola Note ID', kind: 'string', writable: false, required: true, description: 'The stable Granola note id.' },
        ],
        references: [
          {
            fieldId: GRANOLA_ATTENDEES_FIELD,
            targetTypeId: GRANOLA_ATTENDEE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: 'Attendees',
            description: 'The people on the call (zero or more).',
          },
        ],
      };
    }
    if (typeId === GRANOLA_ATTENDEE_TYPE_ID) {
      return {
        typeId: GRANOLA_ATTENDEE_TYPE_ID,
        displayName: GRANOLA_ATTENDEE_DISPLAY_NAME,
        description: 'A person who attended the meeting.',
        fields: [
          { fieldId: 'email', displayName: 'Email', kind: 'string', writable: false, required: true, description: 'The attendee\'s email — their identity.' },
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
        ],
        references: [],
      };
    }
    return null;
  }

  // ── 2. Field-level access ──────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== GRANOLA_ADAPTER_TYPE) {
      throw new Error(
        `GranolaAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    return data[fieldId] ?? null;
  }

  // ── 3. Reference traversal (attendees) ─────────────────────────────────
  // The summary and transcript are read explicitly off the note (`Summary` /
  // `Transcript` fields). The source content that fed an extraction is reached
  // off the extracted node (`extractedNode-[:_resources]->`), not the input.

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== GRANOLA_ADAPTER_TYPE) {
      throw new Error(
        `GranolaAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // Meta-root → `Meetings` collection: a movement constructed `granola(...)`
    // and is traversing `granola-[m:Meetings]-> { … }` to pull PAST meetings.
    // The collection name crosses verbatim (the meta position carries no type
    // to resolve an edge against), so match it BEFORE the per-type edge
    // resolver (which would drift on the typeless meta position).
    if (input.position.recordType === META_RECORD_TYPE) {
      if (input.fieldId !== GRANOLA_MEETINGS_COLLECTION) return [];
      // The LIMIT travels only when nothing has to be sorted first: Granola's
      // list endpoint takes no sort, so under an ORDER BY the engine orders the
      // whole set and slices it (`GetRelatedInput.limit`).
      const cap = input.orderBy === undefined ? input.limit : undefined;
      return this.listMeetings({
        ...(input.where !== undefined ? { where: input.where } : {}),
        ...(cap !== undefined ? { limit: cap } : {}),
      });
    }

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId === GRANOLA_ATTENDEES_FIELD) {
      const note = (positionData(input.position) ?? {}) as Partial<GranolaNotePayload>;
      return (note.attendees ?? []).map((attendee) => ({
        position: makeUnstablePosition({
          adapterType: GRANOLA_ADAPTER_TYPE,
          recordType: GRANOLA_ATTENDEE_DISPLAY_NAME,
          data: attendee,
        }),
      }));
    }
    return [];
  }

  /**
   * Pull past meetings for the `Meetings` collection — one `Meeting Note`
   * position per past note (unstable, carrying the normalised payload the
   * Note's `getFieldValue` / `Attendees` edge already read from).
   *
   * Bounding: no default lookback — with no date WHERE this pulls the whole
   * archive (page cap aside). We push down what the API supports: a date lower
   * bound from the hop's WHERE becomes `updated_after` (`pushDownUpdatedAfter`).
   * Everything else the WHERE expresses (an upper bound, an attendee EXISTS, a
   * title match) the engine post-filters over what we return, so the result is
   * exact regardless of what we manage to push. `limit` (the hop's LIMIT, and
   * only when the hop asked for no ordering) caps the hydrated count.
   */
  private async listMeetings(input: { where?: Expression; limit?: number }): Promise<RelatedResult[]> {
    const updatedAfter = pushDownUpdatedAfter(input.where);
    const client = await this.client();
    const notes = await client.listMeetingsSince({
      ...(updatedAfter !== undefined ? { updatedAfter } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return notes.map((note) => ({
      position: makeUnstablePosition({
        adapterType: GRANOLA_ADAPTER_TYPE,
        recordType: GRANOLA_NOTE_DISPLAY_NAME,
        data: note,
      }),
    }));
  }

  // ── 4. Actor — the note's owner is its originator ──────────────────────

  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const actor = await this.extractActor(input);
    return actor ? [{ identity: actor, source: 'originator' }] : [];
  }

  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    const note = (input.event.payload ?? {}) as Partial<GranolaNotePayload>;
    const email = note.note_owner_email;
    if (!email) return null;
    return {
      identifier: email,
      scheme: 'email',
      adapterType: GRANOLA_ADAPTER_TYPE,
      email,
      ...(note.note_owner_name ? { name: note.note_owner_name } : {}),
    };
  }

  // ── 5. Event typing ────────────────────────────────────────────────────

  async listEventTypes(): Promise<EventType[]> {
    // Every polled note carries the `granola:note` tag (set by the PollSource),
    // so discrimination is by tag → the typed `granola:note` root position.
    return [
      {
        tag: GRANOLA_NOTE_EVENT_TAG,
        positionType: GRANOLA_NOTE_TYPE_ID,
        match: { path: 'granola_note_id', equals: [] },
      },
    ];
  }
}

/** Factory matching the registry's AdapterFactory signature. */
export function createGranolaAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): GranolaAdapter {
  return new GranolaAdapter(input.teamId, input.credentialsId);
}

/** The ISO timestamp `lookbackDays` ago — the default lower bound for the
 *  `Meetings` collection (see `GranolaAdapter.listMeetings`). */
/**
 * The tightest safe `updated_after` we can push from a hop's WHERE: the MAX
 * lower bound (`>=` / `>`) across the pushable date fields
 * (`PUSHABLE_LOWER_BOUND_NAMES`). A meeting matching `scheduled_start >= A` has
 * `updated_at >= scheduled_start >= A`, so `updated_after = A` never drops it;
 * taking the max across several such bounds stays safe and fetches the least.
 * Returns undefined when the WHERE names no pushable lower bound (→ fetch the
 * whole archive). Non-`and` structure (OR, NOT) is not pushed — the engine
 * post-filters it. `right`/`left` operand order is handled both ways.
 */
function pushDownUpdatedAfter(where: Expression | undefined): string | undefined {
  if (where === undefined) return undefined;
  let bound: string | undefined;
  const consider = (fieldExpr: Expression, valueExpr: Expression): void => {
    const field = fieldExpr.type === 'property' ? fieldExpr.propertyTypeId : undefined;
    const value =
      valueExpr.type === 'static' && typeof valueExpr.value === 'string' ? valueExpr.value : undefined;
    if (field === undefined || value === undefined || !PUSHABLE_LOWER_BOUND_NAMES.has(field)) return;
    if (bound === undefined || value > bound) bound = value;
  };
  const visit = (e: Expression): void => {
    if (e.type === 'logical' && e.op === 'and') {
      e.operands.forEach(visit);
      return;
    }
    if (e.type === 'compare' && (e.op === 'gte' || e.op === 'gt')) {
      consider(e.left, e.right); // field >= value
    } else if (e.type === 'compare' && (e.op === 'lte' || e.op === 'lt')) {
      consider(e.right, e.left); // value <= field  ⇒  field >= value
    }
  };
  visit(where);
  return bound;
}
