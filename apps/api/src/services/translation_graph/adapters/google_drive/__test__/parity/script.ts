// The calls recorded parity makes, in order, against one Google Drive
// implementation. Each later call is built from what an earlier one answered,
// so the script walks the seeded Drive the way a run would: the root and every
// type, the granted Folders and Files, a folder's children and every field of
// a file (its File a file the instance owns), that file's bytes, then every
// write kind, an upload of the file read earlier among them, and the folder's
// children again with the new file's bytes. The transcript is every answer, as
// JSON (a file's bytes as base64); two implementations agree when their
// transcripts and the requests they made are identical.
//
// Every call is made on a FRESH adapter, as a module served as a process is
// built afresh per request. A file's owner, when a write redeems one, is a
// fresh adapter of the same subject, found the way a run finds it.

import type { Adapter, FileRef, MutationContext, ParentLink, RelatedResult } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { fileValue } from 'movement-engine/public/adapter';
import { makeMetaPosition, makeStablePosition } from 'movement-engine/public/catalog';
import { withFileOwners } from 'movement-engine/public/files';

export interface ParitySubject {
  /** A fresh adapter for one call. */
  adapter(): Promise<Adapter> | Adapter;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** The grants the subjects are seeded with, in grant order. `gone-file` is a
 *  grant whose file the fake never held (deleted or revoked). */
export const PARITY_GRANTS: ReadonlyArray<{ itemId: string; mimeType: string; name: string | null }> = [
  { itemId: 'fold-deals', mimeType: FOLDER_MIME, name: 'Deals' },
  { itemId: 'file-memo', mimeType: 'text/plain', name: 'acme-memo.txt' },
  { itemId: 'gone-file', mimeType: 'application/pdf', name: null },
];

export const PARITY_ACCESS_TOKEN = 'parity-google-access-token';

/** Steps expected to fail: the refusals are part of the surface. */
export const REFUSED = 'refused: ';

const ADAPTER = 'google_drive';
const MUTATION: MutationContext = { source: { type: 'api' }, occurredAt: '2026-10-17T00:00:00.000Z' };

function json(answer: unknown): unknown {
  return answer === undefined ? null : JSON.parse(JSON.stringify(answer));
}

const under = (folderId: string, edgeName: string): ParentLink[] => [{ recordType: 'Folder', externalId: folderId, edgeName }];

const isFileRef = (value: unknown): value is FileRef =>
  value !== null && typeof value === 'object' && Reflect.get(value, '__brand') === 'FileRef';

async function bytesOf(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
  return Buffer.concat(chunks);
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
  // A run's file owners: a fresh adapter of the subject for this type.
  const owned = <T>(call: () => Promise<T>): Promise<T> =>
    withFileOwners((owner) => (owner.adapterType === ADAPTER ? ownerAdapter : undefined), call);
  let ownerAdapter: Adapter | undefined;
  const ownedStep = async <T>(name: string, call: (adapter: Adapter) => Promise<T>): Promise<T | undefined> => {
    ownerAdapter = await subject.adapter();
    return step(name, (a) => owned(() => call(a)));
  };
  const bytes = (name: string, ref: FileRef | undefined) =>
    step(name, async (a) => {
      if (ref === undefined) throw new Error('no file to read');
      if (a.resolveFileRef === undefined) throw new Error('resolveFileRef is not implemented');
      const resolved = await a.resolveFileRef({ ref });
      return { contentType: resolved.contentType ?? null, base64: (await bytesOf(resolved.stream)).toString('base64') };
    });
  const meta = makeMetaPosition(ADAPTER);

  // ── The root and every type ───────────────────────────────────────────────
  await step('listEntryPoints', (a) => a.listEntryPoints());
  for (const type of ['Folder', 'File', 'Google Drive', 'Nonexistent']) {
    await step(`describe ${type}`, (a) => a.describe(type));
  }
  await step('edgesFrom meta', async (a) => (await a.edgesFrom?.(meta)) ?? null);

  // ── The granted Folders and Files ─────────────────────────────────────────
  const folders = await step('Folders collection', (a) => a.getRelated({ position: meta, fieldId: 'Folders', direction: 'outgoing' }));
  const files = await step('Files collection', (a) => a.getRelated({ position: meta, fieldId: 'Files', direction: 'outgoing' }));
  await step('Folder collection (type name)', (a) => a.getRelated({ position: meta, fieldId: 'Folder', direction: 'outgoing' }));
  await step('unknown collection', (a) => a.getRelated({ position: meta, fieldId: 'Drives', direction: 'outgoing' }));
  await step(`${REFUSED}incoming direction`, (a) => a.getRelated({ position: meta, fieldId: 'Folders', direction: 'incoming' }));

  const deals: SourcePosition =
    folders?.[0]?.position ??
    makeStablePosition({ adapterType: ADAPTER, recordType: 'Folder', recordId: 'fold-deals', data: { id: 'fold-deals', name: 'Deals' } });
  const grantedMemo = files?.find((f: RelatedResult) => f.position.identity.recordId === 'file-memo')?.position;
  const goneFile = files?.find((f: RelatedResult) => f.position.identity.recordId === 'gone-file')?.position;

  // ── A folder's children and every field of a file ─────────────────────────
  await step('edgesFrom Deals', async (a) => (await a.edgesFrom?.(deals)) ?? null);
  await step('Deals / Folders', (a) => a.getRelated({ position: deals, fieldId: 'Folders', direction: 'outgoing' }));
  const children = await step('Deals / Files', (a) => a.getRelated({ position: deals, fieldId: 'Files', direction: 'outgoing' }));
  await step(`${REFUSED}Deals / unknown edge`, (a) => a.getRelated({ position: deals, fieldId: 'Drives', direction: 'outgoing' }));
  const memo = children?.[0]?.position;
  if (memo !== undefined) {
    await step('memo hop', async (a) => (await a.edgesFrom?.(memo)) ?? null);
    await step('memo / Files (a file has no edges)', (a) => a.getRelated({ position: memo, fieldId: 'Files', direction: 'outgoing' }));
  }
  let memoFile: FileRef | undefined;
  for (const field of ['Id', 'Name', 'Mime Type', 'Url', 'Size', 'File', 'Content', 'Missing']) {
    const answer = await step(`memo.${field}`, (a) => (memo === undefined ? Promise.resolve(null) : a.getFieldValue({ position: memo, fieldId: field })));
    if (field === 'File' && isFileRef(answer)) memoFile = answer;
  }
  await step('Deals.Name', (a) => a.getFieldValue({ position: deals, fieldId: 'Name' }));
  await step('Deals.File', (a) => a.getFieldValue({ position: deals, fieldId: 'File' }));
  let grantedMemoFile: FileRef | undefined;
  if (grantedMemo !== undefined) {
    await step('granted memo.Url', (a) => a.getFieldValue({ position: grantedMemo, fieldId: 'Url' }));
    const answer = await step('granted memo.File', (a) => a.getFieldValue({ position: grantedMemo, fieldId: 'File' }));
    if (isFileRef(answer)) grantedMemoFile = answer;
  }
  let goneFileRef: FileRef | undefined;
  if (goneFile !== undefined) {
    const answer = await step('gone file.File', (a) => a.getFieldValue({ position: goneFile, fieldId: 'File' }));
    if (isFileRef(answer)) goneFileRef = answer;
  }

  // ── Bytes ─────────────────────────────────────────────────────────────────
  await bytes('memo bytes', memoFile);
  await bytes('granted memo bytes', grantedMemoFile);
  await bytes(`${REFUSED}gone file bytes`, goneFileRef);
  await bytes(`${REFUSED}bytes of a file with no handle`, { __brand: 'FileRef', name: 'loose.txt', contentType: 'text/plain' });

  // ── Entity resolution ─────────────────────────────────────────────────────
  await step('resolveEntity Folder', (a) => a.resolveEntity({ recordType: 'Folder', record: { name: 'Deals' }, candidates: [] }));

  // ── Every write kind ──────────────────────────────────────────────────────
  const write = (name: string, recordType: string, fields: Record<string, unknown>, parentLinks?: ParentLink[]) =>
    step(name, (a) => a.createRecord({ recordType, fields, mutationContext: MUTATION, ...(parentLinks !== undefined ? { parentLinks } : {}) }));
  await write('create Folder under Deals', 'Folder', { Name: 'Q3 Deals' }, under('fold-deals', 'Folders'));
  await write('create Folder again (reused by name)', 'Folder', { Name: 'Q3 Deals' }, under('fold-deals', 'Folders'));
  await write('create Folder by the parent field', 'Folder', { Name: 'Pinned', parent: 'fold-deals' });
  await write(`${REFUSED}create Folder with no parent`, 'Folder', { Name: 'Orphan' });
  await write('create File from Content (a Google Doc)', 'File', { Name: 'Deal notes', Content: 'Acme: term sheet signed.' }, under('fold-deals', 'Files'));
  await write('create File from inline text', 'File', { Name: 'inline.txt', File: 'plain bytes, inline' }, under('fold-deals', 'Files'));
  await write('create File from inline content', 'File', { File: { __brand: 'FileRef', name: 'composed.md', contentType: 'text/markdown', content: '# Composed' } }, under('fold-deals', 'Files'));
  const copied = await ownedStep('create File from the memo file (upload)', (a) =>
    a.createRecord({
      recordType: 'File',
      fields: { Name: 'memo-copy.txt', ...(memoFile !== undefined ? { File: fileValue(memoFile) } : {}) },
      mutationContext: MUTATION,
      parentLinks: under('fold-deals', 'Files'),
    }),
  );
  await ownedStep('create File from the memo file, its own name', (a) =>
    a.createRecord({
      recordType: 'File',
      fields: memoFile !== undefined ? { File: fileValue(memoFile) } : {},
      mutationContext: MUTATION,
      parentLinks: under('fold-deals', 'Files'),
    }),
  );
  await write(`${REFUSED}create File with both Content and File`, 'File', { Name: 'x', Content: 'a', File: 'b' }, under('fold-deals', 'Files'));
  await write(`${REFUSED}create File with neither`, 'File', { Name: 'x' }, under('fold-deals', 'Files'));
  await write(`${REFUSED}create File with no parent`, 'File', { Name: 'x', Content: 'a' });
  await write(`${REFUSED}create File from a file with no bytes`, 'File', { File: { __brand: 'FileRef', name: 'nothing.bin' } }, under('fold-deals', 'Files'));
  await write(`${REFUSED}create an unknown type`, 'Drive', { Name: 'x' }, under('fold-deals', 'Files'));
  await step(`${REFUSED}updateRecord`, (a) =>
    a.updateRecord({ recordType: 'File', externalId: 'file-memo', fields: { Name: 'renamed' }, mutationContext: MUTATION }),
  );
  await step(`${REFUSED}deleteRecord`, (a) => a.deleteRecord({ recordType: 'File', externalId: 'file-memo', mutationContext: MUTATION }));

  // ── What the writes left ──────────────────────────────────────────────────
  await step('Deals / Folders after the writes', (a) => a.getRelated({ position: deals, fieldId: 'Folders', direction: 'outgoing' }));
  const after = await step('Deals / Files after the writes', (a) => a.getRelated({ position: deals, fieldId: 'Files', direction: 'outgoing' }));
  const copy = after?.find((f: RelatedResult) => f.position.identity.recordId === copied?.externalId)?.position;
  if (copy !== undefined) {
    const answer = await step('memo copy.File', (a) => a.getFieldValue({ position: copy, fieldId: 'File' }));
    await bytes('memo copy bytes', isFileRef(answer) ? answer : undefined);
  }
  return transcript;
}
