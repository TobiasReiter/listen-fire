// The Drive v3 client. googleapis builds every request (the query strings,
// the multipart uploads) as it always has; it reaches Google through the
// caller's fetch (gaxios's `fetchImplementation`) with a token the caller
// supplies per call. The client holds only that token, never a refresh token:
// whoever hands it the token keeps it fresh (the module's host, or the
// platform's google-auth-library client for the platform's own callers).

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { google, type drive_v3 } from 'googleapis';

/** One Drive item as the read surface projects it. */
export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  size: number | null;
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface GoogleDriveClientOptions {
  /** The current access token, asked for per call. */
  accessToken: () => Promise<string>;
  fetch: typeof fetch;
  /** The test-harness redirect (the dev loop's fake): Google's root URL. */
  baseUrl?: string;
}

/** A stream as Node's: gaxios answers a web stream through Node's fetch, a
 *  Node one through node-fetch. */
function nodeStream(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body !== null && typeof body === 'object' && 'getReader' in body) return Readable.fromWeb(body as WebReadableStream);
  throw new Error('Google Drive: the download answered no stream');
}

export class GoogleDriveClient {
  private readonly drive: drive_v3.Drive;
  private readonly auth = new google.auth.OAuth2();
  private readonly rootUrl: string | undefined;

  /** The service-level `rootUrl` rewrites plain request URLs, but googleapis
   *  does NOT rewrite MEDIA upload URLs from it: media-bearing calls pass
   *  `rootUrl` per request (see `mediaOptions`). */
  constructor(private readonly options: GoogleDriveClientOptions) {
    this.rootUrl = options.baseUrl;
    this.drive = google.drive({
      version: 'v3',
      auth: this.auth,
      fetchImplementation: options.fetch,
      ...(options.baseUrl ? { rootUrl: options.baseUrl } : {}),
    });
  }

  /** The drive, holding the caller's current token. */
  private async authorized(): Promise<drive_v3.Drive> {
    this.auth.setCredentials({ access_token: await this.options.accessToken() });
    return this.drive;
  }

  private mediaOptions(): { rootUrl?: string } {
    return this.rootUrl ? { rootUrl: this.rootUrl } : {};
  }

  async findFolder(options: { name: string; parentId: string }): Promise<string | null> {
    const q = [
      `name = '${options.name.replace(/'/g, "\\'")}'`,
      `'${options.parentId}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      'trashed = false',
    ].join(' and ');

    const response = await (await this.authorized()).files.list({
      q,
      fields: 'files(id,name)',
      spaces: 'drive',
    });

    return response.data.files?.[0]?.id ?? null;
  }

  async createFolder(options: { name: string; parentId: string }): Promise<{ id: string; webViewLink: string }> {
    const response = await (await this.authorized()).files.create({
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

    return { id: response.data.id, webViewLink: response.data.webViewLink ?? '' };
  }

  async createDocument(options: {
    name: string;
    content: string;
    parentId: string;
    mimeType?: string;
  }): Promise<{ id: string; webViewLink: string }> {
    const response = await (await this.authorized()).files.create(
      {
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
      },
      this.mediaOptions(),
    );

    if (!response.data.id) {
      throw new Error('Google Drive: failed to create document');
    }

    return { id: response.data.id, webViewLink: response.data.webViewLink ?? '' };
  }

  async uploadFile(options: {
    name: string;
    parentId: string;
    stream: Readable;
    mimeType?: string;
  }): Promise<{ id: string; webViewLink: string }> {
    const response = await (await this.authorized()).files.create(
      {
        requestBody: {
          name: options.name,
          parents: [options.parentId],
        },
        media: {
          mimeType: options.mimeType ?? 'application/octet-stream',
          body: options.stream,
        },
        fields: 'id,webViewLink',
      },
      this.mediaOptions(),
    );

    if (!response.data.id) {
      throw new Error('Google Drive: failed to upload file');
    }

    return { id: response.data.id, webViewLink: response.data.webViewLink ?? '' };
  }

  // ── Read surface ──────────────────────────────────────────────────────────

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
    const response = await (await this.authorized()).files.list({
      q,
      fields: 'files(id,name,mimeType,webViewLink,size)',
      pageSize: options.limit ?? 200,
      spaces: 'drive',
    });
    return (response.data.files ?? []).flatMap((f) => (f.id ? [toDriveItem(f)] : []));
  }

  async getFile(options: { fileId: string }): Promise<DriveItem | null> {
    try {
      const response = await (await this.authorized()).files.get({
        fileId: options.fileId,
        fields: 'id,name,mimeType,webViewLink,size',
      });
      return response.data.id ? toDriveItem(response.data) : null;
    } catch (err) {
      if (err !== null && typeof err === 'object' && Reflect.get(err, 'code') === 404) return null;
      throw err;
    }
  }

  /** The file's bytes (binary content; Docs-native files can't be fetched
   *  this way — export is a follow-up). */
  async downloadFile(options: { fileId: string }): Promise<Readable> {
    const response = await (await this.authorized()).files.get({ fileId: options.fileId, alt: 'media' }, { responseType: 'stream' });
    return nodeStream(response.data);
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
