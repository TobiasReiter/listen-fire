// Dropbox adapter — implements the translation-graph `Adapter` contract.
// The source-trigger side (snapshot/poll) is deferred; the adapter declares no
// triggers and leaves `webhookEventTypeId` undefined.
//
// This is the structural TWIN of the Google Drive TG adapter. The surface is
// the API's own two nouns — `Folder` and `File` — each readable AND creatable
// (adapters/CLAUDE.md rules 4/6; the old document/upload write forms were one
// concept). See schema.ts for the graph.
//
// Dropbox addresses records by PATH (not id): the externalId of a created
// record is its path, and the parent is a parent folder path. The Dropbox
// ROOT is itself a real folder (path ""), so the root collections read its
// children and a bare root create lands there.
//
// Dropbox is create-only: `updateRecord`/`deleteRecord` throw a clear "not
// supported" error. `resolveEntity` is bridge-only (tier-0 linked_object
// dedup for re-delivery).
//
// The client comes from the host's credential (`ctx.credential`) through a
// source the module builds per call; bytes a write carries are read through
// the host (`ctx.files`), so nothing here knows a database or a team.

import type { ModuleFiles, ModuleLog } from 'module-kit';
import type {
  DeleteInput,
  DeleteResult,
  FileRef,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  ResolveFileRefResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
  EdgesFromResult,
} from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';
import type { DropboxClient } from './api_client';

import { fileHandle, ownedFileSource } from 'movement-engine/public/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData } from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { naturalName } from 'module-kit/adapter/name_resolution';
import { DROPBOX_ADAPTER_TYPE, dropboxWebUrl } from './types';
import {
  DROPBOX_FILES_COLLECTION,
  DROPBOX_FILE_TYPE,
  DROPBOX_FOLDERS_COLLECTION,
  DROPBOX_FOLDER_EDGES,
  DROPBOX_FOLDER_TYPE,
  DROPBOX_PARENT_EDGE,
  listEntryPoints as catalogListEntryPoints,
  describe as catalogDescribe,
  rootDescriptor,
} from './schema';
import { DROPBOX_MANIFEST } from './manifest';
import { uniformWalk } from 'module-kit/adapter/hop';
import {
  createRecord as writeCreateRecord,
  updateRecord as writeUpdateRecord,
  deleteRecord as writeDeleteRecord,
  resolveEntity as writeResolveEntity,
} from './write';


/** The client the host's credential reaches Dropbox with, read per call. */
export type DropboxClientSource = () => Promise<DropboxClient>;

/** One Dropbox entry as the read surface projects it (listFolder's shape). */
type DropboxEntryRecord = { name: string; path: string; isFolder: boolean; size: number | null };

export class DropboxAdapter extends BaseAdapter {
  readonly adapterType = DROPBOX_ADAPTER_TYPE;

  readonly supportedTriggers = DROPBOX_MANIFEST.supportedTriggers;

  /** No synthetic event positions — unstable positions never resolve here. */
  readonly webhookEventTypeId = undefined;

  private readonly client: DropboxClientSource;
  private readonly files: Pick<ModuleFiles, 'read'>;
  private readonly log: ModuleLog;

  constructor(input: { client: DropboxClientSource; files: Pick<ModuleFiles, 'read'>; log: ModuleLog }) {
    super();
    this.client = input.client;
    this.files = input.files;
    this.log = input.log;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────
  // The Dropbox surface is a fixed pair of types (no per-credential
  // enumeration, no API call), so neither method touches the client.

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return catalogListEntryPoints();
  }

  /**
   * Folders nest, so the meta graph is genuinely recursive — `Folder` has a
   * `Folders` edge back to itself. Nothing special is needed for that: a type
   * id locates every node here, so the walk terminates when the caller stops
   * asking rather than when the graph runs out.
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: DROPBOX_ADAPTER_TYPE,
      at: position,
      root: rootDescriptor(),
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // The engine names types by their pretty displayName, which IS the entry
    // typeId now — the static catalog recovers the write kind from that name.
    return catalogDescribe({ name: typeRef });
  }

  // ── 2. Entity resolution — bridge-only ─────────────────────────────────

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // Dropbox is create-only, so this always returns 0 candidates (see write.ts);
    // `recordType` is the pretty type name and passes straight through.
    return writeResolveEntity({ resolve: input });
  }

  // ── 3/4. The read graph (2026-07-05, positions-and-edges) ────────────────
  // Folders/files are path-addressed stable nouns: collections off the meta
  // root (the Dropbox root folder), children via `Folders`/`Files` edges,
  // bytes via the file's `File` field (FileRef; handle = the path).

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.direction !== 'outgoing') {
      throw new Error('DropboxAdapter.getRelated only supports outgoing direction.');
    }
    const client = await this.client();

    if (input.position.recordType === META_RECORD_TYPE) {
      const collection = naturalName(input.fieldId);
      if (collection === DROPBOX_FOLDERS_COLLECTION || collection === DROPBOX_FOLDER_TYPE) {
        return this.entryPositions(await client.listFolder(''), 'folder');
      }
      if (collection === DROPBOX_FILES_COLLECTION || collection === DROPBOX_FILE_TYPE) {
        return this.entryPositions(await client.listFolder(''), 'file');
      }
      return [];
    }

    if (input.position.recordType === DROPBOX_FOLDER_TYPE) {
      const folder = positionData(input.position) as DropboxEntryRecord | null;
      if (!folder?.path) return [];
      const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
      if (edgeId === DROPBOX_FOLDER_EDGES.folders) {
        return this.entryPositions(await client.listFolder(folder.path), 'folder');
      }
      if (edgeId === DROPBOX_FOLDER_EDGES.files) {
        return this.entryPositions(await client.listFolder(folder.path), 'file');
      }
      if (edgeId === DROPBOX_PARENT_EDGE) {
        return this.parentFolderPositions(folder.path);
      }
      return [];
    }

    // A file's only edge is the up-hop to its containing folder.
    if (input.position.recordType === DROPBOX_FILE_TYPE) {
      const file = positionData(input.position) as DropboxEntryRecord | null;
      if (!file?.path) return [];
      const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
      if (edgeId === DROPBOX_PARENT_EDGE) {
        return this.parentFolderPositions(file.path);
      }
      return [];
    }

    return [];
  }

  /**
   * The containing folder of a path — the reverse of `Folders`/`Files`. Dropbox
   * addresses by path, so the parent is deterministic (path minus its last
   * segment) and needs no round trip; the parent provably exists (the child is
   * inside it). An entry directly under the Dropbox root has no Folder node
   * above it, so that HONESTLY yields [] rather than a synthetic root node.
   */
  private parentFolderPositions(path: string): RelatedResult[] {
    const parentPath = parentFolderPath(path);
    if (parentPath === null) return [];
    const name = parentPath.slice(parentPath.lastIndexOf('/') + 1);
    return [
      {
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: DROPBOX_FOLDER_TYPE,
          recordId: parentPath,
          data: { name, path: parentPath, isFolder: true, size: null } as DropboxEntryRecord,
        }),
      },
    ];
  }

  private entryPositions(
    entries: Awaited<ReturnType<DropboxClient['listFolder']>>,
    kind: 'folder' | 'file',
  ): RelatedResult[] {
    return entries
      .filter((entry) => entry.isFolder === (kind === 'folder'))
      .map((entry) => ({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: kind === 'folder' ? DROPBOX_FOLDER_TYPE : DROPBOX_FILE_TYPE,
          recordId: entry.path,
          data: entry,
        }),
      }));
  }

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const entry = positionData(input.position) as DropboxEntryRecord | null;
    if (!entry) return null;
    const typeName = input.position.recordType ?? DROPBOX_FILE_TYPE;
    const resolver = await this.resolver({ types: [typeName] });
    const fieldId = resolver.tryFieldId(naturalName(typeName), naturalName(input.fieldId))
      ?? input.fieldId;
    switch (fieldId) {
      case 'name': return entry.name || null;
      case 'path': return entry.path || null;
      case 'url': return entry.path ? dropboxWebUrl(entry.path) : null;
      case 'size': return entry.size ?? null;
      // ONE `File` field, read and write (rule 6 at field level): the read is
      // the content FileRef; the write side consumes the same field in
      // write.ts (`createUpload`).
      case 'file': return this.dropboxFileRef(entry);
      default: return null;
    }
  }

  /** The file's binary primitive — a descriptor naming the Dropbox path as its
   *  handle, redeemed by `resolveFileRef`. The host names which install owns it. */
  private dropboxFileRef(entry: DropboxEntryRecord): FileRef | null {
    if (!entry.path || entry.isFolder) return null;
    const path = entry.path;
    return {
      __brand: 'FileRef',
      name: entry.name || undefined,
      size: entry.size ?? undefined,
      source: ownedFileSource({ adapterType: DROPBOX_ADAPTER_TYPE, handle: path }),
    };
  }

  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error('DropboxAdapter.resolveFileRef: FileRef has no source handle.');
    }
    const client = await this.client();
    return { stream: await client.download(handle), contentType: input.ref.contentType };
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const client = await this.client();
    return writeCreateRecord({ client, files: this.files, log: this.log, write: await this.toInternalWrite(input) });
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    return writeUpdateRecord({ update: input });
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    return writeDeleteRecord({ del: input });
  }

  /**
   * Translate a write's NATURAL field names to this adapter's internal field
   * ids on the boundary. `recordType` is already the pretty type name (the
   * write path recovers its kind from it). Dropbox publishes no references, so
   * every field key is a property — resolved via `tryFieldId`, leaving an
   * unrecognised key untouched (covers internal-keyed legacy callers). The
   * values are unchanged.
   */
  private async toInternalWrite(input: WriteInput): Promise<WriteInput> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const naturalType = naturalName(input.recordType);
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.fields)) {
      const fieldId = resolver.tryFieldId(naturalType, naturalName(key)) ?? key;
      fields[fieldId] = value;
    }
    return { ...input, fields };
  }
}

/**
 * The containing folder's path for a Dropbox path — the path minus its last
 * segment. Returns null when the entry sits directly under the Dropbox root
 * (its parent is the root collection, which has no Folder node). Dropbox paths
 * are `/a/b/c` with a leading slash; a trailing slash is tolerated.
 */
function parentFolderPath(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}
