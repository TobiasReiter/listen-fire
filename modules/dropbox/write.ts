// Dropbox — the write paths plus the reads that support them
// (bridge-only entity resolution, display data). Two create paths, one per
// noun (adapters/CLAUDE.md rule 4 — the old document/upload split was one
// concept; `files/upload` is the API's single file-creation endpoint):
//
//   • folder — `files/create_folder_v2`, with a by-name reuse search first.
//   • file   — `files/upload`; the bytes arrive as the `File` field value
//              (a FileRef descriptor, or inline text).
//
// Structural twin of the Google Drive write paths; the divergence is that
// Dropbox addresses by PATH: `findFolder`/`createFolder` take/return a parent
// path, the externalId of a created record IS its path, and the display URL
// is `dropboxWebUrl(path)`. The parent folder comes from the enclosing
// edge/action (`parentLink.externalId`), else the `parent` field pin, else
// the Dropbox ROOT — itself a real folder (path ""), so a bare root create
// is honest, not an error.
//
// Dropbox is create-only: `updateRecord` / `deleteRecord` throw a clear "not
// supported" error (a created folder/file has no in-place TG mutation path;
// the API's `files/move_v2` re-parent is a recorded capability gap).

import type { ModuleFiles, ModuleLog } from 'module-kit';
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
} from 'movement-engine/public/adapter';
import type { DropboxClient } from './api_client';

import { singleParentLink } from 'movement-engine/public/adapter';
import {
  DROPBOX_ADAPTER_TYPE,
  dropboxWebUrl,
  requireStructuredId,
} from './types';

// ── createRecord — dispatch on type ───────────────────────────────────────────

export interface WriteHost {
  client: DropboxClient;
  /** The host's way to a file value's bytes (the run's own team's). */
  files: Pick<ModuleFiles, 'read'>;
  log: ModuleLog;
}

export async function createRecord(input: WriteHost & { write: WriteInput }): Promise<WriteResult> {
  // `recordType` is the pretty type name; recover the write kind from the static
  // name → kind map (an unknown name is drift — a hard throw).
  const kind = requireStructuredId(input.write.recordType, 'createRecord');

  switch (kind) {
    case 'folder':
      return createFolder(input);
    case 'file':
      return createUpload(input);
  }
}

/** Resolve the parent folder PATH for a write: a child/edge write inherits it
 *  from its lone parent link's externalId; a root action may pin it via the
 *  `parent` field. Neither present ⇒ the Dropbox ROOT (path "") — itself a
 *  real folder, which is exactly what the root collections read. A folder/
 *  file lives in a single parent folder. */
function resolveParentPath(write: WriteInput): string {
  const parentLink = singleParentLink(write);
  if (parentLink?.externalId) return parentLink.externalId;
  const parent = write.fields.parent;
  return typeof parent === 'string' && parent.length > 0 ? parent : '';
}

/** Create (or reuse) a folder — mirror v3 `executeFolder`, minus the LLM. The
 *  tier-0 linked_object dedup happens in `resolveEntity`; here a tier-1 search
 *  by name within the parent precedes creation, exactly as v3 does. */
async function createFolder(input: Pick<WriteHost, 'client' | 'log'> & { write: WriteInput }): Promise<WriteResult> {
  const { client, write, log } = input;
  const folderName = String(write.fields.name ?? write.fields.title ?? 'Untitled');
  const parentPath = resolveParentPath(write);

  // Tier 1: search by name within parent (tier-0 bridge dedup is resolveEntity).
  const existingPath = await client.findFolder({ name: folderName, parentPath });
  if (existingPath) {
    log.info(`[Dropbox] Found existing folder "${folderName}" → ${existingPath}`);
    return {
      adapterType: DROPBOX_ADAPTER_TYPE,
      externalId: existingPath,
      data: { name: folderName, url: dropboxWebUrl(existingPath) },
    };
  }

  const folder = await client.createFolder({ name: folderName, parentPath });
  log.info(`[Dropbox] Created folder "${folderName}" → ${folder.path}`);
  return {
    adapterType: DROPBOX_ADAPTER_TYPE,
    externalId: folder.path,
    data: { name: folderName, url: dropboxWebUrl(folder.path) },
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

/** Create a file — the ONE file-creation path (`files/upload`). The bytes
 *  arrive as the `File` field value (a FileRef descriptor, or inline text), not from a context-node resource: in
 *  the TG model content is delivered as a field. */
async function createUpload(input: WriteHost & { write: WriteInput }): Promise<WriteResult> {
  const { client, write, log } = input;
  const parentPath = resolveParentPath(write);

  const fileValue = asFileValue(write.fields.file);
  if (fileValue == null) {
    throw new Error(
      'DropboxAdapter.createRecord(File): the `File` field is empty — map a ' +
        'file value or inline text into it.',
    );
  }

  const resolved = await uploadBytes(fileValue, input.files);
  const name =
    String(write.fields.name ?? '') ||
    (typeof fileValue === 'object' ? fileValue.name : undefined) ||
    'file';

  const result = await client.uploadBytes({ name, parentPath, bytes: resolved });
  log.info(`[Dropbox] Uploaded "${name}" → ${result.path}`);
  return {
    adapterType: DROPBOX_ADAPTER_TYPE,
    externalId: result.path,
    data: { name, url: dropboxWebUrl(result.path) },
  };
}

/** Whether a file value names where its bytes are: an owner and handle, or a
 *  fetchable URL the host handed in. */
function hasRetrievableBytes(ref: FileRef): boolean {
  return ref.source !== undefined || (typeof ref.url === 'string' && ref.url !== '');
}

/** Resolve a `file` field value to its bytes. Preferred: the FileRef's own,
 *  read through the host (which holds only the run's team's). Fallback:
 *  inline string content composed in the program body. */
async function uploadBytes(fileValue: FileValue | string, files: Pick<ModuleFiles, 'read'>): Promise<Uint8Array> {
  if (typeof fileValue === 'string') return Buffer.from(fileValue);
  if (hasRetrievableBytes(fileValue)) return files.read(fileValue);
  if (typeof fileValue.content === 'string') return Buffer.from(fileValue.content);

  throw new Error(
    `DropboxAdapter.createRecord(File): file value "${fileValue.name ?? 'unnamed'}" ` +
      'has no retrievable file and no inline content.',
  );
}

// ── updateRecord / deleteRecord — create-only, so loud throws ──────────────────

export async function updateRecord(_input: { update: UpdateInput }): Promise<UpdateResult> {
  throw new Error(
    'Dropbox is create-only — updateRecord is not supported. Folder and File ' +
      'creates have no in-place edit; model a change as a new write instead.',
  );
}

export async function deleteRecord(_input: { del: DeleteInput }): Promise<DeleteResult> {
  throw new Error(
    'Dropbox is create-only — deleteRecord is not supported. Created ' +
      'folders/files have no delete path through this adapter.',
  );
}

// ── resolveEntity — always empty (Dropbox is create-only) ──────────────────────
// Dropbox has no addressable record to update, so we must never surface a
// candidate: a returned candidate routes the engine into `updateRecord`, which
// throws create-only. (The tier-0/tier-1 folder reuse that gives re-delivery its
// idempotency lives in the CREATE path — `createFolder` — where a live parent
// path is available; it does not belong here.) Returning [] keeps Dropbox
// honestly unlinkable, matching the Sheets exemplar.

export async function resolveEntity(_input: {
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  return { candidates: [] };
}
