// The calls recorded parity makes, in order, against one Dropbox
// implementation: introspection, a walk down the seeded tree, every field,
// the bytes of a file, then the creates (a folder, its reuse, a folder under
// a parent, an inline text file, a file copied from another Dropbox file, a
// file pinned to a parent) and the refusals. The transcript is every answer
// as JSON; two implementations agree when their transcripts and the requests
// they made are identical.

import type { Adapter, FileRef, RelatedResult, WriteInput } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { withFileOwners } from 'movement-engine/public/files';
import { makeMetaPosition } from 'movement-engine/public/catalog';
import { fileValue, userEditContext } from 'movement-engine/public/adapter';

export interface ParitySubject {
  adapter: Adapter;
  /** What an error says, when the subject's transport wraps it. */
  messageOf?(error: unknown): string;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runParityScript(subject: ParitySubject): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  // A run holds the instance a file names as its owner while a call redeems it.
  const owned = <T>(call: () => Promise<T>): Promise<T> => withFileOwners(() => adapter, call);
  const step = async <T>(name: string, call: () => Promise<T>): Promise<T | undefined> => {
    try {
      const answer = await owned(call);
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: subject.messageOf?.(error) ?? (error instanceof Error ? error.message : String(error)) } });
      return undefined;
    }
  };
  const related = (name: string, position: SourcePosition, fieldId: string) =>
    step(name, () => adapter.getRelated({ position, fieldId, direction: 'outgoing' }));
  const first = (results: RelatedResult[] | undefined): SourcePosition | undefined => results?.[0]?.position;
  const write = (name: string, input: Omit<WriteInput, 'mutationContext'>) =>
    step(name, () => adapter.createRecord({ ...input, mutationContext: userEditContext('parity-actor') }));

  const meta = makeMetaPosition('dropbox');
  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['Folder', 'File', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  await step('edgesFrom meta', async () => adapter.edgesFrom?.(meta) ?? null);
  await step('resolveEntity', () => adapter.resolveEntity({ recordType: 'Folder', record: { name: 'Deals' }, candidates: [], constraints: { any: [] } } as never));

  // The seeded tree: /Deals and /Deals/foo-notes.txt.
  const folder = first(await related('root Folders', meta, 'Folders'));
  await related('root Files', meta, 'Files');
  let file: SourcePosition | undefined;
  if (folder !== undefined) {
    for (const field of ['Name', 'Path', 'Url', 'Size', 'File']) {
      await step(`Folder.${field}`, () => adapter.getFieldValue({ position: folder, fieldId: field }));
    }
    await related('Folder Folders', folder, 'Folders');
    file = first(await related('Folder Files', folder, 'Files'));
    await related('Folder Parent', folder, 'Parent');
  }
  let ref: FileRef | undefined;
  if (file !== undefined) {
    for (const field of ['Name', 'Path', 'Url', 'Size']) {
      await step(`File.${field}`, () => adapter.getFieldValue({ position: file as SourcePosition, fieldId: field }));
    }
    await related('File Parent', file, 'Parent');
    ref = (await step('File.File', () => adapter.getFieldValue({ position: file as SourcePosition, fieldId: 'File' }))) as FileRef | undefined;
  }
  if (ref !== undefined && adapter.resolveFileRef !== undefined) {
    const resolve = adapter.resolveFileRef.bind(adapter);
    const redeemed = ref;
    await step('resolveFileRef', async () => {
      const { stream, contentType } = await resolve({ ref: redeemed });
      return { body: await text(stream), contentType: contentType ?? null };
    });
  }

  // Creates.
  await write('create Folder at the root', { recordType: 'Folder', fields: { name: 'Clients' } });
  await write('create the same Folder again (reused)', { recordType: 'Folder', fields: { name: 'clients' } });
  if (folder !== undefined) {
    await write('create Folder along an edge', {
      recordType: 'Folder',
      fields: { name: '2026' },
      parentLinks: [{ recordType: 'Folder', externalId: '/Deals', edgeName: 'Folders' }],
    });
  }
  await write('create File from inline text', { recordType: 'File', fields: { name: 'hello.txt', file: 'hello from a run' } });
  await write('create File from a file value', {
    recordType: 'File',
    fields: { file: { __brand: 'FileRef', name: 'memo.txt', contentType: 'text/plain', content: 'inline content' } },
  });
  if (ref !== undefined) {
    await write('create File copied from a Dropbox file', { recordType: 'File', fields: { name: 'copy.txt', file: fileValue(ref), parent: '/Clients' } });
  }
  await write('create File with no content', { recordType: 'File', fields: { name: 'empty.txt' } });
  await write('create an unknown type', { recordType: 'Spreadsheet', fields: {} });
  await step('updateRecord', () => adapter.updateRecord({ recordType: 'File', externalId: '/x', fields: {}, mutationContext: userEditContext('parity-actor') }));
  await step('deleteRecord', () => adapter.deleteRecord({ recordType: 'File', externalId: '/x', mutationContext: userEditContext('parity-actor') }));

  // What the creates left behind.
  await related('root Folders after', meta, 'Folders');
  if (folder !== undefined) {
    await related('Folder Folders after', folder, 'Folders');
    await related('Folder Files after', folder, 'Files');
  }
  return transcript;
}
