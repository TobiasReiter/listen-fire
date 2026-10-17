// Google Drive TG adapter — implements the translation-graph `Adapter`
// contract. The source-trigger side (snapshot/poll) is deferred; the adapter
// declares no triggers and leaves `webhookEventTypeId` undefined.
//
// This is the structural TWIN of the Dropbox TG adapter. The surface is the
// API's own two nouns — `Folder` and `File` — readable at the root (the
// install's GRANTED items) and creatable along a folder's edges
// (adapters/CLAUDE.md rules 0/4/6; the old document/upload write forms were
// one concept, and under drive.file there is no root to write into). See
// schema_catalog.ts for the graph.
//
// Drive is create-only: `updateRecord`/`deleteRecord` throw a clear "not
// supported" error. `resolveEntity` is bridge-only (tier-0 linked_object
// dedup for re-delivery).
//
// The host supplies the client (built from the install's credential), the
// install's kv (where its granted items are kept), how a handed file's bytes
// are read, and a logger; the adapter reaches nothing else. A file it reads
// out is named by its own handle (the Drive file id); the host names it as
// the install's.

import type { ModuleKv, ModuleLog } from 'module-kit';
import type {
  AdapterManifest,
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
import type { DriveItem, GoogleDriveClient } from './drive_client';
import type { ReadHandedFile } from './write';

import { fileHandle } from 'movement-engine/public/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData } from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { naturalName } from 'module-kit/adapter/name_resolution';
import { moduleFileRef } from 'module-kit/files';
import { DRIVE_FOLDER_MIME } from './drive_client';
import { driveGrants, type DriveGrants, type GrantedDriveItem } from './grants';
import { GOOGLE_DRIVE_MANIFEST } from './manifest';
import { GOOGLE_DRIVE_ADAPTER_TYPE } from './types';
import {
  DRIVE_FILES_COLLECTION,
  DRIVE_FILE_TYPE,
  DRIVE_FOLDERS_COLLECTION,
  DRIVE_FOLDER_EDGES,
  DRIVE_FOLDER_TYPE,
  listEntryPoints as catalogListEntryPoints,
  describe as catalogDescribe,
  rootDescriptor,
} from './schema_catalog';
import { uniformWalk } from 'module-kit/adapter/hop';
import {
  createRecord as writeCreateRecord,
  updateRecord as writeUpdateRecord,
  deleteRecord as writeDeleteRecord,
  resolveEntity as writeResolveEntity,
} from './write';

// A granted item as the minimal `DriveItem` the position layer needs. A
// granted item only knows id/name/mimeType; `webViewLink`/`size` are
// re-fetched by id on deeper reads (folder children, file bytes), so they're
// null here. Module-level (not a method) so `itemPositions` stays untouched.
function grantedToDriveItem(g: GrantedDriveItem): DriveItem {
  return { id: g.itemId, name: g.name ?? g.itemId, mimeType: g.mimeType, webViewLink: null, size: null };
}

export class GoogleDriveAdapter extends BaseAdapter {
  readonly adapterType = GOOGLE_DRIVE_ADAPTER_TYPE;

  readonly supportedTriggers = GOOGLE_DRIVE_MANIFEST.supportedTriggers;

  /** No synthetic event positions — unstable positions never resolve here. */
  readonly webhookEventTypeId = undefined;

  private readonly getClient: GoogleDriveClientSource;
  private readonly grants: DriveGrants;
  private readonly readFile: ReadHandedFile;
  private readonly log: ModuleLog;

  constructor(input: { client: GoogleDriveClientSource; kv: ModuleKv; readFile: ReadHandedFile; log: ModuleLog }) {
    super();
    this.getClient = input.client;
    this.grants = driveGrants(input.kv);
    this.readFile = input.readFile;
    this.log = input.log;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────
  // The Drive surface is a fixed pair of types (no per-credential
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
      adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
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
    // Drive is create-only, so this always returns 0 candidates (see write.ts);
    // `recordType` is the pretty type name and passes straight through.
    return writeResolveEntity({ resolve: input });
  }

  // ── 3/4. The read graph (2026-07-05, positions-and-edges) ────────────────
  // Folders/files are stable nouns: collections off the meta root, children
  // via `Folders`/`Files` edges, bytes via the file's `File` field (FileRef).

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.direction !== 'outgoing') {
      throw new Error('GoogleDriveAdapter.getRelated only supports outgoing direction.');
    }
    // The meta root's collections come from the install's GRANTED items
    // (its kv), not `client.listChildren('root')` —
    // under the drive.file scope Drive publishes no "root" listing, so a Picker
    // grant is the only way an item becomes reachable. No client needed here.
    if (input.position.recordType === META_RECORD_TYPE) {
      const collection = naturalName(input.fieldId);
      const granted = await this.grants.list();
      const folders = granted.filter((g) => g.mimeType === DRIVE_FOLDER_MIME);
      const files = granted.filter((g) => g.mimeType !== DRIVE_FOLDER_MIME);
      if (collection === DRIVE_FOLDERS_COLLECTION || collection === DRIVE_FOLDER_TYPE) {
        return this.itemPositions(folders.map(grantedToDriveItem));
      }
      if (collection === DRIVE_FILES_COLLECTION || collection === DRIVE_FILE_TYPE) {
        return this.itemPositions(files.map(grantedToDriveItem));
      }
      return [];
    }

    const client = await this.getClient();

    if (input.position.recordType === DRIVE_FOLDER_TYPE) {
      const folder = positionData(input.position) as DriveItem | null;
      if (!folder?.id) return [];
      const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
      if (edgeId === DRIVE_FOLDER_EDGES.folders) {
        return this.itemPositions(await client.listChildren({ parentId: folder.id, kind: 'folder' }));
      }
      if (edgeId === DRIVE_FOLDER_EDGES.files) {
        return this.itemPositions(await client.listChildren({ parentId: folder.id, kind: 'file' }));
      }
      return [];
    }

    return []; // files carry no outgoing edges
  }

  private itemPositions(items: DriveItem[]): RelatedResult[] {
    return items.map((item) => ({
      position: makeStablePosition({
        adapterType: this.adapterType,
        recordType:
          item.mimeType === 'application/vnd.google-apps.folder'
            ? DRIVE_FOLDER_TYPE
            : DRIVE_FILE_TYPE,
        recordId: item.id,
        data: item,
      }),
    }));
  }

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const item = positionData(input.position) as DriveItem | null;
    if (!item) return null;
    const typeName = input.position.recordType ?? DRIVE_FILE_TYPE;
    const resolver = await this.resolver({ types: [typeName] });
    const fieldId = resolver.tryFieldId(naturalName(typeName), naturalName(input.fieldId))
      ?? input.fieldId;
    switch (fieldId) {
      case 'id': return item.id || null;
      case 'name': return item.name || null;
      case 'mimeType': return item.mimeType || null;
      case 'url': return item.webViewLink ?? null;
      case 'size': return item.size ?? null;
      // ONE `File` field, read and write (rule 6 at field level): the read is
      // the content FileRef; the write side consumes the same field in
      // write.ts (`createUpload`).
      case 'file': return this.driveFileRef(item);
      default: return null;
    }
  }

  /** The file's binary primitive — a descriptor naming the Drive file id
   *  (the host names this install as its owner), redeemed by
   *  `resolveFileRef`. */
  private driveFileRef(item: DriveItem): FileRef | null {
    if (!item.id) return null;
    return moduleFileRef({
      adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
      handle: item.id,
      ...(item.name ? { name: item.name } : {}),
      ...(item.mimeType ? { contentType: item.mimeType } : {}),
      ...(item.size != null ? { size: item.size } : {}),
    });
  }

  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error('GoogleDriveAdapter.resolveFileRef: FileRef has no source handle.');
    }
    const client = await this.getClient();
    return {
      stream: await client.downloadFile({ fileId: handle }),
      contentType: input.ref.contentType,
    };
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const client = await this.getClient();
    return writeCreateRecord({ client, readFile: this.readFile, log: this.log, write: await this.toInternalWrite(input) });
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
   * write path recovers its kind from it). Drive publishes no references, so
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

/** The client the install's credential reaches Drive with, per call. */
export type GoogleDriveClientSource = () => Promise<GoogleDriveClient>;
