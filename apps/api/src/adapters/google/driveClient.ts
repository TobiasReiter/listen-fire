import { Readable } from 'node:stream';

import { google, type drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

/** One Drive item as the read surface projects it. */
export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  size: number | null;
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

class GoogleDriveClient {
  private drive: drive_v3.Drive;
  private rootUrl: string | undefined;

  /** `baseUrl` is the test-harness redirect (fake-channels). The service-level
   *  `rootUrl` rewrites plain request URLs, but googleapis does NOT rewrite
   *  MEDIA upload URLs from it — media-bearing calls must pass `rootUrl`
   *  per-request (see `mediaOptions`). */
  constructor(oauth2Client: OAuth2Client, options?: { baseUrl?: string }) {
    this.rootUrl = options?.baseUrl;
    this.drive = google.drive({
      version: 'v3',
      auth: oauth2Client,
      ...(options?.baseUrl ? { rootUrl: options.baseUrl } : {}),
    });
  }

  /** Per-request options for media uploads — the only path that needs the
   *  redirect repeated (upload URLs ignore the service rootUrl). */
  private mediaOptions(): { rootUrl?: string } {
    return this.rootUrl ? { rootUrl: this.rootUrl } : {};
  }

  async findFolder(options: {
    name: string;
    parentId: string;
  }): Promise<string | null> {
    const q = [
      `name = '${options.name.replace(/'/g, "\\'")}'`,
      `'${options.parentId}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      'trashed = false',
    ].join(' and ');

    const response = await this.drive.files.list({
      q,
      fields: 'files(id,name)',
      spaces: 'drive',
    });

    return response.data.files?.[0]?.id ?? null;
  }

  async createFolder(options: {
    name: string;
    parentId: string;
  }): Promise<{ id: string; webViewLink: string }> {
    const response = await this.drive.files.create({
      requestBody: {
        name: options.name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [options.parentId],
      },
      fields: 'id,webViewLink',
    });

    if (!response.data.id) {
      throw new Error('Google Drive: failed to create folder');
    }

    return {
      id: response.data.id,
      webViewLink: response.data.webViewLink ?? '',
    };
  }

  async createDocument(options: {
    name: string;
    content: string;
    parentId: string;
    mimeType?: string;
  }): Promise<{ id: string; webViewLink: string }> {
    const response = await this.drive.files.create({
      requestBody: {
        name: options.name,
        mimeType: options.mimeType ?? 'application/vnd.google-apps.document',
        parents: [options.parentId],
      },
      media: {
        mimeType: 'text/plain',
        body: Readable.from(options.content),
      },
      fields: 'id,webViewLink',
    }, this.mediaOptions());

    if (!response.data.id) {
      throw new Error('Google Drive: failed to create document');
    }

    return {
      id: response.data.id,
      webViewLink: response.data.webViewLink ?? '',
    };
  }

  async uploadFile(options: {
    name: string;
    parentId: string;
    stream: Readable;
    mimeType?: string;
  }): Promise<{ id: string; webViewLink: string }> {
    const response = await this.drive.files.create({
      requestBody: {
        name: options.name,
        parents: [options.parentId],
      },
      media: {
        mimeType: options.mimeType ?? 'application/octet-stream',
        body: options.stream,
      },
      fields: 'id,webViewLink',
    }, this.mediaOptions());

    if (!response.data.id) {
      throw new Error('Google Drive: failed to upload file');
    }

    return {
      id: response.data.id,
      webViewLink: response.data.webViewLink ?? '',
    };
  }

  // ── Read surface (2026-07-05) ─────────────────────────────────────────────

  /** The children of a folder ('root' = My Drive), folders and files alike. */
  async listChildren(options: {
    parentId: string;
    /** Restrict to folders only / non-folders only; absent = everything. */
    kind?: 'folder' | 'file';
    limit?: number;
  }): Promise<DriveItem[]> {
    const q = [
      `'${options.parentId.replace(/'/g, "\\'")}' in parents`,
      'trashed = false',
      ...(options.kind === 'folder' ? [`mimeType = '${DRIVE_FOLDER_MIME}'`] : []),
      ...(options.kind === 'file' ? [`mimeType != '${DRIVE_FOLDER_MIME}'`] : []),
    ].join(' and ');
    const response = await this.drive.files.list({
      q,
      fields: 'files(id,name,mimeType,webViewLink,size)',
      pageSize: options.limit ?? 200,
      spaces: 'drive',
    });
    return (response.data.files ?? []).flatMap((f) => (f.id ? [toDriveItem(f)] : []));
  }

  async getFile(options: { fileId: string }): Promise<DriveItem | null> {
    try {
      const response = await this.drive.files.get({
        fileId: options.fileId,
        fields: 'id,name,mimeType,webViewLink,size',
      });
      return response.data.id ? toDriveItem(response.data) : null;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  /** The file's bytes (binary content; Docs-native files can't be fetched
   *  this way — export is a follow-up). */
  async downloadFile(options: { fileId: string }): Promise<Readable> {
    const response = await this.drive.files.get(
      { fileId: options.fileId, alt: 'media' },
      { responseType: 'stream' },
    );
    return response.data as unknown as Readable;
  }
}

function toDriveItem(f: drive_v3.Schema$File): DriveItem {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    webViewLink: f.webViewLink ?? null,
    size: f.size != null ? Number(f.size) : null,
  };
}

export { GoogleDriveClient };
