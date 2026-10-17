// A file's bytes, out of a module served as a process. Protocol 2 answers
// `resolveFileRef` with a URL the caller fetches, since bytes never ride the
// envelope. A file the module serves from its provider has no URL of its own,
// so the server holds the module's stream at a URL of its own: one fetch, an
// unguessable path (the path is the capability, as with any short-lived file
// URL; the protocol's token does not gate it), dropped unfetched after a
// minute.

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { IncomingMessage, ServerResponse } from 'node:http';

export const SERVED_FILES_PATH = '/files/';

/** How long a file waits for its one fetch. */
export const SERVED_FILE_TTL_MS = 60_000;

export interface ServedFile {
  stream: Readable;
  contentType?: string;
}

export interface ServedFiles {
  /** Hold `file` for one fetch; its URL under `origin`. */
  expose(file: ServedFile, origin: string): string;
  /** Answer `req` when it fetches a held file; false when it is not one. */
  serve(req: IncomingMessage, res: ServerResponse): boolean;
}

export function servedFiles(options: { ttlMs?: number } = {}): ServedFiles {
  const held = new Map<string, { file: ServedFile; timer: NodeJS.Timeout }>();
  const ttl = options.ttlMs ?? SERVED_FILE_TTL_MS;
  return {
    expose(file, origin) {
      const token = randomBytes(24).toString('base64url');
      const timer = setTimeout(() => {
        held.delete(token);
        file.stream.destroy();
      }, ttl);
      timer.unref();
      held.set(token, { file, timer });
      return `${origin.replace(/\/+$/, '')}${SERVED_FILES_PATH}${token}`;
    },
    serve(req, res) {
      const path = req.url ?? '';
      if (req.method !== 'GET' || !path.startsWith(SERVED_FILES_PATH)) return false;
      const token = path.slice(SERVED_FILES_PATH.length);
      const entry = held.get(token);
      if (entry === undefined) {
        res.writeHead(404).end();
        return true;
      }
      held.delete(token);
      clearTimeout(entry.timer);
      res.writeHead(200, { 'content-type': entry.file.contentType ?? 'application/octet-stream' });
      entry.file.stream.on('error', () => res.destroy());
      entry.file.stream.pipe(res);
      return true;
    },
  };
}
