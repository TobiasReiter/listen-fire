import { Readable } from 'node:stream';

import { logger } from '../../services/logger';
import { describeError } from '../../lib/utils/error';

/**
 * `fetch`, but a network-level throw (undici `TypeError: fetch failed`) is
 * re-raised naming the operation and unwinding `.cause` — so a failed filing
 * run reads "Dropbox upload failed — getaddrinfo ENOTFOUND …", not the bare
 * "fetch failed" undici hands back. Non-OK HTTP responses are the caller's to
 * interpret (they carry status + body already).
 */
async function netFetch(op: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`Dropbox ${op} failed — ${describeError(err)}`);
  }
}

export class DropboxClient {
  private accessToken: string;
  /** RPC host; overridden by the test-harness redirect (fake-channels). */
  private apiBase: string;
  /** Content host (upload/download). The real API splits hosts; the fake
   *  serves both from one, so a baseUrl override applies to both. */
  private contentBase: string;

  constructor(accessToken: string, options?: { baseUrl?: string }) {
    this.accessToken = accessToken;
    this.apiBase = options?.baseUrl ?? 'https://api.dropboxapi.com';
    this.contentBase = options?.baseUrl ?? 'https://content.dropboxapi.com';
  }

  private async rpc(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await netFetch(`rpc(${endpoint})`, `${this.apiBase}/2/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Dropbox API error (${endpoint}): ${response.status} ${text}`);
    }

    return response.json();
  }

  async listFolder(
    path: string,
  ): Promise<{ name: string; path: string; isFolder: boolean; size: number | null }[]> {
    const data = await this.rpc('files/list_folder', {
      path: path || '',
      recursive: false,
      include_deleted: false,
    }) as { entries: { name: string; path_display: string; '.tag': string; size?: number }[] };

    return data.entries.map((entry) => ({
      name: entry.name,
      path: entry.path_display,
      isFolder: entry['.tag'] === 'folder',
      size: typeof entry.size === 'number' ? entry.size : null,
    }));
  }

  /** A file's bytes. Dropbox addresses by path; the path IS the handle. */
  async download(path: string): Promise<Readable> {
    const response = await netFetch(`download(${path})`, `${this.contentBase}/2/files/download`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`Dropbox download failed (${path}): ${response.status} ${text}`);
    }
    return Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
  }

  async findFolder({ name, parentPath }: { name: string; parentPath: string }): Promise<string | null> {
    try {
      const entries = await this.listFolder(parentPath);
      const match = entries.find((e) => e.isFolder && e.name.toLowerCase() === name.toLowerCase());
      return match?.path ?? null;
    } catch {
      return null;
    }
  }

  async createFolder({ name, parentPath }: { name: string; parentPath: string }): Promise<{ path: string }> {
    const fullPath = `${parentPath}/${name}`;
    const data = await this.rpc('files/create_folder_v2', { path: fullPath }) as {
      metadata: { path_display: string };
    };

    return { path: data.metadata.path_display };
  }

  async uploadFile({ name, parentPath, stream, mimeType }: {
    name: string;
    parentPath: string;
    stream: Readable;
    mimeType?: string;
  }): Promise<{ path: string }> {
    const fullPath = `${parentPath}/${name}`;

    // Collect stream into buffer — Dropbox upload API expects the full body
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const dropboxArg = JSON.stringify({
      path: fullPath,
      mode: { '.tag': 'overwrite' },
      autorename: true,
    });

    const response = await netFetch('upload', `${this.contentBase}/2/files/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': dropboxArg,
      },
      body: buffer,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Dropbox upload failed: ${response.status} ${text}`);
    }

    const data = await response.json() as { path_display: string };

    return { path: data.path_display };
  }

  async createTextFile({ name, content, parentPath }: {
    name: string;
    content: string;
    parentPath: string;
  }): Promise<{ path: string }> {
    return this.uploadFile({
      name,
      parentPath,
      stream: Readable.from(content),
      mimeType: 'text/plain',
    });
  }
}
