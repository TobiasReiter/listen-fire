// Dropbox TG adapter — implements the translation-graph `Adapter` contract.
// The source-trigger side (snapshot/poll) is deferred; the adapter declares no
// triggers and leaves `webhookEventTypeId` undefined.
//
// This is the structural TWIN of the Google Drive TG adapter. The surface is
// the API's own two nouns — `Folder` and `File` — each readable AND creatable
// (adapters/CLAUDE.md rules 4/6; the old document/upload write forms were one
// concept). See schema_catalog.ts for the graph.
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
// Lazy-loads team credentials from external_service_credentials and constructs
// the Dropbox client on first use (via the shared Dropbox auth client, which
// refreshes + returns a valid access token), redirecting to fake-channels for
// the dev-loop test-harness team (mirrors Attio / Airtable / Sheets / Drive).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
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
} from 'movement-engine/services/translation_graph/adapter';
import type { TriggerType } from 'movement-engine/services/translation_graph/triggers/types';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/services/translation_graph/types';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { logger } from 'movement-engine/services/logger';
import { services } from '../../../../adapters/registry';
import { DropboxClient } from '../../../../adapters/dropbox/apiClient';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { fileHandle, ownedFileSource } from 'movement-engine/services/translation_graph/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { BaseAdapter } from '../base';
import { naturalName } from '../name_resolution';
import {
  DROPBOX_ADAPTER_TYPE,
  dropboxAdapterCredsParser,
  dropboxWebUrl,
} from './types';
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
} from './schema_catalog';
import { uniformWalk } from '../hop';
import {
  createRecord as writeCreateRecord,
  updateRecord as writeUpdateRecord,
  deleteRecord as writeDeleteRecord,
  resolveEntity as writeResolveEntity,
} from './write';

export { DROPBOX_ADAPTER_TYPE } from './types';

/**
 * Static manifest. Create-only target (no inbound triggers); `createRecord`
 * is a real write. `updateRecord` / `deleteRecord` are NOT listed — Dropbox
 * is create-only and they throw.
 *
 */
export const DROPBOX_MANIFEST: AdapterManifest = {
  adapterType: DROPBOX_ADAPTER_TYPE,
  displayName: 'Dropbox',
  website: 'https://www.dropbox.com',
  category: 'Files',
  description:
    'Dropbox. Save files into Dropbox folders from your movements, and read ' +
    'the Dropbox tree — folders, files, and file content.',
  supportedTriggers: [],
  methods: [
    'listEntryPoints', 'describe', 'resolveEntity', 'createRecord',
    'getFieldValue', 'getRelated', 'resolveFileRef',
  ],
  requiredCredentialType: ExternalServiceType.DROPBOX,
  triggerKinds: ['DROPBOX'],
  vocabulary: {
    icon: {
      d: 'M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z',
      fill: true,
    },
  },
};

/** One Dropbox entry as the read surface projects it (listFolder's shape). */
type DropboxEntryRecord = { name: string; path: string; isFolder: boolean; size: number | null };

export class DropboxAdapter extends BaseAdapter {
  readonly adapterType = DROPBOX_ADAPTER_TYPE;

  readonly supportedTriggers = DROPBOX_MANIFEST.supportedTriggers;

  /** No synthetic event positions — unstable positions never resolve here. */
  readonly webhookEventTypeId = undefined;

  private dropboxClient: DropboxClient | null = null;
  private readonly teamId: TeamId;
  private readonly credentialsId: string;

  constructor(input: { teamId: TeamId; credentialsId: string }) {
    super();
    this.teamId = input.teamId;
    this.credentialsId = input.credentialsId;
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
    const client = await this.getClient();

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

  /** The file's binary primitive — a descriptor naming this instance (its
   *  credential) and the Dropbox path, redeemed by `resolveFileRef`. */
  private dropboxFileRef(entry: DropboxEntryRecord): FileRef | null {
    if (!entry.path || entry.isFolder) return null;
    const path = entry.path;
    return {
      __brand: 'FileRef',
      name: entry.name || undefined,
      size: entry.size ?? undefined,
      source: ownedFileSource({ adapterType: DROPBOX_ADAPTER_TYPE, credentialsId: this.credentialsId, handle: path }),
    };
  }

  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error('DropboxAdapter.resolveFileRef: FileRef has no source handle.');
    }
    const client = await this.getClient();
    return { stream: await client.download(handle), contentType: input.ref.contentType };
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const client = await this.getClient();
    return writeCreateRecord({ client, teamId: this.teamId, write: await this.toInternalWrite(input) });
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

  // ── Internal: lazy Dropbox client construction ───────────────────────────

  private async getClient(): Promise<DropboxClient> {
    if (this.dropboxClient) return this.dropboxClient;

    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', this.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', this.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Dropbox credentials ${this.credentialsId} not found for team ${this.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
      );
    }

    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch (err) {
      logger.error('[DropboxAdapter] credential payload is not valid JSON', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Dropbox credentials ${row.id} are malformed (not valid JSON).`);
    }

    // Route dev-loop team traffic to fake-channels (mirrors Attio / Airtable /
    // Sheets / Drive). The Dropbox client carries no base-url override today, so
    // this is structurally identical to the other adapters and a no-op unless a
    // DROPBOX fake-base-url is added.
    const rawPayload = isTestHarnessTeam(this.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'DROPBOX')
      : payload;

    const parsed = dropboxAdapterCredsParser.safeParse(rawPayload);
    if (!parsed.success) {
      logger.error('[DropboxAdapter] credential payload failed validation', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: parsed.error.message,
      });
      throw new Error(`Dropbox credentials ${row.id} are malformed (${parsed.error.message}).`);
    }

    if (!services.dropbox) {
      throw new Error(
        'Dropbox adapter: Dropbox integrations are not configured (services.dropbox is unset).',
      );
    }

    const accessToken = await services.dropbox.authClient.getValidAccessToken(row.id, {
      accessToken: parsed.data.accessToken,
      refreshToken: parsed.data.refreshToken,
      expiresAt: parsed.data.expiresAt,
    });
    this.dropboxClient = new DropboxClient(
      accessToken,
      parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : undefined,
    );
    return this.dropboxClient;
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

export function createDropboxAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): DropboxAdapter {
  if (!input.credentialsId) {
    throw new Error(
      'Dropbox adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  return new DropboxAdapter({
    teamId: input.teamId,
    credentialsId: input.credentialsId,
  });
}
