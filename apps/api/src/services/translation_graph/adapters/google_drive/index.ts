// Google Drive TG adapter — implements the translation-graph `Adapter`
// contract. The source-trigger side (snapshot/poll) is deferred; the adapter
// declares no triggers and leaves `webhookEventTypeId` undefined.
//
// This is the structural TWIN of the Dropbox TG adapter. The surface is the
// API's own two nouns — `Folder` and `File` — readable at the root (the
// credential's GRANTED items) and creatable along a folder's edges
// (adapters/CLAUDE.md rules 0/4/6; the old document/upload write forms were
// one concept, and under drive.file there is no root to write into). See
// schema_catalog.ts for the graph.
//
// Drive is create-only: `updateRecord`/`deleteRecord` throw a clear "not
// supported" error. `resolveEntity` is bridge-only (tier-0 linked_object
// dedup for re-delivery).
//
// Lazy-loads team credentials from external_service_credentials and constructs
// the Drive client on first use (via the shared Google OAuth client),
// redirecting to fake-channels for the dev-loop test-harness team (mirrors
// Attio / Airtable / Sheets).

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
import type { DriveItem } from '../../../../adapters/google/driveClient';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { listGrantedItems, DRIVE_FOLDER_MIME } from '../../../credentials/granted_items';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { logger } from 'movement-engine/services/logger';
import { services } from '../../../../adapters/registry';
import { GoogleDriveClient } from '../../../../adapters/google/driveClient';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { fileHandle, ownedFileSource } from 'movement-engine/services/translation_graph/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { BaseAdapter } from 'module-kit/adapter/base';
import { naturalName } from 'module-kit/adapter/name_resolution';
import {
  GOOGLE_DRIVE_ADAPTER_TYPE,
  googleDriveAdapterCredsParser,
} from './types';
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

export { GOOGLE_DRIVE_ADAPTER_TYPE } from './types';

/**
 * Static manifest. Create-only target (no inbound triggers); `createRecord`
 * is a real write. `updateRecord` / `deleteRecord` are NOT listed — Drive is
 * create-only and they throw.
 *
 */
export const GOOGLE_DRIVE_MANIFEST: AdapterManifest = {
  adapterType: GOOGLE_DRIVE_ADAPTER_TYPE,
  displayName: 'Google Drive',
  website: 'https://www.google.com/drive/',
  category: 'Files',
  description:
    'Google Drive. Save files into Drive folders from your movements, and ' +
    'read the Drive tree — folders, files, and file content.',
  supportedTriggers: [],
  methods: [
    'listEntryPoints', 'describe', 'resolveEntity', 'createRecord',
    'getFieldValue', 'getRelated', 'resolveFileRef',
  ],
  requiredCredentialType: ExternalServiceType.GOOGLE,
  triggerKinds: ['GOOGLE_DRIVE'],
  vocabulary: {
    icon: {
      d: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
      fill: true,
    },
  },
  construction: [
    {
      kind: 'action',
      actionKind: 'google-drive-picker',
      label: 'Connect Drive files or folders',
      help: 'Pick files and folders to make them available to your movements.',
    },
  ],
};

// A granted item as the minimal `DriveItem` the position layer needs. A
// granted item only knows id/name/mimeType; `webViewLink`/`size` are
// re-fetched by id on deeper reads (folder children, file bytes), so they're
// null here. Module-level (not a method) so `itemPositions` stays untouched.
function grantedToDriveItem(g: { itemId: string; name: string | null; mimeType: string }): DriveItem {
  return { id: g.itemId, name: g.name ?? g.itemId, mimeType: g.mimeType, webViewLink: null, size: null };
}

export class GoogleDriveAdapter extends BaseAdapter {
  readonly adapterType = GOOGLE_DRIVE_ADAPTER_TYPE;

  readonly supportedTriggers = GOOGLE_DRIVE_MANIFEST.supportedTriggers;

  /** No synthetic event positions — unstable positions never resolve here. */
  readonly webhookEventTypeId = undefined;

  private driveClient: GoogleDriveClient | null = null;
  private readonly teamId: TeamId;
  private readonly credentialsId: string;

  constructor(input: { teamId: TeamId; credentialsId: string }) {
    super();
    this.teamId = input.teamId;
    this.credentialsId = input.credentialsId;
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
    // The meta root's collections come from the credential's GRANTED items
    // (the generic `granted_items` store), not `client.listChildren('root')` —
    // under the drive.file scope Drive publishes no "root" listing, so a Picker
    // grant is the only way an item becomes reachable. No client needed here.
    if (input.position.recordType === META_RECORD_TYPE) {
      const collection = naturalName(input.fieldId);
      const granted = await listGrantedItems(this.credentialsId);
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

  /** The file's binary primitive — a descriptor naming this instance (its
   *  credential) and the Drive file id, redeemed by `resolveFileRef`. */
  private driveFileRef(item: DriveItem): FileRef | null {
    if (!item.id) return null;
    return {
      __brand: 'FileRef',
      name: item.name || undefined,
      contentType: item.mimeType || undefined,
      size: item.size ?? undefined,
      source: ownedFileSource({ adapterType: GOOGLE_DRIVE_ADAPTER_TYPE, credentialsId: this.credentialsId, handle: item.id }),
    };
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

  // ── Internal: lazy Drive client construction ─────────────────────────────

  private async getClient(): Promise<GoogleDriveClient> {
    if (this.driveClient) return this.driveClient;

    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', this.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', this.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Google Drive credentials ${this.credentialsId} not found for team ${this.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
      );
    }

    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch (err) {
      logger.error('[GoogleDriveAdapter] credential payload is not valid JSON', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Google Drive credentials ${row.id} are malformed (not valid JSON).`);
    }

    // Route dev-loop team traffic to fake-channels (mirrors Attio / Airtable /
    // Sheets): the injected baseUrl becomes the googleapis rootUrl, so every
    // call — uploads included — hits the fake.
    const rawPayload = isTestHarnessTeam(this.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'GOOGLE_DRIVE')
      : payload;

    const parsed = googleDriveAdapterCredsParser.safeParse(rawPayload);
    if (!parsed.success) {
      logger.error('[GoogleDriveAdapter] credential payload failed validation', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: parsed.error.message,
      });
      throw new Error(`Google Drive credentials ${row.id} are malformed (${parsed.error.message}).`);
    }

    if (!services.google) {
      throw new Error(
        'Google Drive adapter: Google integrations are not configured (services.google is unset).',
      );
    }

    const oauth2Client = services.google.authClient.getGoogleClient(row.id, parsed.data);
    this.driveClient = new GoogleDriveClient(
      oauth2Client,
      parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : undefined,
    );
    return this.driveClient;
  }
}

export function createGoogleDriveAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): GoogleDriveAdapter {
  if (!input.credentialsId) {
    throw new Error(
      'Google Drive adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  return new GoogleDriveAdapter({
    teamId: input.teamId,
    credentialsId: input.credentialsId,
  });
}
