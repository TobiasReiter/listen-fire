import { Readable } from 'node:stream';

/** An error's message with its `cause` chain unwound: undici throws
 *  `TypeError: fetch failed` and puts the reason (DNS, reset, TLS) on `cause`. */
function describeError(error: unknown): string {
  const messageOf = (value: unknown): string => (value instanceof Error ? value.message : String(value));
  let message = messageOf(error);
  const seen = new Set<unknown>([error]);
  let current: unknown = error instanceof Error ? error.cause : undefined;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const detail = messageOf(current);
    if (detail && !message.includes(detail)) message += `: ${detail}`;
    current = current instanceof Error ? current.cause : undefined;
  }
  return message;
}

export interface DropboxClientOptions {
  /** Both Dropbox hosts at once: the dev loop's fake serves RPC and content
   *  from one. */
  baseUrl?: string;
  /** The host's fetch. Default: the global one. */
  fetch?: typeof fetch;
}

export class DropboxClient {
  private readonly fetchImpl: typeof fetch;
  private accessToken: string;
  /** RPC host; overridden by the test-harness redirect (fake-channels). */
  private apiBase: string;
  /** Content host (upload/download). The real API splits hosts; the fake
   *  serves both from one, so a baseUrl override applies to both. */
  private contentBase: string;

  constructor(accessToken: string, options?: DropboxClientOptions) {
    this.fetchImpl = options?.fetch ?? fetch;
    this.accessToken = accessToken;
    this.apiBase = options?.baseUrl ?? 'https://api.dropboxapi.com';
    this.contentBase = options?.baseUrl ?? 'https://content.dropboxapi.com';
  }

  /**
   * `fetch`, but a network-level throw is re-raised naming the operation —
   * so a failed filing run reads "Dropbox upload failed — getaddrinfo
   * ENOTFOUND …", not the bare "fetch failed". Non-OK HTTP responses are the
   * caller's to interpret (they carry status + body already).
   */
  private async netFetch(op: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new Error(`Dropbox ${op} failed — ${describeError(err)}`);
    }
  }

  private async rpc(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.netFetch(`rpc(${endpoint})`, `${this.apiBase}/2/${endpoint}`, {
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
    const response = await this.netFetch(`download(${path})`, `${this.contentBase}/2/files/download`, {
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

  async uploadFile({ name, parentPath, stream }: {
    name: string;
    parentPath: string;
    stream: Readable;
    mimeType?: string;
  }): Promise<{ path: string }> {
    // Dropbox's upload API expects the full body, so the stream is collected.
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return this.uploadBytes({ name, parentPath, bytes: Buffer.concat(chunks) });
  }

  async uploadBytes({ name, parentPath, bytes }: {
    name: string;
    parentPath: string;
    bytes: Uint8Array;
  }): Promise<{ path: string }> {
    const fullPath = `${parentPath}/${name}`;
    const dropboxArg = JSON.stringify({
      path: fullPath,
      mode: { '.tag': 'overwrite' },
      autorename: true,
    });

    const response = await this.netFetch('upload', `${this.contentBase}/2/files/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': dropboxArg,
      },
      body: bytes,
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
