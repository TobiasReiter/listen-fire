// Granola adapter + poll — pure helpers + mocked client. Covers note
// normalisation, the attendees edge + TEXT resources, field reads, actor
// extraction, and the poll (paging / checkpoint / folder filter / empty-skip /
// ordering). No network; the API client is faked.

import type { TriggerEvent } from 'engine-contracts';

import { RESOURCES_REFERENCE_FIELD_ID } from 'movement-engine/public/adapter';
import {
  ADAPTER_META_TYPE_ID,
  makeMetaPosition,
  makeStablePosition,
  positionData,
} from 'movement-engine/public/catalog';
import {
  GranolaAdapter,
  GRANOLA_ATTENDEE_TYPE_ID,
  GRANOLA_ATTENDEE_DISPLAY_NAME,
  GRANOLA_MEETINGS_COLLECTION,
  GRANOLA_NOTE_TYPE_ID,
  GRANOLA_NOTE_DISPLAY_NAME,
  GRANOLA_WORKSPACE_TYPE_ID,
} from '../index';
import { pollGranola } from '../poll';
import {
  GranolaClient,
  noteHasContent,
  normalizeNote,
  transcriptText,
  type GranolaNote,
} from '../api_client';

/** An adapter that is never asked for a client (the reads here are off inline
 *  position data), and one over a fake client. */
const withoutClient = () =>
  new GranolaAdapter(async () => {
    throw new Error('no client in this test');
  });
const withClient = (client: GranolaClient) => new GranolaAdapter(async () => client);

function note(over: Partial<GranolaNote> = {}): GranolaNote {
  return {
    id: 'note-1',
    object: 'note',
    title: 'Series A sync',
    owner: { name: 'Priya Owner', email: 'priya@fund.com' },
    created_at: '2026-06-19T09:00:00.000Z',
    updated_at: '2026-06-19T10:00:00.000Z',
    calendar_event: {
      event_title: 'Series A sync',
      invitees: [{ email: 'ceo@acme.com' }],
      organiser: 'priya@fund.com',
      calendar_event_id: 'cal-1',
      scheduled_start_time: '2026-06-19T09:00:00.000Z',
      scheduled_end_time: '2026-06-19T09:30:00.000Z',
    },
    attendees: [
      { name: 'Acme CEO', email: 'ceo@acme.com' },
      { name: null, email: 'cfo@acme.com' },
    ],
    folder_membership: [{ id: 'f1', name: 'Dealflow' }],
    summary_text: 'They want $2M.',
    summary_markdown: '## Notes\nThey want **$2M**.',
    transcript: [
      { speaker: { source: 'microphone' }, text: 'Hi', start_time: '0', end_time: '1' },
      { speaker: { source: 'speaker' }, text: 'Hello', start_time: '1', end_time: '2' },
    ],
    ...over,
  };
}

/** A fake client returning a fixed note set, honouring `updated_after`.
 *  `listMeetingsSince` borrows the REAL implementation (it only leans on
 *  `listAllNotes` + `getNote`, both faked here) so the meta-collection path
 *  exercises the genuine bound + hydrate logic. */
function fakeClient(notes: GranolaNote[]): GranolaClient {
  const fake = {
    listAllNotes: async (updatedAfter?: string) =>
      notes
        .filter((n) => !updatedAfter || n.updated_at > updatedAfter)
        .map((n) => ({ id: n.id, object: 'note', title: n.title, owner: n.owner, created_at: n.created_at, updated_at: n.updated_at })),
    getNote: async (id: string) => notes.find((n) => n.id === id)!,
  } as unknown as GranolaClient;
  fake.listMeetingsSince = GranolaClient.prototype.listMeetingsSince.bind(fake);
  return fake;
}

// The engine's `surfaceReadAdapter` restamps a position's recordType to the
// NATURAL type name (the displayName) before a field/edge read, so the adapter
// resolves the also-natural field name against it. Mirror that here.
const notePosition = (data: unknown) =>
  makeStablePosition({ adapterType: 'granola', recordType: 'Meeting Note', recordId: 'note-1', data });
const attendeePosition = (data: unknown) =>
  makeStablePosition({ adapterType: 'granola', recordType: 'Attendee', recordId: 'att-1', data });

// ── client / normalisation ──────────────────────────────────────────────────

describe('normalizeNote', () => {
  it('flattens a note, preferring markdown summary + calendar fields', () => {
    const p = normalizeNote(note());
    expect(p).toMatchObject({
      title: 'Series A sync',
      summary: '## Notes\nThey want **$2M**.',
      scheduled_start: '2026-06-19T09:00:00.000Z',
      organizer_email: 'priya@fund.com',
      folder_names: 'Dealflow',
      note_owner_email: 'priya@fund.com',
      note_owner_name: 'Priya Owner',
      granola_note_id: 'note-1',
    });
    expect(p.attendees).toEqual([{ email: 'ceo@acme.com', name: 'Acme CEO' }, { email: 'cfo@acme.com' }]);
    expect(p.transcript_text).toBe('[You]: Hi\n[Speaker]: Hello');
  });

  it('falls back to summary_text + calendar title when fields are absent', () => {
    const p = normalizeNote(note({ title: null, summary_markdown: null }));
    expect(p.title).toBe('Series A sync'); // calendar event title
    expect(p.summary).toBe('They want $2M.');
  });

  it('noteHasContent is false for an empty note', () => {
    expect(noteHasContent(note({ summary_text: '', summary_markdown: null, transcript: null }))).toBe(false);
    expect(transcriptText(note({ transcript: null }))).toBeUndefined();
  });
});

// ── adapter: describe / fields / edge / resources / actor ───────────────────

describe('GranolaAdapter', () => {
  const adapter = withoutClient();

  it('describes the note type with summary + transcript fields and an attendees reference (no input-side #resources)', async () => {
    const d = await adapter.describe(GRANOLA_NOTE_TYPE_ID);
    // The summary AND the transcript are now read explicitly as fields — the
    // transcript moved off the retired input-side `_resources` bundle so it
    // stays reachable (lossless).
    expect(d?.fields.map((f) => f.fieldId)).toEqual(
      expect.arrayContaining(['summary', 'transcript_text']),
    );
    expect(d?.references.map((r) => r.fieldId)).toEqual(['attendees']);
    expect(d?.references.map((r) => r.fieldId)).not.toContain(RESOURCES_REFERENCE_FIELD_ID);
  });

  it('reads the transcript explicitly off the note (the lossless replacement for input-side #resources)', async () => {
    const value = await adapter.getFieldValue({
      position: notePosition(normalizeNote(note())),
      fieldId: 'Transcript',
    });
    expect(value).toBe('[You]: Hi\n[Speaker]: Hello');
  });

  it('reads a scalar field by its natural name', async () => {
    const value = await adapter.getFieldValue({
      position: notePosition(normalizeNote(note())),
      fieldId: 'Title',
    });
    expect(value).toBe('Series A sync');
  });

  it('drifts when a position carries the raw typeId instead of the display name (ids never belong on a position)', async () => {
    // The invariant after the structured-id migration: a position's recordType
    // is the pretty NAME (`Meeting Note`); the typeId `granola:note` is the
    // adapter's private handle and never rides a position. A position stamped
    // with the raw id is a leak — field resolution drifts LOUDLY (rather than
    // being silently tolerated), so the bug is caught at the boundary.
    await expect(
      adapter.getFieldValue({
        position: makeStablePosition({
          adapterType: 'granola',
          recordType: GRANOLA_NOTE_TYPE_ID,
          recordId: 'note-1',
          data: normalizeNote(note()),
        }),
        fieldId: 'Title',
      }),
    ).rejects.toThrow(/not a known field/i);
  });

  it('traverses the attendees edge into typed attendee positions', async () => {
    const related = await adapter.getRelated({
      position: notePosition(normalizeNote(note())),
      fieldId: 'Attendees',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(2);
    expect(related[0].position.recordType).toBe(GRANOLA_ATTENDEE_DISPLAY_NAME);
    // The landing already carries the natural type name; the engine's restamp
    // is a no-op (the name it would stamp equals what's already there).
    const email = await adapter.getFieldValue({
      position: attendeePosition(positionData(related[0].position)),
      fieldId: 'Email',
    });
    expect(email).toBe('ceo@acme.com');
  });

  it('no longer resolves a `_resources` hop off a note (drifts — it is extracted-node-only now)', async () => {
    // Summary + transcript are read explicitly as fields now; `_resources`
    // is reachable only off an extracted node (`extractedNode-[:_resources]->`).
    await expect(
      adapter.getRelated({
        position: notePosition(normalizeNote(note())),
        fieldId: RESOURCES_REFERENCE_FIELD_ID,
        direction: 'outgoing',
      }),
    ).rejects.toThrow();
  });

  it('extracts the note owner as the email-scheme originator', async () => {
    const event = { payload: normalizeNote(note()) } as TriggerEvent;
    const actor = await adapter.extractActor({ event });
    expect(actor).toEqual({
      identifier: 'priya@fund.com',
      scheme: 'email',
      adapterType: 'granola',
      email: 'priya@fund.com',
      name: 'Priya Owner',
    });
    expect(await adapter.getActorCandidates({ event })).toEqual([{ identity: actor, source: 'originator' }]);
  });
});

// ── adapter: the `meetings` meta-collection (pulling PAST meetings) ──────────

describe('GranolaAdapter — meetings meta-collection', () => {
  const adapter = withoutClient();

  it('lists the Meeting Note entry with a distinct `meetings` collection name', async () => {
    const entries = await adapter.listEntryPoints();
    const noteEntry = entries.find((e) => e.typeId === GRANOLA_NOTE_TYPE_ID);
    expect(noteEntry?.collectionName).toBe(GRANOLA_MEETINGS_COLLECTION);
    expect(noteEntry?.readable).toBe(true);
  });

  it('publishes Attendee as a CHILD type: readable:false, reached only via `attendees`', async () => {
    // The root cannot enumerate attendees — `getRelated(meta, …)` has no branch
    // for them — so the entry must not claim a root collection. The position
    // (and field resolution after `-[:attendees]->`) derives from reachability.
    const entries = await adapter.listEntryPoints();
    const attendeeEntry = entries.find((e) => e.typeId === GRANOLA_ATTENDEE_TYPE_ID);
    expect(attendeeEntry?.readable).toBe(false);
    expect(attendeeEntry?.writable).toBe(false);
  });

  it('describes the workspace meta-node with a `meetings` -> Meeting Note edge', async () => {
    for (const ref of [ADAPTER_META_TYPE_ID, GRANOLA_WORKSPACE_TYPE_ID]) {
      const d = await adapter.describe(ref);
      expect(d?.typeId).toBe(GRANOLA_WORKSPACE_TYPE_ID);
      expect(d?.displayName).toBe('Granola Meetings');
      expect(d?.references).toEqual([
        expect.objectContaining({
          name: GRANOLA_MEETINGS_COLLECTION,
          targetTypeId: GRANOLA_NOTE_TYPE_ID,
          cardinality: 'many',
          direction: 'outgoing',
        }),
      ]);
    }
  });

  it('resolves the `meetings` collection off the meta root into Meeting Note positions', async () => {
    const a = withClient(fakeClient([note({ id: 'a' }), note({ id: 'b' })]));
    const related = await a.getRelated({
      position: makeMetaPosition('granola'),
      fieldId: GRANOLA_MEETINGS_COLLECTION,
      direction: 'outgoing',
    });
    expect(related).toHaveLength(2);
    // Each landed position is a Meeting Note carrying the normalised payload —
    // the SAME shape the poll-fired note + its field/edge reads consume.
    expect(related.every((r) => r.position.recordType === GRANOLA_NOTE_DISPLAY_NAME)).toBe(true);
    const summary = await a.getFieldValue({
      position: makeStablePosition({
        adapterType: 'granola',
        recordType: 'Meeting Note',
        recordId: 'note-1',
        data: positionData(related[0].position),
      }),
      fieldId: 'Summary',
    });
    expect(summary).toBe('## Notes\nThey want **$2M**.');
  });

  it('pulls the whole archive when the hop places no date bound (no arbitrary lookback)', async () => {
    const client = fakeClient([note()]);
    const spy = jest.spyOn(client, 'listAllNotes');
    const a = withClient(client);
    await a.getRelated({
      position: makeMetaPosition('granola'),
      fieldId: GRANOLA_MEETINGS_COLLECTION,
      direction: 'outgoing',
    });
    // No date WHERE → no `updated_after` floor: list the whole archive.
    expect(spy.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('pushes a date lower bound from the hop WHERE down to updated_after', async () => {
    const client = fakeClient([note()]);
    const spy = jest.spyOn(client, 'listAllNotes');
    const a = withClient(client);
    await a.getRelated({
      position: makeMetaPosition('granola'),
      fieldId: GRANOLA_MEETINGS_COLLECTION,
      direction: 'outgoing',
      // `m.\`Meeting Start\` >= "2026-03-01…"` — the pushable lower bound.
      where: {
        type: 'compare',
        op: 'gte',
        left: { type: 'property', propertyTypeId: 'Meeting Start' },
        right: { type: 'static', value: '2026-03-01T00:00:00.000Z' },
      },
    });
    expect(spy.mock.calls[0]?.[0]).toBe('2026-03-01T00:00:00.000Z');
  });

  it('ignores the hop LIMIT when an ORDER BY came with it (Granola cannot sort)', async () => {
    const client = fakeClient([note({ id: 'a' }), note({ id: 'b' })]);
    const a = withClient(client);
    // The contract on `GetRelatedInput.limit`: n arbitrary rows sorted
    // afterwards answers a different question, so the whole set comes back and
    // the engine orders and cuts it.
    const related = await a.getRelated({
      position: makeMetaPosition('granola'),
      fieldId: GRANOLA_MEETINGS_COLLECTION,
      direction: 'outgoing',
      orderBy: { fieldId: 'Meeting Start', direction: 'desc' },
      limit: 1,
    });
    expect(related).toHaveLength(2);
  });

  it('honours the hop LIMIT when the hop asked for no ordering', async () => {
    const a = withClient(fakeClient([note({ id: 'a' }), note({ id: 'b' })]));
    const related = await a.getRelated({
      position: makeMetaPosition('granola'),
      fieldId: GRANOLA_MEETINGS_COLLECTION,
      direction: 'outgoing',
      limit: 1,
    });
    expect(related).toHaveLength(1);
  });

  it('returns nothing for an unknown collection on the meta root', async () => {
    const a = withClient(fakeClient([note()]));
    expect(
      await a.getRelated({
        position: makeMetaPosition('granola'),
        fieldId: 'nonexistent',
        direction: 'outgoing',
      }),
    ).toEqual([]);
  });
});

// ── PollSource: getEvents ───────────────────────────────────────────────────

describe('pollGranola', () => {
  function source(notes: GranolaNote[]) {
    return { getEvents: (input: { config: unknown; checkpoint?: unknown }) => pollGranola(fakeClient(notes), input) };
  }

  it('first poll sets the checkpoint and emits nothing (no backfill)', async () => {
    const older = note({ id: 'a', updated_at: '2026-06-19T08:00:00.000Z' });
    const newer = note({ id: 'b', updated_at: '2026-06-19T11:00:00.000Z' });
    // No checkpoint = first sight of this trigger: start watching from now, don't
    // replay the archive. The checkpoint is set (to ~now) so the next poll is
    // incremental; nothing is emitted this time.
    const { events, checkpoint } = await source([newer, older]).getEvents({ config: {} });

    expect(events).toEqual([]);
    expect((checkpoint as { updatedAfter: string }).updatedAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a subsequent poll emits one tagged event per note, oldest first, and advances the checkpoint', async () => {
    const older = note({ id: 'a', updated_at: '2026-06-19T08:00:00.000Z' });
    const newer = note({ id: 'b', updated_at: '2026-06-19T11:00:00.000Z' });
    // A checkpoint already exists (not the first poll) — this is where meetings
    // are emitted.
    const { events, checkpoint } = await source([newer, older]).getEvents({
      checkpoint: { updatedAfter: '2026-06-19T00:00:00.000Z' },
      config: {},
    });

    expect(events.map((e) => e.externalId)).toEqual(['a', 'b']); // oldest first
    expect(events.every((e) => e.tag === 'granola:note')).toBe(true);
    expect((checkpoint as { updatedAfter: string }).updatedAfter).toBe('2026-06-19T11:00:00.000Z');
  });

  it('only lists notes updated since the checkpoint', async () => {
    const stale = note({ id: 'a', updated_at: '2026-06-19T08:00:00.000Z' });
    const fresh = note({ id: 'b', updated_at: '2026-06-19T11:00:00.000Z' });
    const { events } = await source([stale, fresh]).getEvents({
      checkpoint: { updatedAfter: '2026-06-19T10:00:00.000Z' },
      config: {},
    });
    expect(events.map((e) => e.externalId)).toEqual(['b']);
  });

  it('filters by folder (a listen option)', async () => {
    const inFolder = note({ id: 'a', folder_membership: [{ id: 'f', name: 'Dealflow' }] });
    const outFolder = note({ id: 'b', folder_membership: [{ id: 'g', name: 'Personal' }] });
    const { events } = await source([inFolder, outFolder]).getEvents({
      checkpoint: { updatedAfter: '2026-06-19T00:00:00.000Z' },
      config: { folder: 'dealflow' },
    });
    expect(events.map((e) => e.externalId)).toEqual(['a']);
  });

  it('skips notes with neither summary nor transcript', async () => {
    const empty = note({ id: 'a', summary_text: '', summary_markdown: null, transcript: null });
    const { events } = await source([empty]).getEvents({
      checkpoint: { updatedAfter: '2026-06-19T00:00:00.000Z' },
      config: {},
    });
    expect(events).toHaveLength(0);
  });
});
