// The calls recorded parity makes, in order, against one Evertrace
// implementation. Each later call is built from what an earlier one answered,
// so the script walks the seeded workspace the way a run would: describe every
// type, read each root collection (pushed down and not), read every field and
// edge each landed type declares, read records back by id, write (create,
// update, delete, and every refusal), and poll both event kinds. The
// transcript is every answer, as JSON; two implementations agree when their
// transcripts and the requests they made are identical.

import type { Expression } from '#shared/expression/types';
import type { Adapter, DiscriminableEvent, MutationContext, RelatedResult } from 'movement-engine/public/adapter';
import type { SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';

import { makeMetaPosition, positionRecordId } from 'movement-engine/public/catalog';

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
const cmp = (left: Expression, op: 'eq' | 'gte' | 'contains', right: Expression): Expression =>
  ({ type: 'compare', op, left, right }) as Expression;

/** Before every seeded signal and entry, so a poll has something to deliver
 *  and never reads the clock; and after all of them, so one has nothing. */
const BEFORE_EVERYTHING = 1;
const AFTER_EVERYTHING = 4_000_000_000_000;

const MUTATION: MutationContext = {
  source: { type: 'api', adapterType: 'kg' },
  occurredAt: '2026-10-17T12:00:00.000Z',
};

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
  const meta = makeMetaPosition('evertrace');
  const root = (name: string, fieldId: string, extra: Partial<{ where: Expression; orderBy: { fieldId: string; direction: 'asc' | 'desc' }; limit: number }> = {}) =>
    step(name, () => adapter.getRelated({ position: meta, fieldId, direction: 'outgoing', ...extra }));
  const edge = (name: string, position: SourcePosition, fieldId: string, extra: Partial<{ where: Expression; orderBy: { fieldId: string; direction: 'asc' | 'desc' }; limit: number }> = {}) =>
    step(name, () => adapter.getRelated({ position, fieldId, direction: 'outgoing', ...extra }));
  const first = (results: RelatedResult[] | undefined): SourcePosition | undefined => results?.[0]?.position;

  /** Every field the type declares, by display name, read off `position`. */
  const readFields = async (label: string, position: SourcePosition, typeName: string) => {
    const descriptor: SchemaTypeDescriptor | null | undefined = await adapter.describe(typeName);
    for (const field of descriptor?.fields ?? []) {
      await step(`${label}.${field.displayName}`, () => adapter.getFieldValue({ position, fieldId: field.displayName }));
    }
    await step(`${label}.Nonexistent`, () => adapter.getFieldValue({ position, fieldId: 'Nonexistent' }));
  };

  // ── schema ────────────────────────────────────────────────────────────────
  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['Signal', 'Experience', 'Education', 'Company', 'School', 'Search', 'List', 'List Entry', 'evertrace:workspace', 'meta', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  await step('edgesFrom meta', async () => adapter.edgesFrom?.(meta) ?? null);

  // ── the root collections ──────────────────────────────────────────────────
  const signals = await root('Signals', 'Signals');
  await root('Signals WHERE Score >= 7', 'Signals', { where: cmp(prop('Score'), 'gte', value(7)) });
  await root('Signals WHERE Country == Japan LIMIT 2', 'Signals', { where: cmp(prop('Country'), 'eq', value('Japan')), limit: 2 });
  await root('Signals WHERE Name CONTAINS', 'Signals', { where: cmp(prop('Name'), 'contains', value('a')) });
  await root('Signals WHERE Discovered At >=', 'Signals', { where: cmp(prop('Discovered At'), 'gte', value('2026-01-01T00:00:00.000Z')) });
  await root('Signals ORDER BY Score LIMIT 2', 'Signals', { orderBy: { fieldId: 'Score', direction: 'desc' }, limit: 2 });
  const searches = await root('Searches', 'Searches');
  await root('Searches LIMIT 1', 'Searches', { limit: 1 });
  const lists = await root('Lists', 'Lists');
  const companies = await root('Companies', 'Companies');
  await root('Companies WHERE Name ==', 'Companies', { where: cmp(prop('Name'), 'eq', value('Northwind Robotics')) });
  const schools = await root('Schools', 'Schools');
  await root('Nonexistent root', 'Nonexistent');

  // ── a signal, and what hangs off it ───────────────────────────────────────
  const signal = first(signals);
  if (signal !== undefined) {
    await readFields('Signal', signal, 'Signal');
    const experiences = await edge('Signal Experiences', signal, 'Experiences');
    const educations = await edge('Signal Educations', signal, 'Educations');
    const entries = await edge('Signal List Entries', signal, 'List Entries');
    await edge('Signal List Entries ORDER BY Added At DESC LIMIT 1', signal, 'List Entries', { orderBy: { fieldId: 'Added At', direction: 'desc' }, limit: 1 });
    await step('Signal incoming', () => adapter.getRelated({ position: signal, fieldId: 'Experiences', direction: 'incoming' }));
    for (const [index, experience] of (experiences ?? []).entries()) {
      await readFields(`Experience ${index}`, experience.position, 'Experience');
      await edge(`Experience ${index} Company`, experience.position, 'Company');
    }
    for (const [index, education] of (educations ?? []).entries()) {
      await readFields(`Education ${index}`, education.position, 'Education');
      await edge(`Education ${index} School`, education.position, 'School');
    }
    const entry = first(entries);
    if (entry !== undefined) {
      await readFields('Entry', entry, 'List Entry');
      await edge('Entry Signal', entry, 'Signal');
      await edge('Entry List', entry, 'List');
    }
  }
  // Signals with no experiences or no list entries: every signal's edges.
  for (const [index, landed] of (signals ?? []).slice(1).entries()) {
    await edge(`Signal ${index + 1} Experiences`, landed.position, 'Experiences');
    await edge(`Signal ${index + 1} List Entries`, landed.position, 'List Entries');
  }

  const company = first(companies);
  if (company !== undefined) await readFields('Company', company, 'Company');
  const school = first(schools);
  if (school !== undefined) await readFields('School', school, 'School');

  // ── searches and lists ────────────────────────────────────────────────────
  for (const [index, landed] of (searches ?? []).entries()) {
    await readFields(`Search ${index}`, landed.position, 'Search');
    await edge(`Search ${index} Signals`, landed.position, 'Signals');
    await edge(`Search ${index} Signals LIMIT 1`, landed.position, 'Signals', { limit: 1 });
    await edge(`Search ${index} Signals ORDER BY Score`, landed.position, 'Signals', { orderBy: { fieldId: 'Score', direction: 'desc' }, limit: 1 });
  }
  for (const [index, landed] of (lists ?? []).entries()) {
    await readFields(`List ${index}`, landed.position, 'List');
    await edge(`List ${index} Entries`, landed.position, 'Entries');
    await edge(`List ${index} Entries ORDER BY Added At DESC`, landed.position, 'Entries', { orderBy: { fieldId: 'Added At', direction: 'desc' }, limit: 1 });
    await edge(`List ${index} Entries ORDER BY other`, landed.position, 'Entries', { orderBy: { fieldId: 'Signal', direction: 'asc' }, limit: 1 });
  }

  // ── read back by id ───────────────────────────────────────────────────────
  const idOf = (position: SourcePosition | undefined): string => (position === undefined ? 'missing' : (positionRecordId(position) ?? 'missing'));
  await step('readRecord Signal', async () => (await adapter.readRecord?.({ recordType: 'Signal', externalId: idOf(signal) })) ?? null);
  await step('readRecord Search', async () => (await adapter.readRecord?.({ recordType: 'Search', externalId: idOf(first(searches)) })) ?? null);
  await step('readRecord List', async () => (await adapter.readRecord?.({ recordType: 'List', externalId: idOf(first(lists)) })) ?? null);
  await step('readRecord List Entry', async () => (await adapter.readRecord?.({ recordType: 'List Entry', externalId: 'list_1:entry_1' })) ?? null);
  await step('readRecord List Entry bare id', async () => (await adapter.readRecord?.({ recordType: 'List Entry', externalId: 'bare' })) ?? null);
  await step('readRecord Signal missing', async () => (await adapter.readRecord?.({ recordType: 'Signal', externalId: 'sig_nope' })) ?? null);
  await step('readRecord Company', async () => (await adapter.readRecord?.({ recordType: 'Company', externalId: 'exe_1' })) ?? null);

  // ── writes ────────────────────────────────────────────────────────────────
  const write = (recordType: string, fields: Record<string, unknown>) => ({ recordType, fields, mutationContext: MUTATION });
  const created = await step('create Search', () =>
    adapter.createRecord!(write('Search', { Title: 'Parity search', Emoji: '🔭', Filters: [{ key: 'score', operator: 'gte', value: '7' }] })),
  );
  await step('create Search bad filter', () => adapter.createRecord!(write('Search', { Title: 'x', Filters: [{ key: 'score' }] })));
  await step('create Search no title', () => adapter.createRecord!(write('Search', {})));
  const newList = await step('create List', () => adapter.createRecord!(write('List', { Name: 'Parity list' })));
  await step('create List no name', () => adapter.createRecord!(write('List', {})));
  const newEntry = await step('create List Entry', () =>
    adapter.createRecord!({
      ...write('List Entry', {}),
      parentLinks: [
        { recordType: 'List', externalId: newList?.externalId ?? 'list_missing', edgeName: 'Entries' },
        { recordType: 'Signal', externalId: idOf(signal), edgeName: 'List Entries' },
      ],
    }),
  );
  await step('create List Entry again (idempotent)', () =>
    adapter.createRecord!({
      ...write('List Entry', {}),
      parentLinks: [
        { recordType: 'List', externalId: newList?.externalId ?? 'list_missing', edgeName: 'Entries' },
        { recordType: 'Signal', externalId: idOf(signal), edgeName: 'List Entries' },
      ],
    }),
  );
  await step('create List Entry one end', () =>
    adapter.createRecord!({ ...write('List Entry', {}), parentLinks: [{ recordType: 'List', externalId: 'list_1', edgeName: 'Entries' }] }),
  );
  await step('create Signal', () => adapter.createRecord!(write('Signal', {})));
  await step('create Company', () => adapter.createRecord!(write('Company', { Name: 'x' })));

  if (created !== undefined) {
    await step('update Search title', () => adapter.updateRecord!({ ...write('Search', { Title: 'Renamed search', Filters: [{ key: 'score', operator: 'gte', value: '9' }] }), externalId: created.externalId }));
    await step('readRecord Search after update', async () => (await adapter.readRecord?.({ recordType: 'Search', externalId: created.externalId })) ?? null);
  }
  if (newList !== undefined) {
    await step('update List name', () => adapter.updateRecord!({ ...write('List', { Name: 'Renamed list' }), externalId: newList.externalId }));
  }
  await step('update Search missing', () => adapter.updateRecord!({ ...write('Search', { Title: 'x' }), externalId: 'srch_nope' }));
  await step('update List missing', () => adapter.updateRecord!({ ...write('List', { Name: 'x' }), externalId: 'list_nope' }));
  await step('update Search no fields', () => adapter.updateRecord!({ ...write('Search', {}), externalId: 'srch_1' }));
  await step('update List Entry', () => adapter.updateRecord!({ ...write('List Entry', { x: 1 }), externalId: 'list_1:entry_1' }));
  const sid = idOf(signal);
  await step('update Signal Screened true', () => adapter.updateRecord!({ ...write('Signal', { Screened: true }), externalId: sid }));
  await step('update Signal Viewed true', () => adapter.updateRecord!({ ...write('Signal', { Viewed: true }), externalId: sid }));
  await step('readRecord Signal after screening', async () => (await adapter.readRecord?.({ recordType: 'Signal', externalId: sid })) ?? null);
  await step('update Signal Screened false', () => adapter.updateRecord!({ ...write('Signal', { Screened: false }), externalId: sid }));
  await step('update Signal Screened false again', () => adapter.updateRecord!({ ...write('Signal', { Screened: false }), externalId: sid }));
  await step('update Signal Viewed false', () => adapter.updateRecord!({ ...write('Signal', { Viewed: false }), externalId: sid }));
  await step('update Signal missing', () => adapter.updateRecord!({ ...write('Signal', { Screened: true }), externalId: 'sig_nope' }));

  await step('poll after create (entry on the new list)', () =>
    subject.poll({ config: { events: ['list_entry'], list: 'Renamed list' }, checkpoint: { entriesCreatedAfter: BEFORE_EVERYTHING } }),
  );

  if (newEntry !== undefined) {
    await step('delete List Entry', () => adapter.deleteRecord!({ recordType: 'List Entry', externalId: newEntry.externalId, mutationContext: MUTATION }));
  }
  await step('delete List Entry bare id', () => adapter.deleteRecord!({ recordType: 'List Entry', externalId: 'bare', mutationContext: MUTATION }));
  if (newList !== undefined) await step('delete List', () => adapter.deleteRecord!({ recordType: 'List', externalId: newList.externalId, mutationContext: MUTATION }));
  if (created !== undefined) await step('delete Search', () => adapter.deleteRecord!({ recordType: 'Search', externalId: created.externalId, mutationContext: MUTATION }));
  await step('delete Search missing', () => adapter.deleteRecord!({ recordType: 'Search', externalId: 'srch_nope', mutationContext: MUTATION }));
  await step('delete Signal', () => adapter.deleteRecord!({ recordType: 'Signal', externalId: sid, mutationContext: MUTATION }));

  await step('listEventTypes', async () => (await adapter.listEventTypes?.()) ?? null);

  // ── polls ─────────────────────────────────────────────────────────────────
  // A first look sets its mark from the clock (fixed here), so the mark shows.
  await step('poll first look (signals)', () => subject.poll({ config: {} }));
  await step('poll first look (entries)', () => subject.poll({ config: { events: ['list_entry'] } }));
  await step('poll first look (both)', () => subject.poll({ config: { events: ['signal', 'list_entry'] } }));
  await step('poll signals from the start', () => subject.poll({ config: {}, checkpoint: { createdAfter: BEFORE_EVERYTHING } }));
  await step('poll signals past the newest', () => subject.poll({ config: {}, checkpoint: { createdAfter: AFTER_EVERYTHING } }));
  await step('poll signals of a saved search (title)', () => subject.poll({ config: { search: 'Stealth founders' }, checkpoint: { createdAfter: BEFORE_EVERYTHING } }));
  await step('poll signals of a saved search (id, scalar and exclude rows)', () => subject.poll({ config: { search: 'srch_2' }, checkpoint: { createdAfter: BEFORE_EVERYTHING } }));
  await step('poll signals of an unknown search', () => subject.poll({ config: { search: 'Nope' }, checkpoint: { createdAfter: BEFORE_EVERYTHING } }));
  await step('poll entries from the start', () => subject.poll({ config: { events: ['list_entry'] }, checkpoint: { entriesCreatedAfter: BEFORE_EVERYTHING } }));
  await step('poll entries of one list', () => subject.poll({ config: { events: ['list_entry'], list: 'Pipeline' }, checkpoint: { entriesCreatedAfter: BEFORE_EVERYTHING } }));
  await step('poll entries of an unknown list', () => subject.poll({ config: { events: ['list_entry'], list: 'Nope' }, checkpoint: { entriesCreatedAfter: BEFORE_EVERYTHING } }));
  await step('poll entries past the newest', () => subject.poll({ config: { events: ['list_entry'] }, checkpoint: { entriesCreatedAfter: AFTER_EVERYTHING } }));
  await step('poll both from the start', () =>
    subject.poll({ config: { events: ['signal', 'list_entry'] }, checkpoint: { createdAfter: BEFORE_EVERYTHING, entriesCreatedAfter: BEFORE_EVERYTHING } }),
  );
  return transcript;
}
