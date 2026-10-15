// The document store's local backend: the project's `.lf/files/` folder. The
// host family (`DocumentStore`) and everything that reads through it — the
// remote adapter's file transport, redeeming a descriptor for bytes — are the
// hosted product's own code; only where the bytes sit is lf's.
//
// A stored document's handle is `lf-files:<key>`, its key the path under
// `.lf/files/`. Exposing a file (for an external that fetches it across the
// JSON wire) copies it under `exposed/` and serves it from a loopback HTTP
// listener that lives as long as the session: the local stand-in for the
// hosted API's short-lived blob route.

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  documentStoreFileRef,
  teamDocumentKeyPrefix,
  type DocumentStore,
} from 'movement-engine/services/translation_graph/engine/files/document_store';

const HANDLE_PREFIX = 'lf-files:';
const EXPOSED = 'exposed';

export interface LocalDocumentStore extends DocumentStore {
  /** Stop serving exposed files. */
  close(): Promise<void>;
}

export function localDocumentStore(lfDir: string): LocalDocumentStore {
  const root = join(lfDir, 'files');
  let serving: Promise<{ server: Server; port: number }> | undefined;

  const pathOf = (objectUri: string): string | undefined => {
    const key = keyOf(objectUri);
    return key !== undefined ? join(root, key) : undefined;
  };

  const write = (key: string, bytes: Buffer): void => {
    const path = join(root, key);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  };

  const listener = (): Promise<{ server: Server; port: number }> =>
    (serving ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const id = /^\/files\/([0-9a-f-]+)$/.exec(req.url ?? '')?.[1];
        const path = id !== undefined ? join(root, EXPOSED, id) : undefined;
        if (req.method !== 'GET' || path === undefined || !existsSync(path)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-length': statSync(path).size });
        createReadStream(path).pipe(res);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') reject(new Error('the file listener has no port'));
        else resolve({ server, port: address.port });
      });
    }));

  return {
    put: async ({ tenantId, bytes, name, contentType }) => {
      const key = `${teamDocumentKeyPrefix(tenantId)}/${randomUUID()}/${name}`;
      write(key, bytes);
      return documentStoreFileRef({ objectUri: `${HANDLE_PREFIX}${key}`, name, contentType, size: bytes.byteLength });
    },
    owns: async ({ objectUri, tenantId }) => {
      const key = keyOf(objectUri);
      return key !== undefined && key.startsWith(`${teamDocumentKeyPrefix(tenantId)}/`) && existsSync(join(root, key));
    },
    open: async ({ objectUri, ref }) => {
      const path = pathOf(objectUri);
      if (path === undefined || !existsSync(path)) throw new Error(`no stored document ${objectUri} in ${root}`);
      return {
        stream: createReadStream(path),
        size: statSync(path).size,
        ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
      };
    },
    expose: async ({ stream }) => {
      const id = randomUUID();
      write(`${EXPOSED}/${id}`, await bytesOf(stream));
      const { port } = await listener();
      return { url: `http://127.0.0.1:${port}/files/${id}` };
    },
    close: async () => {
      const open = serving;
      serving = undefined;
      if (open === undefined) return;
      const { server } = await open;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The key a handle names: `/`-separated names, never a way out of the
 *  folder. */
function keyOf(objectUri: string): string | undefined {
  if (!objectUri.startsWith(HANDLE_PREFIX)) return undefined;
  const key = objectUri.slice(HANDLE_PREFIX.length);
  const segments = key.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..') ? key : undefined;
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
