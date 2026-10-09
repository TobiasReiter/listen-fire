// Google Drive TG adapter — the write paths plus the reads that support them
// (bridge-only entity resolution, display data). Two create paths, one per
// noun (adapters/CLAUDE.md rule 4 — the old document/upload split was one
// concept; `files.create` is the API's single creation endpoint):
//
//   • folder — `files.create` with the folder mimeType, after a by-name
//              reuse search within the parent.
//   • file   — ONE type, two byte channels, the write choosing by which
//              field arrives: `File` (a FileRef descriptor, or inline
//              text) uploads bytes as-is; `Content`
//              (a string) imports text as a Google Doc. Exactly one of the
//              two — both or neither is a loud error, never a guess.
//
// Every create names a REAL parent folder (`parentLink.externalId` from the
// enclosing folder edge/action — under drive.file there is no root to write
// into, which is why the root entries are read-only and creates live on the
// folder edges).
//
// Drive is create-only: `updateRecord` / `deleteRecord` throw a clear "not
// supported" error (a created folder/file has no in-place TG mutation path;
// the API's `files.update`/`files.delete` are a recorded capability gap).

import { Readable } from 'node:stream';

import type { GoogleDriveClient } from '../../../../adapters/google/driveClient';
import type {
  DeleteInput,
  DeleteResult,
  FileRef,
  ResolveEntityInput,
  ResolveEntityResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { LinkedObject } from '../../../../generated/kysely/knowledge/LinkedObject';

import { logger } from '../../../logger';
import { singleParentLink } from '../../adapter';
import { hasFileSource, streamFileRef } from '../../engine/files/retrieve';
import {
  GOOGLE_DRIVE_ADAPTER_TYPE,
  driveUrl,
  requireStructuredId,
} from './types';

// ── createRecord — dispatch on type ───────────────────────────────────────────

export async function createRecord(input: {
  client: GoogleDriveClient;
  /** The team whose run is writing — a `File` value is redeemed for it. */
  teamId: TeamId;
  write: WriteInput;
}): Promise<WriteResult> {
  // `recordType` is the pretty type name; recover the write kind from the static
  // name → kind map (an unknown name is drift — a hard throw).
  const kind = requireStructuredId(input.write.recordType, 'createRecord');

  switch (kind) {
    case 'folder':
      return createFolder(input);
    case 'file':
      return createFile(input);
  }
}

/** Resolve the parent folder id for a write: an edge/child write inherits it
 *  from its lone parent link's externalId (the published path — creates live
 *  on the folder edges); a legacy `parent` field pin is still honoured for
 *  internal callers. Throws when neither is present — under drive.file every
 *  create names a real parent folder. */
function resolveParentId(write: WriteInput): string | undefined {
  const parentLink = singleParentLink(write);
  if (parentLink?.externalId) return parentLink.externalId;
  const parent = write.fields.parent;
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined;
}

/** Create (or reuse) a folder — mirror v3 `executeFolder`, minus the LLM. The
 *  tier-0 linked_object dedup happens in `resolveEntity`; here a tier-1 search
 *  by name within the parent precedes creation, exactly as v3 does. */
async function createFolder(input: {
  client: GoogleDriveClient;
  write: WriteInput;
}): Promise<WriteResult> {
  const { client, write } = input;
  const folderName = String(write.fields.name ?? write.fields.title ?? 'Untitled');
  const parentId = resolveParentId(write);
  if (!parentId) {
    throw new Error(
      'GoogleDriveAdapter.createFolder: no parent folder — create it along a ' +
        'connected folder\'s edge (write folder-[:Folders]-> { … }).',
    );
  }

  // Tier 1: search by name within parent (tier-0 bridge dedup is resolveEntity).
  const existingId = await client.findFolder({ name: folderName, parentId });
  if (existingId) {
    logger.info(`[GDrive] Found existing folder "${folderName}" → ${existingId}`);
    return {
      adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
      externalId: existingId,
      data: { name: folderName, url: driveUrl(existingId, 'folder') },
    };
  }

  const folder = await client.createFolder({ name: folderName, parentId });
  logger.info(`[GDrive] Created folder "${folderName}" → ${folder.id}`);
  return {
    adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
    externalId: folder.id,
    data: { name: folderName, url: folder.webViewLink || driveUrl(folder.id, 'folder') },
  };
}

/** Create a file — ONE noun, two byte channels (rule 4: the old document/
 *  upload split was presentation, not a type distinction). Which channel is
 *  chosen by which FIELD arrives: `content` (a string) imports text as a
 *  Google Doc; `file` (a File-typed value or inline text) uploads bytes
 *  as-is. Exactly one of the two — both or neither is a loud error, never a
 *  guess (one value must not mean two facts). */
async function createFile(input: {
  client: GoogleDriveClient;
  teamId: TeamId;
  write: WriteInput;
}): Promise<WriteResult> {
  const { client, teamId, write } = input;
  const parentId = resolveParentId(write);
  if (!parentId) {
    throw new Error(
      'GoogleDriveAdapter.createRecord(File): no parent folder — create it ' +
        'along a connected folder\'s edge (write folder-[:Files]-> { … }).',
    );
  }

  const hasContent = write.fields.content != null;
  const hasFile = write.fields.file != null;
  if (hasContent && hasFile) {
    throw new Error(
      'GoogleDriveAdapter.createRecord(File): both `Content` and `File` are ' +
        'set — provide exactly one (`Content` imports text as a Google Doc; ' +
        '`File` uploads bytes as-is).',
    );
  }
  if (!hasContent && !hasFile) {
    throw new Error(
      'GoogleDriveAdapter.createRecord(File): neither `Content` nor `File` is ' +
        'set — provide one (`Content` imports text as a Google Doc; `File` ' +
        'uploads bytes as-is).',
    );
  }

  return hasContent
    ? createDocument({ client, write, parentId })
    : createUpload({ client, teamId, write, parentId });
}

/** The Google-Doc channel: import the PROVIDED text as a Doc (`files.create`
 *  with the Doc mimeType + text/plain media). The body is produced by the TG
 *  body's field mappings (AI() / property reads) — no LLM runs here. */
async function createDocument(input: {
  client: GoogleDriveClient;
  write: WriteInput;
  parentId: string;
}): Promise<WriteResult> {
  const { client, write, parentId } = input;
  const title = String(write.fields.name ?? write.fields.title ?? 'Document');
  const content = String(write.fields.content);

  const doc = await client.createDocument({ name: title, content, parentId });
  logger.info(`[GDrive] Created document "${title}" → ${doc.id}`);
  return {
    adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
    externalId: doc.id,
    data: { name: title, url: doc.webViewLink || driveUrl(doc.id, 'file') },
  };
}

/** The File-typed value the engine delivers for the `File` field — a
 *  branded `FileRef` descriptor (adapter.ts), redeemed for its bytes here on
 *  the host side, with `name` / `contentType` metadata top-level. Inline
 *  `content` is the fallback for text composed in the program body. */
interface FileValue extends FileRef {
  url?: string | null;
  content?: string;
}

function asFileValue(raw: unknown): FileValue | string | null {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return null;
  return raw as FileValue;
}

/** The upload channel: the bytes arrive as the `File` field value (a
 *  FileRef descriptor, or inline text), not
 *  from a context-node resource: in the TG model content is delivered as a
 *  field. */
async function createUpload(input: {
  client: GoogleDriveClient;
  teamId: TeamId;
  write: WriteInput;
  parentId: string;
}): Promise<WriteResult> {
  const { client, write, parentId } = input;
  const fileValue = asFileValue(write.fields.file);
  if (fileValue == null) {
    throw new Error(
      'GoogleDriveAdapter.createRecord(File): the `File` field is empty — map ' +
        'a file value or inline text into it.',
    );
  }

  const resolved = await resolveUploadStream(fileValue, input.teamId);
  const name =
    String(write.fields.name ?? '') ||
    (typeof fileValue === 'object' ? fileValue.name : undefined) ||
    'file';

  const result = await client.uploadFile({
    name,
    parentId,
    stream: resolved.stream,
    mimeType: resolved.contentType,
  });
  logger.info(`[GDrive] Uploaded "${name}" → ${result.id}`);
  return {
    adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
    externalId: result.id,
    data: { name, url: result.webViewLink || driveUrl(result.id, 'file') },
  };
}

/** Resolve a `file` field value to a readable stream + mime type. Preferred:
 *  the FileRef's bytes, redeemed for the team (`streamFileRef`, P5). Fallback:
 *  inline string content composed in the program body. */
async function resolveUploadStream(
  fileValue: FileValue | string,
  teamId: TeamId,
): Promise<{ stream: Readable; contentType: string | undefined }> {
  if (typeof fileValue === 'string') {
    return { stream: Readable.from(fileValue), contentType: 'text/plain' };
  }

  if (hasFileSource(fileValue)) {
    const resolved = await streamFileRef(fileValue, { teamId });
    return {
      stream: resolved.stream,
      contentType: resolved.contentType ?? fileValue.contentType ?? undefined,
    };
  }

  if (typeof fileValue.content === 'string') {
    return {
      stream: Readable.from(fileValue.content),
      contentType: fileValue.contentType ?? 'text/plain',
    };
  }

  throw new Error(
    `GoogleDriveAdapter.createRecord(File): file value "${fileValue.name ?? 'unnamed'}" ` +
      'has no retrievable file and no inline content.',
  );
}

// ── updateRecord / deleteRecord — create-only, so loud throws ──────────────────

export async function updateRecord(_input: { update: UpdateInput }): Promise<UpdateResult> {
  throw new Error(
    'Google Drive is create-only — updateRecord is not supported. Folder and ' +
      'File creates have no in-place edit; model a change as a new write instead.',
  );
}

export async function deleteRecord(_input: { del: DeleteInput }): Promise<DeleteResult> {
  throw new Error(
    'Google Drive is create-only — deleteRecord is not supported. Created ' +
      'folders/files have no delete path through this adapter.',
  );
}

// ── resolveEntity — always empty (Drive is create-only) ────────────────────────
// Drive has no addressable record to update, so we must never surface a
// candidate: a returned candidate routes the engine into `updateRecord`, which
// throws create-only. (The tier-0/tier-1 folder reuse that gives re-delivery its
// idempotency lives in the CREATE path — `createFolder` — where a live parentId
// is available; it does not belong here.) Returning [] keeps Drive honestly
// unlinkable, matching the Sheets exemplar.

export async function resolveEntity(_input: {
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  return { candidates: [] };
}
