// The calls recorded parity makes, in order, against one Gmail
// implementation. Each later call is built from what an earlier one answered,
// so the script walks the seeded mailbox the way a run would: the root and
// every type, the mailbox's search (narrowed, limited, ordered), every field
// of a message, its attachments and their bytes, read-back by id, every write
// kind (a send, a reply, a send carrying a file read earlier) with their
// refusals, then the poll: the first look, history from a mark, a listen
// narrowed by its query, Spam widened in, an arrival carried as pending and
// an expired mark resynced. The transcript is every answer, as JSON; two
// implementations agree when their transcripts and the requests they made
// are identical.
//
// The poll stamps the moment it looked (`lastSeenAt`, a new pending
// arrival's `firstSeenAt`), so those read `<now>` in the transcript. Every
// checkpoint the script hands in is fixed, so the requests never depend on
// the clock.
//
// Every call is made on a FRESH adapter, as a module served as a process is
// built afresh per request. A file's owner, when a write redeems one, is a
// fresh adapter of the same subject, found the way a run finds it.

import type { Expression } from '#shared/expression/types';
import type { Adapter, DiscriminableEvent, FileRef, MutationContext, ParentLink, RelatedResult } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { fileValue } from 'movement-engine/public/adapter';
import { makeMetaPosition, makeStablePosition, positionData } from 'movement-engine/public/catalog';
import { withFileOwners } from 'movement-engine/public/files';

export interface ParitySubject {
  /** A fresh adapter for one call. */
  adapter(): Promise<Adapter> | Adapter;
  poll(input: { config: unknown; checkpoint?: unknown }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }>;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

/** The fake's own mailbox, which a sign-in names. */
export const PARITY_MAILBOX = 'dev-loop@listen-fire.local';
export const PARITY_ACCESS_TOKEN = 'parity-gmail-access-token';

/** What the fake mailbox is seeded with before the script runs, in order:
 *  each one advances the mailbox's change marker by one from 1000. */
export const PARITY_SEED: ReadonlyArray<Record<string, unknown>> = [
  {
    id: 'msg-acme',
    subject: 'Q3 figures',
    from: 'Rita Okoye <rita@acme.com>',
    to: PARITY_MAILBOX,
    cc: 'ops@acme.com',
    date: '2026-10-10T09:00:00.000Z',
    bodyText: 'Figures attached, as promised.',
    attachments: [{ filename: 'figures.csv', contentType: 'text/csv', content: 'quarter,revenue\nQ3,1200\n' }],
  },
  {
    id: 'msg-beta',
    subject: 'Intro: Beta Labs',
    from: 'sam@beta.io',
    to: PARITY_MAILBOX,
    date: '2026-10-11T10:30:00.000Z',
    bodyHtml: '<p>Meet <b>Beta Labs</b>, building ledgers.</p>',
  },
  {
    id: 'msg-spam',
    subject: 'Cold outreach',
    from: 'cold@outreach.example',
    to: PARITY_MAILBOX,
    date: '2026-10-12T08:00:00.000Z',
    bodyText: 'Would you like to buy leads?',
    labelIds: ['SPAM'],
  },
  {
    id: 'msg-acme-2',
    subject: 'Re: Q3 figures',
    from: 'Rita Okoye <rita@acme.com>',
    to: PARITY_MAILBOX,
    date: '2026-10-13T11:00:00.000Z',
    bodyText: 'One correction to the figures.',
    threadId: 'msg-acme',
  },
];

/** Steps expected to fail: the refusals are part of the surface. */
export const REFUSED = 'refused: ';

const ADAPTER = 'gmail';
const MUTATION: MutationContext = { source: { type: 'api' }, occurredAt: '2026-10-17T00:00:00.000Z' };
/** Before every seeded message: the mark history reads from. */
const MARK = { historyId: '1000', lastSeenAt: '2026-10-09T00:00:00.000Z' };
/** A mark Gmail has dropped (the fake answers 404 below its floor of 1). */
const EXPIRED_MARK = { historyId: '0', lastSeenAt: '2026-10-11T00:00:00.000Z' };

function json(answer: unknown): unknown {
  return answer === undefined ? null : JSON.parse(JSON.stringify(answer));
}

const isFileRef = (value: unknown): value is FileRef =>
  value !== null && typeof value === 'object' && Reflect.get(value, '__brand') === 'FileRef';

async function bytesOf(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
  return Buffer.concat(chunks);
}

const recordIdOf = (position: SourcePosition): string | undefined =>
  position.identity.kind === 'stable' ? position.identity.recordId : undefined;

const property = (name: string): Expression => ({ type: 'property', propertyTypeId: name }) as Expression;
const literal = (value: string): Expression => ({ type: 'static', value }) as Expression;
const compare = (left: Expression, op: string, right: Expression): Expression => ({ type: 'compare', op, left, right }) as Expression;

/** The poll's own clock, out of the transcript: the look's moment, and a
 *  pending arrival first seen by this look. */
function withoutClock(answer: unknown, carried: ReadonlySet<string>): unknown {
  if (answer === null || typeof answer !== 'object') return answer;
  const checkpoint: unknown = Reflect.get(answer, 'checkpoint');
  if (checkpoint === null || typeof checkpoint !== 'object') return answer;
  const pending: unknown = Reflect.get(checkpoint, 'pending');
  return {
    ...answer,
    checkpoint: {
      ...checkpoint,
      ...('lastSeenAt' in checkpoint ? { lastSeenAt: '<now>' } : {}),
      ...(Array.isArray(pending)
        ? {
            pending: pending.map((entry: unknown) =>
              entry !== null && typeof entry === 'object' && !carried.has(String(Reflect.get(entry, 'firstSeenAt')))
                ? { ...entry, firstSeenAt: '<now>' }
                : entry,
            ),
          }
        : {}),
    },
  };
}

export async function runParityScript(subject: ParitySubject): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  const step = async <T>(name: string, call: (adapter: Adapter) => Promise<T>): Promise<T | undefined> => {
    try {
      const answer = await call(await subject.adapter());
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };
  let ownerAdapter: Adapter | undefined;
  const owned = <T>(call: () => Promise<T>): Promise<T> =>
    withFileOwners((owner) => (owner.adapterType === ADAPTER ? ownerAdapter : undefined), call);
  const ownedStep = async <T>(name: string, call: (adapter: Adapter) => Promise<T>): Promise<T | undefined> => {
    ownerAdapter = await subject.adapter();
    return step(name, (a) => owned(() => call(a)));
  };
  const bytes = (name: string, ref: FileRef | undefined) =>
    step(name, async (a) => {
      if (ref === undefined) throw new Error('no file to read');
      if (a.resolveFileRef === undefined) throw new Error('resolveFileRef is not implemented');
      const resolved = await a.resolveFileRef({ ref });
      return { contentType: resolved.contentType ?? null, size: resolved.size ?? null, base64: (await bytesOf(resolved.stream)).toString('base64') };
    });
  const poll = async (name: string, input: { config: unknown; checkpoint?: unknown }) => {
    const carried = new Set<string>();
    const pending: unknown = input.checkpoint !== null && typeof input.checkpoint === 'object' ? Reflect.get(input.checkpoint, 'pending') : undefined;
    if (Array.isArray(pending)) for (const entry of pending) carried.add(String(Reflect.get(entry, 'firstSeenAt')));
    try {
      transcript.push({ step: name, answer: withoutClock(json(await subject.poll(input)), carried) });
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
    }
  };
  const meta = makeMetaPosition(ADAPTER);

  // ── The root and every type ───────────────────────────────────────────────
  await step('listEntryPoints', (a) => a.listEntryPoints());
  for (const type of ['Gmail', 'Message', 'Attachment', 'gmail:message', 'Nonexistent']) {
    await step(`describe ${type}`, (a) => a.describe(type));
  }
  await step('edgesFrom meta', async (a) => (await a.edgesFrom?.(meta)) ?? null);
  await step('listEventTypes', async (a) => (await a.listEventTypes?.()) ?? null);

  // ── The mailbox's search ──────────────────────────────────────────────────
  const messages = await step('Messages', (a) => a.getRelated({ position: meta, fieldId: 'Messages', direction: 'outgoing' }));
  await step('Messages LIMIT 1', (a) => a.getRelated({ position: meta, fieldId: 'Messages', direction: 'outgoing', limit: 1 }));
  await step('Messages WHERE From CONTAINS acme.com', (a) =>
    a.getRelated({ position: meta, fieldId: 'Messages', direction: 'outgoing', where: compare(property('From'), 'contains', literal('acme.com')) }),
  );
  await step('Messages WHERE Subject = Intro: Beta Labs', (a) =>
    a.getRelated({ position: meta, fieldId: 'Messages', direction: 'outgoing', where: compare(property('Subject'), '=', literal('Intro: Beta Labs')) }),
  );
  await step('Messages ORDER BY Date DESC LIMIT 2', (a) =>
    a.getRelated({ position: meta, fieldId: 'Messages', direction: 'outgoing', orderBy: { fieldId: 'Date', direction: 'desc' }, limit: 2 }),
  );
  await step('Messages ORDER BY Date ASC LIMIT 1', (a) =>
    a.getRelated({ position: meta, fieldId: 'Messages', direction: 'outgoing', orderBy: { fieldId: 'Date', direction: 'asc' }, limit: 1 }),
  );
  await step('unknown collection', (a) => a.getRelated({ position: meta, fieldId: 'Threads', direction: 'outgoing' }));
  await step('incoming direction', (a) => a.getRelated({ position: meta, fieldId: 'Messages', direction: 'incoming' }));

  const acme: SourcePosition =
    messages?.find((m: RelatedResult) => recordIdOf(m.position) === 'msg-acme')?.position ??
    makeStablePosition({ adapterType: ADAPTER, recordType: 'Message', recordId: 'msg-acme', data: { id: 'msg-acme' } });
  const beta = messages?.find((m: RelatedResult) => recordIdOf(m.position) === 'msg-beta')?.position;

  // ── Every field of a message ──────────────────────────────────────────────
  await step('edgesFrom acme', async (a) => (await a.edgesFrom?.(acme)) ?? null);
  for (const field of ['Message Id', 'Thread Id', 'Subject', 'From', 'To', 'Cc', 'Date', 'Body', 'Plain Body', 'HTML Body', 'Labels', 'Snippet', 'Has Attachments']) {
    await step(`acme.${field}`, (a) => a.getFieldValue({ position: acme, fieldId: field }));
  }
  await step(`${REFUSED}acme.Missing`, (a) => a.getFieldValue({ position: acme, fieldId: 'Missing' }));
  if (beta !== undefined) {
    for (const field of ['Body', 'HTML Body', 'Has Attachments']) {
      await step(`beta.${field}`, (a) => a.getFieldValue({ position: beta, fieldId: field }));
    }
  }

  // ── Attachments and their bytes ───────────────────────────────────────────
  const attachments = await step('acme / Attachments', (a) => a.getRelated({ position: acme, fieldId: 'Attachments', direction: 'outgoing' }));
  await step('acme / Attachments LIMIT 0', (a) => a.getRelated({ position: acme, fieldId: 'Attachments', direction: 'outgoing', limit: 0 }));
  await step('acme / Replies (write only)', (a) => a.getRelated({ position: acme, fieldId: 'Replies', direction: 'outgoing' }));
  const figures = attachments?.[0]?.position;
  let figuresFile: FileRef | undefined;
  if (figures !== undefined) {
    await step('edgesFrom figures', async (a) => (await a.edgesFrom?.(figures)) ?? null);
    for (const field of ['Name', 'Content Type', 'Size', 'File']) {
      const answer = await step(`figures.${field}`, (a) => a.getFieldValue({ position: figures, fieldId: field }));
      if (field === 'File' && isFileRef(answer)) figuresFile = answer;
    }
    await step(`${REFUSED}figures.Missing`, (a) => a.getFieldValue({ position: figures, fieldId: 'Missing' }));
  }
  await bytes('figures bytes', figuresFile);
  await bytes(`${REFUSED}bytes of a file with no handle`, { __brand: 'FileRef', name: 'loose.txt', contentType: 'text/plain' });

  // ── Read-back by id ───────────────────────────────────────────────────────
  await step('readRecord Message msg-beta', async (a) => (await a.readRecord?.({ recordType: 'Message', externalId: 'msg-beta' })) ?? null);
  await step('readRecord Message (missing)', async (a) => (await a.readRecord?.({ recordType: 'Message', externalId: 'msg-nope' })) ?? null);
  await step('readRecord Attachment', async (a) => (await a.readRecord?.({ recordType: 'Attachment', externalId: 'msg-acme:msg-acme-att-1' })) ?? null);

  // ── Every write kind ──────────────────────────────────────────────────────
  const write = (name: string, recordType: string, fields: Record<string, unknown>, parentLinks?: ParentLink[]) =>
    step(name, (a) => a.createRecord({ recordType, fields, mutationContext: MUTATION, ...(parentLinks !== undefined ? { parentLinks } : {}) }));
  const acmeData: Record<string, unknown> = { ...(positionData(acme) ?? {}) };
  const replyAlong = (data: Record<string, unknown>): ParentLink[] => [
    { recordType: 'Message', externalId: String(data['id'] ?? 'msg-acme'), edgeName: 'Replies', data },
  ];
  await write('send a new message', 'Message', { To: ['rita@acme.com'], Subject: 'Your Q3 figures', Body: 'Thanks — reading now.' });
  await write('send with HTML and Cc', 'Message', {
    To: 'Rita Okoye <rita@acme.com>, sam@beta.io',
    Cc: ['ops@acme.com'],
    Subject: 'Both of you',
    Body: 'Plain words.',
    'HTML Body': '<p>Plain <i>words</i>.</p>',
  });
  await write('send with an inline file', 'Message', {
    To: ['rita@acme.com'],
    Subject: 'Notes',
    Body: 'See the notes.',
    Files: [{ __brand: 'FileRef', name: 'notes.md', contentType: 'text/markdown', content: '# Notes\nAll good.' }],
  });
  await ownedStep('send carrying the figures file', (a) =>
    a.createRecord({
      recordType: 'Message',
      fields: { To: ['sam@beta.io'], Subject: 'Fwd: Q3 figures', Body: 'Forwarding.', ...(figuresFile !== undefined ? { Files: [fileValue(figuresFile)] } : {}) },
      mutationContext: MUTATION,
    }),
  );
  await write('reply along Replies', 'Message', { Body: 'Got it — looking now.' }, replyAlong(acmeData));
  await write('reply overriding To and Subject', 'Message', { Body: 'Looping in Sam.', To: ['sam@beta.io'], Subject: 'Q3 (for Sam)' }, replyAlong(acmeData));
  await write(`${REFUSED}send with no To`, 'Message', { Subject: 'Nobody', Body: 'x' });
  await write(`${REFUSED}send with no body`, 'Message', { To: ['rita@acme.com'], Subject: 'Empty' });
  await write(`${REFUSED}reply to a message with no thread`, 'Message', { Body: 'x' }, replyAlong({ id: 'msg-loose', from: 'a@b.c' }));
  await write(`${REFUSED}reply to a message with no sender`, 'Message', { Body: 'x' }, replyAlong({ id: 'msg-loose', threadId: 't-1' }));
  await write(`${REFUSED}create along the wrong edge`, 'Message', { Body: 'x' }, [{ recordType: 'Message', externalId: 'msg-acme', edgeName: 'Attachments', data: acmeData }]);
  await write(`${REFUSED}create an Attachment`, 'Attachment', { Filename: 'x' });
  await write(`${REFUSED}send a file with no bytes`, 'Message', { To: ['rita@acme.com'], Body: 'x', Files: [{ __brand: 'FileRef', name: 'nothing.bin' }] });
  await step(`${REFUSED}updateRecord`, (a) => a.updateRecord({ recordType: 'Message', externalId: 'msg-acme', fields: { Subject: 'x' }, mutationContext: MUTATION }));
  await step(`${REFUSED}deleteRecord`, (a) => a.deleteRecord({ recordType: 'Message', externalId: 'msg-acme', mutationContext: MUTATION }));
  await bytes(`${REFUSED}bytes of a handle that is not a pair`, {
    __brand: 'FileRef',
    name: 'x.bin',
    source: { ownerAdapterType: ADAPTER, handle: 'not-a-pair' },
  } as FileRef);

  // ── The poll ──────────────────────────────────────────────────────────────
  await poll('first poll sets the mark', { config: {} });
  await poll('poll from the mark', { config: {}, checkpoint: MARK });
  await poll('poll narrowed by its query', { config: { query: 'from:acme.com' }, checkpoint: MARK });
  await poll('poll with Spam widened in', { config: { labels: ['INBOX', 'SPAM'] }, checkpoint: MARK });
  await poll('poll carrying a pending arrival past its grace', {
    config: { query: 'from:acme.com' },
    checkpoint: { ...MARK, pending: [{ id: 'msg-beta', firstSeenAt: '2026-10-09T00:00:00.000Z' }] },
  });
  await poll('poll from an expired mark resyncs', { config: {}, checkpoint: EXPIRED_MARK });
  await poll(`${REFUSED}poll with labels that are not a list`, { config: { labels: 'INBOX' }, checkpoint: MARK });
  return transcript;
}
