// The calls recorded parity makes, in order, against one Granola
// implementation. Each later call is built from what an earlier one answered,
// so the script walks the seeded notes the way a run would: describe the
// types, pull past meetings (bounded and not), read every field and the
// attendees of a landed note, derive the actor, poll. The transcript is every
// answer, as JSON; two implementations agree when their transcripts and the
// requests they made are identical.

import type { TriggerEvent } from 'engine-contracts';
import type { Expression } from '#shared/expression/types';
import type { Adapter, DiscriminableEvent } from 'movement-engine/public/adapter';

import { makeMetaPosition } from 'movement-engine/public/catalog';

export interface ParitySubject {
  adapter: Adapter;
  poll(input: { config: unknown; checkpoint?: unknown }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }>;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

const prop = (name: string): Expression => ({ type: 'property', propertyTypeId: name }) as Expression;
const value = (v: string | number | boolean | null): Expression => ({ type: 'static', value: v }) as Expression;
const cmp = (left: Expression, op: 'eq' | 'gte', right: Expression): Expression =>
  ({ type: 'compare', op, left, right }) as Expression;

/** A fixed checkpoint before every seeded note, so the poll has something to
 *  deliver and never reads the clock. */
const POLL_CHECKPOINT = { updatedAfter: '2026-06-01T00:00:00.000Z' };

function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

export async function runParityScript(subject: ParitySubject): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  const step = async <T>(name: string, call: () => Promise<T>, shape: (answer: T) => unknown = (answer) => answer): Promise<T | undefined> => {
    try {
      const answer = await call();
      transcript.push({ step: name, answer: json(shape(answer)) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };
  const meetings = (name: string, extra: Partial<{ where: Expression; orderBy: { fieldId: string; direction: 'asc' | 'desc' }; limit: number }> = {}) =>
    step(name, () => adapter.getRelated({ position: makeMetaPosition('granola'), fieldId: 'Meetings', direction: 'outgoing', ...extra }));

  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['granola:note', 'Meeting Note', 'granola:attendee', 'Attendee', 'granola:workspace', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  await step('edgesFrom meta', async () => adapter.edgesFrom?.(makeMetaPosition('granola')) ?? null);

  // The back-catalogue: the whole archive, then a pushed-down lower bound, a
  // bound that cannot be pushed (an equality), and a LIMIT that travels.
  const all = await meetings('Meetings');
  await meetings('Meetings WHERE Meeting Start >= 2026-07-01', { where: cmp(prop('Meeting Start'), 'gte', value('2026-07-01T00:00:00.000Z')) });
  await meetings('Meetings WHERE Title ==', { where: cmp(prop('Title'), 'eq', value('Series A sync')) });
  await meetings('Meetings LIMIT 1', { limit: 1 });
  await meetings('Meetings ORDER BY Updated At LIMIT 1', { orderBy: { fieldId: 'Updated At', direction: 'asc' }, limit: 1 });

  // Every landed note, newest first: each field by its display name (and one
  // by its id, one that does not exist), then its attendees and theirs.
  const FIELDS = [
    'Title', 'Summary', 'Transcript', 'Meeting Start', 'Meeting End', 'Organizer Email', 'Folder Names',
    'Note Owner Email', 'Note Owner Name', 'Created At', 'Updated At', 'Granola Note ID', 'granola_note_id', 'Nonexistent',
  ];
  for (const [index, landed] of (all ?? []).entries()) {
    for (const field of FIELDS) {
      await step(`Note ${index}.${field}`, () => adapter.getFieldValue({ position: landed.position, fieldId: field }));
    }
    const attendees = await step(`Note ${index} Attendees`, () => adapter.getRelated({ position: landed.position, fieldId: 'Attendees', direction: 'outgoing' }));
    await step(`Note ${index} incoming`, () => adapter.getRelated({ position: landed.position, fieldId: 'Attendees', direction: 'incoming' }));
    for (const [at, attendee] of (attendees ?? []).entries()) {
      for (const field of ['Email', 'Name', 'Nonexistent']) {
        await step(`Note ${index} Attendee ${at}.${field}`, () => adapter.getFieldValue({ position: attendee.position, fieldId: field }));
      }
    }
  }

  await step('listEventTypes', async () => (await adapter.listEventTypes?.()) ?? null);

  // The poll. The first look sets a mark from the clock, so only its shape is
  // kept; every other poll starts from a fixed checkpoint.
  await step('poll first look', () => subject.poll({ config: {} }), (answer) => ({
    events: answer.events,
    checkpoint: typeof (answer.checkpoint as { updatedAfter?: unknown } | undefined)?.updatedAfter,
  }));
  await step('poll from a checkpoint', () => subject.poll({ config: {}, checkpoint: POLL_CHECKPOINT }));
  await step('poll folder Dealflow', () => subject.poll({ config: { folder: 'Dealflow' }, checkpoint: POLL_CHECKPOINT }));
  await step('poll folders list', () => subject.poll({ config: { folder: ['portfolio', 'nope'] }, checkpoint: POLL_CHECKPOINT }));
  await step('poll past the newest', () => subject.poll({ config: {}, checkpoint: { updatedAfter: '2026-09-01T00:00:00.000Z' } }));

  // The actor, from the payload a poll delivered.
  const delivered = await subject.poll({ config: {}, checkpoint: POLL_CHECKPOINT });
  for (const [index, event] of delivered.events.entries()) {
    const triggerEvent: TriggerEvent = {
      pipelineInputId: `parity-${index}`,
      adapterType: 'granola',
      triggerType: 'poll',
      payload: event.payload,
      occurredAt: event.occurredAt ?? '2026-01-01T00:00:00.000Z',
    };
    await step(`extractActor ${index}`, async () => (await adapter.extractActor?.({ event: triggerEvent })) ?? null);
    await step(`getActorCandidates ${index}`, async () => (await adapter.getActorCandidates?.({ event: triggerEvent })) ?? null);
  }
  return transcript;
}
